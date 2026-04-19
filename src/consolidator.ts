/**
 * Consolidator — extracts structured knowledge from session conversations.
 *
 * After a session ends (or on demand), reads the conversation and uses an
 * LLM to extract:
 * - Preferences (→ semantic memory, pref.*)
 * - Project patterns (→ semantic memory, project.*)
 * - Corrections/lessons (→ lessons table)
 * - Tool preferences (→ semantic memory, tool.*)
 *
 * Uses the pi SDK's createAgentSession for the LLM call, or falls back
 * to a simple extraction when no LLM is available.
 */
import type { MemoryStore } from "./store.js";

// ─── Types ───────────────────────────────────────────────────────────

export interface ConsolidationInput {
  /** User messages from the session */
  userMessages: string[];
  /** Assistant messages from the session */
  assistantMessages: string[];
  /** Working directory of the session */
  cwd?: string;
  /** Session ID for provenance */
  sessionId?: string;
}

export interface ExtractedMemory {
  semantic: Array<{ key: string; value: string; confidence: number }>;
  lessons: Array<{ rule: string; category: string; negative: boolean }>;
}

export const CONSOLIDATION_PROMPT = `You are a memory extraction system. Analyze this conversation and extract structured knowledge.

Extract ONLY concrete, reusable facts — not summaries of what happened. Focus on:

1. **User preferences** (key prefix: pref.) — coding style, tool preferences, workflow habits
   Example: { "key": "pref.commit_style", "value": "conventional commits", "confidence": 0.9 }

2. **Project patterns** (key prefix: project.<name>.) — languages, frameworks, architecture decisions
   Example: { "key": "project.rosie.di", "value": "Dagger dependency injection", "confidence": 0.95 }

3. **Tool preferences** (key prefix: tool.) — which tools to prefer/avoid, how to use them
   Example: { "key": "tool.sed", "value": "use for daily note insertion, not echo >>", "confidence": 0.9 }

4. **Corrections/lessons** — things the user corrected, mistakes to avoid
   Example: { "rule": "Use sed to insert after ## Notes heading, not echo >> which appends after Tags", "category": "vault", "negative": true }

5. **Validated approaches** — things the user explicitly confirmed worked well (positive signal)
   Example: { "rule": "When deploying wiki changes, draft first and let user preview before publishing", "category": "wiki-edit", "negative": false }

## What NOT to extract — these are derivable or ephemeral, and pollute memory:

- **Code patterns, architecture, file paths, project structure** — these can be derived by reading the current project state (grep, git, file reads)
- **Git history, recent changes, who-changed-what** — git log/blame are authoritative
- **Debugging solutions or fix recipes** — the fix is in the code; the commit message has context
- **Anything already documented in AGENTS.md, CLAUDE.md, or project config files**
- **Ephemeral task details** — in-progress work, temporary state, current conversation context
- **Activity summaries** — "today we worked on X" is not a lasting fact. Instead ask: what was *surprising* or *non-obvious* about it?
- **File contents or code snippets** — the file itself is the source of truth
- **Exact commands that worked once** — unless they encode a non-obvious pattern that the agent consistently gets wrong

These exclusions apply even if the user asks to save such things. If asked, extract what was *surprising* or *non-obvious* — that is the part worth keeping.

Rules:
- Only extract if confidence >= 0.8 (you're reasonably sure this is a lasting preference, not a one-off)
- Key format: lowercase, dots as separators, no spaces
- Keep values concise (under 200 chars)
- For corrections, set negative=true if it's something to AVOID
- For validated approaches (user confirmed something works), set negative=false

Respond with ONLY valid JSON matching this schema:
{
  "semantic": [{ "key": "string", "value": "string", "confidence": number }],
  "lessons": [{ "rule": "string", "category": "string", "negative": boolean }]
}

If nothing worth extracting, return: { "semantic": [], "lessons": [] }`;

// ─── Consolidation ───────────────────────────────────────────────────

/**
 * Build the consolidation prompt for an LLM call.
 */
export function buildConsolidationPrompt(
  input: ConsolidationInput,
  currentFacts?: { key: string; value: string }[],
  currentLessons?: { rule: string; category: string }[]
): string {
  const messages: string[] = [];

  // Current memory state section — helps the LLM avoid duplicates
  let memorySection = "";
  if ((currentFacts && currentFacts.length > 0) || (currentLessons && currentLessons.length > 0)) {
    const parts: string[] = ["## Current Memory State"];
    if (currentFacts && currentFacts.length > 0) {
      parts.push("The user already has these facts stored (avoid duplicating, update if changed):");
      let chars = 0;
      for (const f of currentFacts) {
        const line = `- ${f.key}: ${f.value.length > 120 ? f.value.slice(0, 120) + "…" : f.value}`;
        if (chars + line.length > 1500) { parts.push("- ... (truncated)"); break; }
        parts.push(line);
        chars += line.length;
      }
    }
    if (currentLessons && currentLessons.length > 0) {
      parts.push("\nAnd these lessons (avoid duplicating):");
      let chars = 0;
      for (const l of currentLessons) {
        const line = `- [${l.category}] ${l.rule.length > 120 ? l.rule.slice(0, 120) + "…" : l.rule}`;
        if (chars + line.length > 500) { parts.push("- ... (truncated)"); break; }
        parts.push(line);
        chars += line.length;
      }
    }
    memorySection = parts.join("\n") + "\n\n";
  }

  // Interleave user/assistant messages for context
  const maxPairs = 30; // cap to avoid huge prompts
  const len = Math.min(input.userMessages.length, maxPairs);
  for (let i = 0; i < len; i++) {
    const userMsg = input.userMessages[i];
    if (userMsg) messages.push(`User: ${truncate(userMsg, 1000)}`);
    const assistantMsg = input.assistantMessages[i];
    if (assistantMsg) messages.push(`Assistant: ${truncate(assistantMsg, 500)}`);
  }

  return `${CONSOLIDATION_PROMPT}

${memorySection}${input.cwd ? `Working directory: ${input.cwd}\n` : ""}
## Conversation

${messages.join("\n\n")}`;
}

