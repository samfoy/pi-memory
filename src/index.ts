/**
 * pi-memory — Persistent memory extension for pi.
 *
 * Learns corrections, preferences, and patterns from sessions.
 * Injects relevant memory into future conversations.
 *
 * Lifecycle:
 * - session_start: open store, inject memory into status
 * - before_agent_start: inject memory context into system prompt
 * - agent_end: queue messages for consolidation
 * - session_shutdown: consolidate and close store
 *
 * Tools:
 * - memory_search: search semantic memory
 * - memory_remember: manually add a memory
 * - memory_forget: delete a memory
 * - memory_lessons: list learned corrections
 * - memory_stats: show memory statistics
 */
import type { ExtensionAPI, AgentToolResult } from "@mariozechner/pi-coding-agent";
import { Type, type TSchema } from "@sinclair/typebox";
import { join } from "node:path";
import { homedir } from "node:os";
import { readFileSync } from "node:fs";
import { MemoryStore } from "./store.js";
import { buildContextBlock, type InjectorConfig } from "./injector.js";

type ToolResult = AgentToolResult<unknown>;
function ok(text: string): ToolResult { return { content: [{ type: "text", text }], details: {} }; }
import {
  buildConsolidationPrompt,
  parseConsolidationResponse,
  applyExtracted,
  type ConsolidationInput,
} from "./consolidator.js";

const MEMORY_DIR = join(homedir(), ".pi", "memory");
const DB_PATH = join(MEMORY_DIR, "memory.db");
const GLOBAL_SETTINGS_PATH = join(homedir(), ".pi", "agent", "settings.json");

/**
 * Read pi-memory config from settings.json.
 * Looks for a "memory" key with extension-specific settings.
 *
 * Example settings.json:
 * {
 *   "memory": {
 *     "lessonInjection": "selective"
 *   }
 * }
 */
function readSettingsConfig(): InjectorConfig {
  try {
    const raw = readFileSync(GLOBAL_SETTINGS_PATH, "utf-8");
    const settings = JSON.parse(raw);
    const memorySettings = settings?.memory;
    if (!memorySettings || typeof memorySettings !== "object") return {};

    const config: InjectorConfig = {};
    if (memorySettings.lessonInjection === "all" || memorySettings.lessonInjection === "selective") {
      config.lessonInjection = memorySettings.lessonInjection;
    }
    return config;
  } catch {
    return {};
  }
}

