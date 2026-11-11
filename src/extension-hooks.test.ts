/**
 * Drives the extension through its registered hooks and tools with a stub
 * ExtensionAPI, so behaviour is checked end-to-end rather than per helper.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// pi-memory reads ~/.pi/agent/settings.json; point HOME at an empty dir so a
// developer's real config (e.g. a live embedding provider) cannot leak in.
// node --test runs each file in its own process, so this stays local.
const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-memory-home-"));
process.env.HOME = fakeHome;
process.env.USERPROFILE = fakeHome;
const { default: piMemory } = await import("./index.js");

type Api = Parameters<typeof piMemory>[0];
type Handler = (event: unknown, ctx: unknown) => unknown;
type Tool = { execute: (...args: unknown[]) => Promise<{ content: { text: string }[] }> };

function createHarness(memorySettings: Record<string, unknown>) {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "pi-memory-hooks-"));
  fs.mkdirSync(path.join(project, ".pi"), { recursive: true });
  fs.writeFileSync(
    path.join(project, ".pi", "settings.json"),
    JSON.stringify({ "pi-memory": { localPath: path.join(project, "memory") }, memory: memorySettings }),
  );

  const handlers = new Map<string, Handler>();
  const tools = new Map<string, Tool>();
  const notifications: { text: string; level?: string }[] = [];
  const statuses: string[] = [];
  const sent: { customType?: string; content?: string }[] = [];
  const execCalls: unknown[][] = [];
  const contextEntries: unknown[] = [];
  const pi = {
    on: (name: string, h: Handler) => void handlers.set(name, h),
    registerTool: (t: Tool & { name: string }) => void tools.set(t.name, t),
    registerCommand() {},
    sendMessage: (m: { customType?: string; content?: string }) => void sent.push(m),
    exec: async (...args: unknown[]) => {
      execCalls.push(args);
      return { code: 0, stdout: '{"semantic":[],"lessons":[]}' };
    },
  };
  piMemory(pi as unknown as Api);

  const ctx = {
    cwd: project,
    hasUI: true,
    ui: {
      setStatus: (_key: string, value: string) => void statuses.push(value),
      notify: (text: string, level?: string) => void notifications.push({ text, level }),
    },
    sessionManager: { getBranch: () => [], getEntries: () => [], buildContextEntries: () => contextEntries },
  };

  const call = async (tool: string, params: Record<string, unknown>) =>
    (await tools.get(tool)!.execute("id", params, undefined, undefined, ctx)).content[0]!.text;

  return {
    ctx,
    handlers,
    notifications,
    statuses,
    sent,
    execCalls,
    contextEntries,
    call,
    async cleanup() {
      await handlers.get("session_shutdown")?.({}, ctx);
      fs.rmSync(project, { recursive: true, force: true });
    },
  };
}

async function withoutEnv<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const saved = process.env[name];
  delete process.env[name];
  try {
    return await fn();
  } finally {
    if (saved !== undefined) process.env[name] = saved;
  }
}

describe("embedding failures are surfaced, not silent (#30)", () => {
  it("notifies once with cause and fix, and keyword search keeps working", async () => {
    await withoutEnv("OPENAI_API_KEY", async () => {
      const h = createHarness({ embedding: { type: "openai" } });
      try {
        await h.handlers.get("session_start")!({}, h.ctx);

        assert.equal(h.notifications.length, 1);
        const [note] = h.notifications;
        assert.equal(note!.level, "warning");
        assert.match(note!.text, /semantic search unavailable: no API key is configured for openai embeddings/);
        assert.match(note!.text, /OPENAI_API_KEY/);
        assert.match(note!.text, /Keyword search still works/);

        await h.call("memory_remember", { type: "fact", key: "pref.editor", value: "nvim with lazy.nvim" });
        assert.match(await h.call("memory_search", { query: "editor" }), /pref\.editor: nvim with lazy\.nvim/);
        assert.match(await h.call("memory_stats", {}), /Semantic search is failing: no API key/);
        assert.equal(h.notifications.length, 1, "same cause must not be re-notified");
      } finally {
        await h.cleanup();
      }
    });
  });

  it("reports a provider that fails at query time and still returns lexical hits", async () => {
    // Loopback port 9 refuses connections immediately; no network needed.
    const h = createHarness({ embedding: { type: "ollama", url: "http://127.0.0.1:9" } });
    try {
      await h.handlers.get("session_start")!({}, h.ctx);
      assert.equal(h.notifications.length, 0, "nothing to embed yet, nothing to report");

      await h.call("memory_remember", { type: "fact", key: "tool.jq.usage", value: "prefer jq over python for JSON" });
      assert.match(await h.call("memory_search", { query: "jq" }), /tool\.jq\.usage/);

      assert.equal(h.notifications.length, 1);
      assert.match(h.notifications[0]!.text, /Ollama is not reachable at http:\/\/127\.0\.0\.1:9/);
      assert.match(h.notifications[0]!.text, /ollama serve/);
    } finally {
      await h.cleanup();
    }
  });
});

describe("per-turn injection through the hooks", () => {
  async function seeded(memorySettings: Record<string, unknown>) {
    const h = createHarness(memorySettings);
    await h.handlers.get("session_start")!({}, h.ctx);
    await h.call("memory_remember", { type: "fact", key: "pref.editor", value: "neovim editor with lazy.nvim" });
    return h;
  }

  type Recall = { message: { customType: string; content: string; display: boolean; details: { semantic: string[]; lessons: string[] } } };

  const ask = (h: Awaited<ReturnType<typeof seeded>>, prompt: string | undefined) =>
    h.handlers.get("before_agent_start")!({ prompt, systemPrompt: "SYS" }, h.ctx) as Promise<Recall | undefined>;

  const persist = (h: Awaited<ReturnType<typeof seeded>>, recall: Recall) =>
    h.contextEntries.push({ type: "custom_message", customType: recall.message.customType, details: recall.message.details });

  it("default: persists memory as a hidden session message and leaves history and system prompt alone", async () => {
    const h = await seeded({});
    try {
      const recall = (await ask(h, "which editor do I use?"))!;
      assert.equal((recall as { systemPrompt?: string }).systemPrompt, undefined, "system prompt must not be modified");
      assert.equal(recall.message.customType, "pi-memory-recall");
      assert.equal(recall.message.display, false);
      assert.match(recall.message.content, /^<memory>/);
      assert.match(recall.message.content, /editor: neovim editor with lazy\.nvim/);
      assert.equal(recall.message.details.semantic.length, 1);
      assert.equal(h.handlers.get("context"), undefined, "earlier turns must never be rewritten");
    } finally {
      await h.cleanup();
    }
  });

  it("skips memory the session context already holds and re-injects it once it changes or leaves the context", async () => {
    const h = await seeded({});
    try {
      persist(h, (await ask(h, "which editor do I use?"))!);
      assert.equal(await ask(h, "which editor do I use?"), undefined, "nothing new to recall");

      await h.call("memory_remember", { type: "fact", key: "pref.editor", value: "helix editor" });
      const changed = (await ask(h, "which editor do I use?"))!;
      assert.match(changed.message.content, /editor: helix editor/);

      h.contextEntries.length = 0;
      assert.match((await ask(h, "which editor do I use?"))!.message.content, /editor: helix editor/, "compacted away, so recall again");
    } finally {
      await h.cleanup();
    }
  });

  it("injects nothing for runs started by a custom message", async () => {
    const h = await seeded({});
    try {
      assert.equal(await ask(h, undefined), undefined);
    } finally {
      await h.cleanup();
    }
  });

  it("injects nothing when no memory matches", async () => {
    const h = createHarness({});
    try {
      await h.handlers.get("session_start")!({}, h.ctx);
      assert.equal(await h.handlers.get("before_agent_start")!({ prompt: "unrelated", systemPrompt: "SYS" }, h.ctx), undefined);
    } finally {
      await h.cleanup();
    }
  });

  it('treats the retired "context-hook" setting as the default', async () => {
    const h = await seeded({ injectionMode: "context-hook" });
    try {
      assert.equal((await ask(h, "which editor do I use?"))!.message.customType, "pi-memory-recall");
    } finally {
      await h.cleanup();
    }
  });

  it("system-prompt mode appends to the system prompt and adds no message", async () => {
    const h = await seeded({ injectionMode: "system-prompt" });
    try {
      const start = (await h.handlers.get("before_agent_start")!(
        { prompt: "which editor do I use?", systemPrompt: "SYS" },
        h.ctx,
      )) as { systemPrompt: string };
      assert.match(start.systemPrompt, /^SYS\n\n<memory>/);
      assert.match(start.systemPrompt, /editor: neovim editor with lazy\.nvim/);
      assert.equal((start as { message?: unknown }).message, undefined);
    } finally {
      await h.cleanup();
    }
  });

  it("perTurnInjection: false injects once at session_start instead", async (t) => {
    // session_start with a non-empty store arms a 5s status-clear timer.
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const h = createHarness({ perTurnInjection: false });
    try {
      await h.handlers.get("session_start")!({}, h.ctx);
      await h.call("memory_remember", { type: "fact", key: "pref.editor", value: "neovim editor" });
      // A later session over the same store gets the one-shot dump.
      await h.handlers.get("session_start")!({}, h.ctx);
      assert.equal(h.sent.filter((m) => m.customType === "pi-memory-context").length, 1);
      assert.equal(
        await h.handlers.get("before_agent_start")!({ prompt: "editor", systemPrompt: "SYS" }, h.ctx),
        undefined,
      );
    } finally {
      await h.cleanup();
    }
  });
});

describe("consolidation status", () => {
  it("session_before_switch consolidates and always clears the status", async () => {
    const h = createHarness({ consolidationModel: "test/model" });
    try {
      await h.handlers.get("session_start")!({}, h.ctx);
      await h.handlers.get("agent_end")!(
        {
          messages: ["one", "two", "three"].flatMap((n) => [
            { role: "user", content: `remember preference ${n}` },
            { role: "assistant", content: "ok" },
          ]),
        },
        h.ctx,
      );
      await h.handlers.get("session_before_switch")!({}, h.ctx);
      assert.deepEqual(h.statuses.slice(-2), ["🧠 Consolidating memory...", ""]);
      assert.equal(h.execCalls.length, 1);
      assert.ok((h.execCalls[0]![1] as string[]).includes("test/model"));

      // Queue was reset, so shutdown has nothing left to consolidate.
      await h.handlers.get("session_shutdown")!({}, h.ctx);
      assert.equal(h.execCalls.length, 1);
    } finally {
      await h.cleanup();
    }
  });
});
