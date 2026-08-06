# Project Guidelines

This file provides guidance to AI Agents when working with code in this repository.

> The file `CLAUDE.md` is a symlink to `AGENTS.md`, so any changes in either file are reflected in the other.

`cc-analyzer` is a **read-only** CLI that browses and analyzes Claude Code sessions
stored in `~/.claude` (or any other configured Claude data directory, several at
once). It never writes to them; its own state (pricing cache,
SQLite index) lives under `~/.config/cc-analyzer/`. Runtime is **Bun ≥ 1.3**;
it ships as a single compiled binary.

## Commands

```bash
bun install
bun start <command>          # run the CLI (alias for: bun run src/cli/index.ts)

bun test                     # full test suite (bun's built-in runner)
bun test test/core/analyze.test.ts   # a single test file
bun test -t "computeCost"    # tests matching a name

bun run lint                 # Biome check (no writes)
bun run check                # Biome lint + format, autofix
bun run typecheck            # tsc for core/CLI/TUI/server (root tsconfig)
bun run typecheck:web        # tsc for the web SPA (web/tsconfig.json)

bun run dev:web              # Vite dev server for the SPA
bun run build:web            # Vite build → web/dist/index.html
bun run build                # build:web, disposable embed, compile → dist/cc-analyzer
```

There are **two separate typecheck commands** because there are two tsconfigs with
incompatible settings (see below). CI runs both; run both before claiming types pass.

Env overrides (used in tests): `CC_ANALYZER_CLAUDE_DIR` (Claude data dir; a
`PATH`-style list is accepted), `CC_ANALYZER_STATE_DIR` (cc-analyzer state dir).
`CLAUDE_CONFIG_DIR` is read too — see the Claude-roots note below.

## Architecture: one core, three frontends

All parsing, analysis, pricing, and indexing lives in `src/core/`. The three
frontends are thin presentation layers that consume it:

- `src/cli/` — scriptable commands (`index.ts` is the entrypoint + arg router).
- `src/tui/` — interactive terminal UI (Ink + React), launched when the CLI is run
  with no command. Reads from the SQLite index.
- `src/web/` — `cc-analyzer serve`: a Hono API (`api.ts`) plus an embedded React SPA.

The core pipeline for a single session:

```
.jsonl file → parser.ts → SessionEvent[] → analyzeSession() → SessionAnalysis
                                          → buildTranscript() → TranscriptItem[]
```

`SessionAnalysis` is the central data structure (per-turn + aggregate metrics). It
feeds the CLI/web renderers directly, and `indexer.ts` flattens it into a SQLite row.

There is also a **streaming path** for consumers that don't need the full array in
memory: `parser.ts` exposes `streamSessionEvents(path)` (an `AsyncGenerator`), and
`analyzeSession` is a thin wrapper over a shared `SessionAnalyzer` accumulator that
`analyzeSessionStream(iterable, pricing, { detail })` also drives. The **indexer**
uses `analyzeSessionStream(streamSessionEvents(path), …, { detail: false })` so a
multi-hundred-MB session indexes without ever materializing the event array or the
per-turn timeline (it stores only aggregates). The interactive consumers
(CLI `analyze`, web, TUI) keep the array path — they render the full output and
reuse the events for `buildTranscript`.

## Concepts that span multiple files (read before editing)

**Turn segmentation.** A *turn* is one genuine user prompt plus every assistant
API call and tool loop until the next prompt. The discriminator `isRealPrompt()`
lives in `events.ts` (a user event that is not a sidechain, not `isMeta`, not a
machine-written compaction summary (`isCompactSummary`), and carries something
other than `tool_result` blocks) and is shared by both
`analyze.ts` and `transcript.ts`, so turn boundaries can't drift between them —
change the rule in one place.

**Streamed responses are de-duplicated.** A single API response is logged as one
`assistant` line per content block, each repeating the same `message.id` /
`requestId` and full `usage`. `analyzeSession` keys an `ApiCall` by that id and
merges continuation lines into it, counting `usage` exactly once — so token and
cost totals aren't inflated by the streaming block count.

