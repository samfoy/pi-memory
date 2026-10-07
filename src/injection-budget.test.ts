import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MemoryStore } from "./store.js";
import { buildContextBlock } from "./injector.js";

describe("memory injection budget", () => {
  let store: MemoryStore;
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pi-memory-budget-"));
    store = new MemoryStore(join(dir, "test.db"));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  for (const mode of ["selective", "fallback"] as const) {
    const prompt = mode === "selective" ? "budgetprobe" : undefined;

    it(`${mode}: keeps a complete lesson when facts exceed the budget`, async () => {
      for (let i = 0; i < 15; i++) {
        store.setSemantic(`pref.budget_${i}`, `budgetprobe FACT_${i} ${"x".repeat(700)} END_${i}`, 0.9, "user");
      }
      const rule = "Check the budgetprobe deployment target before publishing changes.";
      store.addLesson(rule, "general", "user", true);

      const { text, stats } = await buildContextBlock(store, undefined, prompt);
      assert.ok(text.length <= 8000);
      assert.ok(text.startsWith("<memory>\n"));
      assert.ok(text.endsWith("</memory>"));
      assert.ok(text.includes(`DON'T: ${rule}`));
      assert.ok(text.includes("## Before acting on memory"));
      assert.ok(text.includes("entries omitted"));
      assert.equal(stats.lessons, 1);
      let included = 0;
      for (const entry of store.listSemantic()) {
        if (text.includes(entry.value)) included++;
        else assert.ok(!text.includes(`- ${entry.key.slice(5)}:`), "omitted facts must not appear partially");
      }
      assert.equal(stats.semantic, included);
      assert.ok(included > 0 && included < 15);
    });

    it(`${mode}: skips an oversized entry without losing smaller entries`, async () => {
      store.setSemantic("pref.oversized", `budgetprobe ${"x".repeat(10000)} OVERSIZED_END`, 0.9, "user");
      store.setSemantic("pref.small", "budgetprobe SMALL_COMPLETE_VALUE", 0.9, "user");
      const { text, stats } = await buildContextBlock(store, undefined, prompt);
      assert.ok(text.length <= 8000);
      assert.ok(!text.includes("- oversized:"));
      assert.ok(text.includes("small: budgetprobe SMALL_COMPLETE_VALUE"));
      assert.ok(text.includes("entries omitted"));
      assert.deepEqual(stats, { semantic: 1, lessons: 0 });
    });

    it(`${mode}: counts only complete lessons when one lesson is oversized`, async () => {
      store.addLesson(`budgetprobe ${"oversized ".repeat(1000)} LESSON_END`, "general", "user", true);
      const rule = "Verify the budgetprobe environment before running a deployment.";
      store.addLesson(rule, "general", "user");
      const { text, stats } = await buildContextBlock(store, undefined, prompt);
      assert.ok(text.length <= 8000);
      assert.ok(!text.includes("oversized"));
      assert.ok(text.includes(rule));
      assert.ok(text.includes("entries omitted"));
      assert.deepEqual(stats, { semantic: 0, lessons: 1 });
    });
  }

  it("selective: only touches facts actually included in the block", async () => {
    store.setSemantic("pref.oversized", `budgetprobe ${"x".repeat(10000)}`, 0.9, "user");
    store.setSemantic("pref.small", "budgetprobe complete small fact", 0.9, "user");
    const touched: string[] = [];
    const touch = store.touchAccessed.bind(store);
    store.touchAccessed = keys => { touched.push(...keys); touch(keys); };
    await buildContextBlock(store, undefined, "budgetprobe");
    assert.deepEqual(touched, ["pref.small"]);
  });

  it("reports omission without slicing a single oversized Unicode fact", async () => {
    store.setSemantic("pref.unicode", `budgetprobe ${"🧭".repeat(3900)} COMPLETE_END`, 0.9, "user");
    const { text, stats } = await buildContextBlock(store, undefined, "budgetprobe");
    assert.ok(text.length <= 8000);
    assert.ok(!text.includes("- unicode:"));
    assert.ok(!text.includes("🧭"));
    assert.ok(text.includes("entries omitted"));
    assert.ok(text.includes("## Before acting on memory"));
    assert.ok(text.endsWith("</memory>"));
    assert.deepEqual(stats, { semantic: 0, lessons: 0 });
  });

  it("uses the full budget when every entry fits exactly", async () => {
    const value = "budgetprobe complete small fact";
    store.setSemantic("pref.small", value, 0.9, "user");
    const initial = await buildContextBlock(store, undefined, "budgetprobe");
    const exact = value + "x".repeat(8000 - initial.text.length);
    store.setSemantic("pref.small", exact, 0.9, "user");
    const { text, stats } = await buildContextBlock(store, undefined, "budgetprobe");
    assert.equal(text.length, 8000);
    assert.ok(text.includes(exact));
    assert.ok(!text.includes("omitted"));
    assert.deepEqual(stats, { semantic: 1, lessons: 0 });

    store.setSemantic("pref.small", exact + "x", 0.9, "user");
    const over = await buildContextBlock(store, undefined, "budgetprobe");
    assert.ok(over.text.length <= 8000);
    assert.ok(over.text.includes("entries omitted"));
    assert.ok(!over.text.includes("- small:"));
    assert.equal(over.stats.semantic, 0);
  });

  it("keeps normal blocks unchanged and does not add an omission notice", async () => {
    store.setSemantic("pref.small", "budgetprobe complete small fact", 0.9, "user");
    const { text, stats } = await buildContextBlock(store, undefined, "budgetprobe");
    assert.ok(text.startsWith("<memory>\n## Relevant Memory\n- small: budgetprobe complete small fact\n\n## Before acting on memory"));
    assert.ok(!text.includes("omitted"));
    assert.deepEqual(stats, { semantic: 1, lessons: 0 });
  });
});
