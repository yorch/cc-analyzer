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

**Turn-scoped skill cost** — The primary skill-cost number: the total cost of the *turns* that invoked a skill (the turn's API calls, its tool loop, and any subagent burst inside it), accumulated per session in `SessionAnalysis.skillTurnCosts`, stored in the index column `skill_turn_costs_json` (schema v10), and summed across sessions into `SkillUsageRow.attributedTurns` / `attributedCost`. Tighter than the session-scoped `totalCost` (a session's whole cost charged to every skill it touched, kept as an upper bound), but still correlational, not causal: a turn invoking several skills counts its full cost toward each. Every surface prints the shared `SKILL_COST_CAVEAT` ([src/core/analyze.ts](https://github.com/yorch/cc-analyzer/blob/51ccd4e/src/core/analyze.ts), [src/core/stats-types.ts](https://github.com/yorch/cc-analyzer/blob/51ccd4e/src/core/stats-types.ts)).

**Parse coverage** — How much of a session file this build of the parser actually understood: `lines` seen, `parseErrors` (lines that produced no event — invalid JSON or a non-object), and `unknownEvents` (lines kept only as tolerant "unknown" events, whether a known type whose schema drifted or a type this parser has never seen). Carried on `SessionAnalysis.parseCoverage`, stored in the index columns `parse_lines` / `parse_errors` / `unknown_events` (schema v11), and rolled up portfolio-wide and per Claude Code version by `parseCoverage()` as `unparsedShare = (parseErrors + unknownEvents) / lines`. It exists because the JSONL format is undocumented and changes between releases: unparsed lines are silently excluded from every metric, so this is the signal that says when the numbers are incomplete — and what the `parse-coverage-drop` insight fires on ([src/core/parser.ts](https://github.com/yorch/cc-analyzer/blob/main/src/core/parser.ts), [src/core/stats.ts](https://github.com/yorch/cc-analyzer/blob/main/src/core/stats.ts)).

**Token categories** — The four separately-priced kinds of tokens: input, output, cache-write, and cache-read ([src/core/pricing.ts:L1-L60](https://github.com/yorch/cc-analyzer/blob/51ccd4e/src/core/pricing.ts#L1-L60)).

**Cache-write (5m / 1h TTL) / Cache-read** — Tokens written into the prompt cache (priced by time-to-live) and tokens served from it (priced well below input). Cache accounting is where most real spend hides ([src/core/pricing.ts:L1-L60](https://github.com/yorch/cc-analyzer/blob/51ccd4e/src/core/pricing.ts#L1-L60)).

**Context tax** — The tokens a session pays before the user types anything: system prompt + `CLAUDE.md` + MCP tool schemas, approximated by the prompt-side tokens of the session's first main-chain API call (`SessionAnalysis.firstPromptTokens`, index column `first_prompt_tokens`, schema v9). `contextTax()` reports it per project as median / p90 / average. A heuristic baseline — continuation sessions and large opening pastes inflate individual sessions, so the median is the honest read ([src/core/stats.ts:L1-L60](https://github.com/yorch/cc-analyzer/blob/51ccd4e/src/core/stats.ts#L1-L60)).

**What-if repricing** — `whatIfRepricing()`, which replays each model's actual token mix (all four categories, both cache-write TTLs) at the rates of the other models the user ran — falling back to a canonical model per family when fewer than two of theirs are priceable. Strictly a rate comparison: a different model would produce different tokens, and quality is not priced in ([src/core/stats.ts:L1-L60](https://github.com/yorch/cc-analyzer/blob/51ccd4e/src/core/stats.ts#L1-L60)).

**Setup inventory** — What is *installed* under the Claude config dir: skills (`skills/<name>/SKILL.md`), subagents (`agents/<name>.md`), plugins and the skills/agents they ship, MCP servers (from `settings.json` and the sibling `~/.claude.json`, global or project-scoped), hook events, permission rule counts, and any pinned model. Produced by `scanInventory()`, which is read-only and never throws ([src/core/inventory.ts](https://github.com/yorch/cc-analyzer/blob/51ccd4e/src/core/inventory.ts)).

**Setup audit** — The cross-reference of the setup inventory against observed usage from the index, produced by the Bun-free `buildSetupAudit(inventory, usage, today)`. It emits `session-diagnostics`-shaped findings: `unused-mcp-server` and `error-prone-skill` (warnings), `unused-skill`, `unused-agent`, `stale-skill`, and `missing-but-used` (info). Surfaced by `cc-analyzer audit`, `GET /api/audit`, and the web Tools view's Setup section. Machine-local and historical: sessions may predate the current setup, and project-scoped items live outside the config dir ([src/core/setup-audit.ts](https://github.com/yorch/cc-analyzer/blob/51ccd4e/src/core/setup-audit.ts)).

**Portfolio insights** — The ranked, explainable findings the Bun-free rules engine `buildPortfolioDiagnostics(signals)` folds out of every portfolio signal (cache, compactions, context tax, what-if repricing, retries, weekly error trend, spend concentration, pricing confidence, the setup audit, subagent balance). Findings follow the `session-diagnostics` shape — code, severity, evidence, action, plus a project pointer when scoped — with warnings ranked before infos and dollar-backed findings first within a severity. Deliberately named heuristics with documented thresholds, not a score. Surfaced by `cc-analyzer insights`, the `diagnostics` field of `GET /api/insights`, and the web/TUI Insights views; signals are assembled identically everywhere by `assemblePortfolioSignals(db, pricing)` ([src/core/portfolio-diagnostics.ts](https://github.com/yorch/cc-analyzer/blob/51ccd4e/src/core/portfolio-diagnostics.ts)).

**Cache efficiency** — How well cache-write spend is amortized by later cache reads. The Insights view ranks projects and sessions by un-amortized cache-write spend (the "leakiest" work) ([src/core/stats.ts:L1-L60](https://github.com/yorch/cc-analyzer/blob/51ccd4e/src/core/stats.ts#L1-L60)).

**Estimated cost** — A cost flagged approximate because the model matched only by family heuristic (not an exact table entry) or could not be priced.

**Cost basis** — A persisted display preference (`"api"` or `"subscription"`, default `"api"`), set with `cc-analyzer cost-basis` and stored in `<stateDir>/prefs.json` (`src/core/prefs.ts`). It never changes how a dollar figure is computed — costs are always tokens × the pricing table — only how it's framed: `"api"` reads it as a bill, `"subscription"` (for flat-plan Pro/Max users) frames the same number as API-equivalent value via one canonical sentence (`costFramingNote()` in the bun-free `src/core/cost-framing.ts`), rendered on the CLI `stats` report, the TUI portfolio lede, and the web Dashboard/Insights pages when set.

**Family heuristic** — The model-resolution fallback: exact id → `anthropic/`-prefixed → `opus`/`sonnet`/`haiku` family, so newer versioned models still get a price (as an estimate).

**SessionAnalysis** — The central per-session data structure produced by `analyzeSession()`: totals, per-turn breakdowns, per-model usage, tools, skills, subagents, and files touched ([src/core/analyze.ts:L1-L60](https://github.com/yorch/cc-analyzer/blob/51ccd4e/src/core/analyze.ts#L1-L60)).

**Transcript / TranscriptItem** — A linear, human-readable flattening of a session's events shared by the TUI and web readers.

**Index** — A disposable SQLite cache at `~/.config/cc-analyzer/index.db` holding one flattened row per session; rebuildable from the JSONL files at any time ([src/core/db.ts:L1-L60](https://github.com/yorch/cc-analyzer/blob/51ccd4e/src/core/db.ts#L1-L60)).

**Schema version** — A `schema_version` stored in the index's `meta` table (currently v9, `SCHEMA_VERSION`). Bumping it invalidates and rebuilds the disposable cache — never a breaking change for users ([src/core/db.ts:L86-L108](https://github.com/yorch/cc-analyzer/blob/51ccd4e/src/core/db.ts#L86-L108)).

**Incremental indexing** — Re-parsing only files changed by size + mtime, pruning rows for deleted files.

**Analytics rollup** — The single-table-scan fold (`analyticsRollup`) over the index's per-session JSON blobs that computes portfolio and project analytics in one pass, so every analytics surface shares the same numbers ([src/core/stats.ts:L1-L60](https://github.com/yorch/cc-analyzer/blob/51ccd4e/src/core/stats.ts#L1-L60)).

**Chart series** — Plottable time-series and distributions built by the bun-free `chart-series.ts` module (e.g. spend burn, compaction, hot files), imported directly by both the TUI and the web SPA so the two frontends chart identical data ([src/core/chart-series.ts:L1-L60](https://github.com/yorch/cc-analyzer/blob/51ccd4e/src/core/chart-series.ts#L1-L60)).

**Bun-free module** — A core module (`stats-types.ts`, `chart-series.ts`, `session-diagnostics.ts`, `setup-audit.ts`, `portfolio-diagnostics.ts`) written without Bun-only APIs so the browser SPA can import it directly, keeping analytics logic single-sourced across frontends.

**Trends** — The time-series view (TUI `TrendsView` / web `Trends`): spend and usage over time with metric and granularity toggles, rendered as braille charts in the terminal and SVG charts on the web.

**Tools analytics** — The tool/skill/subagent usage view (TUI `ToolsView` / web `Tools`): which tools, skills, and subagents are used, how often, and at what cost (skills at both the turn and session scope).

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