**Derived activity metrics are heuristics — keep them honest.** `analyze.ts` also
computes: *active time* (timestamps sorted, then gaps ≤ `ACTIVE_GAP_MS` (5 min)
summed — longer gaps are idle, and sorting keeps it ≤ duration under sidechain
interleaving); the *sidechain split* (API calls with `isSidechain`, i.e. subagent
spend); *turn depth* (main-chain calls per turn — a subagent burst is one step;
`Turn.mainApiCalls` in detail mode, and the `turnDepths` aggregate carries the
same series through the indexer's aggregate mode); *retries* (a tool call
identical to the immediately
preceding one on the same chain — chain identity resolves through `parentUuid`,
so parallel subagents get independent cursors, and every cursor resets at each
new turn); and the two **thrash** signals (schema v12) — *test-fail streak*
(`testFailStreak`: the longest run of consecutive failing test runs on one
chain; a pass resets it, non-test calls in between don't, new turn resets — the
edit→test→fail loop; unlike command heads this bakes `isTestCommand()` into the
index and needs a reindex to evolve, the trade-off `testRuns` already makes)
and *redundant reads* (`redundantReads`/`rereadFiles`: per chain, `Read`s of
the same `file_path` beyond the second — the third read is the first redundant
one; different offset/limit still counts, chains stay isolated, turns don't
reset). Both feed the `edit-test-thrash`/`repeated-file-reads` session
diagnostics and the `test-thrash-pattern`/`reread-heavy` insight rules. The two
**correction** signals (schema v13) measure prompts redoing the previous turn:
*interruption turns* (`interruptionTurns`: turns whose events carry the literal
machine-written `[Request interrupted by user…]` marker, centralized by
`isInterruptionEvent()` / `isInterruptionMarker()` in `events.ts` — once per
turn, main chain only; it rides on the message text or inside a `tool_result`
block's content (string or nested blocks) when the
interrupt cancelled a pending tool call, and that carrier is *not* a real prompt
so it marks the turn already open; a plain marker message IS a real prompt, so
turn segmentation is unchanged and it usually opens its own short turn) and
*correction turns* (`correctionTurns`: real prompts opening with a correction
marker per `isCorrectionPrompt()` in `events.ts` — a conservative
**English-only keyword heuristic** over the first ~120 chars in **two tiers**:
outcome/miscommunication phrases ("that's not what i", "still broken", "same
error") match anywhere in that window, imperative/ambiguous ones ("no, …",
"undo that", "go back to", "try again", "not working") must open the prompt,
because each is also ordinary product language mid-sentence ("add a back button
so users can go back to the list view"); never matching `<`/`/`/`[`-leading
prompts; false negatives are fine, false positives are the failure mode; like
`testFailStreak` the phrase list is baked into the index and needs a reindex to
evolve — a pinning test over the exported `CORRECTION_PATTERN_SOURCE` fails on
any edit and says to bump `SCHEMA_VERSION`). The two counters are independent — an interrupted turn followed by a
"no, …" prompt counts once in each. In **detail mode** each `Turn` additionally
carries its own signal positions — `retries`, `redundantReads`, `testFailures`
(attributed to the *issuing* turn through the pending-tool map, since a test's
result can land after the next prompt already opened a new turn), and the
`interrupted`/`correction` flags — which is what lets the session charts mark
*where* the churn happened; the session counters, aggregate mode, and the index
columns are unchanged. Share = `correctionTurns / totals.turns`
(turns counts exactly the real prompts); every render site prints the shared
`CORRECTION_CAVEAT` from `stats-types.ts`. They feed the `correction-loop`
session diagnostic and the `correction-heavy` insight rule, and roll up (with a
weekly trend) as `AnalyticsRollup.corrections`. For
shell commands the index stores a **raw signal, not a
classification**: normalized per-segment command heads (`commandHead()`, schema
v6). Command families and test-run detection (`isTestCommand()`) classify those
heads **at query time** in `stats.ts`, so the heuristics can evolve without a
reindex; `analyze.ts` still classifies live for single-session views. All of
these flatten into index columns and roll up in `stats.ts` — the per-session
JSON blobs fold in **one table scan** via `analyticsRollup()` (used by the web
`/api/analytics`, the TUI tools view, and CLI stats), the portfolio overview
shared by `cc-analyzer stats` and `/api/stats` is assembled only by
`buildPortfolioStats()`, and `serve` memoizes aggregate responses against an
index fingerprint (row count + newest `indexed_at`). The pure shapes and date
helpers live in `stats-types.ts`, a bun-free module the web SPA imports directly
so client and server types cannot drift. Several rollups are **session-scoped
and correlational** (permission-mode cost, branch cost, idle-vs-cache
buckets): a session counts its full cost toward each label it carries. Keep the
"correlational, not causal" caveat wherever they're rendered.

**Skill cost is turn-scoped first.** The session-scoped number was too weak to
act on, so `analyze.ts` attributes each skill the cost of the *turns* that
invoked it: the `SessionAnalyzer` accumulates the open turn's total cost (every
API call in it — sidechains included, since a subagent burst belongs to the turn
that spawned it) plus the set of skills invoked in it, and folds them into
`SessionAnalysis.skillTurnCosts` (`{ turns, cost }` per skill) at the *same*
turn boundary `turnDepths` uses — so it works in aggregate mode, with no
materialized turns. Attribution keys off the `Skill` tool_use, not its
later-arriving tool_result, and pre-first-prompt events belong to no turn. It
flattens to the `skill_turn_costs_json` column (**schema v10** forces the
rebuild — the incremental indexer would otherwise leave v9 rows unattributed
forever) and sums in `analyticsRollup()` into `SkillUsageRow.attributedTurns` /
`attributedCost`, the **primary** cost columns everywhere (CLI `stats` and the
single-session report, TUI skills panel, web Tools). Session-scoped
`totalCost`/`avgCostPerSession` stay beside them as the whole-session upper
bound. Turn scope is tighter but still **not causal** — a turn invoking N
skills counts its full cost toward each — so every render site prints the
shared `SKILL_COST_CAVEAT` from `stats-types.ts` verbatim.

**Compactions and session charts.** `analyze.ts` records context compactions
(`SessionAnalysis.compactions`) from `system`/`compact_boundary` events (trigger +
`preTokens`), falling back to `isCompactSummary` user prompts for older Claude Code
files; a boundary and its immediately-following summary prompt count as one
compaction. The per-session charts — TUI `SessionDetailScreen` charts mode and the
web session Charts tab — render series built in `chart-series.ts`, a **bun-free**
module (like `stats-types.ts`) the SPA imports directly, so both frontends chart
identical numbers: context-window fill per main-chain API call (sidechains run in
their own context windows and are excluded), cumulative burn (main + sidechain),
per-turn cost/tokens/calls, and compaction markers mapped onto the call axis.
Around that spine sit the derived series, all in the same module: the **cache
series** (`buildCacheSeries`, cached vs fresh prompt-side split + token-weighted
hit rate + cold-call count, derived from the context series' points so the two
charts describe the same calls), **idle-gap markers** on the burn series
(`buildGapMarkers` places the analyzer's `totals.idlePeriods` — the exact gaps
`activeMs` excluded, over ALL event timestamps — onto the call axis, so a
chart's "idle" total is `durationMs − activeMs` and a long-running tool whose
result lands mid-gap is active, never phantom idle), the **headroom
projection** (`projectHeadroom`: linear context growth over the calls since the
last compaction, ≥ 3 points and a known window required, flat/shrinking →
undefined — a projection, not a promise), a per-marker `reclaimed` token count
(`preTokens` minus the first post-compaction call's context, clamped at 0,
absent when either side is unknown), the in-session **model mix**
(`modelMixRows`), and the widened `TurnPoint` (the four cost categories which
sum to `cost`, `wallMs`, operation-step `kindCounts` + `toolErrors`, and the
per-turn signal flags below). `turnFlags()` is the ONE "is this turn worth
flagging" predicate (interrupted / correction / retries / test failures /
redundant reads / tool errors) — the web tooltips and marks and the TUI ▲ row
both render exactly its output; the web timeline's red lanes are deliberately
the narrower user-intervention subset (interrupted/correction only). The
analyzer also groups sidechain calls into
**`SessionAnalysis.sidechainBursts`** — one entry per chain, so "which subagent
burst cost $3" is answerable — with a **best-effort** `subagentType`: a burst's
root sidechain user event repeats the Task prompt verbatim, so bursts join to
main-chain `Task`/`Agent` spawns by normalized prompt (each spawn consumed
once, in order), falling back to an order-zip only when nothing matched and the
counts align exactly; anything else stays unnamed rather than guessed —
which is why render sites keep the accurate `subagents` type list alongside
the burst table instead of replacing it. `groupSidechainBursts()` is the one
per-type rollup (label, fold, ordering) over them. Bursts are **detail-mode
only** (always empty in aggregate mode — the indexer's streaming path never
reads them and must not pay for the per-chain accumulators) and are not
flattened into the index.
Pricing's `maxInputTokens` (LiteLLM `max_input_tokens`, also in the bundled
snapshot; the pricing cache is format-versioned so pre-upgrade caches refresh)
flows through `resolveModel` into `ModelUsage.contextLimit` →
`ContextSeries.contextLimit` (suppressed when the peak exceeds it — a
bigger-window variant priced by the family heuristic), so both context charts
scale to the window and label "% of window" via the shared `pctOfLimit` (the
web draws the dashed limit line; the TUI braille chart takes the limit as its
ceiling). Compaction records carry the boundary event's `uuid`;
`compactionUsage()` filters every category through `dedupeCompactions()`
portfolio-wide, so a copied session file (or continuation edge case) never
counts one compaction twice — the `compactions` INT column stays a per-row
SUM-able convenience (schema v8 forces the rebuild that backfills uuids).
Subagents compact too (`compact_boundary` with `isSidechain`): those compactions
are captured and counted but never marked on the main-chain context chart —
they compacted the subagent's own window. Continuation files copy the parent
session's final boundary at their start; the analyzer flags those `inherited`
(boundary before any API call). Schema v7 flattens compactions into the index:
the `compactions` INT column counts only a session's *own main-chain*
compactions (sidechain + inherited excluded, so one compaction never counts in
two rows), with full detail in `compactions_json`; `compactionUsage()` rolls up
portfolio pressure for `/api/analytics` and the web Tools view.

