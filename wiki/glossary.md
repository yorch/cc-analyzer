# Glossary

> Indexed at commit `bf5a4c8` on 2026-07-12 · [view on GitHub](https://github.com/yorch/cc-analyzer/tree/bf5a4c8)

Domain terms used throughout `cc-analyzer` and this wiki, grounded in the code that implements them.

## Relevant source files

- [src/core/analyze.ts](https://github.com/yorch/cc-analyzer/blob/bf5a4c8/src/core/analyze.ts)
- [src/core/pricing.ts](https://github.com/yorch/cc-analyzer/blob/bf5a4c8/src/core/pricing.ts)
- [src/core/steps.ts](https://github.com/yorch/cc-analyzer/blob/bf5a4c8/src/core/steps.ts)
- [src/core/update.ts](https://github.com/yorch/cc-analyzer/blob/bf5a4c8/src/core/update.ts)
- [src/core/checksum.ts](https://github.com/yorch/cc-analyzer/blob/bf5a4c8/src/core/checksum.ts)

## Terms

**Session** — One Claude Code conversation, stored as a single JSONL file at `~/.claude/projects/<project>/<session>.jsonl`. Its basename is usually a UUID and serves as its id ([src/core/discover.ts:L1-L102](https://github.com/yorch/cc-analyzer/blob/bf5a4c8/src/core/discover.ts#L1-L102)).

**Project** — A directory under `~/.claude/projects/` grouping the sessions for one working directory. Its encoded directory name is the stable **project id**; the authoritative human path comes from a session's `cwd` field, not from decoding the id ([src/core/discover.ts:L1-L102](https://github.com/yorch/cc-analyzer/blob/bf5a4c8/src/core/discover.ts#L1-L102)).

**Event / SessionEvent** — One parsed line of a session file. Events are typed (`user`, `assistant`, and others) and validated with Zod; an unrecognized or drifted line becomes a tolerant "unknown" event rather than an error.

**Turn** — The central unit of analysis: one genuine user prompt plus every assistant API call and tool loop until the next genuine prompt. Turn boundaries are set by `isRealPrompt()` ([src/core/analyze.ts:L1-L60](https://github.com/yorch/cc-analyzer/blob/bf5a4c8/src/core/analyze.ts#L1-L60)).

**Real prompt** — A user event that starts a new turn: not `isMeta`, and carrying content other than `tool_result` blocks. Tool-result-only user events are loop continuations, not turns.

**Step** — A fine-grained item within a turn (prompt, thinking, assistant text, an individual tool call and its result), produced by `steps.ts` for the per-turn timeline shown in the TUI session detail and the web per-turn view ([src/core/steps.ts:L1-L60](https://github.com/yorch/cc-analyzer/blob/bf5a4c8/src/core/steps.ts#L1-L60)).

**API call** — One assistant event: a single request to the model, carrying a `usage` block, a model id, and any tool-use blocks it produced. A turn aggregates one or more.

**Tool call** — A `tool_use` block emitted by the assistant (Bash, Edit, Read, …), with its error status resolved by matching against the corresponding `tool_result`.

**Sidechain** — An API call made outside the main conversation thread (marked `isSidechain`), typically from subagent work.

**Skill / Subagent** — A named capability invoked via the `Skill` tool, and a delegated agent launched via the `Task` tool (`subagent_type`); both are recorded per session.

**Token categories** — The four separately-priced kinds of tokens: input, output, cache-write, and cache-read ([src/core/pricing.ts:L1-L60](https://github.com/yorch/cc-analyzer/blob/bf5a4c8/src/core/pricing.ts#L1-L60)).

**Cache-write (5m / 1h TTL) / Cache-read** — Tokens written into the prompt cache (priced by time-to-live, ~1.25× input at 5 minutes and ~2× at 1 hour) and tokens served from it (well below input). Cache accounting is where most real spend hides ([src/core/pricing.ts:L1-L60](https://github.com/yorch/cc-analyzer/blob/bf5a4c8/src/core/pricing.ts#L1-L60)).

**Estimated cost** — A cost flagged approximate because the model matched only by family heuristic (not an exact table entry) or could not be priced.

**Family heuristic** — The model-resolution fallback: exact id → `anthropic/`-prefixed → `opus`/`sonnet`/`haiku` family, so newer versioned models still get a price (as an estimate).

**SessionAnalysis** — The central per-session data structure produced by `analyzeSession()`: totals, per-turn breakdowns, per-model usage, tools, skills, subagents, and files touched ([src/core/analyze.ts:L1-L60](https://github.com/yorch/cc-analyzer/blob/bf5a4c8/src/core/analyze.ts#L1-L60)).

**Transcript / TranscriptItem** — A linear, human-readable flattening of a session's events shared by the TUI and web readers ([src/core/transcript.ts:L1-L60](https://github.com/yorch/cc-analyzer/blob/bf5a4c8/src/core/transcript.ts#L1-L60)).

**Index** — A disposable SQLite cache at `~/.config/cc-analyzer/index.db` holding one flattened row per session; rebuildable from the JSONL files at any time.

**Incremental indexing** — Re-parsing only files changed by size + mtime, pruning rows for deleted files.

**Portfolio analytics** — Aggregations over the index (spend by month/project/model, most expensive sessions) powering the `stats` command and the dashboards.

**State dir** — `cc-analyzer`'s own writable directory (`~/.config/cc-analyzer/`, overridable via `CC_ANALYZER_STATE_DIR`) holding the index, pricing cache, and update-check cache. Distinct from the read-only Claude data dir (`~/.claude`, overridable via `CC_ANALYZER_CLAUDE_DIR`).

**Embedded version** — The build-time version, imported from `package.json` and bundled by `bun --compile`, so the running binary reports its own version ([src/core/version.ts:L1-L8](https://github.com/yorch/cc-analyzer/blob/bf5a4c8/src/core/version.ts#L1-L8)).

**Compiled binary** — A `bun build --compile` standalone executable, detected via the `$bunfs` marker in `import.meta.url`; self-update only runs in this mode ([src/core/update.ts:L1-L20](https://github.com/yorch/cc-analyzer/blob/bf5a4c8/src/core/update.ts#L1-L20)).

**Self-update** — `cc-analyzer update`: resolve the latest release, download the matching asset, verify its checksum, and atomically replace the running binary (macOS/Linux); Windows delegates to the installer ([src/core/update.ts:L1-L138](https://github.com/yorch/cc-analyzer/blob/bf5a4c8/src/core/update.ts#L1-L138)).

**Update check** — A passive, once-a-day cached "update available" notice printed after quick commands; disabled in CI, non-TTY, `--json`, and via `CC_ANALYZER_NO_UPDATE_CHECK`.

**SHA256SUMS / checksum verification** — A manifest of asset hashes published with each release; the installers and `update` verify the download against it before installing, degrading gracefully when it is absent ([src/core/checksum.ts:L1-L33](https://github.com/yorch/cc-analyzer/blob/bf5a4c8/src/core/checksum.ts#L1-L33)).

**SPA embedding** — Serializing the Vite-built single-file front end into a string in `src/web/spa.ts`, so `bun build --compile` bakes the whole UI into the binary.

**Wiki sync** — The build step that copies the canonical `/wiki` into the VitePress `site/docs/`, normalizing filenames and links; `/wiki` is the single source of truth for the docs site.

Sources: [src/core/analyze.ts:L1-L60](https://github.com/yorch/cc-analyzer/blob/bf5a4c8/src/core/analyze.ts#L1-L60) [src/core/pricing.ts:L1-L60](https://github.com/yorch/cc-analyzer/blob/bf5a4c8/src/core/pricing.ts#L1-L60) [src/core/steps.ts:L1-L60](https://github.com/yorch/cc-analyzer/blob/bf5a4c8/src/core/steps.ts#L1-L60) [src/core/update.ts:L1-L138](https://github.com/yorch/cc-analyzer/blob/bf5a4c8/src/core/update.ts#L1-L138) [src/core/checksum.ts:L1-L33](https://github.com/yorch/cc-analyzer/blob/bf5a4c8/src/core/checksum.ts#L1-L33)
