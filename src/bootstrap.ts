#!/usr/bin/env npx tsx
/**
 * Bootstrap pi-memory from existing session-search index.
 * 
 * Reads session summaries, batches them, and runs LLM consolidation
 * to extract preferences, patterns, and lessons from past sessions.
 *
 * Usage: npx tsx src/bootstrap.ts [--dry-run] [--limit N] [--batch-size N]
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import { MemoryStore } from "./store.js";
import { parseConsolidationResponse, applyExtracted, CONSOLIDATION_PROMPT } from "./consolidator.js";

const INDEX_PATH = join(homedir(), ".pi", "session-search", "index", "session-index.json");
const DB_PATH = join(homedir(), ".pi", "memory", "memory.db");

interface IndexedSession {
  session: {
    file: string;
    id: string;
    cwd: string;
    startedAt: string;
    name?: string;
    userMessages: string[];
    assistantText: string;
    compactionSummaries: string[];
    branchSummaries: string[];
  };
  summary: string;
}

// ─── Parse args ──────────────────────────────────────────────────────

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const limitIdx = args.indexOf("--limit");
const limit = limitIdx >= 0 ? parseInt(args[limitIdx + 1], 10) : Infinity;
const batchIdx = args.indexOf("--batch-size");
const batchSize = batchIdx >= 0 ? parseInt(args[batchIdx + 1], 10) : 15;

// ─── Load sessions ───────────────────────────────────────────────────

console.log(`Loading session index from ${INDEX_PATH}...`);
const indexData = JSON.parse(readFileSync(INDEX_PATH, "utf8"));
const sessions: IndexedSession[] = Object.values(indexData.sessions);

// Sort by date (newest first) and take limit
sessions.sort((a, b) => b.session.startedAt.localeCompare(a.session.startedAt));
const selected = sessions.slice(0, limit);

console.log(`Found ${sessions.length} sessions, processing ${selected.length}`);

// ─── Build batches of summaries ──────────────────────────────────────

const batches: string[][] = [];
for (let i = 0; i < selected.length; i += batchSize) {
  const batch = selected.slice(i, i + batchSize).map(s => {
    const parts: string[] = [];
    if (s.session.name) parts.push(`Session: ${s.session.name}`);
    parts.push(`CWD: ${s.session.cwd}`);
    parts.push(`Date: ${s.session.startedAt.slice(0, 10)}`);
    if (s.summary) parts.push(`Summary: ${s.summary.slice(0, 500)}`);
    // Include compaction summaries — they're rich with context
    for (const cs of (s.session.compactionSummaries || []).slice(0, 2)) {
      parts.push(`Context: ${cs.slice(0, 500)}`);
    }
    return parts.join("\n");
  });
  batches.push(batch);
}

console.log(`Created ${batches.length} batches of ~${batchSize} sessions each`);

// ─── Process batches ─────────────────────────────────────────────────

const store = dryRun ? null : new MemoryStore(DB_PATH);
let totalSemantic = 0;
let totalLessons = 0;

for (let i = 0; i < batches.length; i++) {
  const batch = batches[i];
  console.log(`\nBatch ${i + 1}/${batches.length} (${batch.length} sessions)...`);

  const prompt = `${CONSOLIDATION_PROMPT}

You are analyzing summaries from ${batch.length} past coding sessions. Extract any recurring preferences, project patterns, tool usage habits, and corrections you can identify.

Focus on patterns that appear across multiple sessions — these are more likely to be lasting preferences.

## Session Summaries

${batch.map((s, j) => `### Session ${j + 1}\n${s}`).join("\n\n")}`;

  if (dryRun) {
    console.log(`  [dry-run] Would send ${prompt.length} chars to LLM`);
    continue;
  }

  try {
    // Pass the prompt as an argv entry rather than interpolating into a shell
    // string — session summaries are arbitrary past-project content (READMEs,
    // file snippets, MCP tool output), so skipping the shell avoids any quoting
    // pitfalls. Matches the runtime path in index.ts which uses pi.exec(argv).
    const result = execFileSync(
      "pi",
      ["-p", prompt, "--print"],
      { encoding: "utf8", timeout: 120_000, cwd: homedir(), maxBuffer: 1024 * 1024 }
    );

    const extracted = parseConsolidationResponse(result);
    console.log(`  Extracted: ${extracted.semantic.length} facts, ${extracted.lessons.length} lessons`);

    if (extracted.semantic.length + extracted.lessons.length > 0) {
      const applied = applyExtracted(store!, extracted, `bootstrap:batch-${i + 1}`);
      totalSemantic += applied.semantic;
      totalLessons += applied.lessons;
      console.log(`  Applied: ${applied.semantic} new facts, ${applied.lessons} new lessons`);
    }

    // Brief pause between batches to avoid rate limiting
    if (i < batches.length - 1) {
      await new Promise(r => setTimeout(r, 2000));
    }
  } catch (err: any) {
    console.error(`  Error: ${err.message?.slice(0, 200)}`);
  }
}

// ─── Summary ─────────────────────────────────────────────────────────

if (store) {
  const stats = store.stats();
  console.log(`\n✅ Bootstrap complete!`);
  console.log(`   Added: ${totalSemantic} semantic facts, ${totalLessons} lessons`);
  console.log(`   Total: ${stats.semantic} facts, ${stats.lessons} lessons, ${stats.events} events`);
  console.log(`   DB: ${DB_PATH}`);
  store.close();
} else {
  console.log(`\n[dry-run] Would have processed ${batches.length} batches`);
}
