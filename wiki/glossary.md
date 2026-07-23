# Glossary

> Indexed at commit `51ccd4e` on 2026-07-23 · [view on GitHub](https://github.com/yorch/cc-analyzer/tree/51ccd4e)

Domain terms used throughout `cc-analyzer` and this wiki, grounded in the code that implements them.

## Relevant source files

- [src/core/analyze.ts](https://github.com/yorch/cc-analyzer/blob/51ccd4e/src/core/analyze.ts)
- [src/core/stats.ts](https://github.com/yorch/cc-analyzer/blob/51ccd4e/src/core/stats.ts)
- [src/core/chart-series.ts](https://github.com/yorch/cc-analyzer/blob/51ccd4e/src/core/chart-series.ts)
- [src/core/pricing.ts](https://github.com/yorch/cc-analyzer/blob/51ccd4e/src/core/pricing.ts)
- [src/core/update.ts](https://github.com/yorch/cc-analyzer/blob/51ccd4e/src/core/update.ts)

## Terms

**Session** — One Claude Code conversation, stored as a single JSONL file at `~/.claude/projects/<project>/<session>.jsonl`. Its basename is usually a UUID and serves as its id.

**Project** — A directory under `~/.claude/projects/` grouping the sessions for one working directory. Its encoded directory name is the stable **project id**; the authoritative human path comes from a session's `cwd` field, not from decoding the id.

**Event / SessionEvent** — One parsed line of a session file. Events are typed (`user`, `assistant`, and others) and validated with Zod; an unrecognized or drifted line becomes a tolerant "unknown" event rather than an error.

**Turn** — The central unit of analysis: one genuine user prompt plus every assistant API call and tool loop until the next genuine prompt. Turn boundaries are set by `isRealPrompt()` ([src/core/analyze.ts:L1-L60](https://github.com/yorch/cc-analyzer/blob/51ccd4e/src/core/analyze.ts#L1-L60)).

**Real prompt** — A user event that starts a new turn: not `isMeta`, and carrying content other than `tool_result` blocks. Tool-result-only user events are loop continuations, not turns.

**Step** — A fine-grained item within a turn (prompt, thinking, assistant text, an individual tool call and its result), produced by `steps.ts` for the per-turn timeline shown in the TUI session detail and the web per-turn view ([src/core/steps.ts:L1-L60](https://github.com/yorch/cc-analyzer/blob/51ccd4e/src/core/steps.ts#L1-L60)).

**API call** — One assistant event: a single request to the model, carrying a `usage` block, a model id, and any tool-use blocks it produced. A turn aggregates one or more.

**Tool call** — A `tool_use` block emitted by the assistant (Bash, Edit, Read, …), with its error status resolved by matching against the corresponding `tool_result`.

**Streaming analysis** — A consumer API that folds a session's events into metrics without holding the entire event array in memory, for very large sessions; it complements the in-memory `analyzeSession()` ([src/core/analyze.ts:L1-L40](https://github.com/yorch/cc-analyzer/blob/51ccd4e/src/core/analyze.ts#L1-L40)).

**Sidechain** — An API call made outside the main conversation thread (marked `isSidechain`), typically from subagent work.

**Skill / Subagent** — A named capability invoked via the `Skill` tool, and a delegated agent launched via the `Task` tool (`subagent_type`); both are recorded per session and surfaced in the tools analytics.

**Token categories** — The four separately-priced kinds of tokens: input, output, cache-write, and cache-read ([src/core/pricing.ts:L1-L60](https://github.com/yorch/cc-analyzer/blob/51ccd4e/src/core/pricing.ts#L1-L60)).

**Cache-write (5m / 1h TTL) / Cache-read** — Tokens written into the prompt cache (priced by time-to-live) and tokens served from it (priced well below input). Cache accounting is where most real spend hides ([src/core/pricing.ts:L1-L60](https://github.com/yorch/cc-analyzer/blob/51ccd4e/src/core/pricing.ts#L1-L60)).

**Cache efficiency** — How well cache-write spend is amortized by later cache reads. The Insights view ranks projects and sessions by un-amortized cache-write spend (the "leakiest" work) ([src/core/stats.ts:L1-L60](https://github.com/yorch/cc-analyzer/blob/51ccd4e/src/core/stats.ts#L1-L60)).

**Estimated cost** — A cost flagged approximate because the model matched only by family heuristic (not an exact table entry) or could not be priced.

**Family heuristic** — The model-resolution fallback: exact id → `anthropic/`-prefixed → `opus`/`sonnet`/`haiku` family, so newer versioned models still get a price (as an estimate).

**SessionAnalysis** — The central per-session data structure produced by `analyzeSession()`: totals, per-turn breakdowns, per-model usage, tools, skills, subagents, and files touched ([src/core/analyze.ts:L1-L60](https://github.com/yorch/cc-analyzer/blob/51ccd4e/src/core/analyze.ts#L1-L60)).

**Transcript / TranscriptItem** — A linear, human-readable flattening of a session's events shared by the TUI and web readers.

**Index** — A disposable SQLite cache at `~/.config/cc-analyzer/index.db` holding one flattened row per session; rebuildable from the JSONL files at any time ([src/core/db.ts:L1-L60](https://github.com/yorch/cc-analyzer/blob/51ccd4e/src/core/db.ts#L1-L60)).

**Schema version** — A `schema_version` stored in the index's `meta` table (currently v8, `SCHEMA_VERSION`). Bumping it invalidates and rebuilds the disposable cache — never a breaking change for users ([src/core/db.ts:L86-L108](https://github.com/yorch/cc-analyzer/blob/51ccd4e/src/core/db.ts#L86-L108)).

**Incremental indexing** — Re-parsing only files changed by size + mtime, pruning rows for deleted files.

**Analytics rollup** — The single-table-scan fold (`analyticsRollup`) over the index's per-session JSON blobs that computes portfolio and project analytics in one pass, so every analytics surface shares the same numbers ([src/core/stats.ts:L1-L60](https://github.com/yorch/cc-analyzer/blob/51ccd4e/src/core/stats.ts#L1-L60)).

**Chart series** — Plottable time-series and distributions built by the bun-free `chart-series.ts` module (e.g. spend burn, compaction, hot files), imported directly by both the TUI and the web SPA so the two frontends chart identical data ([src/core/chart-series.ts:L1-L60](https://github.com/yorch/cc-analyzer/blob/51ccd4e/src/core/chart-series.ts#L1-L60)).

**Bun-free module** — A core module (`stats-types.ts`, `chart-series.ts`) written without Bun-only APIs so the browser SPA can import it directly, keeping analytics logic single-sourced across frontends.

**Trends** — The time-series view (TUI `TrendsView` / web `Trends`): spend and usage over time with metric and granularity toggles, rendered as braille charts in the terminal and SVG charts on the web.

**Tools analytics** — The tool/skill/subagent usage view (TUI `ToolsView` / web `Tools`): which tools, skills, and subagents are used, how often, and at what cost.

**Compaction tracking** — Analytics that follow context-compaction events across a session/project, surfaced in the session and project charts ([src/core/stats.ts:L1-L60](https://github.com/yorch/cc-analyzer/blob/51ccd4e/src/core/stats.ts#L1-L60)).

**Portfolio analytics** — Aggregations over the whole index (spend by month/project/model, most expensive sessions, insights, trends) powering the `stats` command and the dashboards.

**State dir** — `cc-analyzer`'s own writable directory (`~/.config/cc-analyzer/`, overridable via `CC_ANALYZER_STATE_DIR`) holding the index, pricing cache, and update-check cache. Distinct from the read-only Claude data dir (`~/.claude`, overridable via `CC_ANALYZER_CLAUDE_DIR`).

**Embedded version** — The build-time version, imported from `package.json` and bundled by `bun --compile`, so the running binary reports its own version ([src/core/version.ts:L1-L8](https://github.com/yorch/cc-analyzer/blob/51ccd4e/src/core/version.ts#L1-L8)).

**Compiled binary** — A `bun build --compile` standalone executable, detected via the `$bunfs` marker in `import.meta.url`; self-update only runs in this mode ([src/core/update.ts:L1-L40](https://github.com/yorch/cc-analyzer/blob/51ccd4e/src/core/update.ts#L1-L40)).

**Self-update** — `cc-analyzer update`: resolve the latest release, stream-download the matching asset (with a progress line and stall timeout), verify its checksum, and atomically replace the running binary (macOS/Linux); Windows delegates to the installer ([src/core/update.ts:L1-L265](https://github.com/yorch/cc-analyzer/blob/51ccd4e/src/core/update.ts#L1-L265)).

**Update check** — A passive, once-a-day cached "update available" notice printed after quick commands; disabled in CI, non-TTY, `--json`, and via `CC_ANALYZER_NO_UPDATE_CHECK`.

**SHA256SUMS / checksum verification** — A manifest of asset hashes published with each release; the installers and `update` verify the download against it before installing, degrading gracefully when it is absent ([src/core/checksum.ts:L1-L33](https://github.com/yorch/cc-analyzer/blob/51ccd4e/src/core/checksum.ts#L1-L33)).

**Build provenance** — A signed attestation generated in the release workflow (`actions/attest-build-provenance`) linking each published binary to the workflow run that built it, for supply-chain traceability.

**SPA embedding** — Serializing the Vite-built single-file front end into a string in `src/web/spa.ts`, so `bun build --compile` bakes the whole UI into the binary.

**Wiki sync** — The build step that copies the canonical `/wiki` into the VitePress `site/docs/`, normalizing filenames and links; `/wiki` is the single source of truth for the docs site.

Sources: [src/core/analyze.ts:L1-L60](https://github.com/yorch/cc-analyzer/blob/51ccd4e/src/core/analyze.ts#L1-L60) [src/core/stats.ts:L1-L60](https://github.com/yorch/cc-analyzer/blob/51ccd4e/src/core/stats.ts#L1-L60) [src/core/chart-series.ts:L1-L60](https://github.com/yorch/cc-analyzer/blob/51ccd4e/src/core/chart-series.ts#L1-L60) [src/core/pricing.ts:L1-L60](https://github.com/yorch/cc-analyzer/blob/51ccd4e/src/core/pricing.ts#L1-L60) [src/core/update.ts:L1-L265](https://github.com/yorch/cc-analyzer/blob/51ccd4e/src/core/update.ts#L1-L265)
