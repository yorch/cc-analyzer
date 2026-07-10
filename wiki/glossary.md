# Glossary

> Indexed at commit `4eeed24` on 2026-07-10 · [view on GitHub](https://github.com/yorch/cc-analyzer/tree/4eeed24)

Domain terms used throughout `cc-analyzer` and its wiki. Definitions are grounded in the code that implements them.

## Relevant source files

- [src/core/analyze.ts](https://github.com/yorch/cc-analyzer/blob/4eeed24/src/core/analyze.ts)
- [src/core/pricing.ts](https://github.com/yorch/cc-analyzer/blob/4eeed24/src/core/pricing.ts)
- [src/core/transcript.ts](https://github.com/yorch/cc-analyzer/blob/4eeed24/src/core/transcript.ts)
- [src/core/discover.ts](https://github.com/yorch/cc-analyzer/blob/4eeed24/src/core/discover.ts)
- [src/core/pricing-source.ts](https://github.com/yorch/cc-analyzer/blob/4eeed24/src/core/pricing-source.ts)

## Terms

**Session** — One Claude Code conversation, stored as a single JSONL file at `~/.claude/projects/<project>/<session>.jsonl`. Each line is one event. A session's basename is usually a UUID and serves as its id ([src/core/discover.ts:L14-L21](https://github.com/yorch/cc-analyzer/blob/4eeed24/src/core/discover.ts#L14-L21)).

**Project** — A directory under `~/.claude/projects/` grouping the sessions for one working directory. Its encoded directory name is the stable **project id**; the authoritative human path comes from a session's `cwd` field, not from decoding the id ([src/core/discover.ts:L5-L12](https://github.com/yorch/cc-analyzer/blob/4eeed24/src/core/discover.ts#L5-L12)).

**Event / SessionEvent** — One parsed line of a session file. Events are typed (`user`, `assistant`, and others) and validated with Zod; an unrecognized or drifted line becomes a tolerant "unknown" event rather than an error ([src/core/analyze.ts:L110-L116](https://github.com/yorch/cc-analyzer/blob/4eeed24/src/core/analyze.ts#L110-L116)).

**Turn** — The central unit of analysis: one genuine user prompt plus every assistant API call and tool loop until the next genuine prompt. Turn boundaries are set by `isRealPrompt()` ([src/core/analyze.ts:L216-L231](https://github.com/yorch/cc-analyzer/blob/4eeed24/src/core/analyze.ts#L216-L231)).

**Real prompt** — A user event that starts a new turn: it is not meta and carries content other than `tool_result` blocks. User events that only carry tool results are loop continuations, not turns ([src/core/analyze.ts:L118-L130](https://github.com/yorch/cc-analyzer/blob/4eeed24/src/core/analyze.ts#L118-L130)).

**Meta event** — A system-injected user message (caveats, command output, reminders) flagged with `isMeta`. Meta events are excluded from turn counting because they are not genuine prompts ([src/core/analyze.ts:L122-L127](https://github.com/yorch/cc-analyzer/blob/4eeed24/src/core/analyze.ts#L122-L127)).

**API call** — One assistant event, corresponding to a single request to the model. Each carries a `usage` block, a model id, and any tool-use blocks it produced; a turn aggregates one or more API calls ([src/core/analyze.ts:L28-L36](https://github.com/yorch/cc-analyzer/blob/4eeed24/src/core/analyze.ts#L28-L36)).

**Tool call** — A `tool_use` block emitted by the assistant (Bash, Edit, Read, and so on). Its error status is resolved by matching the tool-use id against the `tool_result` blocks collected across the session ([src/core/analyze.ts:L144-L159](https://github.com/yorch/cc-analyzer/blob/4eeed24/src/core/analyze.ts#L144-L159)).

**Sidechain** — An API call made outside the main conversation thread, marked by `isSidechain`. Sidechains typically come from subagent work and are captured per API call ([src/core/analyze.ts:L270-L278](https://github.com/yorch/cc-analyzer/blob/4eeed24/src/core/analyze.ts#L270-L278)).

**Skill** — A named capability invoked via the `Skill` tool. `cc-analyzer` extracts the skill (or command) name from the tool input and records the set used per session ([src/core/analyze.ts:L257-L259](https://github.com/yorch/cc-analyzer/blob/4eeed24/src/core/analyze.ts#L257-L259)).

**Subagent** — A delegated agent launched via the `Task` tool. Its `subagent_type` is recorded so a session's set of subagents can be reported ([src/core/analyze.ts:L260-L263](https://github.com/yorch/cc-analyzer/blob/4eeed24/src/core/analyze.ts#L260-L263)).

**Files touched** — The set of file paths passed to file-mutating tools (`Write`, `Edit`, `MultiEdit`, `NotebookEdit`), collected per session ([src/core/analyze.ts:L86-L86](https://github.com/yorch/cc-analyzer/blob/4eeed24/src/core/analyze.ts#L86-L86)).

**Token categories** — The four separately-priced kinds of tokens: input, output, cache-write, and cache-read. `cc-analyzer` extracts all four from each `usage` block ([src/core/pricing.ts:L22-L28](https://github.com/yorch/cc-analyzer/blob/4eeed24/src/core/pricing.ts#L22-L28)).

**Cache-write (5m / 1h TTL)** — Tokens written into the prompt cache, priced by their time-to-live: a 5-minute TTL costs roughly 1.25× input, a 1-hour TTL roughly 2× input. The two are tracked as distinct token counts ([src/core/pricing.ts:L13-L17](https://github.com/yorch/cc-analyzer/blob/4eeed24/src/core/pricing.ts#L13-L17)).

**Cache-read** — Tokens served from the prompt cache, priced well below input tokens. Because cache reads dominate long agentic sessions, correct cache accounting is where most real spend is captured ([src/core/pricing.ts:L1-L8](https://github.com/yorch/cc-analyzer/blob/4eeed24/src/core/pricing.ts#L1-L8)).

**Cost breakdown** — The derived per-category cost (`input`, `output`, `cacheWrite`, `cacheRead`, `total`) for a set of token counts under a model's pricing ([src/core/pricing.ts:L56-L75](https://github.com/yorch/cc-analyzer/blob/4eeed24/src/core/pricing.ts#L56-L75)).

**Estimated cost** — A cost flagged as approximate because the model could not be priced from an exact table entry — either it was unpriced, or it matched only by family heuristic ([src/core/pricing.ts:L30-L38](https://github.com/yorch/cc-analyzer/blob/4eeed24/src/core/pricing.ts#L30-L38)).

**Family heuristic** — The fallback in model resolution: when no exact or `anthropic/`-prefixed match exists, the model id is matched to an `opus`/`sonnet`/`haiku` family so newer versioned models still receive a price (as an estimate) ([src/core/pricing.ts:L106-L123](https://github.com/yorch/cc-analyzer/blob/4eeed24/src/core/pricing.ts#L106-L123)).

**Pricing table** — A map from model id to per-token rates. It is fetched from LiteLLM, cached in the state dir, and falls back to a bundled table when offline ([src/core/pricing-source.ts](https://github.com/yorch/cc-analyzer/blob/4eeed24/src/core/pricing-source.ts)).

**Transcript / TranscriptItem** — A linear, human-readable flattening of a session's events (prompt, text, thinking, tool_use, tool_result), shared by the TUI and web readers. Turn numbering follows genuine prompts ([src/core/transcript.ts:L1-L17](https://github.com/yorch/cc-analyzer/blob/4eeed24/src/core/transcript.ts#L1-L17)).

**SessionAnalysis** — The central per-session data structure produced by `analyzeSession()`: totals, per-turn breakdowns, per-model usage, tools, skills, subagents, and files touched ([src/core/analyze.ts:L68-L84](https://github.com/yorch/cc-analyzer/blob/4eeed24/src/core/analyze.ts#L68-L84)).

**Web search / web fetch** — Server-side tool invocations counted from `usage.server_tool_use` (`web_search_requests`, `web_fetch_requests`) and reported in session totals ([src/core/analyze.ts:L236-L237](https://github.com/yorch/cc-analyzer/blob/4eeed24/src/core/analyze.ts#L236-L237)).

**Index** — A disposable SQLite cache at `~/.config/cc-analyzer/index.db` holding one flattened row per session. It can be deleted and rebuilt from the JSONL files at any time.

**Incremental indexing** — The reindex strategy: files whose size and mtime are unchanged since the last index are skipped, changed files are re-parsed, and rows for deleted files are pruned.

**Portfolio analytics** — Aggregations computed over the index (total spend, spend by month/project/model, most expensive sessions) that power the `stats` command and the web dashboard.

**State dir** — `cc-analyzer`'s own writable directory (`~/.config/cc-analyzer/`, overridable via `CC_ANALYZER_STATE_DIR`) holding the index and pricing cache. Distinct from the read-only Claude data dir (`~/.claude`, overridable via `CC_ANALYZER_CLAUDE_DIR`).

**SPA embedding** — The build step that serializes the Vite-built single-file front end into a string in `src/web/spa.ts`, so `bun build --compile` bakes the entire UI into the binary with no external assets.

Sources: [src/core/analyze.ts:L68-L263](https://github.com/yorch/cc-analyzer/blob/4eeed24/src/core/analyze.ts#L68-L263) [src/core/pricing.ts:L1-L123](https://github.com/yorch/cc-analyzer/blob/4eeed24/src/core/pricing.ts#L1-L123) [src/core/transcript.ts:L1-L17](https://github.com/yorch/cc-analyzer/blob/4eeed24/src/core/transcript.ts#L1-L17) [src/core/discover.ts:L1-L21](https://github.com/yorch/cc-analyzer/blob/4eeed24/src/core/discover.ts#L1-L21)
