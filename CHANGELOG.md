# Changelog

All notable changes to `@samfp/pi-memory`. Versions follow [semver](https://semver.org/).

## [1.7.0] - 2026-11-11

### Changed

- **Per-turn memory is now a stored, hidden session message**
  (`injectionMode: "message"`, customType `pi-memory-recall`). The 1.6
  `context-hook` default spliced the block in front of the latest user message
  on every request and never stored it, so each new turn rewrote earlier
  history. That missed the prompt cache from the system prompt onward on every
  turn, and on Claude Fable 5.2 (and other models with preserved thinking)
  Bedrock dropped earlier reasoning blocks. History is now append-only.
- Each recall message holds only memory the active context does not already
  carry (tracked in the message `details`). A fact comes back when its value
  changes or when compaction removes the message that carried it. Entries cut
  by the 8KB cap are not counted as recalled.
- Runs started by an extension message, with no user prompt, add no memory.
  They previously got the full fallback dump.
- `injectionMode: "context-hook"` is no longer a mode; the value is read as
  the default.

## [1.6.1] - 2026-10-09

### Fixed

- **A failing `credential_process` is no longer reported as a missing profile.**
  When a Bedrock profile exists but its `credential_process` exits non-zero
  (typically an expired login session behind it), the startup warning now says
  the process failed and quotes its last stderr line, instead of "no AWS
  credentials were found" with an `aws sso login` hint that did not apply.

## [1.6.0] - 2026-09-24

First npm release since 1.5.0. The 1.5.0 tarball on npm was built before the
context-hook work landed, so the injection change below is new to anyone
upgrading from npm.

### Changed

- **Per-turn memory goes through the `context` hook by default**
  (`injectionMode: "context-hook"`). The system prompt is never modified, so
  its prefix cache always holds. On every LLM call in a turn, including
  tool-call continuations, the relevant `<memory>` block is inserted as an
  ephemeral message just before the latest user message. It is never written
  to session history or the consolidation queue. To get the npm 1.5.0
  behaviour back (append to the system prompt each turn), set
  `injectionMode: "system-prompt"`. `perTurnInjection: false` still means a
  single dump at `session_start`.
- The peer dependency is now `typebox` (TypeBox 1.x) rather than
  `@sinclair/typebox`. Pi supplies both.
- `engines.node` is `>=22.19.0`, matching pi.

### Added

- **Hybrid semantic search, opt-in** through `memory.embedding`, with
  providers `bedrock`, `openai`, `mistral`, `ollama` and `openai-compatible`.
  FTS5 keyword hits and cosine-ranked vector hits are merged with Reciprocal
  Rank Fusion (k = 60). Existing entries get embeddings in bounded background
  batches after `session_start`. Leftover 384-dim vectors from the old
  backend are re-embedded automatically. `memory_stats` reports the search
  mode and how much of the store is embedded. The semantic score floor
  (`minScore` 0.15) was calibrated against measured Titan v2 similarities.
  The AWS SDK is an `optionalDependency`, and none of these providers
  needs a native module.
- **Embedding failures now say what is wrong and how to fix it** ([#30]).
  The first failure of each kind in a session shows a warning naming the
  cause and the fix, and `memory_stats` repeats it:
  - optional AWS SDK not installed (the warning includes the install command
    and the package path)
  - AWS credentials missing, expired or denied
  - missing API key
  - HTTP 401, 403, 404 or 429
  - Ollama not running or missing the model

  Keyword search keeps working in every case. The README has a
  troubleshooting table.

### Removed

- The `@xenova/transformers` backend and dependency ([#31]). It pulled in
  vulnerable transitive packages and a native `sharp` binding that needs an
  install script, which was the root cause of [#30]. Its vectors were written
  but never read at query time, so search quality does not change. Nothing
  in the runtime dependency tree needs an install script now, and a test
  enforces that.

### Fixed

- Pi exited with an unhandled promise rejection when the `bedrock` provider
  was configured, the optional AWS SDK was missing, and there was nothing to
  backfill (for example a fresh store). The SDK now loads on first use.
- `openai` and `mistral` with no API key now fail once, at startup, with a
  clear message instead of a 401 on every query. An Ollama batch in which
  every item fails is reported rather than stored as nulls.
- The "🧠 Consolidating memory..." status could stay on the screen after
  `session_shutdown` or `session_before_switch` if consolidation threw.
  It is now always cleared.
- TypeScript errors that failed the release workflow, which is why 1.6.0
  never reached npm.

### Internal

- CI runs on `master`. It used to listen on `main`, so it never ran. The
  release workflow uses npm trusted publishing (no token) and checks that the
  tag matches `package.json`. Both run typecheck, tests, build and a check
  that the committed `dist/` is current.
- `prepare` became `prepack`, so `pi install git:github.com/samfoy/pi-memory`
  (which runs `npm install --omit=dev`) no longer tries to run esbuild, a
  devDependency. `dist/` is committed.
- Dev dependencies moved to pi 0.87. The lockfile was regenerated against
  registry.npmjs.org, and `npm audit --omit=dev` reports 0 vulnerabilities.
- Hook-level tests now cover context-hook injection, system-prompt mode,
  `perTurnInjection: false`, switch-time consolidation and embedding-failure
  reporting.

[#30]: https://github.com/samfoy/pi-memory/issues/30
[#31]: https://github.com/samfoy/pi-memory/pull/31
