/**
 * Builds a context block from memory for injection into the system prompt.
 *
 * Two modes:
 * - Selective (prompt provided): search semantic memory for entries relevant
 *   to the user's current prompt, plus always-inject lessons.
 * - Fallback (no prompt): dump top entries by prefix (old behavior).
 */
import type { MemoryStore, SemanticEntry, LessonEntry } from "./store.js";
import { createHash } from "node:crypto";
import os from "node:os";

const MAX_CONTEXT_CHARS = 8000;
const SEARCH_LIMIT = 15;
const LESSON_SEARCH_LIMIT = 15;

export interface RecallIds {
  semantic: string[];
  lessons: string[];
}

export interface Recalled {
  semantic: ReadonlySet<string>;
  lessons: ReadonlySet<string>;
}

export interface ContextBlock {
  text: string;
  stats: { semantic: number; lessons: number };
  included: RecallIds;
}

const NOTHING_RECALLED: Recalled = { semantic: new Set(), lessons: new Set() };

export function semanticRecallId(entry: SemanticEntry): string {
  return `${entry.key}#${createHash("sha256").update(entry.value).digest("hex").slice(0, 12)}`;
}

/**
 * Configuration for lesson injection behavior.
 * - "all": inject all lessons (original behavior, default)
 * - "selective": use semantic search to pick relevant lessons + category filtering
 */
export type LessonInjectionMode = "all" | "selective";

export interface InjectorConfig {
  lessonInjection?: LessonInjectionMode;
  /**
   * Optional embedding provider for semantic search. Absent -- the default --
   * means FTS5 BM25 only and needs no configuration.
   *
   * Shape mirrors EmbedderConfig in ./embedder.ts, typed structurally here so
   * injector.ts does not need the embedder import.
   */
  embedding?: {
    type: "openai" | "bedrock" | "ollama" | "mistral" | "openai-compatible";
    apiKey?: string;
    model?: string;
    baseUrl?: string;
    sendDimensions?: boolean;
    profile?: string;
    region?: string;
    url?: string;
    dimensions?: number;
  };
  /**
   * Per-turn retrieval switch. Default (undefined or true): each user turn
   * runs a relevance search against the current prompt, and `injectionMode`
   * decides where the block goes.
   *
   * false: no per-turn retrieval; a one-shot fallback block (all relevant
   * memory, 8KB cap) is injected as a hidden message at session_start.
   */
  perTurnInjection?: boolean;
  injectionMode?: "system-prompt" | "message";
  /**
   * Model string passed to `pi --model` for session-end consolidation.
   * When omitted, the built-in default is used.  Useful for users on
   * non-Anthropic providers (OpenAI/Codex/OpenRouter/Ollama/local),
   * or for picking a cheaper/faster model for background extraction.
   *
   * Invalid model strings will cause the consolidation sub-process to
   * fail — the existing try/catch swallows that silently, so the worst
   * case is that consolidation skips this session.
   */
  consolidationModel?: string;
}

/**
 * Build context block. When `prompt` is provided, uses selective injection
 * (search-based). Otherwise falls back to prefix-based dump.
 */
export async function buildContextBlock(
  store: MemoryStore,
  cwd?: string,
  prompt?: string,
  config?: InjectorConfig,
  recalled: Recalled = NOTHING_RECALLED,
): Promise<ContextBlock> {
  if (prompt?.trim()) {
    return buildSelectiveBlock(store, prompt, cwd, config, recalled);
  }
  return buildFallbackBlock(store, cwd);
}

// ─── Selective injection ─────────────────────────────────────────────

