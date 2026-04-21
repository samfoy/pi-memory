/**
 * SQLite-backed memory store using Node's built-in node:sqlite.
 * Three tables:
 * - semantic: key-value facts (preferences, project patterns, corrections)
 * - lessons: learned corrections with dedup
 * - events: audit log of all memory operations
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";

// ─── Types ───────────────────────────────────────────────────────────

export interface SemanticEntry {
  key: string;
  value: string;
  confidence: number;
  source: "user" | "consolidation" | "correction";
  created_at: string;
  updated_at: string;
  last_accessed?: string;
}

export interface LessonEntry {
  id: string;
  rule: string;
  category: string;
  source: string;
  negative: boolean;
  created_at: string;
}

export interface MemoryEvent {
  id: number;
  event_type: string;
  memory_type: string;
  memory_key: string;
  details: string;
  created_at: string;
}

// ─── Store ───────────────────────────────────────────────────────────

export class MemoryStore {
  private db: DatabaseSync;
  private writeLock: Promise<void> = Promise.resolve();
  private hasFTS5: boolean = false;

  constructor(dbPath: string) {
    const dir = dirname(dbPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.migrate();
  }

  private migrate(): void {
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

    // Migration: add last_accessed column if missing
    try {
      this.db.exec(`ALTER TABLE semantic ADD COLUMN last_accessed TEXT`);
    } catch {
      // Column already exists — ignore
    }

    // FTS5 virtual tables for semantic + lesson search (optional — node:sqlite may lack FTS5)
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

      // Rebuild FTS indexes from existing data (idempotent)
      this.db.exec(`INSERT INTO semantic_fts(semantic_fts) VALUES('rebuild')`);
      this.db.exec(`INSERT INTO lessons_fts(lessons_fts) VALUES('rebuild')`);
      this.hasFTS5 = true;
    } catch {
      // FTS5 not available (node:sqlite compiled without SQLITE_ENABLE_FTS5).
      // Search will use substring fallback — fine for typical memory store sizes.
      this.hasFTS5 = false;
    }
  }

  /**
   * Serialize async callers so concurrent read-modify-write cycles
   * (e.g. two consolidation calls) don't clobber each other.
   */
  private withLock<T>(fn: () => T): T {
    // DatabaseSync is synchronous, so we just need to ensure
    // transactional integrity. Wrap in a SQLite transaction.
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

  getSemantic(key: string): SemanticEntry | undefined {
    const normalized = key.toLowerCase();
    return this.db.prepare("SELECT * FROM semantic WHERE key = ?").get(normalized) as unknown as SemanticEntry | undefined;
  }

  setSemantic(key: string, value: string, confidence: number = 0.8, source: SemanticEntry["source"] = "consolidation"): void {
    const normalized = key.toLowerCase();
    this.withLock(() => {
      const existing = this.db.prepare("SELECT * FROM semantic WHERE key = ?").get(normalized) as unknown as SemanticEntry | undefined;
      if (existing && existing.confidence > confidence) return; // higher confidence wins

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

  deleteSemantic(key: string): boolean {
    const normalized = key.toLowerCase();
    return this.withLock(() => {
      const result = this.db.prepare("DELETE FROM semantic WHERE key = ?").run(normalized);
      if (result.changes > 0) this.logEvent("delete", "semantic", normalized);
      return result.changes > 0;
    });
  }

  listSemantic(prefix?: string, limit: number = 100): SemanticEntry[] {
    if (prefix) {
      return this.db.prepare("SELECT * FROM semantic WHERE key LIKE ? ORDER BY updated_at DESC LIMIT ?")
        .all(`${prefix}%`, limit) as unknown as SemanticEntry[];
    }
    return this.db.prepare("SELECT * FROM semantic ORDER BY updated_at DESC LIMIT ?")
      .all(limit) as unknown as SemanticEntry[];
  }

  searchSemantic(query: string, limit: number = 10): SemanticEntry[] {
    const terms = query.trim().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return [];

    if (!this.hasFTS5) return this._searchSemanticFallback(query, limit);

    // Build FTS5 query — quote each term for safety
    const ftsQuery = terms.map(t => `"${t.replace(/"/g, '""')}"`).join(" OR ");

    try {
      const rows = this.db.prepare(`
        SELECT s.key, s.value, s.confidence, s.source, s.created_at, s.updated_at, s.last_accessed
        FROM semantic s
        JOIN semantic_fts fts ON s.rowid = fts.rowid
        WHERE semantic_fts MATCH ?
        ORDER BY bm25(semantic_fts)
        LIMIT ?
      `).all(ftsQuery, limit) as unknown as SemanticEntry[];

      return rows;
    } catch {
      // FTS query failed — fall back to substring matching
      return this._searchSemanticFallback(query, limit);
    }
  }

  private _searchSemanticFallback(query: string, limit: number): SemanticEntry[] {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return [];

    const all = this.db.prepare("SELECT * FROM semantic").all() as unknown as SemanticEntry[];
    return all
      .map(entry => {
        const text = `${entry.key} ${entry.value}`.toLowerCase();
        const matches = terms.filter(t => text.includes(t)).length;
        return { entry, score: matches / terms.length };
      })
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ entry }) => entry);
  }

  touchAccessed(keys: string[]): void {
    if (keys.length === 0) return;
    const stmt = this.db.prepare("UPDATE semantic SET last_accessed = datetime('now') WHERE key = ?");
    for (const key of keys) {
      stmt.run(key.toLowerCase());
    }
  }

  // ─── Lessons ─────────────────────────────────────────────────────

  addLesson(rule: string, category: string = "general", source: string = "consolidation", negative: boolean = false): { success: boolean; id?: string; reason?: string } {
    const trimmed = rule.trim();
    if (!trimmed) return { success: false, reason: "empty rule" };

    const normalizedCategory = category.trim().toLowerCase() || "general";

    return this.withLock(() => {
      // Exact-match dedup (case-insensitive)
      const existing = this.db.prepare(
        "SELECT id FROM lessons WHERE LOWER(TRIM(rule)) = LOWER(?) AND is_deleted = 0"
      ).get(trimmed.toLowerCase()) as { id: string } | undefined;
      if (existing) return { success: false as const, reason: "duplicate" as const, id: existing.id };

      // Jaccard dedup
      const allRules = this.db.prepare("SELECT id, rule FROM lessons WHERE is_deleted = 0").all() as { id: string; rule: string }[];
      for (const r of allRules) {
        if (jaccard(trimmed, r.rule) >= 0.7) {
          return { success: false as const, reason: "similar" as const, id: r.id };
        }
      }

      const id = crypto.randomUUID();
      this.db.prepare(
        "INSERT INTO lessons (id, rule, category, source, negative) VALUES (?, ?, ?, ?, ?)"
      ).run(id, trimmed, normalizedCategory, source, negative ? 1 : 0);

      this.logEvent("create", "lesson", id, trimmed.slice(0, 100));
      return { success: true as const, id };
    });
  }

  getLesson(id: string): LessonEntry | undefined {
    const row = this.db.prepare("SELECT * FROM lessons WHERE id = ? AND is_deleted = 0").get(id) as any;
    if (!row) return undefined;
    return { ...row, negative: !!row.negative };
  }

  listLessons(category?: string, limit: number = 50): LessonEntry[] {
    let rows: any[];
    if (category) {
      const normalizedCategory = category.trim().toLowerCase();
      rows = this.db.prepare("SELECT * FROM lessons WHERE category = ? AND is_deleted = 0 ORDER BY created_at DESC LIMIT ?")
        .all(normalizedCategory, limit);
    } else {
      rows = this.db.prepare("SELECT * FROM lessons WHERE is_deleted = 0 ORDER BY created_at DESC LIMIT ?")
        .all(limit);
    }
    return rows.map(r => ({ ...r, negative: !!r.negative }));
  }

  /**
   * Search lessons by relevance to a query. Uses FTS5 when available,
   * falls back to substring matching. Returns lessons ranked by relevance.
   */
  searchLessons(query: string, limit: number = 20): LessonEntry[] {
    const terms = query.trim().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return [];

    if (!this.hasFTS5) return this._searchLessonsFallback(query, limit);

    const ftsQuery = terms.map(t => `"${t.replace(/"/g, '""')}"`).join(" OR ");

    try {
      const rows = this.db.prepare(`
        SELECT l.id, l.rule, l.category, l.source, l.negative, l.created_at
        FROM lessons l
        JOIN lessons_fts fts ON l.rowid = fts.rowid
        WHERE lessons_fts MATCH ? AND l.is_deleted = 0
        ORDER BY bm25(lessons_fts)
        LIMIT ?
      `).all(ftsQuery, limit) as any[];

      return rows.map(r => ({ ...r, negative: !!r.negative }));
    } catch {
      return this._searchLessonsFallback(query, limit);
    }
  }

  private _searchLessonsFallback(query: string, limit: number): LessonEntry[] {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return [];

    const all = this.db.prepare("SELECT * FROM lessons WHERE is_deleted = 0").all() as any[];
    return all
      .map(entry => {
        const text = `${entry.rule} ${entry.category}`.toLowerCase();
        const matches = terms.filter(t => text.includes(t)).length;
        return { entry: { ...entry, negative: !!entry.negative } as LessonEntry, score: matches / terms.length };
      })
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ entry }) => entry);
  }

  deleteLesson(id: string): boolean {
    return this.withLock(() => {
      // Support both full UUIDs and prefix matches (e.g. first 8 chars)
      let result = this.db.prepare("UPDATE lessons SET is_deleted = 1 WHERE id = ? AND is_deleted = 0").run(id);
      if (result.changes === 0 && id.length < 36) {
        // Try prefix match — ensure it's unambiguous
        const matches = this.db.prepare("SELECT id FROM lessons WHERE id LIKE ? AND is_deleted = 0").all(`${id}%`) as { id: string }[];
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

  private logEvent(eventType: string, memoryType: string, key: string, details: string = ""): void {
    this.db.prepare(
      "INSERT INTO events (event_type, memory_type, memory_key, details) VALUES (?, ?, ?, ?)"
    ).run(eventType, memoryType, key, details);
  }

  listEvents(limit: number = 50): MemoryEvent[] {
    return this.db.prepare("SELECT * FROM events ORDER BY id DESC LIMIT ?").all(limit) as unknown as MemoryEvent[];
  }

  // ─── Stats ───────────────────────────────────────────────────────

  stats(): { semantic: number; lessons: number; events: number } {
    const semantic = (this.db.prepare("SELECT COUNT(*) as c FROM semantic").get() as any).c;
    const lessons = (this.db.prepare("SELECT COUNT(*) as c FROM lessons WHERE is_deleted = 0").get() as any).c;
    const events = (this.db.prepare("SELECT COUNT(*) as c FROM events").get() as any).c;
    return { semantic, lessons, events };
  }

  close(): void {
    this.db.close();
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────

function jaccard(a: string, b: string): number {
  const setA = new Set(a.toLowerCase().split(/\s+/).filter(Boolean));
  const setB = new Set(b.toLowerCase().split(/\s+/).filter(Boolean));
  if (setA.size === 0 && setB.size === 0) return 1;
  const intersection = new Set([...setA].filter(x => setB.has(x)));
  const union = new Set([...setA, ...setB]);
  return intersection.size / union.size;
}
