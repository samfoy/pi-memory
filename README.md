# pi-memory

Persistent memory for [pi](https://github.com/badlogic/pi-mono). Learns corrections, preferences, and project patterns from sessions and injects them into future conversations.

## Features

- **Automatic learning** — Extracts preferences, project patterns, and corrections from conversations at session end via LLM consolidation
- **Context injection** — Retrieves memory relevant to each prompt and injects it just before your message, without touching the system prompt
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

1. **`session_start`** — Opens the SQLite store and shows memory stats briefly in the status bar.
2. **`before_agent_start`** — On every user turn, searches memory for entries relevant to the prompt (plus project context for the cwd) and prepares a `<memory>` block.
3. **`context`** — Splices that block into the request as an ephemeral message just before the latest user message. It is never written to session history.
4. **`agent_end`** — Collects conversation messages for later consolidation.
5. **`session_before_switch` / `session_shutdown`** — Runs LLM consolidation (via `pi -p --print`) to extract structured knowledge, then closes the store.

### Consolidation

At session end, if there were ≥3 user messages, the extension sends the conversation to an LLM and asks it to extract:

- **Preferences** — coding style, workflow habits, tool choices
- **Project patterns** — languages, frameworks, architecture decisions
- **Corrections** — things you corrected, mistakes to avoid

Only facts with confidence ≥ 0.8 are stored. Lessons are deduplicated using exact match and Jaccard similarity (≥ 0.7 threshold).

### Injection

By default (since 1.5.0), memory is retrieved **per turn** against the current prompt and injected through pi's `context` hook (`injectionMode: "context-hook"`):

- The block is inserted as an ephemeral message immediately **before** the latest user message, on every LLM call in the turn (including tool-call continuations), so the user's question stays the last user-role turn.
- The system prompt is never modified, so its prefix cache always hits. A change in retrieved memory only misses the cache from the injection point forward.
- The injected block is not persisted to session history and is not fed back into consolidation.

Retrieval is FTS5 keyword search by default; vector matching is available as an opt-in — see [Semantic search](#semantic-search).

| Setting | Behavior |
|---------|----------|
| *(default)* | Per-turn retrieval, `context-hook` injection |
| `"injectionMode": "system-prompt"` | Per-turn retrieval appended to the system prompt (legacy 1.4.x). A topic shift invalidates the prefix cache from the system prompt onward. |
| `"perTurnInjection": false` | No per-turn retrieval. One hidden `<memory>` message (customType `pi-memory-context`) is injected once at `session_start` with a fallback dump of preferences, cwd project context, tool preferences, lessons and identity, capped at 8KB. |

```json
{
  "memory": {
    "injectionMode": "context-hook"
  }
}
```

**Lesson filtering** — With per-turn retrieval (the default), the `lessonInjection` config takes effect:

```json
{
  "memory": {
    "lessonInjection": "selective"
  }
}
```

In `selective` lesson mode, lessons are filtered by:

1. **Prompt relevance** — FTS search against the current prompt
2. **Project context** — lessons matching the current working directory's project
3. **Category inference** — keywords in the prompt trigger relevant categories (e.g. "pentest" pulls in `bug-bounty` lessons, "blog post" pulls in `writing` lessons)
4. **General lessons** — always included regardless of prompt

The result is capped at 15 most relevant lessons instead of all of them.

| `lessonInjection` | Behavior (per-turn retrieval only) |
|------|----------|
| `"all"` (default) | All lessons injected every turn |
| `"selective"` | Only relevant lessons based on prompt, project, and category |

**Consolidation model** — At session end, pi-memory spawns a lightweight `pi -p --print` process to extract facts and lessons from the conversation. By default it uses `claude-sonnet-4-20250514`, which is a no-op for users on non-Anthropic providers. Override it with any model string your `pi` binary accepts:

```json
{
  "memory": {
    "lessonInjection": "selective",
    "consolidationModel": "openai/gpt-4.1-mini",
    "consolidation": true
  }
}
```

Set this in `~/.pi/agent/settings.json` for a user-wide default, or in `{project}/.pi/settings.json` (either under `memory` or `pi-memory`) to override per project. Examples: `openai/gpt-4.1-mini`, `ollama/qwen3:8b`, `anthropic/claude-haiku-4-5-20251001`. If the model string is invalid the consolidation sub-process fails silently and the session's memory is simply not consolidated — no data is lost from previous sessions.

Set `"consolidation": false` to skip automatic session-end extraction entirely (for example on metered providers); `memory_remember` and the manual `/memory-consolidate` command keep working.

## Semantic search

Off by default. `memory_search` uses FTS5 BM25 keyword matching, which needs no
configuration and no dependencies.

Setting `embedding` turns on **hybrid** search: the keyword results and
cosine-ranked vector results are combined with Reciprocal Rank Fusion, so an
entry both paths agree on outranks one found by either alone. This is what makes
"that auth thing" retrieve a fact worded "OIDC token refresh".

```json
{
  "memory": {
    "embedding": {
      "type": "bedrock",
      "model": "amazon.titan-embed-text-v2:0",
      "region": "us-west-2",
      "profile": "default",
      "dimensions": 512
    }
  }
}
```

Providers: `bedrock`, `openai`, `mistral`, `ollama`, `openai-compatible`.
Bedrock is the default choice because it needs no API key beyond the AWS
credential chain. The AWS SDK packages are `optionalDependencies` — absent, the
Bedrock provider is simply unavailable and search stays lexical.

Behaviour worth knowing:

- **Fully optional and fail-soft.** An unconfigured, misconfigured, or failing
  provider falls back to FTS5, and search never errors out. The first failure
  of each kind in a session shows a warning naming the cause and the fix (see
  [Troubleshooting](#troubleshooting-semantic-search)).
- **Embeddings are written lazily.** New facts are embedded as they are stored;
  existing ones are backfilled in bounded batches shortly after `session_start`.
  Backfill runs there rather than at write time because the main writer is
  session-end consolidation, and a promise started during shutdown is killed
  before it resolves.
- **Stale-width vectors are replaced automatically.** Stores written by v1.5.0
  and earlier hold 384-dim MiniLM vectors; a 512-dim config makes those unmatchable,
  since cosine similarity of different-length vectors is treated as 0. Backfill
  detects the width mismatch and re-embeds, so you do not need to clear the
  column.
- `memory_stats` reports which mode is active and how much of the store is
  embedded.

To turn it off, remove the `embedding` block. Stored vectors are left alone and
become inert.

### Troubleshooting semantic search

Run `memory_stats` (ask the agent to, or call the tool). With a provider
configured it prints `Search: hybrid (...)` and, if embedding is failing,
a `Semantic search is failing: <cause>. <fix>` line. The same message appears
once per session as a warning. Keyword search keeps working throughout.

| Cause | Fix |
|---|---|
| **AWS SDK not installed** (bedrock). The SDK packages are `optionalDependencies`, so `--omit=optional`, `--no-optional`, an `omit=optional` npm config, or a failed optional install leaves them out. | Run `npm install --omit=dev --include=optional` in the pi-memory package directory (the warning prints the path), or use a provider that needs no SDK: `openai`, `mistral`, `ollama`, `openai-compatible`. |
| **No AWS credentials / expired / access denied** (bedrock) | Check `memory.embedding.profile` and `region`, refresh the profile's credentials (for SSO: `aws sso login --profile <name>`), and make sure the model is enabled for `bedrock:InvokeModel` in that region. |
| **No API key** (openai, mistral) | Set `memory.embedding.apiKey`, or export `OPENAI_API_KEY` / `MISTRAL_API_KEY` before starting pi. |
| **Ollama not reachable / model missing** | `ollama serve`, then `ollama pull <model>` (default `nomic-embed-text`). Check `memory.embedding.url`. |

**Blocked install scripts are no longer a factor.** Up to v1.5.0, semantic
search ran on `@xenova/transformers`, whose native `sharp` binding is built by
an install script. Installers that skip lifecycle scripts left it unbuilt, and
search silently fell back to keywords with a misleading
`@xenova/transformers not installed` message ([#30](https://github.com/samfoy/pi-memory/issues/30)).
That backend is gone. The current providers are plain HTTP or AWS SDK calls,
and nothing in the runtime dependency tree needs an install script, which a
test enforces. If you still see the `@xenova/transformers` message, you are
on an old version: upgrade with `pi update npm:@samfp/pi-memory` (or `pi update --extensions`).

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