async function buildSelectiveBlock(store: MemoryStore, prompt: string, cwd: string | undefined, config: InjectorConfig | undefined, recalled: Recalled): Promise<ContextBlock> {
  const sections: string[] = [];
  let semanticCount = 0;
  let lessonCount = 0;
  const mode = config?.lessonInjection ?? "all";

  // Search semantic memory using the user's prompt
  const results = store.searchSemantic(prompt, SEARCH_LIMIT);

  // Also search with project slug if we have a cwd, to pull in project context
  const slug = cwd ? projectSlug(cwd) : "";
  if (slug) {
    const projectResults = store.searchSemantic(slug, 5);
    // Merge, dedup by key
    const seen = new Set(results.map(r => r.key));
    for (const r of projectResults) {
      if (!seen.has(r.key)) {
        results.push(r);
        seen.add(r.key);
      }
    }
  }

  // Filter out project.* facts that belong to other projects.
  // FTS can match project facts from unrelated projects when their text
  // coincidentally matches the prompt (e.g. a prompt about "prisma" pulling
  // in rise.testing.fabricca). Keep only facts whose project segment
  // matches the current slug; non-project facts (pref.*, tool.*, user.*)
  // are always kept.
  const filteredResults = slug
    ? results.filter(r => {
        if (!r.key.startsWith("project.")) return true;
        const parts = r.key.split(".");
        return parts.length >= 2 && parts[1] === slug;
      })
    : results;

  // Shared dedup set — used by FTS search and prefix expansion below.
  const seen = new Set(filteredResults.map(r => r.key));

  // ── Prefix co-expansion ──────────────────────────────────────────────────
  // When any key in a sibling group appears in FTS results, pull a bounded set
  // of siblings under the same prefix to recover useful nearby context.
  const expandedPrefixes = new Set<string>();
  for (const r of [...filteredResults]) {  // snapshot — we push into filteredResults below
    const prefix = keyDomainPrefix(r.key);
    if (!prefix || expandedPrefixes.has(prefix)) continue;
    expandedPrefixes.add(prefix);
    for (const sibling of store.listSemantic(prefix, 5)) {
      if (!seen.has(sibling.key)) {
        filteredResults.push(sibling);
        seen.add(sibling.key);
      }
    }
  }

  const freshSemantic = filteredResults.filter(r => !recalled.semantic.has(semanticRecallId(r)));
  const semanticLines = freshSemantic.map(r => ({ id: semanticRecallId(r), line: formatSemantic(r) }));
  if (semanticLines.length > 0) {
    sections.push(formatSection("Relevant Memory", semanticLines.map(l => l.line)));
    semanticCount = semanticLines.length;
  }

  const lessons = (mode === "selective"
    ? getRelevantLessons(store, prompt, cwd)
    : store.listLessons(undefined, 50, slug || undefined)
  ).filter(l => !recalled.lessons.has(l.id));
  const lessonLines = lessonSections(lessons, sections);
  lessonCount = lessons.length;

  if (sections.length === 0) {
    return { text: "", stats: { semantic: 0, lessons: 0 }, included: { semantic: [], lessons: [] } };
  }

  const text = capped(`<memory>\n${sections.join("\n")}\n\n${MEMORY_DRIFT_CAVEAT}\n</memory>`);
  const included = { semantic: shownIn(text, semanticLines), lessons: shownIn(text, lessonLines) };
  store.touchAccessed(freshSemantic.filter(r => included.semantic.includes(semanticRecallId(r))).map(r => r.key));

  return { text, stats: { semantic: semanticCount, lessons: lessonCount }, included };
}

function lessonSections(lessons: LessonEntry[], sections: string[]): { id: string; line: string }[] {
  const tag = (l: LessonEntry) => (l.category !== "general" ? ` [${l.category}]` : "");
  const corrections = lessons.filter(l => l.negative).map(l => ({ id: l.id, line: `DON'T: ${l.rule}${tag(l)}` }));
  const positives = lessons.filter(l => !l.negative).map(l => ({ id: l.id, line: `${l.rule}${tag(l)}` }));
  if (corrections.length > 0) sections.push(formatSection("Learned Corrections", corrections.map(l => l.line)));
  if (positives.length > 0) sections.push(formatSection("Validated Approaches", positives.map(l => l.line)));
  return [...corrections, ...positives];
}

function capped(text: string): string {
  return text.length > MAX_CONTEXT_CHARS
    ? text.slice(0, MAX_CONTEXT_CHARS - 20) + "\n... (truncated)\n</memory>"
    : text;
}

function shownIn(text: string, lines: { id: string; line: string }[]): string[] {
  return lines.filter(l => text.includes(`\n- ${l.line}\n`)).map(l => l.id);
}

// ─── Selective lesson injection ──────────────────────────────────────

/**
 * Get lessons relevant to the current prompt + project context.
 *
 * Strategy:
 * 1. Search lessons by prompt terms (semantic/FTS match)
 * 2. If cwd implies a project, also search by project slug
 * 3. Always include "general" category lessons (broadly applicable)
 * 4. Dedup and cap at LESSON_SEARCH_LIMIT
 */
function getRelevantLessons(store: MemoryStore, prompt: string, cwd?: string): LessonEntry[] {
  const seen = new Set<string>();
  const result: LessonEntry[] = [];

  function add(lessons: LessonEntry[]) {
    for (const l of lessons) {
      if (!seen.has(l.id)) {
        seen.add(l.id);
        result.push(l);
      }
    }
  }

  // 1. Search by prompt relevance (FTS across rule text + category)
  add(store.searchLessons(prompt, LESSON_SEARCH_LIMIT));

  // 2. Search by project slug if we have a cwd
  const slug = cwd ? projectSlug(cwd) : "";
  if (slug) {
    add(store.searchLessons(slug, 5));
  }

  // 3. Always include general lessons (they're broadly applicable)
  add(store.listLessons("general", 10));

  return result.slice(0, LESSON_SEARCH_LIMIT);
}

