# pi-memory

Persistent memory extension for pi. Stores facts and lessons across sessions and injects them into every new conversation so the agent doesn't repeat mistakes or re-ask known preferences.

## Language

**Fact**:
A key-value declarative memory. Key uses dotted namespace (`pref.*`, `project.*`, `tool.*`, `user.*`). Value is a short string (min length enforced). Written as a declaration, not an instruction.
_Avoid_: note, record, setting, config.

**Lesson**:
A corrective rule stored in its own table. The shape is "DON'T X, because Y — do Z instead." Lessons prevent repeating a past mistake. Unlike Facts, Lessons have no key — they're deduplicated by Jaccard similarity (≥ 0.7 threshold).
_Avoid_: rule, correction (ambiguous), gotcha.

**Preference / Project pattern / Tool preference / User identity**:
The four Fact categories. Distinguished by key prefix:
- **Preference** → `pref.*` (e.g. `pref.commit_style`)
- **Project pattern** → `project.*` (e.g. `project.rosie.di`)
- **Tool preference** → `tool.*` (e.g. `tool.sed`)
- **User identity** → `user.*` (e.g. `user.timezone`)

**Consolidation**:
End-of-session step where the conversation transcript is sent to an LLM with a structured prompt to extract Facts and Lessons. Only Facts with `confidence ≥ 0.8` are stored. Runs only if the session had ≥ 3 user messages.
_Avoid_: extraction, summarization.

**Injection**:
Start-of-session step where stored Facts and Lessons are assembled into a `<memory>` block and appended to the system prompt. Capped at 8KB. Sections are ordered: preferences → project context (filtered to cwd) → tool preferences → lessons → user identity.

**`<memory>` block**:
The XML-tagged block injected into the system prompt. Consumers of pi-memory data (other skills, extensions) should not rely on internal structure — treat it as opaque context.

**Selective lesson injection**:
Opt-in mode (`memory.lessonInjection: "selective"` in settings) that filters lessons by relevance to the first user message instead of injecting all of them. Filters by FTS search against the prompt, project-scoped lessons for the cwd's project, category inference from prompt keywords (e.g. "pentest" pulls in `bug-bounty` lessons), and always-include "general" lessons. Caps output at 15 lessons.

**Bootstrap**:
First-run operation that processes historical session summaries and extracts Facts/Lessons retroactively. Only runs when the store is empty.

## Relationships

- A **Fact** has one key; a **Lesson** has no key.
- **Consolidation** produces **Facts** and **Lessons** and writes them to the store.
- **Injection** reads the store and builds the `<memory>` block.
- The four Fact categories are distinguished only by key prefix — no separate tables.

## Flagged ambiguities

- **"Memory"** (unqualified) is overloaded — can mean the whole system, the SQLite store, or the injected `<memory>` block. Prefer the specific term.
- **"Confidence"** belongs to Facts (set during consolidation, threshold 0.8). Lessons don't have confidence — they have a stricter acceptance test (must not duplicate existing, must be declarative).
- **"Imperative vs declarative"** — Facts must be declarative ("Sam prefers concise responses"), not imperative ("always respond concisely"). Imperative phrasing gets re-read as a directive in later sessions and can override the user's current request. Procedures belong in skills, not memory.

## Example dialogue

> **Sam:** "Every time I say 'deploy the dashboard' you forget I want Effect version."
> **Agent:** "Should we save this as a **Fact**, or a **Lesson**?"
> **Sam:** "Fact — project pattern."
> **Agent:** "Writing `project.pi-dashboard.default_deploy = effect branch`. That's a **Preference**-style Fact under the `project.*` prefix. Future sessions will see it in the **Injection** step."