**Context tax and what-if repricing are the two cost-optimization rollups.**
*Context tax* is what a session pays before the user types: `analyze.ts`
records `SessionAnalysis.firstPromptTokens` — the prompt-side tokens (input +
cache-read + both cache-write TTLs) of the **first main-chain** API call, read
off the de-duplicated call so streamed continuation lines can't shift it, and
populated in aggregate mode like `promptChars`/`turnDepths`. Sidechains are
skipped (subagents have their own context window). It flattens to the
`first_prompt_tokens` INT column — NULL, not 0, when the session made no
main-chain call, since absent ≠ zero — and **schema v9** forces the rebuild
that fills it (the incremental indexer skips unchanged files, so v8 rows would
stay NULL forever). `contextTax()` groups by project and takes median / p90 /
mean through the same `percentile` helper as `costDistribution`; it is a
heuristic baseline, so keep the "continuation sessions and big opening pastes
inflate it — read the median" caveat at every render site.
*What-if repricing* (`whatIfRepricing()`) replays each model's actual token mix
at other models' rates. The fold itself — alternative selection, all four
categories, both cache-write TTLs — is `repriceModelMixes()` in the **bun-free**
`session-insights.ts`; `whatIfRepricing()` only feeds it `modelTotals()` (the
same accumulator `spendByModel()` uses, so the two can't disagree), and prices
through the existing `computeCost`. Alternatives are the *other models in the
mix*, capped to ids `resolveModel()` can price (an unresolvable id would cost
$0 and read as a huge saving), falling back to `FALLBACK_WHATIF_MODELS` (one
model per family, newest in the bundled snapshot; now exported from
`session-insights.ts`, re-exported by `stats.ts`) when fewer than two of theirs
resolve. It is a **rate comparison only**: a different model would produce
different tokens, and quality is not priced in — that caveat is the exported
`WHATIF_CAVEAT` in `stats-types.ts`, mandatory wherever it renders. Both ride
on `/api/analytics` (memoized on the same fingerprint), both are sections of
`cc-analyzer stats` (and its `--json`), the web Insights view renders both as
tables, and the TUI Insights header carries them as two summary lines computed
at the screen boundary.

**Session-scoped insights share the portfolio's folds.** `session-insights.ts`
(bun-free) is the per-session half of the cost-optimization story:
`sessionWhatIf(analysis.models, pricing)` runs the *same* `repriceModelMixes`
fold as the portfolio, and `sessionOutcomes(analysis)` derives the
cost-per-outcome ratios (per turn / per file touched / per test run / per
active hour — a ratio is **absent, not $0**, when its denominator is zero) with
the exported `OUTCOME_CAVEAT` ("activity, not value") printed verbatim at every
render site; `outcomeRows()` is the one label/order/skip-undefined row
derivation all three renderers print, and signed dollar deltas go through
`formatSignedUSD` (format-shared) so "saving vs overspend" reads identically
everywhere. `sessionCostRank(db, id)` in `stats.ts` places one session's cost
among the indexed sessions: the percentile is the share costing **strictly
less** (NULL costs read as $0), so a tied-cheapest session is p0, never p100;
portfolio + same-project cohorts fold in ONE table scan; ids resolve through
`sessionRowById` in `queries.ts` — the same rule `sessionPathById` uses, so
the session route and its rank can never resolve different rows — and
un-indexed sessions return undefined. Cohort sizes ride along and render
sites hide the rank below `MIN_RANK_COHORT` (stats-types) sessions — "p50 of
2 sessions" is noise. Surfaces: `cc-analyzer analyze`
appends "Cost per outcome", "What-if repricing" (the what-if is computed in
`cmdAnalyze` and passed in — the renderer never sees the pricing table), and a
"Subagent bursts" table (plus the accurate `Subagents:` type list, which the
best-effort burst join must never replace); `GET /api/sessions/:id` returns
the analysis plus an `insights` sibling (`{ whatIf, rank }` — computed
server-side because pricing and the index live there, in the same handler so a
huge session parses once; the rank memoizes per session id on the index
fingerprint); the SPA derives outcomes client-side from the same payload
(`sessionOutcomes` is bun-free) and renders rank/what-if from `insights`,
guarding `insights === undefined`; the TUI computes its what-if at the screen
boundary from its `pricing` prop. TUI caveat lines render verbatim and wrap —
never `truncate()` a mandatory caveat.

**Setup audit is the one surface that reads config, not transcripts.**
`inventory.ts` (`node:fs`, read-only, never throws) scans **each** configured
Claude root — `scanInventory(root)` per root, folded by `scanInventories()`
(see the Claude-roots note below) — for `settings.json` (permission rule counts, hook events, a pinned
`model`, any `mcpServers`), `skills/<name>/SKILL.md`, `agents/<name>.md`, and a
best-effort walk of `plugins/` — a dir counts as a plugin when it declares
`.claude-plugin/plugin.json` or ships `skills`/`agents`/`commands`, and its own
skills/agents/MCP servers are recorded against it (servers from the plugin's own
`.mcp.json` or a manifest `mcpServers` field, inline or by path; they stay on
`PluginEntry` and are never merged into `SetupInventory.mcpServers`, which
describes what the *user* configured) — plus that root's `.claude.json`, read
from **both** the sibling `<root>.json` of a default install and
`<root>/.claude.json` where Claude Code keeps it once the dir has been
relocated: its top-level `mcpServers` are global, `projects.<path>.mcpServers`
are project-scoped. Every read is wrapped; a missing dir or malformed JSON
shrinks the inventory instead of throwing, because this is user-editable config
whose shape moves between Claude Code releases. `setup-audit.ts` is the
**bun-free** half (the SPA imports its types): `buildSetupAudit(inventory,
usage, today)` — `today` is a parameter, never `Date.now()` — folds
`analyticsRollup`'s `skills`/`subagents`/`tools` against the inventory and
emits `session-diagnostics`-shaped findings: `unused-mcp-server` and
`error-prone-skill` (≥25% errors over ≥5 invocations) as warnings,
`unused-skill`, `unused-agent`, `unused-plugin`, `stale-skill` (≥30 days), and
`missing-but-used` as info. **One classifier answers every name question**:
`attribute(observed, item, owners, userNames)` in `setup-audit.ts` — findings
ask it loosely (anything but `"none"` counts as used, because a loose match is
a false negative, which beats accusing a daily-driver skill of being unused),
the per-plugin numbers ask it strictly (`"owned"` only). A plugin skill may be
invoked qualified (`plugin:skill`) or bare, so either form counts as used, but
an observed **bare** row is owned by the user's own same-named skill when there
is one: the plugin's copy is shadowed, so one erroring `deploy` row reports one
`error-prone-skill` finding (the user's), not one per installed copy. **Usage also rolls up per plugin**:
`buildPluginUsage(inventory, usage)` folds one level higher into a
`PluginUsageRow` per plugin (skills/agents/MCP servers used of shipped,
invocations, subagent sessions — an upper bound, since the rollup only has
per-name counts — turn-scoped `attributedTurns`/`attributedCost` summed over its
skills, and the latest last-used day), sorted by cost then invocations. Here
**usedness stays loose but the numbers are attributed strictly**, because a
loose match on a number is not silence but invention: a qualified row
(`toolkit:fmt`) counts for the plugin it names; a bare row (`fmt`) counts only
when unambiguous — no user-installed skill of that name AND exactly one plugin
shipping it — which is what still sums one skill's two index rows (bare `fmt` +
qualified `toolkit:fmt`) into one plugin row; a bare name shared by two plugins
counts as *used* for each (one of them did run it) but is summed into neither;
and a bare name that is also a user skill is shadowed, counting for no plugin at
all, so that plugin stays eligible for `unused-plugin`. `deadPlugins` keys off
the loose usedness side. The cost is the per-skill turn-scoped attribution, so
`SKILL_COST_CAVEAT` prints at every render site. It rides on
`SetupAudit.plugins`, which is why the CLI `--json` and `/api/audit` carry it for
free. `unused-plugin` fires when *nothing* a plugin ships was used, and it
**replaces** its components' `unused-skill`/`unused-agent` findings (one finding
per dead plugin, not N — the skill/agent loops skip items whose source plugin is
dead); a plugin with nothing discoverable never fires it, since "all zero
components unused" is vacuously true. The audit is machine-local and historical
(sessions can predate the setup; project-scoped items live outside the config
dir) — that caveat ships as the exported `SETUP_AUDIT_CAVEAT` so every render
site prints the same words. Surfaces: `cc-analyzer audit` (+`--json`,
`renderSetupAudit`), `GET /api/audit` (memoized on the index fingerprint plus
the local day; the inventory rescans with the payload), and the web Tools
view's Setup section. **No TUI screen** — the CLI and web cover it.

