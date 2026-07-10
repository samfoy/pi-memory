// src/index.ts
import { Type } from "@sinclair/typebox";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { readFileSync } from "node:fs";

// src/store.ts
import { createRequire } from "node:module";
import { mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
var _require = createRequire(import.meta.url);
var isBun = typeof globalThis.Bun !== "undefined";
var DatabaseSync = isBun ? _require("bun:sqlite").Database : _require("node:sqlite").DatabaseSync;
var MemoryStore = class {
  db;
  writeLock = Promise.resolve();
  hasFTS5 = false;
  constructor(dbPath) {
    const dir = dirname(dbPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.migrate();
  }
  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS semantic (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        confidence REAL NOT NULL DEFAULT 0.8,
        source TEXT NOT NULL DEFAULT 'consolidation',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS lessons (
        id TEXT PRIMARY KEY,
        rule TEXT NOT NULL,
        category TEXT NOT NULL DEFAULT 'general',
        source TEXT NOT NULL DEFAULT 'consolidation',
        negative INTEGER NOT NULL DEFAULT 0,
        is_deleted INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_type TEXT NOT NULL,
        memory_type TEXT NOT NULL,
        memory_key TEXT NOT NULL,
        details TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    try {
      this.db.exec(`ALTER TABLE semantic ADD COLUMN last_accessed TEXT`);
    } catch {
    }
    try {
      this.db.exec(`ALTER TABLE lessons ADD COLUMN project TEXT`);
    } catch {
    }
    try {
      this.db.exec(`ALTER TABLE semantic ADD COLUMN embedding BLOB`);
    } catch {
    }
    try {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS semantic_fts USING fts5(key, value, content='semantic', content_rowid='rowid');

        CREATE TRIGGER IF NOT EXISTS semantic_ai AFTER INSERT ON semantic BEGIN
          INSERT INTO semantic_fts(rowid, key, value) VALUES (new.rowid, new.key, new.value);
        END;
        CREATE TRIGGER IF NOT EXISTS semantic_ad AFTER DELETE ON semantic BEGIN
          INSERT INTO semantic_fts(semantic_fts, rowid, key, value) VALUES('delete', old.rowid, old.key, old.value);
        END;
        CREATE TRIGGER IF NOT EXISTS semantic_au AFTER UPDATE ON semantic BEGIN
          INSERT INTO semantic_fts(semantic_fts, rowid, key, value) VALUES('delete', old.rowid, old.key, old.value);
          INSERT INTO semantic_fts(rowid, key, value) VALUES (new.rowid, new.key, new.value);
        END;
      `);
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS lessons_fts USING fts5(rule, category, content='lessons', content_rowid='rowid');

        CREATE TRIGGER IF NOT EXISTS lessons_fts_ai AFTER INSERT ON lessons BEGIN
          INSERT INTO lessons_fts(rowid, rule, category) VALUES (new.rowid, new.rule, new.category);
        END;
        CREATE TRIGGER IF NOT EXISTS lessons_fts_ad AFTER DELETE ON lessons BEGIN
          INSERT INTO lessons_fts(lessons_fts, rowid, rule, category) VALUES('delete', old.rowid, old.rule, old.category);
        END;
        CREATE TRIGGER IF NOT EXISTS lessons_fts_au AFTER UPDATE ON lessons BEGIN
          INSERT INTO lessons_fts(lessons_fts, rowid, rule, category) VALUES('delete', old.rowid, old.rule, old.category);
          INSERT INTO lessons_fts(rowid, rule, category) VALUES (new.rowid, new.rule, new.category);
        END;
      `);
      this.db.exec(`INSERT INTO semantic_fts(semantic_fts) VALUES('rebuild')`);
      this.db.exec(`INSERT INTO lessons_fts(lessons_fts) VALUES('rebuild')`);
      this.hasFTS5 = true;
    } catch {
      this.hasFTS5 = false;
    }
  }
  /**
   * Serialize async callers so concurrent read-modify-write cycles
   * (e.g. two consolidation calls) don't clobber each other.
   */
  withLock(fn) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }
  // ─── Semantic ────────────────────────────────────────────────────
  getSemantic(key) {
    const normalized = key.toLowerCase();
    return this.db.prepare("SELECT * FROM semantic WHERE key = ?").get(normalized);
  }
  setSemantic(key, value, confidence = 0.8, source = "consolidation") {
    const normalized = key.toLowerCase();
    this.withLock(() => {
      const existing = this.db.prepare("SELECT * FROM semantic WHERE key = ?").get(normalized);
      if (existing && existing.confidence > confidence) return;
      this.db.prepare(`
        INSERT INTO semantic (key, value, confidence, source, updated_at)
        VALUES (?, ?, ?, ?, datetime('now'))
        ON CONFLICT(key) DO UPDATE SET
          value = excluded.value,
          confidence = excluded.confidence,
          source = excluded.source,
          updated_at = datetime('now')
      `).run(normalized, value, confidence, source);
      this.logEvent(existing ? "update" : "create", "semantic", normalized);
    });
  }
  deleteSemantic(key) {
    const normalized = key.toLowerCase();
    return this.withLock(() => {
      const result = this.db.prepare("DELETE FROM semantic WHERE key = ?").run(normalized);
      if (result.changes > 0) this.logEvent("delete", "semantic", normalized);
      return result.changes > 0;
    });
  }
  /**
   * Store a pre-computed embedding for a key.
   * Converts Float32Array → Buffer for SQLite BLOB storage.
   */
  setEmbedding(key, embedding) {
    const normalized = key.toLowerCase();
    const blob = Buffer.from(new Uint8Array(embedding.buffer, embedding.byteOffset, embedding.byteLength));
    this.db.prepare("UPDATE semantic SET embedding = ? WHERE key = ?").run(blob, normalized);
  }
  /**
   * Return all semantic keys with their raw embedding BLOBs.
   * Used for in-memory cosine similarity at query time.
   * Entries without an embedding have embedding = null.
   */
  getAllEmbeddings() {
    return this.db.prepare("SELECT key, embedding FROM semantic ORDER BY updated_at DESC").all();
  }
  listSemantic(prefix, limit = 100) {
    if (prefix) {
      return this.db.prepare("SELECT * FROM semantic WHERE key LIKE ? ORDER BY updated_at DESC LIMIT ?").all(`${prefix}%`, limit);
    }
    return this.db.prepare("SELECT * FROM semantic ORDER BY updated_at DESC LIMIT ?").all(limit);
  }
  searchSemantic(query, limit = 10) {
    const terms = query.trim().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return [];
    if (!this.hasFTS5) return this._searchSemanticFallback(query, limit);
    const ftsQuery = terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(" OR ");
    try {
      const rows = this.db.prepare(`
        SELECT s.key, s.value, s.confidence, s.source, s.created_at, s.updated_at, s.last_accessed
        FROM semantic s
        JOIN semantic_fts fts ON s.rowid = fts.rowid
        WHERE semantic_fts MATCH ?
        ORDER BY bm25(semantic_fts)
        LIMIT ?
      `).all(ftsQuery, limit);
      if (rows.length > 0) return rows;
      return this._searchSemanticFallback(query, limit);
    } catch {
      return this._searchSemanticFallback(query, limit);
    }
  }
  _searchSemanticFallback(query, limit) {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return [];
    const all = this.db.prepare("SELECT * FROM semantic").all();
    return all.map((entry) => {
      const text = `${entry.key} ${entry.value}`.toLowerCase();
      const matches = terms.filter((t) => text.includes(t)).length;
      return { entry, score: matches / terms.length };
    }).filter(({ score }) => score > 0).sort((a, b) => b.score - a.score).slice(0, limit).map(({ entry }) => entry);
  }
  touchAccessed(keys) {
    if (keys.length === 0) return;
    const stmt = this.db.prepare("UPDATE semantic SET last_accessed = datetime('now') WHERE key = ?");
    for (const key of keys) {
      stmt.run(key.toLowerCase());
    }
  }
  // ─── Lessons ─────────────────────────────────────────────────────
  addLesson(rule, category = "general", source = "consolidation", negative = false, project) {
    const trimmed = rule.trim();
    if (!trimmed) return { success: false, reason: "empty rule" };
    const normalizedCategory = category.trim().toLowerCase() || "general";
    return this.withLock(() => {
      const existing = this.db.prepare(
        "SELECT id FROM lessons WHERE LOWER(TRIM(rule)) = LOWER(?) AND is_deleted = 0"
      ).get(trimmed.toLowerCase());
      if (existing) return { success: false, reason: "duplicate", id: existing.id };
      const allRules = this.db.prepare("SELECT id, rule FROM lessons WHERE is_deleted = 0").all();
      for (const r of allRules) {
        if (jaccard(trimmed, r.rule) >= 0.7) {
          return { success: false, reason: "similar", id: r.id };
        }
      }
      const id = crypto.randomUUID();
      this.db.prepare(
        "INSERT INTO lessons (id, rule, category, source, negative, project) VALUES (?, ?, ?, ?, ?, ?)"
      ).run(id, trimmed, normalizedCategory, source, negative ? 1 : 0, project ?? null);
      this.logEvent("create", "lesson", id, trimmed.slice(0, 100));
      return { success: true, id };
    });
  }
  getLesson(id) {
    const row = this.db.prepare("SELECT * FROM lessons WHERE id = ? AND is_deleted = 0").get(id);
    if (!row) return void 0;
    return { ...row, negative: !!row.negative };
  }
  /**
   * List lessons, optionally filtered by category and/or project.
   *
   * Project filtering:
   * - If `project` is provided, returns lessons where `project = slug` OR `project IS NULL`
   *   (NULL = user-authored or pre-migration lessons, treated as global).
   * - If `project` is not provided, returns all lessons (no project filter).
   */
  listLessons(category, limit = 50, project) {
    let rows;
    if (category && project) {
      const normalizedCategory = category.trim().toLowerCase();
      rows = this.db.prepare(
        "SELECT * FROM lessons WHERE category = ? AND (project = ? OR project IS NULL) AND is_deleted = 0 ORDER BY created_at DESC LIMIT ?"
      ).all(normalizedCategory, project, limit);
    } else if (category) {
      const normalizedCategory = category.trim().toLowerCase();
      rows = this.db.prepare("SELECT * FROM lessons WHERE category = ? AND is_deleted = 0 ORDER BY created_at DESC LIMIT ?").all(normalizedCategory, limit);
    } else if (project) {
      rows = this.db.prepare(
        "SELECT * FROM lessons WHERE (project = ? OR project IS NULL) AND is_deleted = 0 ORDER BY created_at DESC LIMIT ?"
      ).all(project, limit);
    } else {
      rows = this.db.prepare("SELECT * FROM lessons WHERE is_deleted = 0 ORDER BY created_at DESC LIMIT ?").all(limit);
    }
    return rows.map((r) => ({ ...r, negative: !!r.negative, project: r.project ?? null }));
  }
  /**
   * Search lessons by relevance to a query. Uses FTS5 when available,
   * falls back to substring matching. Returns lessons ranked by relevance.
   */
  searchLessons(query, limit = 20) {
    const terms = query.trim().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return [];
    if (!this.hasFTS5) return this._searchLessonsFallback(query, limit);
    const ftsQuery = terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(" OR ");
    try {
      const rows = this.db.prepare(`
        SELECT l.id, l.rule, l.category, l.source, l.negative, l.created_at, l.project
        FROM lessons l
        JOIN lessons_fts fts ON l.rowid = fts.rowid
        WHERE lessons_fts MATCH ? AND l.is_deleted = 0
        ORDER BY bm25(lessons_fts)
        LIMIT ?
      `).all(ftsQuery, limit);
      const mapped = rows.map((r) => ({ ...r, negative: !!r.negative, project: r.project ?? null }));
      if (mapped.length > 0) return mapped;
      return this._searchLessonsFallback(query, limit);
    } catch {
      return this._searchLessonsFallback(query, limit);
    }
  }
  _searchLessonsFallback(query, limit) {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return [];
    const all = this.db.prepare("SELECT * FROM lessons WHERE is_deleted = 0").all();
    return all.map((entry) => {
      const text = `${entry.rule} ${entry.category}`.toLowerCase();
      const matches = terms.filter((t) => text.includes(t)).length;
      return { entry: { ...entry, negative: !!entry.negative, project: entry.project ?? null }, score: matches / terms.length };
    }).filter(({ score }) => score > 0).sort((a, b) => b.score - a.score).slice(0, limit).map(({ entry }) => entry);
  }
  deleteLesson(id) {
    return this.withLock(() => {
      let result = this.db.prepare("UPDATE lessons SET is_deleted = 1 WHERE id = ? AND is_deleted = 0").run(id);
      if (result.changes === 0 && id.length < 36) {
        const matches = this.db.prepare("SELECT id FROM lessons WHERE id LIKE ? AND is_deleted = 0").all(`${id}%`);
        if (matches.length === 1) {
          result = this.db.prepare("UPDATE lessons SET is_deleted = 1 WHERE id = ? AND is_deleted = 0").run(matches[0].id);
          if (result.changes > 0) this.logEvent("delete", "lesson", matches[0].id);
          return true;
        }
      }
      if (result.changes > 0) this.logEvent("delete", "lesson", id);
      return result.changes > 0;
    });
  }
  // ─── Events ──────────────────────────────────────────────────────
  logEvent(eventType, memoryType, key, details = "") {
    this.db.prepare(
      "INSERT INTO events (event_type, memory_type, memory_key, details) VALUES (?, ?, ?, ?)"
    ).run(eventType, memoryType, key, details);
  }
  listEvents(limit = 50) {
    return this.db.prepare("SELECT * FROM events ORDER BY id DESC LIMIT ?").all(limit);
  }
  // ─── Stats ───────────────────────────────────────────────────────
  stats() {
    const semantic = this.db.prepare("SELECT COUNT(*) as c FROM semantic").get().c;
    const lessons = this.db.prepare("SELECT COUNT(*) as c FROM lessons WHERE is_deleted = 0").get().c;
    const events = this.db.prepare("SELECT COUNT(*) as c FROM events").get().c;
    return { semantic, lessons, events };
  }
  close() {
    this.db.close();
  }
};
function jaccard(a, b) {
  const setA = new Set(a.toLowerCase().split(/\s+/).filter(Boolean));
  const setB = new Set(b.toLowerCase().split(/\s+/).filter(Boolean));
  if (setA.size === 0 && setB.size === 0) return 1;
  const intersection = new Set([...setA].filter((x) => setB.has(x)));
  const union = /* @__PURE__ */ new Set([...setA, ...setB]);
  return intersection.size / union.size;
}

// src/embedder.ts
var MODEL = "Xenova/all-MiniLM-L6-v2";
var LOAD_TIMEOUT_MS = 3e4;
var INFER_TIMEOUT_MS = 5e3;
var TEXT_CHAR_LIMIT = 512;
var _pipe = null;
var _failed = false;
async function getPipe() {
  if (_failed) return null;
  if (_pipe) return _pipe;
  try {
    const pkg = "@xenova/transformers";
    const mod = await import(pkg).catch(() => null);
    if (!mod) {
      console.error("pi-memory: @xenova/transformers not installed, semantic search disabled");
      _failed = true;
      return null;
    }
    const { pipeline, env } = mod;
    env.allowRemoteModels = true;
    env.useBrowserCache = false;
    _pipe = await withTimeout(
      pipeline("feature-extraction", MODEL, { quantized: true }),
      LOAD_TIMEOUT_MS,
      "model load"
    );
    return _pipe;
  } catch (err) {
    console.error(`pi-memory: embedder unavailable (${err?.message ?? err}), using FTS-only`);
    _failed = true;
    return null;
  }
}
async function embed(text) {
  const pipe = await getPipe();
  if (!pipe) return null;
  try {
    const out = await withTimeout(
      pipe(text.slice(0, TEXT_CHAR_LIMIT), { pooling: "mean", normalize: true }),
      INFER_TIMEOUT_MS,
      "inference"
    );
    return new Float32Array(out.data);
  } catch {
    return null;
  }
}
function similarity(a, b) {
  let dot = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) dot += a[i] * b[i];
  return dot;
}
function fromBlob(b) {
  if (!b) return null;
  const raw = Uint8Array.from(b);
  return new Float32Array(raw.buffer);
}
function withTimeout(p, ms, label) {
  return Promise.race([
    p,
    new Promise(
      (_, reject) => setTimeout(() => reject(new Error(`${label} timeout after ${ms}ms`)), ms)
    )
  ]);
}

