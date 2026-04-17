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

  constructor(dbPath: string) {
    const dir = dirname(dbPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
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
  }

  // ─── Semantic ────────────────────────────────────────────────────

  getSemantic(key: string): SemanticEntry | undefined {
    return this.db.prepare("SELECT * FROM semantic WHERE key = ?").get(key) as unknown as SemanticEntry | undefined;
  }

  setSemantic(key: string, value: string, confidence: number = 0.8, source: SemanticEntry["source"] = "consolidation"): void {
    const existing = this.getSemantic(key);
    if (existing && existing.confidence > confidence) return; // higher confidence wins

    this.db.prepare(`
      INSERT INTO semantic (key, value, confidence, source, updated_at)
      VALUES (?, ?, ?, ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        confidence = excluded.confidence,
        source = excluded.source,
        updated_at = datetime('now')
    `).run(key, value, confidence, source);

    this.logEvent(existing ? "update" : "create", "semantic", key);
  }

  deleteSemantic(key: string): boolean {
    const result = this.db.prepare("DELETE FROM semantic WHERE key = ?").run(key);
    if (result.changes > 0) this.logEvent("delete", "semantic", key);
    return result.changes > 0;
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
    // Keyword search — match against key and value
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

  // ─── Lessons ─────────────────────────────────────────────────────

  addLesson(rule: string, category: string = "general", source: string = "consolidation", negative: boolean = false): { success: boolean; id?: string; reason?: string } {
    const trimmed = rule.trim();
    if (!trimmed) return { success: false, reason: "empty rule" };

    // Exact-match dedup (case-insensitive)
    const existing = this.db.prepare(
      "SELECT id FROM lessons WHERE LOWER(TRIM(rule)) = LOWER(?) AND is_deleted = 0"
    ).get(trimmed.toLowerCase()) as { id: string } | undefined;
    if (existing) return { success: false, reason: "duplicate", id: existing.id };

    // Jaccard dedup
    const allRules = this.db.prepare("SELECT id, rule FROM lessons WHERE is_deleted = 0").all() as { id: string; rule: string }[];
    for (const r of allRules) {
      if (jaccard(trimmed, r.rule) >= 0.7) {
        return { success: false, reason: "similar", id: r.id };
      }
    }

    const id = crypto.randomUUID();
    this.db.prepare(
      "INSERT INTO lessons (id, rule, category, source, negative) VALUES (?, ?, ?, ?, ?)"
    ).run(id, trimmed, category, source, negative ? 1 : 0);

    this.logEvent("create", "lesson", id, trimmed.slice(0, 100));
    return { success: true, id };
  }

  getLesson(id: string): LessonEntry | undefined {
    const row = this.db.prepare("SELECT * FROM lessons WHERE id = ? AND is_deleted = 0").get(id) as any;
    if (!row) return undefined;
    return { ...row, negative: !!row.negative };
  }

  listLessons(category?: string, limit: number = 50): LessonEntry[] {
    let rows: any[];
    if (category) {
      rows = this.db.prepare("SELECT * FROM lessons WHERE category = ? AND is_deleted = 0 ORDER BY created_at DESC LIMIT ?")
        .all(category, limit);
    } else {
      rows = this.db.prepare("SELECT * FROM lessons WHERE is_deleted = 0 ORDER BY created_at DESC LIMIT ?")
        .all(limit);
    }
    return rows.map(r => ({ ...r, negative: !!r.negative }));
  }

  deleteLesson(id: string): boolean {
    const result = this.db.prepare("UPDATE lessons SET is_deleted = 1 WHERE id = ? AND is_deleted = 0").run(id);
    if (result.changes > 0) this.logEvent("delete", "lesson", id);
    return result.changes > 0;
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