/**
 * Parse the LLM's JSON response into structured memory.
 */
export function parseConsolidationResponse(text: string): ExtractedMemory {
  // Extract JSON from response (may be wrapped in markdown code blocks)
  const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/) || text.match(/(\{[\s\S]*\})/);
  if (!jsonMatch) return { semantic: [], lessons: [] };

  try {
    const parsed = JSON.parse(jsonMatch[1].trim());
    const result: ExtractedMemory = { semantic: [], lessons: [] };

    if (Array.isArray(parsed.semantic)) {
      for (const s of parsed.semantic) {
        if (typeof s.key === "string" && typeof s.value === "string" && typeof s.confidence === "number") {
          if (s.confidence >= 0.8 && isValidKey(s.key) && s.value.length <= 500) {
            result.semantic.push({ key: s.key, value: s.value, confidence: s.confidence });
          }
        }
      }
    }

    if (Array.isArray(parsed.lessons)) {
      for (const l of parsed.lessons) {
        if (typeof l.rule === "string" && l.rule.trim().length > 0) {
          result.lessons.push({
            rule: l.rule.trim(),
            category: typeof l.category === "string" ? l.category : "general",
            negative: !!l.negative,
          });
        }
      }
    }

    return result;
  } catch {
    return { semantic: [], lessons: [] };
  }
}

/**
 * Apply extracted memory to the store, filtering out derivable/ephemeral entries.
 */
export function applyExtracted(store: MemoryStore, extracted: ExtractedMemory, source: string = "consolidation"): { semantic: number; lessons: number } {
  let semanticCount = 0;
  let lessonCount = 0;

  for (const s of extracted.semantic) {
    if (isDerivableOrEphemeral(s.key, s.value)) continue;
    store.setSemantic(s.key, s.value, s.confidence, "consolidation");
    semanticCount++;
  }

  for (const l of extracted.lessons) {
    if (isDerivableLesson(l.rule)) continue;
    const result = store.addLesson(l.rule, l.category, source, l.negative);
    if (result.success) lessonCount++;
  }

  return { semantic: semanticCount, lessons: lessonCount };
}

// ─── Helpers ─────────────────────────────────────────────────────────

const VALID_KEY_RE = /^[a-z][a-z0-9._-]*$/;

function isValidKey(key: string): boolean {
  return VALID_KEY_RE.test(key) && key.length <= 100 && key.length >= 2;
}

/**
 * Reject semantic entries that store derivable or ephemeral information.
 * These pollute memory — the project itself is the source of truth.
 */
function isDerivableOrEphemeral(key: string, value: string): boolean {
  const kl = key.toLowerCase();
  const vl = value.toLowerCase();

  // File paths, architecture, project structure — derivable from the project
  if (kl.includes("filepath") || kl.includes("file_path") || kl.includes("directory")) return true;
  if (/^project\.\w+\.(path|dir|location|structure|layout|architecture)$/.test(kl)) return true;

  // Git history — git log/blame is authoritative
  if (kl.includes("commit") || kl.includes("git.history") || kl.includes("git.recent")) return true;

  // Activity summaries — "today we worked on X" is not a lasting fact
  if (vl.startsWith("today ") || vl.startsWith("we worked on") || vl.startsWith("this session")) return true;

  // Exact file contents or long code snippets
  if (vl.includes("```") && vl.length > 300) return true;

  // Temporary investigation state
  if (kl.includes("current_task") || kl.includes("in_progress") || kl.includes("investigating")) return true;

  return false;
}

/**
 * Reject lesson entries that are derivable from code or too ephemeral.
 */
function isDerivableLesson(rule: string): boolean {
  const rl = rule.toLowerCase();

  // "File X is at path Y" — derivable
  if (/file .+ is (at|in|located) /.test(rl)) return true;

  // "The project uses X" when X is obvious from package.json/build files
  if (/^the (project|codebase|repo) (uses|is written in) /.test(rl)) return true;

  // Pure activity logging — "we fixed X" or "we deployed Y"
  if (/^(we|i|the agent) (fixed|deployed|updated|changed|modified|ran|executed) /.test(rl)) return true;

  // Error→fix recipes — "when error X, run command Y" — these are specific
  // debugging commands from one session, not generalizable lessons
  if (/^when (encountering|bash fails|edit fails|.*error)/.test(rl) && /\b(run:|fix with:)/.test(rl)) return true;

  // Literal command sequences — rules that are mostly a shell command
  if (/^run: /.test(rl)) return true;
  if (rl.includes("command exited with code") && rl.length < 100) return true;

  return false;
}

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + "…" : text;
}
