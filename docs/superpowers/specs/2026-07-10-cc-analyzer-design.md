# cc-analyzer — Design

**Date:** 2026-07-10
**Status:** Approved (design), pending implementation plan

## 1. Summary

`cc-analyzer` is a **read-only** CLI tool that browses and analyzes Claude Code
sessions stored in `~/.claude`. It exposes the same analysis core through two
first-class surfaces: an interactive **TUI** and an embedded local **web app**.
A **SQLite index** provides fast portfolio-wide analytics across all projects
and sessions.

The tool never writes to `~/.claude`. All of its own state (index database,
pricing cache, config) lives under `~/.config/cc-analyzer/` (XDG). The index is
a **disposable cache** — it can be deleted and rebuilt from the JSONL files at
any time and is never a source of truth.

- **Language / runtime:** TypeScript on Bun
- **Distribution:** single binary via `bun build --compile` (SPA embedded)
- **Lint/format:** Biome. **Tests:** `bun test`.

## 2. Requirements (locked during brainstorming)

| Decision | Choice |
|---|---|
| Primary UI | Both TUI and web app are first-class, sharing one analysis core |
| Analysis scope | Full portfolio analytics: per-session + per-project + global dashboards |
| Pricing source | Fetch LiteLLM `model_prices_and_context_window.json`, cache locally, bundled fallback |
| Tech stack | TypeScript + Bun |
| Live vs static | Static (past sessions) first; live-follow deferred |
| Step unit | By **turn** (hierarchical: turn → API calls → tool calls) |
| Web frontend | Vite + React SPA (framework-agnostic API allows later swap) |

## 3. Data source & domain model

### On-disk layout
```
~/.claude/projects/<url-encoded-cwd>/<session-uuid>.jsonl
```
- One JSONL file per session; one JSON object per line.
- The directory name is the url-encoded working directory; decode back to a
  real path for display.

### Event types (top-level `type`)
Observed: `user`, `assistant`, `system`, `attachment`, `ai-title`,
`last-prompt`, `permission-mode`, `file-history-snapshot`. Tool calls and
results are nested inside message `content[]` (`tool_use`, `tool_result`),
not top-level events.

### Key record fields
- **Common:** `cwd`, `entrypoint`, `gitBranch`, `isSidechain`, `sessionId`,
  `timestamp`, `uuid`, `parentUuid`, `userType`, `version`.
- **`assistant`:** `message.model`, `message.usage` (rich — see below),
  `message.content[]` (`thinking` / `text` / `tool_use`), `requestId`,
  `stop_reason`.
- **`user`:** `message.content` (string for real prompts, or an array carrying
  `tool_result` for loop continuations), `permissionMode`, `promptId`.

### `usage` block (assistant messages)
```
input_tokens, output_tokens,
cache_creation_input_tokens, cache_read_input_tokens,
cache_creation.{ephemeral_5m_input_tokens, ephemeral_1h_input_tokens},
server_tool_use.{web_search_requests, web_fetch_requests},
service_tier, iterations[]
```
There is **no cost field** — cost is computed from these token counts.

### Domain concepts
- **Project** — a directory under `projects/`; decoded cwd; has N sessions.
- **Session** — one `<uuid>.jsonl`; title from `ai-title`; start/end time; cwd;
  git branch(es); CC version(s); models used.
- **Turn** — the core unit: one genuine user prompt plus every subsequent
  assistant API call and tool loop until the next genuine prompt.
  - **Segmentation subtlety:** `user`-type records whose content is only a
    `tool_result` are loop continuations, **not** new turns. Segment on real
    prompts (string content / presence of `promptId`).
- **Sidechain** (`isSidechain: true`) — subagent/skill work; grouped under the
  `Task`/skill `tool_use` that spawned it.

## 4. Architecture

### `core/` — zero UI dependencies, reused by both surfaces
- **`parser`** — stream JSONL line-by-line into typed events using **tolerant
  Zod schemas** that ignore unknown fields (so newer CC versions don't break
  parsing). Handles missing/partial `usage`.
- **`analyze`** — turn segmentation; extraction of tools, skills, models, files
  touched (from `Edit`/`Write` tool calls and `file-history-snapshot`),
  web-search/fetch counts, permission modes, subagents.
