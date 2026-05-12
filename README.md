# pi-memory

Persistent memory for [pi](https://github.com/badlogic/pi-mono). Learns corrections, preferences, and project patterns from sessions and injects them into future conversations.

## Features

- **Automatic learning** — Extracts preferences, project patterns, and corrections from conversations at session end via LLM consolidation
- **Context injection** — Automatically adds relevant memory into every new session's system prompt
- **Corrections stick** — Mistakes you correct once become permanent lessons (e.g. "use sed for daily notes, not echo >>")
- **Complements session-search** — session-search finds *what you did*, pi-memory remembers *what you learned*

## Install

**Recommended:** Install [pi-total-recall](https://github.com/samfoy/pi-total-recall) to get the complete context stack — persistent memory, session history search, and local knowledge search in one package:

```bash
pi install pi-total-recall
```

Or install pi-memory standalone:

```bash
pi install npm:@samfp/pi-memory
```

Or add to `~/.pi/agent/settings.json`:

```json
{
  "packages": ["npm:@samfp/pi-memory"]
}
```

> **Note:** Make sure you use the `@samfp/` scope. There is an unrelated `pi-memory` package on npm that will install instead if you omit the scope.

## Memory Types

| Type | Key prefix | Example |
|------|-----------|---------|
| Preferences | `pref.*` | `pref.commit_style` → "conventional commits" |
| Project patterns | `project.*` | `project.rosie.di` → "Dagger dependency injection" |
| Tool preferences | `tool.*` | `tool.sed` → "use for daily note insertion" |
| User identity | `user.*` | `user.timezone` → "US/Pacific" |
| Lessons | *(table)* | "DON'T: use echo >> for vault notes, use sed" |

## Tools

| Tool | Description |
|------|-------------|
| `memory_search` | Search semantic memory by keyword |
| `memory_remember` | Manually store a fact or lesson |
| `memory_forget` | Delete a fact or lesson |
| `memory_lessons` | List learned corrections |
| `memory_stats` | Show memory statistics |

## Commands

| Command | Description |
|---------|-------------|
| `/memory-consolidate` | Manually trigger memory extraction from current session |

## How It Works

1. **`session_start`** — Opens the SQLite store, shows memory stats briefly in the status bar, and injects a `<memory>` context block as a hidden custom message (customType `pi-memory-context`, `display: false`) **before** any user message. One-shot per session.
2. **`agent_end`** — Collects conversation messages for later consolidation
3. **`session_shutdown`** — Runs LLM consolidation (via `pi -p --print`) to extract structured knowledge, then closes the store

### Consolidation

At session end, if there were ≥3 user messages, the extension sends the conversation to an LLM and asks it to extract:

- **Preferences** — coding style, workflow habits, tool choices
- **Project patterns** — languages, frameworks, architecture decisions
- **Corrections** — things you corrected, mistakes to avoid

Only facts with confidence ≥ 0.8 are stored. Lessons are deduplicated using exact match and Jaccard similarity (≥ 0.7 threshold).

### Injection

At session start, stored memory is organized into sections (preferences, project context scoped to cwd, tool preferences, lessons, user identity) and injected **once** as a hidden `<memory>` custom message that sits before the first user message in history. The block is capped at 8KB.

The injection happens at `session_start` via `pi.sendMessage`, not per-turn. This is deliberate:

- **Correctness.** A per-turn injection via `before_agent_start` places the memory block *after* the user's question in the message list, so the model ends up responding to the memory block instead of the user. One-shot at the top of history avoids that ordering trap.
- **Cache stability.** Mutating the system prompt per turn (as earlier versions did) invalidates the provider's prefix cache after the system block (Bedrock / Anthropic `cache_control`), forcing the conversation suffix to be re-written at `cacheWrite` rates on every turn boundary.
- **Simplicity.** One block, one time, cached for the whole session.

Tradeoff: per-user-message selective injection (v1.0.x `lessonInjection: "selective"` behavior) is gone. The fallback dump covers preferences, project context for the cwd, tool preferences, lessons, and user identity — enough for typical workflows given the 8KB cap.

**Selective lesson injection** — By default, all lessons are injected into every session. When you have many lessons across different domains, this can waste context. Enable selective mode to filter lessons by relevance:

```json
{
  "memory": {
    "lessonInjection": "selective"
  }
}
```

Add this to `~/.pi/agent/settings.json`. In selective mode, lessons are filtered by:

1. **Prompt relevance** — FTS search against the user's first message
2. **Project context** — lessons matching the current working directory's project
3. **Category inference** — keywords in the prompt trigger relevant categories (e.g. "pentest" pulls in `bug-bounty` lessons, "blog post" pulls in `writing` lessons)
4. **General lessons** — always included regardless of prompt

The result is capped at 15 most relevant lessons instead of all of them.

| Mode | Behavior |
|------|----------|
| `"all"` (default) | Every lesson injected into every session |
| `"selective"` | Only relevant lessons based on prompt, project, and category |

**Consolidation model** — At session end, pi-memory spawns a lightweight `pi -p --print` process to extract facts and lessons from the conversation. By default it uses `claude-sonnet-4-20250514`, which is a no-op for users on non-Anthropic providers. Override it with any model string your `pi` binary accepts:

```json
{
  "memory": {
    "lessonInjection": "selective",
    "consolidationModel": "openai/gpt-4.1-mini"
  }
}
```

Set this in `~/.pi/agent/settings.json` for a user-wide default, or in `{project}/.pi/settings.json` (either under `memory` or `pi-memory`) to override per project. Examples: `openai/gpt-4.1-mini`, `ollama/qwen3:8b`, `anthropic/claude-haiku-4-5-20251001`. If the model string is invalid the consolidation sub-process fails silently and the session's memory is simply not consolidated — no data is lost from previous sessions.

## Storage

SQLite database at `~/.pi/memory/memory.db` (WAL mode). Three tables:

- `semantic` — key-value facts with confidence scores
- `lessons` — learned corrections with dedup
- `events` — audit log of all memory operations

### Project-local storage

To keep a project's memory isolated from your user-global memory, add one of the following to `{project}/.pi/settings.json`:

```jsonc
{
  // Package-specific — wins over the cascade below.
  "pi-memory": {
    "localPath": ".pi/memory"   // resolves to {project}/.pi/memory/memory.db
  }
}
```

Or, if installed via [`pi-total-recall`](https://github.com/samfoy/pi-total-recall), a single cascade key covers all three bundled packages:

```jsonc
{
  "pi-total-recall": {
    "localPath": ".pi/total-recall"
    // pi-memory             → {project}/.pi/total-recall/memory/memory.db
    // pi-session-search     → {project}/.pi/total-recall/session-search/
    // pi-knowledge-search   → {project}/.pi/total-recall/knowledge-search/
  }
}
```

**Resolution order (highest priority first):**

1. `pi-memory.localPath` in `{cwd}/.pi/settings.json`
2. `pi-total-recall.localPath` cascade → `{localPath}/memory/memory.db`
3. Global default: `~/.pi/memory/memory.db`

Existing global installs are unaffected — this is strictly additive.

## License

MIT