**Portfolio insights: one bun-free rules engine, one signal assembler.**
`portfolio-diagnostics.ts` generalizes the `session-diagnostics.ts` pattern
portfolio-wide: `buildPortfolioDiagnostics(signals)` folds a single plain-data
`PortfolioSignals` object (stats, rollup, cache summary/TTL/idle-buckets/
per-project waste, compactions, weekly error rate, context tax, what-if,
optional setup audit, parse coverage, thrash, corrections) into ranked `PortfolioDiagnostic[]`
findings — 16 named rules (codes in `PORTFOLIO_DIAGNOSTIC_CODES`), each with a
threshold-rationale comment, warnings before infos and dollar-backed findings first within a
severity; **not a score**. The module is **bun-free and pure** (no db/fs/
`Date.now()` — "today" lives inside the data); the bun-side
`assemblePortfolioSignals(db, pricing, opts?)` in `portfolio-signals.ts`
assembles the signals (including the audit's filesystem inventory scan unless
`{ audit: false }`, and reusing a caller's `{ rollup }` instead of re-scanning
when it has one) so the CLI `insights` command (`renderPortfolioInsights`,
explicit "healthy by every rule" line when nothing fires), `GET /api/insights`
(`diagnostics` field, memoized on fingerprint + local day like `/api/audit`),
and the TUI Insights header (compact glyph+title list, computed at the screen
boundary) all feed the rules identical inputs. The signals object is the
**whole** surface: `serve` memoizes one per `fingerprint():today` and serves
`/api/audit` out of its `audit` field while `/api/insights` reads its cache
summary/TTL/idle buckets, and the TUI Insights screen assembles one and reads
its cache, context tax, and what-if off it rather than recomputing them. None of the rules use the
correlational cost rollups (skill / permission-mode / branch cost); the idle-cache rule carries its
"correlational, not causal" caveat in the finding text.