// src/injector.ts
import os from "node:os";
var MAX_CONTEXT_CHARS = 8e3;
var SEARCH_LIMIT = 15;
var LESSON_SEARCH_LIMIT = 15;
async function buildContextBlock(store, cwd, prompt, config) {
  if (prompt?.trim()) {
    return buildSelectiveBlock(store, prompt, cwd, config);
  }
  return buildFallbackBlock(store, cwd);
}
async function buildSelectiveBlock(store, prompt, cwd, config) {
  const sections = [];
  let semanticCount = 0;
  let lessonCount = 0;
  const mode = config?.lessonInjection ?? "all";
  const results = store.searchSemantic(prompt, SEARCH_LIMIT);
  const slug = cwd ? projectSlug(cwd) : "";
  if (slug) {
    const projectResults = store.searchSemantic(slug, 5);
    const seen2 = new Set(results.map((r) => r.key));
    for (const r of projectResults) {
      if (!seen2.has(r.key)) {
        results.push(r);
        seen2.add(r.key);
      }
    }
  }
  const filteredResults = slug ? results.filter((r) => {
    if (!r.key.startsWith("project.")) return true;
    const parts = r.key.split(".");
    return parts.length >= 2 && parts[1] === slug;
  }) : results;
  const seen = new Set(filteredResults.map((r) => r.key));
  const SEMANTIC_THRESHOLD = 0.25;
  const SEMANTIC_LIMIT = 8;
  const allEmbs = store.getAllEmbeddings();
  const promptVec = await embed(prompt);
  const semanticKeys = /* @__PURE__ */ new Set();
  if (promptVec) {
    const semanticHits = allEmbs.flatMap(({ key, embedding }) => {
      const vec = fromBlob(embedding);
      if (!vec) return [];
      const score = similarity(promptVec, vec);
      return score >= SEMANTIC_THRESHOLD ? [{ key, score }] : [];
    }).sort((a, b) => b.score - a.score).slice(0, SEMANTIC_LIMIT);
    for (const { key } of semanticHits) {
      semanticKeys.add(key);
      if (!seen.has(key)) {
        const entry = store.getSemantic(key);
        if (entry) {
          filteredResults.push(entry);
          seen.add(key);
        }
      }
    }
    backfillEmbeddings(store, allEmbs.filter((r) => !r.embedding)).catch(() => {
    });
  }
  const expandedPrefixes = /* @__PURE__ */ new Set();
  for (const r of [...filteredResults]) {
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
  if (semanticKeys.size > 0) {
    const semanticPrefixes = /* @__PURE__ */ new Set();
    for (const k of semanticKeys) {
      const p = keyDomainPrefix(k);
      if (p) semanticPrefixes.add(p);
    }
    const isSemanticRelated = (key) => {
      if (semanticKeys.has(key)) return true;
      const p = keyDomainPrefix(key);
      return p ? semanticPrefixes.has(p) : false;
    };
    const priority = filteredResults.filter((r) => isSemanticRelated(r.key));
    const rest = filteredResults.filter((r) => !isSemanticRelated(r.key));
    priority.sort((a, b) => a.key.localeCompare(b.key));
    rest.sort((a, b) => a.key.localeCompare(b.key));
    filteredResults.length = 0;
    filteredResults.push(...priority, ...rest);
  }
  if (filteredResults.length > 0) {
    sections.push(formatSection("Relevant Memory", filteredResults.map(formatSemantic)));
    semanticCount = filteredResults.length;
    store.touchAccessed(filteredResults.map((r) => r.key));
  }
  const lessons = mode === "selective" ? getRelevantLessons(store, prompt, cwd) : store.listLessons(void 0, 50, slug || void 0);
  if (lessons.length > 0) {
    const corrections = lessons.filter((l) => l.negative);
    const positives = lessons.filter((l) => !l.negative);
    if (corrections.length > 0) {
      const formatted = corrections.map(
        (l) => `DON'T: ${l.rule}${l.category !== "general" ? ` [${l.category}]` : ""}`
      );
      sections.push(formatSection("Learned Corrections", formatted));
    }
    if (positives.length > 0) {
      const formatted = positives.map(
        (l) => `${l.rule}${l.category !== "general" ? ` [${l.category}]` : ""}`
      );
      sections.push(formatSection("Validated Approaches", formatted));
    }
    lessonCount = lessons.length;
  }
  if (sections.length === 0) {
    return { text: "", stats: { semantic: 0, lessons: 0 } };
  }
  let text = `<memory>
${sections.join("\n")}

${MEMORY_DRIFT_CAVEAT}
</memory>`;
  if (text.length > MAX_CONTEXT_CHARS) {
    text = text.slice(0, MAX_CONTEXT_CHARS - 20) + "\n... (truncated)\n</memory>";
  }
  return { text, stats: { semantic: semanticCount, lessons: lessonCount } };
}
function getRelevantLessons(store, prompt, cwd) {
  const seen = /* @__PURE__ */ new Set();
  const result = [];
  function add(lessons) {
    for (const l of lessons) {
      if (!seen.has(l.id)) {
        seen.add(l.id);
        result.push(l);
      }
    }
  }
  add(store.searchLessons(prompt, LESSON_SEARCH_LIMIT));
  const slug = cwd ? projectSlug(cwd) : "";
  if (slug) {
    add(store.searchLessons(slug, 5));
  }
  add(store.listLessons("general", 10));
  return result.slice(0, LESSON_SEARCH_LIMIT);
}
function buildFallbackBlock(store, cwd) {
  const sections = [];
  let semanticCount = 0;
  let lessonCount = 0;
  const prefs = store.listSemantic("pref.", 50);
  if (prefs.length > 0) {
    sections.push(formatSection("User Preferences", prefs.map(formatSemantic)));
    semanticCount += prefs.length;
  }
  const projects = store.listSemantic("project.", 50);
  const slug = cwd ? projectSlug(cwd) : "";
  const relevant = slug ? projects.filter((p) => {
    const parts = p.key.split(".");
    return parts.length >= 2 && parts[1] === slug;
  }) : projects;
  if (relevant.length > 0) {
    sections.push(formatSection("Project Context", relevant.map(formatSemantic)));
    semanticCount += relevant.length;
  }
  const tools = store.listSemantic("tool.", 20);
  if (tools.length > 0) {
    sections.push(formatSection("Tool Preferences", tools.map(formatSemantic)));
    semanticCount += tools.length;
  }
  const lessons = store.listLessons(void 0, 50, slug || void 0);
  if (lessons.length > 0) {
    const corrections = lessons.filter((l) => l.negative);
    const positives = lessons.filter((l) => !l.negative);
    if (corrections.length > 0) {
      const formatted = corrections.map(
        (l) => `DON'T: ${l.rule}${l.category !== "general" ? ` [${l.category}]` : ""}`
      );
      sections.push(formatSection("Learned Corrections", formatted));
    }
    if (positives.length > 0) {
      const formatted = positives.map(
        (l) => `${l.rule}${l.category !== "general" ? ` [${l.category}]` : ""}`
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
  let text = `<memory>
${sections.join("\n")}

${MEMORY_DRIFT_CAVEAT}
</memory>`;
  if (text.length > MAX_CONTEXT_CHARS) {
    text = text.slice(0, MAX_CONTEXT_CHARS - 20) + "\n... (truncated)\n</memory>";
  }
  return { text, stats: { semantic: semanticCount, lessons: lessonCount } };
}
var STALE_WARNING_DAYS = 30;
var VERY_STALE_DAYS = 90;
function formatSection(title, items) {
  return `## ${title}
${items.map((i) => `- ${i}`).join("\n")}`;
}
function formatSemantic(entry) {
  const key = entry.key.split(".").slice(1).join(".");
  const ageDays = daysSince(entry.updated_at);
  const staleTag = ageDays >= VERY_STALE_DAYS ? ` \u26A0\uFE0F ${ageDays}d old \u2014 verify before acting on this` : ageDays >= STALE_WARNING_DAYS ? ` (${ageDays}d ago)` : "";
  return `${key}: ${entry.value}${staleTag}`;
}
function daysSince(dateStr) {
  try {
    const then = new Date(dateStr).getTime();
    const now = Date.now();
    return Math.floor((now - then) / (1e3 * 60 * 60 * 24));
  } catch {
    return 0;
  }
}
var MEMORY_DRIFT_CAVEAT = `## Before acting on memory
- Memory records can become stale. If a memory names a file, function, or flag \u2014 verify it still exists before recommending it. "The memory says X exists" is not the same as "X exists now."
- If a recalled memory conflicts with what you observe in the current code or project state, trust what you observe now.
- Memories about project state (deadlines, decisions, architecture) decay fastest \u2014 check if still relevant.`;
function keyDomainPrefix(key) {
  const parts = key.split(".");
  return parts.length >= 3 ? parts.slice(0, 2).join(".") : null;
}
async function backfillEmbeddings(store, missing) {
  if (missing.length === 0) return;
  for (const { key } of missing.slice(0, 10)) {
    const entry = store.getSemantic(key);
    if (!entry) continue;
    const displayKey = key.split(".").slice(1).join(" ");
    const vec = await embed(`${displayKey} ${entry.value}`);
    if (vec) store.setEmbedding(key, vec);
  }
}
function projectSlug(cwd) {
  const parts = cwd.split("/").filter(Boolean);
  const skip = /* @__PURE__ */ new Set(["workplace", "local", "home", "src", "scratch", os.userInfo().username]);
  for (const p of parts.reverse()) {
    if (!skip.has(p.toLowerCase()) && p.length > 1) return p.toLowerCase();
  }
  return "";
}

// src/consolidator.ts
var CONSOLIDATION_PROMPT = `You are a memory extraction system. Analyze this conversation and extract structured knowledge.

Extract ONLY concrete, reusable facts \u2014 not summaries of what happened. Focus on:

1. **User preferences** (key prefix: pref.) \u2014 coding style, tool preferences, workflow habits
   Example: { "key": "pref.commit_style", "value": "conventional commits", "confidence": 0.9 }

2. **Project patterns** (key prefix: project.<name>.) \u2014 languages, frameworks, architecture decisions
   Example: { "key": "project.rosie.di", "value": "Dagger dependency injection", "confidence": 0.95 }

3. **Tool preferences** (key prefix: tool.) \u2014 which tools to prefer/avoid, how to use them
   Example: { "key": "tool.sed", "value": "use for daily note insertion, not echo >>", "confidence": 0.9 }

4. **Corrections/lessons** \u2014 things the user corrected, mistakes to avoid
   Example: { "rule": "Use sed to insert after ## Notes heading, not echo >> which appends after Tags", "category": "vault", "negative": true }

5. **Validated approaches** \u2014 things the user explicitly confirmed worked well (positive signal)
   Example: { "rule": "When deploying wiki changes, draft first and let user preview before publishing", "category": "wiki-edit", "negative": false }

## What NOT to extract \u2014 these are derivable or ephemeral, and pollute memory:

- **Code patterns, architecture, file paths, project structure** \u2014 these can be derived by reading the current project state (grep, git, file reads)
- **Git history, recent changes, who-changed-what** \u2014 git log/blame are authoritative
- **Debugging solutions or fix recipes** \u2014 the fix is in the code; the commit message has context
- **Anything already documented in AGENTS.md, CLAUDE.md, or project config files**
- **Ephemeral task details** \u2014 in-progress work, temporary state, current conversation context
- **Activity summaries** \u2014 "today we worked on X" is not a lasting fact. Instead ask: what was *surprising* or *non-obvious* about it?
- **File contents or code snippets** \u2014 the file itself is the source of truth
- **Exact commands that worked once** \u2014 unless they encode a non-obvious pattern that the agent consistently gets wrong

These exclusions apply even if the user asks to save such things. If asked, extract what was *surprising* or *non-obvious* \u2014 that is the part worth keeping.

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
function buildConsolidationPrompt(input, currentFacts, currentLessons) {
  const messages = [];
  let memorySection = "";
  if (currentFacts && currentFacts.length > 0 || currentLessons && currentLessons.length > 0) {
    const parts = ["## Current Memory State"];
    if (currentFacts && currentFacts.length > 0) {
      parts.push("The user already has these facts stored (avoid duplicating, update if changed):");
      let chars = 0;
      for (const f of currentFacts) {
        const line = `- ${f.key}: ${f.value.length > 120 ? f.value.slice(0, 120) + "\u2026" : f.value}`;
        if (chars + line.length > 1500) {
          parts.push("- ... (truncated)");
          break;
        }
        parts.push(line);
        chars += line.length;
      }
    }
    if (currentLessons && currentLessons.length > 0) {
      parts.push("\nAnd these lessons (avoid duplicating):");
      let chars = 0;
      for (const l of currentLessons) {
        const line = `- [${l.category}] ${l.rule.length > 120 ? l.rule.slice(0, 120) + "\u2026" : l.rule}`;
        if (chars + line.length > 500) {
          parts.push("- ... (truncated)");
          break;
        }
        parts.push(line);
        chars += line.length;
      }
    }
    memorySection = parts.join("\n") + "\n\n";
  }
  const maxPairs = 30;
  const len = Math.min(input.userMessages.length, maxPairs);
  for (let i = 0; i < len; i++) {
    const userMsg = input.userMessages[i];
    if (userMsg) messages.push(`User: ${truncate(userMsg, 1e3)}`);
    const assistantMsg = input.assistantMessages[i];
    if (assistantMsg) messages.push(`Assistant: ${truncate(assistantMsg, 500)}`);
  }
  return `${CONSOLIDATION_PROMPT}

${memorySection}${input.cwd ? `Working directory: ${input.cwd}
` : ""}
## Conversation

${messages.join("\n\n")}`;
}
function parseConsolidationResponse(text) {
  const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/) || text.match(/(\{[\s\S]*\})/);
  if (!jsonMatch) return { semantic: [], lessons: [] };
  try {
    const parsed = JSON.parse(jsonMatch[1].trim());
    const result = { semantic: [], lessons: [] };
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
            negative: !!l.negative
          });
        }
      }
    }
    return result;
  } catch {
    return { semantic: [], lessons: [] };
  }
}
function applyExtracted(store, extracted, source = "consolidation", project) {
  let semanticCount = 0;
  let lessonCount = 0;
  for (const s of extracted.semantic) {
    if (isDerivableOrEphemeral(s.key, s.value)) continue;
    store.setSemantic(s.key, s.value, s.confidence, "consolidation");
    semanticCount++;
  }
  for (const l of extracted.lessons) {
    if (isDerivableLesson(l.rule)) continue;
    const lessonProject = source === "user" ? void 0 : project;
    const result = store.addLesson(l.rule, l.category, source, l.negative, lessonProject);
    if (result.success) lessonCount++;
  }
  return { semantic: semanticCount, lessons: lessonCount };
}
var VALID_KEY_RE = /^[a-z][a-z0-9._-]*$/;
function isValidKey(key) {
  return VALID_KEY_RE.test(key) && key.length <= 100 && key.length >= 2;
}
function isDerivableOrEphemeral(key, value) {
  const kl = key.toLowerCase();
  const vl = value.toLowerCase();
  if (kl.includes("filepath") || kl.includes("file_path") || kl.includes("directory")) return true;
  if (/^project\.\w+\.(path|dir|location|structure|layout|architecture)$/.test(kl)) return true;
  if (kl.includes("commit") || kl.includes("git.history") || kl.includes("git.recent")) return true;
  if (vl.startsWith("today ") || vl.startsWith("we worked on") || vl.startsWith("this session")) return true;
  if (vl.includes("```") && vl.length > 300) return true;
  if (kl.includes("current_task") || kl.includes("in_progress") || kl.includes("investigating")) return true;
  return false;
}
function isDerivableLesson(rule) {
  const rl = rule.toLowerCase();
  if (/file .+ is (at|in|located) /.test(rl)) return true;
  if (/^the (project|codebase|repo) (uses|is written in) /.test(rl)) return true;
  if (/^(we|i|the agent) (fixed|deployed|updated|changed|modified|ran|executed) /.test(rl)) return true;
  if (/^when (encountering|bash fails|edit fails|.*error)/.test(rl) && /\b(run:|fix with:)/.test(rl)) return true;
  if (/^run: /.test(rl)) return true;
  if (rl.includes("command exited with code") && rl.length < 100) return true;
  return false;
}
function truncate(text, max) {
  return text.length > max ? text.slice(0, max) + "\u2026" : text;
}

// src/index.ts
function ok(text) {
  return { content: [{ type: "text", text }], details: {} };
}
function stripQuotes(v) {
  if (typeof v !== "string") return v;
  const s = v.trim();
  if (s.length >= 2) {
    const first = s[0];
    const last = s[s.length - 1];
    if (first === '"' && last === '"' || first === "'" && last === "'") {
      try {
        if (first === '"') return JSON.parse(s);
      } catch {
      }
      return s.slice(1, -1);
    }
  }
  return v;
}
var DEFAULT_MEMORY_DIR = join(homedir(), ".pi", "memory");
var DEFAULT_DB_PATH = join(DEFAULT_MEMORY_DIR, "memory.db");
var GLOBAL_SETTINGS_PATH = join(homedir(), ".pi", "agent", "settings.json");
var DEFAULT_CONSOLIDATION_MODEL = "claude-sonnet-4-20250514";
function warnUnknownKeys(block, blockName, knownKeys) {
  if (!block || typeof block !== "object") return;
  const unknown = Object.keys(block).filter((k) => !knownKeys.includes(k));
  if (unknown.length === 0) return;
  console.error(
    `pi-memory: ignoring unknown key(s) in settings.json "${blockName}" block: ${unknown.join(", ")} (expected: ${knownKeys.join(", ")})`
  );
}
var PI_MEMORY_KNOWN_KEYS = ["localPath", "lessonInjection", "consolidationModel", "perTurnInjection", "injectionMode"];
var PI_TOTAL_RECALL_KNOWN_KEYS = ["localPath"];
function resolveDbPath(cwd) {
  try {
    const localSettingsPath = join(cwd, ".pi", "settings.json");
    const raw = readFileSync(localSettingsPath, "utf-8");
    const settings = JSON.parse(raw);
    const piMemory = settings?.["pi-memory"];
    warnUnknownKeys(piMemory, "pi-memory", PI_MEMORY_KNOWN_KEYS);
    if (piMemory && typeof piMemory === "object" && typeof piMemory.localPath === "string" && piMemory.localPath) {
      return resolve(cwd, piMemory.localPath, "memory.db");
    }
    const piTotalRecall = settings?.["pi-total-recall"];
    warnUnknownKeys(piTotalRecall, "pi-total-recall", PI_TOTAL_RECALL_KNOWN_KEYS);
    if (piTotalRecall && typeof piTotalRecall === "object" && typeof piTotalRecall.localPath === "string" && piTotalRecall.localPath) {
      return resolve(cwd, piTotalRecall.localPath, "memory", "memory.db");
    }
  } catch {
  }
  return DEFAULT_DB_PATH;
}
function mergeMemorySettings(config, memorySettings) {
  if (!memorySettings || typeof memorySettings !== "object") return;
  const m = memorySettings;
  if (m.lessonInjection === "all" || m.lessonInjection === "selective") {
    config.lessonInjection = m.lessonInjection;
  }
  if (typeof m.perTurnInjection === "boolean") {
    config.perTurnInjection = m.perTurnInjection;
  }
  if (m.injectionMode === "system-prompt" || m.injectionMode === "context-hook") {
    config.injectionMode = m.injectionMode;
  }
  if (typeof m.consolidationModel === "string" && m.consolidationModel.trim()) {
    config.consolidationModel = m.consolidationModel.trim();
  }
}
function readSettingsConfig(cwd) {
  const config = {};
  try {
    const raw = readFileSync(GLOBAL_SETTINGS_PATH, "utf-8");
    const settings = JSON.parse(raw);
    mergeMemorySettings(config, settings?.memory);
  } catch {
  }
  if (cwd) {
    try {
      const raw = readFileSync(join(cwd, ".pi", "settings.json"), "utf-8");
      const settings = JSON.parse(raw);
      mergeMemorySettings(config, settings?.memory ?? settings?.["pi-memory"]);
    } catch {
    }
  }
  return config;
}
function index_default(pi) {
  let store = null;
  let pendingUserMessages = [];
  let pendingAssistantMessages = [];
  let sessionCwd = "";
  let sessionId;
  let cachedCtx = null;
  let resolvedDbPath = DEFAULT_DB_PATH;
  let injectorConfig = readSettingsConfig();
  let pendingContextBlock = null;
  pi.on("session_start", async (_event, ctx) => {
    try {
      sessionCwd = ctx.cwd;
      cachedCtx = ctx;
      sessionId = ctx.sessionId ?? ctx.session?.id;
      resolvedDbPath = resolveDbPath(sessionCwd);
      injectorConfig = readSettingsConfig(sessionCwd);
      store = new MemoryStore(resolvedDbPath);
      pendingUserMessages = [];
      pendingAssistantMessages = [];
      try {
        const branch = ctx.sessionManager.getBranch();
        for (const entry of branch) {
          if (entry.type !== "message") continue;
          const msg = entry.message;
          if (!msg) continue;
          if (msg.role === "user") {
            const text = extractText(msg.content);
            if (text) pendingUserMessages.push(text);
          } else if (msg.role === "assistant") {
            const text = extractText(msg.content);
            if (text) pendingAssistantMessages.push(text);
          }
        }
      } catch {
      }
      const stats = store.stats();
      if (stats.semantic + stats.lessons > 0) {
        ctx.ui.setStatus("pi-memory", `Memory: ${stats.semantic} facts, ${stats.lessons} lessons`);
        setTimeout(() => {
          try {
            ctx.ui.setStatus("pi-memory", "");
          } catch {
          }
        }, 5e3);
      }
      if (injectorConfig.perTurnInjection === false) {
        try {
          const alreadyInjected = ctx.sessionManager.getEntries().some(
            (e) => e.type === "custom_message" && e.customType === "pi-memory-context"
          );
          if (!alreadyInjected) {
            const { text, stats: injStats } = await buildContextBlock(
              store,
              sessionCwd,
              void 0,
              // no prompt → fallback: dump all relevant memory
              injectorConfig
            );
            if (text) {
              pi.sendMessage({
                customType: "pi-memory-context",
                content: text,
                display: false,
                details: injStats
              });
            }
          }
        } catch {
        }
      }
    } catch (err) {
      ctx.ui.notify(`pi-memory: failed to open store: ${err.message}`, "warning");
    }
  });
  pi.on("before_agent_start", async (event, ctx) => {
    if (!store) return;
    if (injectorConfig.perTurnInjection === false) return;
    const { text } = await buildContextBlock(store, ctx.cwd, event.prompt, injectorConfig);
    const mode = injectorConfig.injectionMode ?? "context-hook";
    if (mode === "system-prompt") {
      pendingContextBlock = null;
      if (!text) return;
      return { systemPrompt: `${event.systemPrompt}

${text}` };
    }
    pendingContextBlock = text || null;
    return;
  });
  pi.on("context", async (event, _ctx) => {
    if (!store) return;
    if (injectorConfig.perTurnInjection === false) return;
    if ((injectorConfig.injectionMode ?? "context-hook") !== "context-hook") return;
    if (!pendingContextBlock) return;
    const msgs = event.messages;
    if (!msgs || msgs.length === 0) return;
    let idx = -1;
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === "user") {
        idx = i;
        break;
      }
    }
    if (idx === -1) return;
    const recallMessage = {
      role: "user",
      content: pendingContextBlock,
      timestamp: Date.now()
    };
    return { messages: [...msgs.slice(0, idx), recallMessage, ...msgs.slice(idx)] };
  });
  pi.on("agent_end", async (event, _ctx) => {
    for (const msg of event.messages) {
      if (msg.role === "user" && "content" in msg) {
        const text = extractText(msg.content);
        if (text) {
          pendingUserMessages.push(text);
          if (pendingUserMessages.length > 60) pendingUserMessages.shift();
        }
      } else if (msg.role === "assistant" && "content" in msg) {
        const text = extractText(msg.content);
        if (text) {
          pendingAssistantMessages.push(text);
          if (pendingAssistantMessages.length > 60) pendingAssistantMessages.shift();
        }
      }
    }
  });
  pi.on("session_before_switch", async (_event, ctx) => {
    if (!store) return;
    if (pendingUserMessages.length >= 3) {
      ctx.ui.setStatus("pi-memory", "\u{1F9E0} Consolidating memory...");
      try {
        await consolidateSession();
      } catch {
      } finally {
        try {
          ctx.ui.setStatus("pi-memory", "");
        } catch {
        }
      }
    }
    pendingUserMessages = [];
    pendingAssistantMessages = [];
  });
  pi.on("session_shutdown", async () => {
    if (!store) return;
    try {
      if (cachedCtx && pendingUserMessages.length >= 3) {
        cachedCtx.ui.setStatus("pi-memory", "\u{1F9E0} Consolidating memory...");
      }
      if (pendingUserMessages.length >= 3) {
        try {
          await consolidateSession();
        } catch {
        }
      }
    } finally {
      if (cachedCtx) {
        try {
          cachedCtx.ui.setStatus("pi-memory", "");
        } catch {
        }
      }
      store.close();
      store = null;
    }
  });
  async function consolidateSession() {
    if (!store) return;
    const input = {
      userMessages: pendingUserMessages,
      assistantMessages: pendingAssistantMessages,
      cwd: sessionCwd,
      sessionId
    };
    const currentFacts = store.listSemantic(void 0, 200).map((f) => ({ key: f.key, value: f.value }));
    const currentLessons = store.listLessons(void 0, 100).map((l) => ({ rule: l.rule, category: l.category }));
    const prompt = buildConsolidationPrompt(input, currentFacts, currentLessons);
    const EXEC_TIMEOUT_MS = 45e3;
    const HARD_TIMEOUT_MS = 6e4;
    let backstopHandle;
    try {
      const execPromise = pi.exec("pi", [
        "-p",
        prompt,
        "--print",
        "--no-extensions",
        "--no-tools",
        "--no-session",
        "--model",
        injectorConfig.consolidationModel ?? DEFAULT_CONSOLIDATION_MODEL
      ], {
        timeout: EXEC_TIMEOUT_MS,
        cwd: sessionCwd
      });
      const result = await Promise.race([
        execPromise,
        new Promise((_, reject) => {
          backstopHandle = setTimeout(
            () => reject(new Error("consolidation backstop timeout")),
            HARD_TIMEOUT_MS
          );
        })
      ]);
      if (result.code === 0 && result.stdout) {
        const extracted = parseConsolidationResponse(result.stdout);
        const slug = sessionCwd ? projectSlug(sessionCwd) : void 0;
        const applied = applyExtracted(store, extracted, `session:${sessionId ?? "unknown"}`, slug || void 0);
        if (applied.semantic + applied.lessons > 0) {
          console.error(`pi-memory: consolidated ${applied.semantic} facts, ${applied.lessons} lessons`);
        }
      }
    } catch {
    } finally {
      if (backstopHandle) clearTimeout(backstopHandle);
    }
  }
  pi.registerTool({
    name: "memory_search",
    label: "Memory Search",
    description: "Search persistent memory for facts, preferences, and project patterns the user has established across sessions.",
    parameters: Type.Object({
      query: Type.String({ description: "Search query" }),
      limit: Type.Optional(Type.Number({ description: "Max results (default 10)" }))
    }),
    async execute(_id, params, _signal, _update, _ctx) {
      if (!store) return ok("Memory store not initialized");
      const searchParams = params;
      const results = store.searchSemantic(searchParams.query, searchParams.limit ?? 10);
      if (results.length === 0) {
        return ok("No matching memories found.");
      }
      const text = results.map(
        (r) => `${r.key}: ${r.value} (confidence: ${r.confidence}, source: ${r.source})`
      ).join("\n");
      return ok(text);
    }
  });
  pi.registerTool({
    name: "memory_remember",
    label: "Memory Remember",
    description: "Store a fact, preference, or lesson in persistent memory. Use dotted keys like pref.editor, project.rosie.lang, tool.sed.usage. For corrections, use type='lesson'.",
    parameters: Type.Object({
      type: Type.String({ description: "'fact' for key-value, 'lesson' for a correction" }),
      key: Type.Optional(Type.String({ description: "Dotted key for facts (e.g. pref.commit_style)" })),
      value: Type.Optional(Type.String({ description: "Value for facts" })),
      rule: Type.Optional(Type.String({ description: "Rule text for lessons" })),
      category: Type.Optional(Type.String({ description: "Category for lessons (default: general)" })),
      negative: Type.Optional(Type.Boolean({ description: "True if this is something to AVOID" }))
    }),
    async execute(_id, params, _signal, _update, _ctx) {
      if (!store) return ok("Memory store not initialized");
      const input = params;
      const rememberParams = {
        ...input,
        type: stripQuotes(input.type),
        key: stripQuotes(input.key),
        value: stripQuotes(input.value),
        rule: stripQuotes(input.rule),
        category: stripQuotes(input.category)
      };
      if (rememberParams.type !== "fact" && rememberParams.type !== "lesson") {
        return ok(`Invalid type: ${rememberParams.type}. Must be 'fact' or 'lesson'.`);
      }
      if (rememberParams.type === "fact") {
        if (!rememberParams.key || !rememberParams.value) {
          return ok("Both key and value required for facts");
        }
        store.setSemantic(rememberParams.key, rememberParams.value, 0.95, "user");
        const _key = rememberParams.key;
        const _val = rememberParams.value;
        embed(`${_key.split(".").slice(1).join(" ")} ${_val}`).then((vec) => {
          if (vec) store.setEmbedding(_key, vec);
        }).catch(() => {
        });
        return ok(`Remembered: ${rememberParams.key} = ${rememberParams.value}`);
      }
      if (rememberParams.type === "lesson") {
        if (!rememberParams.rule) {
          return ok("Rule text required for lessons");
        }
        const result = store.addLesson(rememberParams.rule, rememberParams.category ?? "general", "user", rememberParams.negative ?? false);
        if (result.success) {
          return ok(`Lesson learned: ${rememberParams.rule}`);
        }
        return ok(`Already known (${result.reason}): ${rememberParams.rule}`);
      }
      return ok("Unknown type");
    }
  });
  pi.registerTool({
    name: "memory_forget",
    label: "Memory Forget",
    description: "Remove a fact or lesson from persistent memory.",
    parameters: Type.Object({
      type: Type.String(),
      key: Type.Optional(Type.String({ description: "Key for facts" })),
      id: Type.Optional(Type.String({ description: "ID for lessons" }))
    }),
    async execute(_id, params, _signal, _update, _ctx) {
      if (!store) return ok("Memory store not initialized");
      const input = params;
      const forgetParams = {
        ...input,
        type: stripQuotes(input.type),
        key: stripQuotes(input.key),
        id: stripQuotes(input.id)
      };
      if (forgetParams.type !== "fact" && forgetParams.type !== "lesson") {
        return ok(`Invalid type: ${forgetParams.type}. Must be 'fact' or 'lesson'.`);
      }
      if (forgetParams.type === "fact" && forgetParams.key) {
        const deleted = store.deleteSemantic(forgetParams.key);
        return ok(deleted ? `Forgot: ${forgetParams.key}` : `Not found: ${forgetParams.key}`);
      }
      if (forgetParams.type === "lesson" && forgetParams.id) {
        const deleted = store.deleteLesson(forgetParams.id);
        return ok(deleted ? `Forgot lesson ${forgetParams.id}` : `Not found: ${forgetParams.id}`);
      }
      return ok("Provide key (for facts) or id (for lessons)");
    }
  });
  pi.registerTool({
    name: "memory_lessons",
    label: "Memory Lessons",
    description: "List learned corrections and lessons from past sessions.",
    parameters: Type.Object({
      category: Type.Optional(Type.String({ description: "Filter by category" })),
      limit: Type.Optional(Type.Number({ description: "Max results (default 50)" }))
    }),
    async execute(_id, params, _signal, _update, _ctx) {
      if (!store) return ok("Memory store not initialized");
      const lessonsParams = params;
      const lessons = store.listLessons(lessonsParams.category, lessonsParams.limit ?? 50);
      if (lessons.length === 0) {
        return ok("No lessons learned yet.");
      }
      const text = lessons.map(
        (l) => `${l.negative ? "\u274C" : "\u2705"} [${l.category}] ${l.rule} (id: ${l.id.slice(0, 8)})`
      ).join("\n");
      return ok(text);
    }
  });
  pi.registerTool({
    name: "memory_stats",
    label: "Memory Stats",
    description: "Show memory statistics \u2014 how many facts, lessons, and events are stored.",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _update, _ctx) {
      if (!store) return ok("Memory store not initialized");
      const stats = store.stats();
      const text = `Memory: ${stats.semantic} semantic facts, ${stats.lessons} active lessons, ${stats.events} events logged
DB: ${resolvedDbPath}`;
      return ok(text);
    }
  });
  pi.registerCommand("memory-consolidate", {
    description: "Manually trigger memory consolidation for the current session",
    async handler(_args, ctx) {
      if (!store) {
        ctx.ui.notify("Memory store not initialized", "warning");
        return;
      }
      if (pendingUserMessages.length < 2) {
        ctx.ui.notify("Not enough conversation to consolidate (need at least 2 user messages)", "warning");
        return;
      }
      ctx.ui.notify("Consolidating session memory...", "info");
      try {
        await consolidateSession();
        const stats = store.stats();
        ctx.ui.notify(`Memory updated: ${stats.semantic} facts, ${stats.lessons} lessons`, "info");
      } catch (err) {
        ctx.ui.notify(`Consolidation failed: ${err.message}`, "error");
      }
    }
  });
}
function extractText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.filter((c) => c.type === "text" && typeof c.text === "string").map((c) => c.text).join("\n");
  }
  return "";
}
export {
  DEFAULT_CONSOLIDATION_MODEL,
  MemoryStore,
  buildContextBlock,
  index_default as default,
  projectSlug,
  readSettingsConfig,
  resolveDbPath
};
//# sourceMappingURL=index.js.map