// ─── Fallback (no prompt) ────────────────────────────────────────────

function buildFallbackBlock(store: MemoryStore, cwd?: string): ContextBlock {
  const sections: string[] = [];
  let semanticCount = 0;
  let lessonCount = 0;

  const prefs = store.listSemantic("pref.", 50);
  if (prefs.length > 0) {
    sections.push(formatSection("User Preferences", prefs.map(formatSemantic)));
    semanticCount += prefs.length;
  }

  const projects = store.listSemantic("project.", 50);
  // Filter project facts to the current project only.
  // Match by exact second key segment (project.<slug>.<rest>) rather than
  // substring — avoids "pi" matching "project.pipefittingjobs.*" and prevents
  // user-set facts (confidence 0.95) from bleeding into unrelated sessions.
  const slug = cwd ? projectSlug(cwd) : "";
  const relevant = slug
    ? projects.filter(p => {
        const parts = p.key.split(".");
        return parts.length >= 2 && parts[1] === slug;
      })
    : projects;
  if (relevant.length > 0) {
    sections.push(formatSection("Project Context", relevant.map(formatSemantic)));
    semanticCount += relevant.length;
  }

  const tools = store.listSemantic("tool.", 20);
  if (tools.length > 0) {
    sections.push(formatSection("Tool Preferences", tools.map(formatSemantic)));
    semanticCount += tools.length;
  }

  const lessons = store.listLessons(undefined, 50, slug || undefined);
  lessonSections(lessons, sections);
  lessonCount = lessons.length;

  const user = store.listSemantic("user.", 10);
  if (user.length > 0) {
    sections.push(formatSection("User", user.map(formatSemantic)));
    semanticCount += user.length;
  }

  if (sections.length === 0) {
    return { text: "", stats: { semantic: 0, lessons: 0 }, included: { semantic: [], lessons: [] } };
  }

  const text = capped(`<memory>\n${sections.join("\n")}\n\n${MEMORY_DRIFT_CAVEAT}\n</memory>`);
  return { text, stats: { semantic: semanticCount, lessons: lessonCount }, included: { semantic: [], lessons: [] } };
}

// ─── Helpers ─────────────────────────────────────────────────────────

/** Staleness thresholds (in days) */
const STALE_WARNING_DAYS = 30;
const VERY_STALE_DAYS = 90;

function formatSection(title: string, items: string[]): string {
  return `## ${title}\n${items.map(i => `- ${i}`).join("\n")}`;
}

/**
 * Format a semantic entry with staleness indicator.
 * Memories older than 30 days get a warning; older than 90 days get a strong warning.
 * This prevents the agent from treating stale facts as current truth.
 */
function formatSemantic(entry: SemanticEntry): string {
  const key = entry.key.split(".").slice(1).join(".");
  const ageDays = daysSince(entry.updated_at);
  const staleTag = ageDays >= VERY_STALE_DAYS
    ? ` ⚠️ ${ageDays}d old — verify before acting on this`
    : ageDays >= STALE_WARNING_DAYS
      ? ` (${ageDays}d ago)`
      : "";
  return `${key}: ${entry.value}${staleTag}`;
}

/**
 * Calculate days since a date string.
 */
function daysSince(dateStr: string): number {
  try {
    const then = new Date(dateStr).getTime();
    const now = Date.now();
    return Math.floor((now - then) / (1000 * 60 * 60 * 24));
  } catch {
    return 0;
  }
}

/**
 * Memory drift caveat — appended to the memory block so the agent knows
 * to verify recalled facts against current state before acting on them.
 */
const MEMORY_DRIFT_CAVEAT = `## Before acting on memory
- Memory records can become stale. If a memory names a file, function, or flag — verify it still exists before recommending it. "The memory says X exists" is not the same as "X exists now."
- If a recalled memory conflicts with what you observe in the current code or project state, trust what you observe now.
- Memories about project state (deadlines, decisions, architecture) decay fastest — check if still relevant.`;

/**
 * Extract domain prefix for sibling expansion.
 * Only keys with 3+ segments expand: `user.health.diet` → `user.health`.
 * 2-segment keys like `pref.editor` or `user.fitness` are leaf-level.
 */
function keyDomainPrefix(key: string): string | null {
  const parts = key.split(".");
  return parts.length >= 3 ? parts.slice(0, 2).join(".") : null;
}

export function projectSlug(cwd: string): string {
  const parts = cwd.split("/").filter(Boolean);
  const skip = new Set(["workplace", "local", "home", "src", "scratch", os.userInfo().username]);
  for (const p of parts.reverse()) {
    if (!skip.has(p.toLowerCase()) && p.length > 1) return p.toLowerCase();
  }
  return "";
}