**The weekly digest is the one period-scoped surface.** Same two-layer split as
the insights engine: bun-free `digest.ts` (shapes, period math on the shared
`weekOf`/`shiftDay`, `digestDelta`, and `buildDigestMarkdown`) plus bun-side
`digest-signals.ts` (`buildWeeklyDigest(db, pricing, { week?, today?, audit? })`).
The default period is the **last complete ISO week** — a half-finished current
week would always read as a decline — and `--week YYYY-MM-DD` / `?week=` picks
the week containing any day (`isDayString` guards both). Period metrics are
**session-day-scoped**: every query filters `day BETWEEN start AND end`, so a
session counts wholly toward the period it *started* in and one running past
midnight is not split; that sentence ships in the rendered footer, not just the
docs. The digest owns **no query of its own** beyond its headline totals: the
period-scoped rollups it needs already exist and take an optional `DayRange`
(`analyticsRollup(db, projectId?, period?)` — the same single scan;
`cacheSummary(db, period?)` — so `DigestCache` is literally `CacheSummary`;
`spendByProject(db, limit, period?)` — the same project ranking `stats` shows),
the model mix folds through the exported `addModelTotalsRow`, and the headline's
token sums reuse the exported `IO_TOKENS` / `CACHE_TOKENS` expressions. So a
digest number and an analytics number for the same span cannot disagree. Each
takes two calls per period (current + prior) by choice: a CASE-bucketed
single-pass query would save one scan and cost the reader the plain reading.
Deltas are null-safe (`share: null` against an empty prior period → render
"new"). The embedded `insights` are deliberately **not** period-scoped: they are
`buildPortfolioDiagnostics` over the whole portfolio (current state), because one
week rarely fires those conservative thresholds honestly — every render site says
so. A zero-session period is **not** an error; an empty index is (exit 1, like
`stats`/`insights`). The model table is the **union** of both periods' models
(ranked by the larger of the two costs), so a model the user stopped running —
the whole point of a weekly read — still shows, with 0 calls against its prior
cost. Surfaces: `cc-analyzer report [--week] [--md|--json]`
(`renderWeeklyDigest`; `--md` prints `buildDigestMarkdown` to stdout — no file
writes; `--md` and `--json` are mutually exclusive and a valueless/flag-shaped
`--week` both exit 2), `GET /api/report?week=` (the period is resolved *before*
the memo, so each ISO week gets its own `report:<start>` slot keyed
`fingerprint():today` like `/api/audit` — two days of one week share an entry
and an old week can't evict the default one; the slot name is the one memo
keyspace a client can enumerate, so it is capped at the most recent
`MAX_REPORT_SLOTS` weeks. `costBasis` is read at the route boundary and passed
in through `WeeklyDigestOptions.costBasis` — the core builder never touches
`prefs.ts` — and rides in the memo *key* rather than being patched over a
cached digest, since it is baked into the framing sentence and the copied
markdown. `?insights=0` builds the digest with an empty snapshot for callers
that render none of it, on its own slot; otherwise the snapshot is injected via
`WeeklyDigestOptions.insights` from the same per-`fingerprint():today` memo
`/api/insights` reads, so the two routes assemble those signals once between
them; the CLI keeps assembling its own), and the web Dashboard's Weekly digest card, whose
"copy as markdown" button imports the same bun-free `buildDigestMarkdown`
instead of adding an endpoint (the card itself fetches `insights=0` and pays
for the full report only on the first copy per cost basis; it refetches when
the cost basis flips, and prints `CORRECTION_CAVEAT` beside its correction
share).
No TUI screen — the CLI and web cover it, and TUI Trends already charts burn.
`SKILL_COST_CAVEAT`, `CORRECTION_CAVEAT`, and the cost-framing sentence print
verbatim wherever their numbers appear.

**Project-scoped charts.** `spendByDay`, `modelMixByDay`, `sessionScatter`,
`costDistribution`, `hotFiles` take an optional `projectId`;
`turnDepthStats()` is their standalone per-project counterpart, and all the
JSON-blob series are built on the same row-fold helpers `analyticsRollup` uses
(so portfolio and project surfaces cannot disagree). `projectTrends()` bundles the six chart series — hot files
stay on `/api/projects/:id/files` — for `/api/projects/:id/trends`, folding the
three JSON-blob series (model mix, tools, turn depth) in one pass over the
project's rows while the SQL aggregates stay in SQLite. The web project page
renders it via the shared chart components in `web/src/trend-charts.tsx` (also
used by the Trends page); the TUI project preview renders
`projectPreviewStats()` (weekly burn sparkline + distribution ramps), computed
at the screen boundary in `ProjectsView` and passed in as plain props — TUI
presentation components never touch the database.

**Cost is derived, not stored.** Sessions record token counts but no cost.
`pricing.ts` computes cost as tokens × per-model rates, pricing the four token
categories separately: input, output, cache-write (5m and 1h TTL), and cache-read.
Cache accounting is where most real spend hides. `resolveModel()` matches a model id
by exact → `anthropic/`-prefixed → family heuristic (opus/sonnet/haiku); a
heuristic (non-exact) match flags the cost as `estimated`. Pricing comes from LiteLLM
(remote, in `pricing-source.ts`), cached in the state dir, with `bundled-pricing.json`
as offline fallback. A dollar figure is always computed the same way regardless of
how the user pays — `computeCost()` has no notion of billing plan. `cost-framing.ts`
(bun-free, imported by the SPA) is the display-only layer on top: the `CostBasis`
preference (`"api" | "subscription"`, persisted by `prefs.ts` under `<stateDir>/prefs.json`
the same tolerant pattern as `telemetry.ts`, default `"api"`) never changes a computed
number, only its wording — `"api"` reads the number as a bill, `"subscription"` (for
flat-plan Pro/Max users) frames the identical number as API-equivalent value via one
canonical sentence, `costFramingNote()`, rendered verbatim wherever it appears. Set with
`cc-analyzer cost-basis api|subscription`, or, for web-only users, the `Seg` toggle on the
web Dashboard hero — `GET`/`PUT` (`POST` accepted too) `/api/prefs` in `src/web/api.ts`,
the API's only write route, which persists only to `<stateDir>/prefs.json` and never
touches `~/.claude`; the SPA calls it then re-triggers its `useAsync` fetch, no reload.
Read at each surface's presentation boundary (CLI `cmdStats`, the TUI `App` component, and
a `costBasis` field merged into `/api/stats` at the route level, read fresh per request
rather than memoized with the rest of the payload) so flipping it — from either surface —
never requires a reindex.

