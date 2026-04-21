import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MemoryStore } from "./store.js";
import { buildContextBlock } from "./injector.js";

describe("buildContextBlock", () => {
  let store: MemoryStore;
  let tmpDir: string;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pi-memory-injector-test-"));
    store = new MemoryStore(join(tmpDir, "test.db"));
  });

  after(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns empty for empty store", () => {
    const { text, stats } = buildContextBlock(store);
    assert.equal(text, "");
    assert.equal(stats.semantic, 0);
    assert.equal(stats.lessons, 0);
  });

  it("includes preferences in fallback mode (no prompt)", () => {
    store.setSemantic("pref.editor", "vim", 0.9, "user");
    const { text, stats } = buildContextBlock(store);
    assert.ok(text.includes("User Preferences"));
    assert.ok(text.includes("editor: vim"));
    assert.ok(stats.semantic > 0);
  });

  it("includes lessons with DON'T prefix for negative", () => {
    store.addLesson("Use sed for daily notes", "vault", "user", true);
    const { text } = buildContextBlock(store);
    assert.ok(text.includes("Learned Corrections"));
    assert.ok(text.includes("DON'T:"));
  });

  it("wraps in <memory> tags", () => {
    const { text } = buildContextBlock(store);
    assert.ok(text.startsWith("<memory>"));
    assert.ok(text.endsWith("</memory>"));
  });

  it("scopes project context to cwd in fallback mode", () => {
    store.setSemantic("project.rosie.lang", "java", 0.9, "consolidation");
    store.setSemantic("project.other.lang", "python", 0.5, "consolidation");

    const { text } = buildContextBlock(store, "/workplace/samfp/Rosie");
    assert.ok(text.includes("rosie.lang"));
    assert.ok(!text.includes("other.lang"));
  });

  // ─── Selective injection tests ───────────────────────────────────

  it("selective: searches by prompt and returns relevant entries", () => {
    store.setSemantic("pref.commit_style", "conventional commits", 0.9, "user");
    store.setSemantic("project.rosie.di", "Dagger dependency injection", 0.95, "consolidation");
    store.setSemantic("tool.sed", "use for daily note insertion", 0.9, "consolidation");

    const { text, stats } = buildContextBlock(store, undefined, "how do I make commits");
    assert.ok(text.includes("Relevant Memory"));
    assert.ok(text.includes("commit"));
    assert.ok(stats.semantic > 0);
  });

  it("selective: always includes lessons regardless of prompt", () => {
    const { text } = buildContextBlock(store, undefined, "something totally unrelated xyz");
    assert.ok(text.includes("Learned Corrections"));
    assert.ok(text.includes("DON'T:"));
  });

  it("selective: filters lessons by relevance when config is selective", () => {
    // Add lessons in different categories
    store.addLesson("Always verify exploit PoC before submission", "bug-bounty", "user", false);
    store.addLesson("Use conventional commits for all projects", "general", "user", false);
    store.addLesson("Never fabricate competitor claims in blog posts", "writing", "user", true);

    // With selective mode and a bug bounty prompt, should get bug-bounty + general lessons
    const { text: bbText } = buildContextBlock(store, undefined, "run a pentest on the target", { lessonInjection: "selective" });
    assert.ok(bbText.includes("verify exploit"), "should include bug-bounty lesson for pentest prompt");
    assert.ok(bbText.includes("conventional commits"), "should include general lessons");

    // With selective mode and a writing prompt, should get writing + general lessons
    const { text: writeText } = buildContextBlock(store, undefined, "write a blog post about testing", { lessonInjection: "selective" });
    assert.ok(writeText.includes("fabricate"), "should include writing lesson for blog prompt");
    assert.ok(writeText.includes("conventional commits"), "should include general lessons");
  });

  it("selective: mode 'all' still includes all lessons", () => {
    const { text } = buildContextBlock(store, undefined, "something totally unrelated xyz", { lessonInjection: "all" });
    assert.ok(text.includes("Learned Corrections"));
    assert.ok(text.includes("DON'T:"));
  });

  it("selective: includes project context when cwd matches", () => {
    const { text } = buildContextBlock(store, "/workplace/samfp/Rosie", "how do I build");
    // Should find rosie entries via project slug search
    assert.ok(text.includes("rosie"));
  });

  it("selective: returns only lessons when prompt matches nothing", () => {
    const { text, stats } = buildContextBlock(store, undefined, "zzzzqqqq xyzzy nonsense");
    // No semantic hits, but lessons should still be there
    assert.ok(text.includes("Learned Corrections"));
    assert.equal(stats.semantic, 0);
    assert.ok(stats.lessons > 0);
  });
});