- **`pricing`** — fetch LiteLLM JSON, cache to config dir with timestamp,
  bundled snapshot fallback; refresh when stale or on `pricing update`. Compute
  cost with separate rates for input, output, cache-write (5m + 1h), cache-read.
  Map session model IDs (e.g. `claude-opus-4-7`) to pricing entries; unknown
  models flagged and cost marked *estimated/unknown*.
- **`index`** — SQLite schema + **incremental** ingest. Track each file's path,
  mtime, and size; re-parse only new/changed files. Store computed metrics
  only; read full transcript text lazily from JSONL on view. Provide
  aggregation queries for dashboards. Parse files concurrently (worker pool).

### `cli/` — command surface
- `cc-analyzer` (no args) → launch TUI
- `cc-analyzer serve [--port]` → launch web app
- `cc-analyzer index [--rebuild]` → build/refresh (or fully rebuild) the index
- `cc-analyzer ls` / `show <session>` / `analyze <session> --json` → scriptable output
- `cc-analyzer pricing update` → refresh the pricing cache

### `tui/` — Ink (React for terminal)
Screens: Projects list → Sessions list → Session detail with tabs
(**Summary** / **Turns** / **Transcript**). Keyboard navigation and filtering.

### `web/` — Hono API + Vite React SPA (embedded in the binary)
- **API:** `/api/projects`, `/api/projects/:id/sessions`,
  `/api/sessions/:id` (analysis), `/api/sessions/:id/transcript`,
  `/api/stats` (portfolio dashboards).
- **SPA:** global dashboard, project view, session view (transcript reader +
  charts). Served from embedded assets by Hono.

## 5. Analysis outputs

### Per session
Total cost + tokens by category; duration; #turns / #API calls / #tool calls;
model split; tool-usage counts; skills invoked; subagents spawned; web
search/fetch counts; files touched; permission modes; CC versions. Cost broken
down **by model** and **by token category** (cache economics surfaced
explicitly — cache reads vs writes are where most of the cost hides).

### Per turn
Prompt preview, cost, tokens, duration, tools used, #API calls, model(s).

### Portfolio
Total spend (all-time + by month); spend by project / model / day; session
counts; token trends; top tools/skills; most-expensive sessions and turns.

## 6. Transcript reader

Faithful, readable rendering:
- User prompts, assistant markdown text.
- **Thinking** blocks — collapsible.
- **tool_use** — name + input, collapsible.
- **tool_result** — collapsible, truncated.
- Attachments/images — noted.

Web: syntax highlighting + collapsible sections. TUI: scrollable with
expand/collapse. Transcript text is loaded lazily from the JSONL, not from the
index.

## 7. Persistence & performance

- **SQLite tables (indicative):** `projects`, `sessions`, `turns`,
  `tool_calls`, and a `files` table holding ingest state (path, mtime, size).
- **Incremental ingest:** on `index` or launch, scan for new/changed files by
  mtime/size and parse only those.
- **Concurrency:** worker pool parses multiple session files in parallel.
- **Large sessions:** stream parsing, lazy transcript loading, pagination in
  the UIs.

## 8. Pricing details

- **Source:** LiteLLM `model_prices_and_context_window.json` (raw GitHub).
- **Cache:** stored in config dir with fetch timestamp; refreshed when older
  than a configurable interval or on `pricing update`.
- **Fallback:** a bundled snapshot compiled into the binary so first run and
  offline use still produce costs.
- **Unknown models:** flagged; cost shown as estimated/unknown rather than zero.

## 9. Config & safety

- **Read-only** with respect to `~/.claude` — the tool never writes there.
- **Own state:** `~/.config/cc-analyzer/` (`index.db`, pricing cache,
  `config.toml`).
- **Config options:** base dir override (default `~/.claude`), web port,
  pricing refresh interval.
- **Privacy:** fully local; no telemetry. Transcripts can contain sensitive
  content and never leave the machine.

## 10. Testing & distribution

- **Unit tests (`bun test`):** parser against sanitized fixtures for each event
  type; turn segmentation (including the tool_result-continuation edge case);
  pricing math with explicit cache-token cases; incremental re-index logic.
- **Golden tests:** stable analysis output for known fixture sessions.
- **Distribution:** `bun build --compile` → single binary with the built SPA
  embedded; cross-compile targets for macOS and Linux.

## 11. Deferred (YAGNI for v1)

- Live-follow of active sessions (file watching + SSE/WS push).
- Alternative web frameworks (Svelte/Solid) — API is framework-agnostic.