**The index is a disposable cache.** `cc-analyzer index` scans every session, analyzes
it, and upserts a flattened row into SQLite (`bun:sqlite`) at
`~/.config/cc-analyzer/index.db`. It's **incremental** — files unchanged by (size,
mtime) are skipped, deleted files are pruned (root-scoped — see the Claude-roots
note below) — and safe to delete and rebuild. The
TUI and `serve` build an empty index automatically; `serve --refresh` requests an
incremental refresh. Every successful scan persists `last_scan_at`, while
`index --check` and the CLI/TUI/web freshness surfaces compare source (path, size,
mtime) metadata with indexed rows without parsing session content.

**Project ids are lossy encodings.** A project's stable id is its encoded directory
name under `<claudeRoot>/projects/`. `decodeProjectLabel()` is best-effort display only;
the authoritative project path comes from the session's `cwd` field, not by decoding
the id. Never round-trip a real path through the encoded id.

**The Claude data directory is a list, and project ids carry the root.**
`claude-roots.ts` resolves `claudeRoots()` through five exclusive tiers — the
`--claude-dir=` flag, `CC_ANALYZER_CLAUDE_DIR` (a `PATH`-style list, still the
test hook), the `claudeDirs` pref, `CLAUDE_CONFIG_DIR` (what Claude Code itself
reads, so a relocated install works unconfigured), then `~/.claude` — first
non-empty tier wins, so a configured root never mixes the default back in.
`claudeDir()` is the **primary** (first) root and remains what single-root call
sites use. It lives apart from `paths.ts` (which stayed pure location algebra
for cc-analyzer's own state) because resolution does I/O and needs `prefs.ts`,
which reads `paths.ts` for its own location — one module would be a cycle, and
the cycle is what previously forced a second, drifting reader of the same pref.
The roots are resolved **once** and threaded down as a defaulted parameter
(`listProjects`/`listAllSessions`/`scanRoots`/`ReindexOptions.roots`), so a
portfolio scan reads `prefs.json` once rather than once per project — and the
same parameter is the injection seam tests use instead of process globals. The flag is applied by `setClaudeRootsOverride()` at argv-parse time
in `main()` (module state, not an env write, so `claudeRoots()` can report
`source` accurately) and is stripped from argv before dispatch — it must be
written `--claude-dir=<path>`, since the space form would survive
`rest.filter(a => !a.startsWith("--"))` as a positional and shadow
`sessions <projectId>`. It is accepted **only** on the commands that read
session files directly (`projects`/`sessions`/`analyze`/`doctor`) and refused
on every index-backed one: the index always covers the whole configured set, so
a one-invocation scope would be silently ignored on a read and would prune the
un-pointed-at roots on `index`. `CC_ANALYZER_CLAUDE_DIR` stays unguarded as the
hermetic test hook. Two roots can hold a project for the *same* cwd, whose
encoded names are byte-identical, so `qualifyProjectId()` makes the id globally
unique at **index time**: **every** root qualifies, uniformly, as
`rootSlug(path)~<encodedName>` — including the first one. Qualification used to
be conditional (the primary root's ids stayed bare), which made identity
*positional*: reordering the configured list re-keyed a project, so a stored id,
a bookmarked `/api/projects/:id`, or a scripted `sessions <id>` silently meant a
different project. Uniform qualification makes an id a fact about a directory,
and it deleted the two mechanisms that special case had needed — the indexer's
re-stamp `UPDATE` pass, and `discover.ts`'s `roots[0]` fallback for bare ids.
That is deliberate leverage — because the stored `project_id` is unique, every
`GROUP BY project_id` and the `projectScope()` helper in `stats.ts` aggregate
across roots **with no scoping clause anywhere in the query layer**.

The price is that a raw id is neither showable nor typeable, so
`project-labels.ts` (bun-free) owns both directions and every surface goes
through it: `projectDisplayName(path, id)` for output — the path when the index
has one, else the slug-stripped decode, so no `<slug>~<name>` ever reaches a
person — and `resolveProjectRef(ref, knownIds)` for input, where a full id
matches exactly, a bare name resolves when exactly one root holds that project,
and several roots make it **ambiguous rather than silently picked**. Both the
filesystem side (`findProject()` in `discover.ts`, behind `cc-analyzer
sessions`) and the index side (`resolveIndexedProject()` in `queries.ts`, behind
`/api/projects/:id/*` and `/api/insights/:id/sessions`) run that one rule, so a
bare id typed at the CLI and one left in an old bookmark resolve identically —
and the API answers `409` with the candidate list rather than guessing. The
`claude_dir` column (schema v14; v15 re-keyed every id) exists for prune scoping, not for querying:
`reindex()` drops rows whose root is no longer configured (removing a root
removes its data) but **retains** rows under a configured root that was
unreadable this scan, so an unmounted volume never silently wipes a portfolio —
`scanRoots()` in `discover.ts` tells those two cases apart and
`retainsMissingRows()` beside it is the single predicate both `reindex()` and
`inspectIndexStatus()` call, so `index --check` cannot report a deletion the
indexer would not make. Skipped
files are re-stamped rather than re-parsed when a root change re-keys them.
`scanInventories()` folds one inventory per root into one `SetupInventory`
(same-named skills collapse — usage is recorded by name only, so two entries
would report one unused on evidence that cannot tell them apart; hooks and
permission counts sum; the pinned model is the primary root's), and
`SetupInventory.claudeDirs` carries every scanned root (primary first) and is
the *only* field for it — an earlier `claudeDir` alongside it drifted between
the CLI and web render sites within one change. `scanMcpServers()` reads `.claude.json` from **both** the sibling
`<root>.json` of a default install and `<root>/.claude.json`, where Claude Code
keeps it when the dir was relocated, keyed by project path so a root carrying
both files doesn't double-count. Naming projects across roots is one bun-free
decision in `project-labels.ts` (`labelProjects`), imported by the CLI, the TUI,
and the SPA: it qualifies only labels that actually collide, and each surface
renders that decision to fit its medium (the CLI table gets a full-path column,
the space-constrained lists get a `[root]` suffix).

**The parser never throws — and its tolerance is measured, not silent.**
`parser.ts` is tolerant: invalid JSON → recorded `ParseError` and skipped; a
known event type whose Zod schema drifted → kept as a tolerant "unknown" event
so counts stay consistent. Event schemas live in `events.ts`.
`parseSessionFile` streams the file line by line (sessions can be hundreds of MB);
`parseSessionText` is the in-memory path; `streamSessionEvents` yields events one
at a time for bulk consumers. All three share `parseLineOutcome` (per line) and
`readLines` (byte streaming), so their behavior can't drift. (Only file I/O — e.g.
a missing file — throws.)

Because the JSONL format is undocumented and moves between Claude Code
releases, that tolerance is **counted**: `countLine` folds every outcome into a
`ParseCoverage` (`{ lines, parseErrors, unknownEvents }`, declared in
`events.ts` so `analyze.ts` — and through it the SPA — can name the shape
without pulling the Bun-only reader into the browser typecheck graph).
`parseErrors` counts lines that produced **no** event; `unknownEvents` counts
lines kept as tolerant unknowns — schema-drifted known types *and* unrecognized
types in one counter, because they are one actionable signal. The array paths
return it on `ParseResult`; `streamSessionEvents` returns it as the
**generator's return value**, which `analyzeSessionStream` captures by driving
the iterator by hand (a `for await` discards it) — so the streaming path stays
constant-memory and no call site can forget to wire it. It lands on
`SessionAnalysis.parseCoverage` (handed in via `AnalyzeOptions.coverage` on the
array paths; the analyzer never sees unparseable lines), flattens to the
`parse_lines` / `parse_errors` / `unknown_events` columns (**schema v11**), and
rolls up in `parseCoverage()`: a portfolio summary plus per-Claude-Code-version
rows sorted newest first, each with `unparsedShare = (parseErrors +
unknownEvents) / lines`. Version attribution is best effort — a session is
attributed to the newest version it ran under, and version-less sessions count
only toward the summary. Surfaces: `cc-analyzer index --check` (one SQL scan —
`--check` still parses nothing), the CLI `analyze` footer, `/api/analytics` →
the web Tools → Environment section, and the `parse-coverage-drop` portfolio
rule (warning when the newest version's `unparsedShare ≥ 1%` over ≥ 10k lines —
judged per version, not per rolling window, because a format change ships with
a release).

**Session health is evidence-backed and read-only.** `session-health.ts` consumes
the parser's events, `ParseError[]`, and `ParseCoverage` to classify one source as
`healthy`, `warning`, or `damaged`. `cc-analyzer doctor <id|path>` exposes that
report without requiring the index. Missing parent/tool records and events kept
only through tolerant unknown parsing remain warnings because continuation files
and newer Claude Code schemas can be valid; skipped JSONL records, duplicate UUIDs,
and mixed session IDs are errors. Every finding carries observed evidence and
remediation guidance, and no check mutates `~/.claude`.
The analyzer and health engine share `isInterruptionEvent()`: analyzer metrics
attribute the marker to a turn, while doctor reports a session that ends after
the marker separately from an unanswered human prompt.

**Tool results resolve in one pass.** `analyzeSession`/`analyzeSessionStream` don't
pre-scan for `tool_result`s. A `tool_use` registers in a small `pending` map and is
resolved (error count + step patch) when its result arrives later in the stream —
so a single forward pass suffices, which is what makes the streaming indexer path
possible.

**Telemetry has one authority, two governed surfaces.** `core/telemetry.ts` owns
enablement (`CC_ANALYZER_TELEMETRY` → `DO_NOT_TRACK` → `CI` → persisted
`telemetry.json` → default on) and the Plausible poster. The CLI/TUI call
`trackCommand()` at **dispatch time** (before `serve`/`tui` block forever). The
`serve` command's SPA is governed by the **same** switch: `injectSpaTelemetry()`
injects a `window.__CC_TELEMETRY__` config into the served HTML **only when
enabled**, and the SPA (which bundles `@plausible-analytics/tracker`) inits from
it — its absence is the SPA's opt-out. Auto-capture is **off**; the SPA sends
sanitized pageviews via `web/src/view-path.ts`, which maps a route to a view type
(`/session`, `/project`) and **drops the id segment** so session UUIDs and encoded
project paths never leave the machine. The docs site (`site/.vitepress/config.ts`)
is a **separate** static lifecycle — its opt-out is Do-Not-Track / `plausible_ignore`,
not the runtime switch. `trackCommand` is fire-and-forget (swallows all errors,
never blocks); telemetry state lives in the state dir, never `~/.claude`.

**CLI events are delivered by a detached child, not by the parent.** A quick
command (`projects`, `sessions`, `audit` — the ones whose runtime is essentially
all startup) exits within ~15ms of dispatch via `process.exit()`, which kills an
in-flight socket — far short of a cold TLS handshake, so an in-process request
was usually dead on arrival. Slow commands (`stats`, `insights`) were never
affected; the fix is uniform because `trackCommand` is the single choke point.
`trackCommand`
instead re-invokes this executable (`posterArgv`, using `isCompiledBinary()` from
`runtime.ts` to decide between `execPath` and `execPath + Bun.main`) with the
hidden `POSTER_COMMAND` marker, the endpoint, and the already-built event body,
`detached` with no stdio so it survives the parent and completes on its own time.
The child's whole job is `runTelemetryPoster`, which re-checks the opt-out (the
marker is reachable by hand) and always exits 0. The endpoint and payload travel
in **argv**, not the environment, so the child posts exactly where the parent
decided to and never re-opens the index to rebuild the body. A refused spawn
falls back to the old in-process post, which is what the bounded
`flushTelemetry()` at exit still exists to drain — on the normal path nothing is
pending and it returns immediately.

## Self-update subsystem

`version.ts` embeds the version by importing `package.json` (bundled by
`bun --compile`), so a compiled binary knows its own version — keep the tag and
`package.json` version in lockstep at release time. `release.ts` resolves the
latest version by following the `/releases/latest` redirect (no API token/rate
limit) and maps `process.platform`/`process.arch` to release asset names.

`update.ts` self-updates only when running as a **compiled** binary (`runtime.ts`'s
`isCompiledBinary()`: the `$bunfs` marker in `import.meta.url`, with an
`execPath`-basename fallback — shared with the telemetry poster, which re-invokes
the same executable);
it downloads the asset (streamed via `pumpStream` to a `Bun.FileSink` with a
live progress line and a per-chunk **stall timeout**, so the multi-MB download
shows progress instead of looking hung and a true stall aborts rather than
hangs forever, and a short Content-Length download fails instead of installing
truncated), verifies it against the release `SHA256SUMS` (`checksum.ts`;
**required** — an unfetchable manifest aborts the update rather than failing
open), then atomically `rename()`s over `process.execPath`. On Windows it
prints the PowerShell installer one-liner instead of self-updating; running
from source refuses. `update-check.ts` prints a passive, once-a-day cached "update
available" notice — gated off in CI, non-TTY, `--json`, and via
`CC_ANALYZER_NO_UPDATE_CHECK`; it never affects exit codes. The install scripts
in `site/public/install.{sh,ps1}` verify the same way, except they still skip
gracefully for releases that predate the manifest (the self-updater no longer
does — it requires the manifest).

## Build & the generated SPA

`src/web/spa.ts` is a tracked placeholder so clean checkouts typecheck and source-mode
commands can run before the SPA is built. `bun run build:web` runs Vite, which bundles
the SPA to `web/dist/index.html` as a single self-contained file via
`vite-plugin-singlefile`. `scripts/compile-with-spa.ts` copies `src/` and `package.json`
into an ignored disposable directory under `tmp/`, embeds the HTML in that copy, and
runs `bun build --compile` against the copied entrypoint. Release binaries therefore
embed the full UI without ever modifying tracked source, even if compilation is
interrupted.

## Conventions

- **Dual tsconfig**: root `tsconfig.json` targets Bun (`types: ["bun"]`, includes
  `src` + `test` + `scripts`); `web/tsconfig.json` targets the browser (`DOM` libs,
  `types: ["vite/client"]`). Web code (`src/web` server aside) that touches the DOM
  belongs to the web config.
- Imports use **explicit `.ts`/`.tsx` extensions** (`allowImportingTsExtensions`).
- **One formatter family**: money, counts, and durations are formatted by the
  bun-free `src/core/format-shared.ts` — `formatUSD`, `formatCount` (plus
  `formatSignedCount` for deltas), `formatDuration` (terminal, with seconds) and
  `formatCompactDuration` (whole minutes, for the digest and the web cards).
  `src/cli/format.ts` re-exports them so terminal call sites keep one import
  source; `digest.ts` and the SPA's digest card import them directly, so a number
  reads the same in the terminal report, the copied markdown, and the browser.
  `web/src/format.ts` keeps the SPA's locale-aware `Intl` helpers for everything
  else. Never re-implement one locally: the copies drifted before (one printed
  `1000.0k` where the other printed `1.0M`).
- Formatting/linting is **Biome** (`biome.json`): 2-space indent, width 100, double
  quotes, semicolons, trailing commas. Biome excludes `web/dist` and the placeholder
  `src/web/spa.ts`.
- Use **Conventional Commits** for commit messages and pull request titles:
  `<type>(<optional scope>): <description>` (for example,
  `feat(web): improve analytics navigation`). Use an appropriate standard type such
  as `feat`, `fix`, `docs`, `refactor`, `perf`, `test`, `build`, `ci`, or `chore`.
  PR descriptions should summarize the change, motivation, user impact, and
  validation.
- For **every change**, identify and update all relevant documentation in the same
  branch. Check `README.md`, `wiki/`, `site/`, inline architecture notes, examples,
  and command/help text as applicable; do not treat code as complete while related
  docs are stale. If no documentation needs changing, explicitly confirm that the
  audit found no affected docs.
- Tests mirror source under `test/`, using Bun's runner and `ink-testing-library` for
  the TUI. `test/fixtures/sample-session.jsonl` is the canonical parse fixture.

## Release

CI (`.github/workflows/ci.yml`) runs lint, both typechecks, tests, and a full build on
every push/PR. Pushing a `v*` tag triggers `.github/workflows/release.yml`, which
cross-compiles binaries for Linux (x64/arm64), macOS (x64/arm64), and Windows (x64),
generates a `SHA256SUMS` manifest, signs a build-provenance attestation for each
binary (`actions/attest-build-provenance`, needing `id-token`/`attestations` write),
and publishes a GitHub release with auto-generated notes.

**Cutting a release.** Invoke the `cut-release` skill (`.claude/skills/cut-release/`)
for the guided, gated procedure. The steps below are the reference. The compiled
binary embeds `package.json`'s version (via `version.ts`, bundled by
`bun --compile`), so the version bump must land on `main` *before* the tag — tag a
commit whose `package.json` still says the old version and the release binaries
report the wrong version.

1. Make sure `main` is green.
2. Bump `package.json` `version` to `X.Y.Z` in a `chore(release): prepare vX.Y.Z` PR and
   merge it.
3. Tag that merge commit and push the tag — this is what triggers the release workflow:

   ```bash
   git checkout main && git pull
   git tag -a vX.Y.Z -m vX.Y.Z && git push origin vX.Y.Z
   ```

4. Verify: `release.yml` attaches the five binaries + `SHA256SUMS` to the `vX.Y.Z`
   GitHub release, and `cc-analyzer --version` reports `X.Y.Z`.
