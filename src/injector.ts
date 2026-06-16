/**
 * Builds a context block from memory for injection into the system prompt.
 *
 * Two modes:
 * - Selective (prompt provided): search semantic memory for entries relevant
 *   to the user's current prompt, plus always-inject lessons.
 * - Fallback (no prompt): dump top entries by prefix (old behavior).
 */
import type { MemoryStore, SemanticEntry, LessonEntry } from "./store.js";
import { embed, similarity, fromBlob } from "./embedder.js";
import os from "node:os";

const MAX_CONTEXT_CHARS = 8000;
const SEARCH_LIMIT = 15;
const LESSON_SEARCH_LIMIT = 15;

export interface ContextBlock {
  text: string;
  stats: { semantic: number; lessons: number };
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
   * Opt-in: restore per-user-message selective injection.
   *
   * When false (default), pi-memory injects a one-shot fallback block at
   * session_start (correct message ordering, stable prefix cache).
   *
   * When true, the session_start dump is skipped and each turn runs a
   * semantic search against the user's current prompt. The injection
   * strategy is then controlled by `injectionMode`.
   *
   * Correctness is preserved either way: systemPrompt is a separate field
   * from the messages list, so the user's question remains the last
   * user-role message and the model responds to it.
   */
  perTurnInjection?: boolean;
  /**
   * Controls how per-turn memory is spliced into the LLM context.
   * Only relevant when perTurnInjection is not false.
   *
   * "context-hook" (default): memory is injected as an ephemeral custom
   *   message immediately before the latest user message, via the
   *   pi.on("context") hook. The system prompt is never modified — it
   *   caches unconditionally. A memory content change only causes a cache
   *   miss at the injection point and forward (not from the system prompt
   *   root). Injected messages are NOT persisted to session history or
   *   fed back into consolidation.
   *
   * "system-prompt" (legacy v1.4.0 behavior): memory is appended to
   *   event.systemPrompt in before_agent_start. Cache-stable when memory
   *   content is unchanged, but a topic shift causes a cache miss that
   *   cascades from the system prompt root through all downstream messages.
   */
  injectionMode?: "system-prompt" | "context-hook";
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
export async function buildContextBlock(store: MemoryStore, cwd?: string, prompt?: string, config?: InjectorConfig): Promise<ContextBlock> {
  if (prompt?.trim()) {
    return buildSelectiveBlock(store, prompt, cwd, config);
  }
  return buildFallbackBlock(store, cwd);
}

// ─── Selective injection ─────────────────────────────────────────────

async function buildSelectiveBlock(store: MemoryStore, prompt: string, cwd?: string, config?: InjectorConfig): Promise<ContextBlock> {
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

  // Shared dedup set — used by both semantic search and prefix expansion below.
  const seen = new Set(filteredResults.map(r => r.key));

  // ── Semantic similarity ──────────────────────────────────────────────────
  // Embed the prompt and compare against stored embeddings to surface entries
  // that are conceptually related but share no keywords with the query.
  // Example: "I'm hungry" → finds user.health.diet via vector proximity.
  //
  // Gracefully degrades: if @xenova/transformers is unavailable or the model
  // hasn't been downloaded yet, embed() returns null and we skip this step.
  const SEMANTIC_THRESHOLD = 0.25;
  const SEMANTIC_LIMIT = 8;
  const allEmbs = store.getAllEmbeddings();
  const promptVec = await embed(prompt);
  const semanticKeys = new Set<string>(); // track entries surfaced by embedding search

  if (promptVec) {
    const semanticHits = allEmbs
      .flatMap(({ key, embedding }) => {
        const vec = fromBlob(embedding);
        if (!vec) return [];
        const score = similarity(promptVec, vec);
        return score >= SEMANTIC_THRESHOLD ? [{ key, score }] : [];
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, SEMANTIC_LIMIT);

    for (const { key } of semanticHits) {
      // Always mark as a semantic hit for priority sorting, even if FTS already
      // added this key — that way the reorder step promotes it to the front.
      semanticKeys.add(key);
      if (!seen.has(key)) {
        const entry = store.getSemantic(key);
        if (entry) {
          filteredResults.push(entry);
          seen.add(key);
        }
      }
    }

    // Background: compute and store embeddings for entries that lack them.
    // Fire-and-forget — does not block injection.
    backfillEmbeddings(store, allEmbs.filter(r => !r.embedding)).catch(() => {});
  }

  // ── Prefix co-expansion ──────────────────────────────────────────────────
  // When any key in a sibling group appears in results (FTS or semantic),
  // pull siblings under the same prefix. Semantic hits get full expansion (20);
  // FTS hits are capped at 5 to prevent noisy matches from flooding context.
  const expandedPrefixes = new Set<string>();
  for (const r of [...filteredResults]) {  // snapshot — we push into filteredResults below
    const prefix = keyDomainPrefix(r.key);
    if (!prefix || expandedPrefixes.has(prefix)) continue;
    expandedPrefixes.add(prefix);
    const limit = semanticKeys.has(r.key) ? 20 : 5;
    for (const sibling of store.listSemantic(prefix, limit)) {
      if (!seen.has(sibling.key)) {
        filteredResults.push(sibling);
        seen.add(sibling.key);
      }
    }
  }

  // Reorder: semantic-related entries float to the front so they survive
  // MAX_CONTEXT_CHARS truncation even when FTS-matched noise fills the list.
  if (semanticKeys.size > 0) {
    const semanticPrefixes = new Set<string>();
    for (const k of semanticKeys) {
      const p = keyDomainPrefix(k);
      if (p) semanticPrefixes.add(p);
    }
    const isSemanticRelated = (key: string): boolean => {
      if (semanticKeys.has(key)) return true;
      const p = keyDomainPrefix(key);
      return p ? semanticPrefixes.has(p) : false;
    };
    const priority = filteredResults.filter(r => isSemanticRelated(r.key));
    const rest = filteredResults.filter(r => !isSemanticRelated(r.key));
    // Deterministic key order within each group: same entries → same text →
    // provider prefix cache hits when the topic doesn't change between turns.
    priority.sort((a, b) => a.key.localeCompare(b.key));
    rest.sort((a, b) => a.key.localeCompare(b.key));
    filteredResults.length = 0;
    filteredResults.push(...priority, ...rest);
  }

  if (filteredResults.length > 0) {
    sections.push(formatSection("Relevant Memory", filteredResults.map(formatSemantic)));
    semanticCount = filteredResults.length;

    // Track access time for these memories
    store.touchAccessed(filteredResults.map(r => r.key));
  }

  // Inject lessons — either all or filtered by relevance + project scope
  const lessons = mode === "selective"
    ? getRelevantLessons(store, prompt, cwd)
    : store.listLessons(undefined, 50, slug || undefined);

  if (lessons.length > 0) {
    const corrections = lessons.filter(l => l.negative);
    const positives = lessons.filter(l => !l.negative);

    if (corrections.length > 0) {
      const formatted = corrections.map(l =>
        `DON'T: ${l.rule}${l.category !== "general" ? ` [${l.category}]` : ""}`
      );
      sections.push(formatSection("Learned Corrections", formatted));
    }
    if (positives.length > 0) {
      const formatted = positives.map(l =>
        `${l.rule}${l.category !== "general" ? ` [${l.category}]` : ""}`
      );
      sections.push(formatSection("Validated Approaches", formatted));
    }
    lessonCount = lessons.length;
  }

  if (sections.length === 0) {
    return { text: "", stats: { semantic: 0, lessons: 0 } };
  }

  let text = `<memory>\n${sections.join("\n")}\n\n${MEMORY_DRIFT_CAVEAT}\n</memory>`;

  if (text.length > MAX_CONTEXT_CHARS) {
    text = text.slice(0, MAX_CONTEXT_CHARS - 20) + "\n... (truncated)\n</memory>";
  }

  return { text, stats: { semantic: semanticCount, lessons: lessonCount } };
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
  if (lessons.length > 0) {
    const corrections = lessons.filter(l => l.negative);
    const positives = lessons.filter(l => !l.negative);

    if (corrections.length > 0) {
      const formatted = corrections.map(l =>
        `DON'T: ${l.rule}${l.category !== "general" ? ` [${l.category}]` : ""}`
      );
      sections.push(formatSection("Learned Corrections", formatted));
    }
    if (positives.length > 0) {
      const formatted = positives.map(l =>
        `${l.rule}${l.category !== "general" ? ` [${l.category}]` : ""}`
      );
      sections.push(formatSection("Validated Approaches", formatted));
    }
    lessonCount = lessons.length;
  }

  const user = store.listSemantic("user.", 10);
  if (user.length > 0) {
    sections.push(formatSection("User", user.map(formatSemantic)));
    semanticCount += user.length;
  }

  if (sections.length === 0) {
    return { text: "", stats: { semantic: 0, lessons: 0 } };
  }

  let text = `<memory>\n${sections.join("\n")}\n\n${MEMORY_DRIFT_CAVEAT}\n</memory>`;

  if (text.length > MAX_CONTEXT_CHARS) {
    text = text.slice(0, MAX_CONTEXT_CHARS - 20) + "\n... (truncated)\n</memory>";
  }

  return { text, stats: { semantic: semanticCount, lessons: lessonCount } };
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

/**
 * Background: compute and store embeddings for entries that are missing them.
 * Runs after a successful semantic search, populating the DB for future use.
 * Capped at 10 entries per call to avoid blocking the event loop.
 */
async function backfillEmbeddings(
  store: MemoryStore,
  missing: Array<{ key: string }>,
): Promise<void> {
  if (missing.length === 0) return;
  for (const { key } of missing.slice(0, 10)) {
    const entry = store.getSemantic(key);
    if (!entry) continue;
    // Use the human-readable key suffix + value as embedding input
    const displayKey = key.split(".").slice(1).join(" ");
    const vec = await embed(`${displayKey} ${entry.value}`);
    if (vec) store.setEmbedding(key, vec);
  }
}

export function projectSlug(cwd: string): string {
  const parts = cwd.split("/").filter(Boolean);
  const skip = new Set(["workplace", "local", "home", "src", "scratch", os.userInfo().username]);
  for (const p of parts.reverse()) {
    if (!skip.has(p.toLowerCase()) && p.length > 1) return p.toLowerCase();
  }
  return "";
}
