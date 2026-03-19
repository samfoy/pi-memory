# pi-memory

Persistent memory for [pi](https://github.com/badlogic/pi-mono). Learns corrections, preferences, and project patterns from sessions and injects them into future conversations.

## Features

- **Automatic learning** — Extracts preferences, project patterns, and corrections from conversations at session end via LLM consolidation
- **Context injection** — Automatically adds relevant memory into every new session's system prompt
- **Corrections stick** — Mistakes you correct once become permanent lessons (e.g. "use sed for daily notes, not echo >>")
- **Complements session-search** — session-search finds *what you did*, pi-memory remembers *what you learned*

## Install

```bash
pi install pi-memory
```

Or add to `~/.pi/agent/settings.json`:

```json
{
  "packages": ["npm:pi-memory"]
}
```

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

1. **`session_start`** — Opens the SQLite store, shows memory stats briefly in the status bar
2. **`before_agent_start`** — Builds a `<memory>` context block from stored facts and lessons, appends it to the system prompt
3. **`agent_end`** — Collects conversation messages for later consolidation
4. **`session_shutdown`** — Runs LLM consolidation (via `pi -p --print`) to extract structured knowledge, then closes the store

### Consolidation

At session end, if there were ≥3 user messages, the extension sends the conversation to an LLM and asks it to extract:

- **Preferences** — coding style, workflow habits, tool choices
- **Project patterns** — languages, frameworks, architecture decisions
- **Corrections** — things you corrected, mistakes to avoid

Only facts with confidence ≥ 0.8 are stored. Lessons are deduplicated using exact match and Jaccard similarity (≥ 0.7 threshold).

### Injection

At session start, stored memory is organized into sections (preferences, project context scoped to cwd, tool preferences, lessons, user identity) and injected as a `<memory>` block in the system prompt. The block is capped at 8KB.

## Storage

SQLite database at `~/.pi/memory/memory.db` (WAL mode). Three tables:

- `semantic` — key-value facts with confidence scores
- `lessons` — learned corrections with dedup
- `events` — audit log of all memory operations

## License

MIT