export default function (pi: ExtensionAPI) {
  let store: MemoryStore | null = null;
  let pendingUserMessages: string[] = [];
  let pendingAssistantMessages: string[] = [];
  let sessionCwd: string = "";
  let sessionId: string | undefined;
  let cachedCtx: any = null;
  let injectorConfig: InjectorConfig = readSettingsConfig();

  // ─── Lifecycle ───────────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    try {
      store = new MemoryStore(DB_PATH);
      sessionCwd = ctx.cwd;
      cachedCtx = ctx;
      sessionId = (ctx as any).sessionId ?? (ctx as any).session?.id;

      const stats = store.stats();
      if (stats.semantic + stats.lessons > 0) {
        ctx.ui.setStatus("pi-memory", `Memory: ${stats.semantic} facts, ${stats.lessons} lessons`);
        setTimeout(() => ctx.ui.setStatus("pi-memory", ""), 5000);
      }
    } catch (err: any) {
      ctx.ui.notify(`pi-memory: failed to open store: ${err.message}`, "warning");
    }
  });

  pi.on("before_agent_start", async (event, ctx) => {
    if (!store) return;

    const { text } = buildContextBlock(store, ctx.cwd, event.prompt, injectorConfig);
    if (!text) return;

    return {
      systemPrompt: `${event.systemPrompt}\n\n${text}`,
    };
  });

  pi.on("agent_end", async (event, _ctx) => {
    // Collect messages for consolidation at shutdown
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

  // Consolidate memory when switching sessions (/new, /resume)
  pi.on("session_before_switch", async (_event, ctx) => {
    if (!store) return;

    if (pendingUserMessages.length >= 3) {
      ctx.ui.setStatus("pi-memory", "🧠 Consolidating memory...");
      try {
        await consolidateSession();
      } catch {
        // Best-effort
      }
      ctx.ui.setStatus("pi-memory", "");
    }

    // Reset for the next session
    pendingUserMessages = [];
    pendingAssistantMessages = [];
  });

  pi.on("session_shutdown", async () => {
    if (!store) return;

    // Immediate visual feedback — user sees this as soon as C-c C-c fires
    if (cachedCtx) {
      cachedCtx.ui.setStatus("pi-memory", "🧠 Consolidating memory...");
    }

    // Consolidate if we have enough conversation
    if (pendingUserMessages.length >= 3) {
      try {
        await consolidateSession();
      } catch {
        // Best-effort — don't crash on shutdown
      }
    }

    store.close();
    store = null;
  });

  // ─── Consolidation ──────────────────────────────────────────────

  async function consolidateSession(): Promise<void> {
    if (!store) return;

    const input: ConsolidationInput = {
      userMessages: pendingUserMessages,
      assistantMessages: pendingAssistantMessages,
      cwd: sessionCwd,
      sessionId,
    };

    const currentFacts = store.listSemantic(undefined, 200).map(f => ({ key: f.key, value: f.value }));
    const currentLessons = store.listLessons(undefined, 100).map(l => ({ rule: l.rule, category: l.category }));
    const prompt = buildConsolidationPrompt(input, currentFacts, currentLessons);

    // Use pi's exec to call the LLM via a lightweight pi session.
    // Use a fast model to avoid blocking shutdown for too long.
    try {
      const result = await pi.exec("pi", [
        "-p", prompt,
        "--print",
        "--no-extensions",
        "--model", "claude-sonnet-4-20250514",
      ], {
        timeout: 45_000,
        cwd: sessionCwd,
      });

      if (result.code === 0 && result.stdout) {
        const extracted = parseConsolidationResponse(result.stdout);
        const applied = applyExtracted(store!, extracted, `session:${sessionId ?? "unknown"}`);
        if (applied.semantic + applied.lessons > 0) {
          // Log but don't notify — we're shutting down
          console.error(`pi-memory: consolidated ${applied.semantic} facts, ${applied.lessons} lessons`);
        }
      }
    } catch {
      // Timeout or exec failure — skip consolidation this session
    }
  }

  // ─── Tools ──────────────────────────────────────────────────────

  pi.registerTool({
    name: "memory_search",
    label: "Memory Search",
    description: "Search persistent memory for facts, preferences, and project patterns the user has established across sessions.",
    parameters: Type.Object({
      query: Type.String({ description: "Search query" }),
      limit: Type.Optional(Type.Number({ description: "Max results (default 10)" })),
    }) as any,
    async execute(_id, params, _signal, _update, _ctx) {
      if (!store) return ok("Memory store not initialized");

      const results = store.searchSemantic(params.query, params.limit ?? 10);
      if (results.length === 0) {
        return ok("No matching memories found.");
      }

      const text = results.map(r =>
        `${r.key}: ${r.value} (confidence: ${r.confidence}, source: ${r.source})`
      ).join("\n");

      return ok(text);
    },
  });

  pi.registerTool({
    name: "memory_remember",
    label: "Memory Remember",
    description: "Store a fact, preference, or lesson in persistent memory. Use dotted keys like pref.editor, project.rosie.lang, tool.sed.usage. For corrections, use type='lesson'.",
    parameters: Type.Object({
      type: Type.Union([Type.Literal("fact"), Type.Literal("lesson")], { description: "'fact' for key-value, 'lesson' for a correction" }),
      key: Type.Optional(Type.String({ description: "Dotted key for facts (e.g. pref.commit_style)" })),
      value: Type.Optional(Type.String({ description: "Value for facts" })),
      rule: Type.Optional(Type.String({ description: "Rule text for lessons" })),
      category: Type.Optional(Type.String({ description: "Category for lessons (default: general)" })),
      negative: Type.Optional(Type.Boolean({ description: "True if this is something to AVOID" })),
    }) as any,
    async execute(_id, params, _signal, _update, _ctx) {
      if (!store) return ok("Memory store not initialized");

      if (params.type === "fact") {
        if (!params.key || !params.value) {
          return ok("Both key and value required for facts");
        }
        store.setSemantic(params.key, params.value, 0.95, "user");
        return ok(`Remembered: ${params.key} = ${params.value}`);
      }

      if (params.type === "lesson") {
        if (!params.rule) {
          return ok("Rule text required for lessons");
        }
        const result = store.addLesson(params.rule, params.category ?? "general", "user", params.negative ?? false);
        if (result.success) {
          return ok(`Lesson learned: ${params.rule}`);
        }
        return ok(`Already known (${result.reason}): ${params.rule}`);
      }

      return ok("Unknown type");
    },
  });

  pi.registerTool({
    name: "memory_forget",
    label: "Memory Forget",
    description: "Remove a fact or lesson from persistent memory.",
    parameters: Type.Object({
      type: Type.Union([Type.Literal("fact"), Type.Literal("lesson")]),
      key: Type.Optional(Type.String({ description: "Key for facts" })),
      id: Type.Optional(Type.String({ description: "ID for lessons" })),
    }) as any,
    async execute(_id, params, _signal, _update, _ctx) {
      if (!store) return ok("Memory store not initialized");

      if (params.type === "fact" && params.key) {
        const deleted = store.deleteSemantic(params.key);
        return ok(deleted ? `Forgot: ${params.key}` : `Not found: ${params.key}`);
      }

      if (params.type === "lesson" && params.id) {
        const deleted = store.deleteLesson(params.id);
        return ok(deleted ? `Forgot lesson ${params.id}` : `Not found: ${params.id}`);
      }

      return ok("Provide key (for facts) or id (for lessons)");
    },
  });

  pi.registerTool({
    name: "memory_lessons",
    label: "Memory Lessons",
    description: "List learned corrections and lessons from past sessions.",
    parameters: Type.Object({
      category: Type.Optional(Type.String({ description: "Filter by category" })),
      limit: Type.Optional(Type.Number({ description: "Max results (default 50)" })),
    }) as any,
    async execute(_id, params, _signal, _update, _ctx) {
      if (!store) return ok("Memory store not initialized");

      const lessons = store.listLessons(params.category, params.limit ?? 50);
      if (lessons.length === 0) {
        return ok("No lessons learned yet.");
      }

      const text = lessons.map(l =>
        `${l.negative ? "❌" : "✅"} [${l.category}] ${l.rule} (id: ${l.id.slice(0, 8)})`
      ).join("\n");

      return ok(text);
    },
  });

  pi.registerTool({
    name: "memory_stats",
    label: "Memory Stats",
    description: "Show memory statistics — how many facts, lessons, and events are stored.",
    parameters: Type.Object({}) as any,
    async execute(_id, _params, _signal, _update, _ctx) {
      if (!store) return ok("Memory store not initialized");

      const stats = store.stats();
      const text = `Memory: ${stats.semantic} semantic facts, ${stats.lessons} active lessons, ${stats.events} events logged\nDB: ${DB_PATH}`;
      return ok(text);
    },
  });

  // ─── Commands ──────────────────────────────────────────────────

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
      } catch (err: any) {
        ctx.ui.notify(`Consolidation failed: ${err.message}`, "error");
      }
    },
  });
}

// ─── Helpers ─────────────────────────────────────────────────────────

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((c: any) => c.type === "text" && typeof c.text === "string")
      .map((c: any) => c.text)
      .join("\n");
  }
  return "";
}
