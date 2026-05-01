import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

type Params = Record<string, string | number>;
type Translate = (key: string, fallback: string, params?: Params) => string;

let translate: Translate = (_key, fallback, params) => format(fallback, params);
function format(text: string, params?: Params): string {
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (_m, key: string) => String(params[key] ?? `{${key}}`));
}
export function t(key: string, fallback: string, params?: Params): string { return translate(key, fallback, params); }

const bundles = [
  { locale: "ja", namespace: "pi-memory", messages: {
    "status.stats": "Memory: {facts} facts, {lessons} lessons",
    "status.consolidating": "🧠 Memory を統合中...",
    "error.openStore": "pi-memory: store を開けませんでした: {error}",
    "tool.search.label": "Memory Search",
    "tool.search.description": "セッションをまたいでユーザーが確立した事実、好み、プロジェクトパターンを persistent memory から検索します。",
    "tool.remember.label": "Memory Remember",
    "tool.remember.description": "事実、好み、lesson を persistent memory に保存します。pref.editor、project.rosie.lang、tool.sed.usage のような dotted key を使ってください。修正事項には type='lesson' を使います。",
    "tool.forget.label": "Memory Forget",
    "tool.forget.description": "persistent memory から fact または lesson を削除します。",
    "tool.lessons.label": "Memory Lessons",
    "tool.lessons.description": "過去セッションから学習した修正事項と lesson を一覧表示します。",
    "tool.stats.label": "Memory Stats",
    "tool.stats.description": "保存されている facts、lessons、events の数を表示します。",
    "cmd.consolidate.description": "現在のセッションの memory consolidation を手動実行します",
    "cmd.notInitialized": "Memory store が初期化されていません",
    "cmd.notEnough": "統合するには会話が少なすぎます（少なくとも2つの user message が必要）",
    "cmd.consolidating": "Session memory を統合中...",
    "cmd.updated": "Memory updated: {facts} facts, {lessons} lessons",
    "cmd.failed": "Consolidation failed: {error}",
    "result.forgot": "Forgot: {key}", "result.notFound": "Not found: {key}", "result.forgotLesson": "Forgot lesson {id}", "result.notFoundLesson": "Not found: {id}",
  }},
  { locale: "zh-TW", namespace: "pi-memory", messages: {
    "status.stats": "Memory: {facts} facts, {lessons} lessons",
    "status.consolidating": "🧠 正在整合 memory...",
    "error.openStore": "pi-memory: 無法開啟 store: {error}",
    "tool.search.label": "Memory Search",
    "tool.search.description": "搜尋使用者跨 session 建立的事實、偏好與專案模式。",
    "tool.remember.label": "Memory Remember",
    "tool.remember.description": "將事實、偏好或 lesson 存入 persistent memory。請使用 pref.editor、project.rosie.lang、tool.sed.usage 這類 dotted key。修正事項請使用 type='lesson'。",
    "tool.forget.label": "Memory Forget",
    "tool.forget.description": "從 persistent memory 移除 fact 或 lesson。",
    "tool.lessons.label": "Memory Lessons",
    "tool.lessons.description": "列出過去 session 學到的修正事項與 lessons。",
    "tool.stats.label": "Memory Stats",
    "tool.stats.description": "顯示已儲存 facts、lessons、events 的數量。",
    "cmd.consolidate.description": "手動觸發目前 session 的 memory consolidation",
    "cmd.notInitialized": "Memory store 尚未初始化",
    "cmd.notEnough": "對話不足，無法整合（至少需要 2 則 user message）",
    "cmd.consolidating": "正在整合 session memory...",
    "cmd.updated": "Memory updated: {facts} facts, {lessons} lessons",
    "cmd.failed": "Consolidation failed: {error}",
    "result.forgot": "Forgot: {key}", "result.notFound": "Not found: {key}", "result.forgotLesson": "Forgot lesson {id}", "result.notFoundLesson": "Not found: {id}",
  }},
  { locale: "de", namespace: "pi-memory", messages: {
    "status.stats": "Memory: {facts} facts, {lessons} lessons",
    "status.consolidating": "🧠 Memory wird konsolidiert...",
    "error.openStore": "pi-memory: Store konnte nicht geöffnet werden: {error}",
    "tool.search.label": "Memory Search",
    "tool.search.description": "Persistent Memory nach Fakten, Präferenzen und Projektmustern durchsuchen, die der Nutzer über Sessions hinweg etabliert hat.",
    "tool.remember.label": "Memory Remember",
    "tool.remember.description": "Fakt, Präferenz oder Lesson in Persistent Memory speichern. Dotted Keys wie pref.editor, project.rosie.lang, tool.sed.usage verwenden. Für Korrekturen type='lesson' nutzen.",
    "tool.forget.label": "Memory Forget",
    "tool.forget.description": "Fakt oder Lesson aus Persistent Memory entfernen.",
    "tool.lessons.label": "Memory Lessons",
    "tool.lessons.description": "Gelernte Korrekturen und Lessons aus vergangenen Sessions auflisten.",
    "tool.stats.label": "Memory Stats",
    "tool.stats.description": "Memory-Statistiken anzeigen — wie viele Facts, Lessons und Events gespeichert sind.",
    "cmd.consolidate.description": "Memory Consolidation für die aktuelle Session manuell starten",
    "cmd.notInitialized": "Memory store not initialized",
    "cmd.notEnough": "Not enough conversation to consolidate (need at least 2 user messages)",
    "cmd.consolidating": "Session Memory wird konsolidiert...",
    "cmd.updated": "Memory updated: {facts} facts, {lessons} lessons",
    "cmd.failed": "Consolidation failed: {error}",
    "result.forgot": "Forgot: {key}", "result.notFound": "Not found: {key}", "result.forgotLesson": "Forgot lesson {id}", "result.notFoundLesson": "Not found: {id}",
  }},
];
export function initI18n(pi: ExtensionAPI): void {
  const events = pi.events; if (!events) return;
  for (const bundle of bundles) events.emit("pi-core/i18n/registerBundle", bundle);
  events.emit("pi-core/i18n/requestApi", { namespace: "pi-memory", callback(api: { t?: Translate } | undefined) { if (typeof api?.t === "function") translate = api.t; } });
}
