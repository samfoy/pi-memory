/**
 * Builds a context block from memory for injection into the system prompt.
 *
 * Two modes:
 * - Selective (prompt provided): search semantic memory for entries relevant
 *   to the user's current prompt, plus always-inject lessons.
 * - Fallback (no prompt): dump top entries by prefix (old behavior).
 */
import type { MemoryStore, SemanticEntry, LessonEntry } from "./store.js";

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
}

/**
 * Build context block. When `prompt` is provided, uses selective injection
 * (search-based). Otherwise falls back to prefix-based dump.
 */
export function buildContextBlock(store: MemoryStore, cwd?: string, prompt?: string, config?: InjectorConfig): ContextBlock {
  if (prompt?.trim()) {
    return buildSelectiveBlock(store, prompt, cwd, config);
  }
  return buildFallbackBlock(store, cwd);
}

// ─── Selective injection ─────────────────────────────────────────────

function buildSelectiveBlock(store: MemoryStore, prompt: string, cwd?: string, config?: InjectorConfig): ContextBlock {
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

  if (results.length > 0) {
    sections.push(formatSection("Relevant Memory", results.map(formatSemantic)));
    semanticCount = results.length;

    // Track access time for these memories
    store.touchAccessed(results.map(r => r.key));
  }

  // Inject lessons — either all or filtered by relevance
  const lessons = mode === "selective"
    ? getRelevantLessons(store, prompt, cwd)
    : store.listLessons(undefined, 50);

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
 * 3. Infer likely categories from the prompt and include those
 * 4. Always include "general" category lessons (up to a cap)
 * 5. Dedup and cap at LESSON_SEARCH_LIMIT
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

  // 1. Search by prompt relevance
  add(store.searchLessons(prompt, LESSON_SEARCH_LIMIT));

  // 2. Search by project slug if we have a cwd
  const slug = cwd ? projectSlug(cwd) : "";
  if (slug) {
    add(store.searchLessons(slug, 5));
  }

  // 3. Infer categories from prompt and pull matching lessons
  const categories = inferCategories(prompt);
  for (const cat of categories) {
    add(store.listLessons(cat, 10));
  }

  // 4. Always include general lessons (they're broadly applicable)
  add(store.listLessons("general", 10));

  return result.slice(0, LESSON_SEARCH_LIMIT);
}

/**
 * Infer likely lesson categories from the prompt text.
 * Maps common keywords/topics to known category names.
 */
const CATEGORY_SIGNALS: Record<string, string[]> = {
  "bug-bounty": ["bounty", "pentest", "recon", "vuln", "exploit", "h1", "hackerone", "intigriti", "bbp", "security", "cve", "xss", "sqli", "idor", "csrf", "ssrf"],
  "writing": ["blog", "write", "article", "post", "draft", "publish", "circuit-break", "readme"],
  "subagent": ["subagent", "background", "spawn", "parallel"],
  "pi-dashboard": ["dashboard", "pi-dashboard", "chat slot"],
};

function inferCategories(prompt: string): string[] {
  const lower = prompt.toLowerCase();
  const matched: string[] = [];
  for (const [category, signals] of Object.entries(CATEGORY_SIGNALS)) {
    if (signals.some(s => lower.includes(s))) {
      matched.push(category);
    }
  }
  return matched;
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
  const relevant = cwd
    ? projects.filter(p => p.key.includes(projectSlug(cwd)) || p.confidence >= 0.9)
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

  const lessons = store.listLessons(undefined, 50);
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

function projectSlug(cwd: string): string {
  const parts = cwd.split("/").filter(Boolean);
  const skip = new Set(["workplace", "local", "home", "src", "scratch"]);
  for (const p of parts.reverse()) {
    if (!skip.has(p.toLowerCase()) && p.length > 1) return p.toLowerCase();
  }
  return parts[parts.length - 1]?.toLowerCase() ?? "";
}
