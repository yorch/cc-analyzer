# Project Guidelines

This file provides guidance to AI Agents when working with code in this repository.

> The file `CLAUDE.md` is a symlink to `AGENTS.md`, so any changes in either file are reflected in the other.

`cc-analyzer` is a **read-only** CLI that browses and analyzes Claude Code sessions
stored in `~/.claude`. It never writes to `~/.claude`; its own state (pricing cache,
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

Env overrides (used in tests): `CC_ANALYZER_CLAUDE_DIR` (Claude data dir),
`CC_ANALYZER_STATE_DIR` (cc-analyzer state dir).

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
new turn). For shell commands the index stores a **raw signal, not a
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
and correlational** (skill cost, permission-mode cost, branch cost, idle-vs-cache
buckets): a session counts its full cost toward each label it carries. Keep the
"correlational, not causal" caveat wherever they're rendered.

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
as offline fallback.

**The index is a disposable cache.** `cc-analyzer index` scans every session, analyzes
it, and upserts a flattened row into SQLite (`bun:sqlite`) at
`~/.config/cc-analyzer/index.db`. It's **incremental** — files unchanged by (size,
mtime) are skipped, deleted files are pruned — and safe to delete and rebuild. The
TUI and `stats`/`serve` all require an existing index.

**Project ids are lossy encodings.** A project's stable id is its encoded directory
name under `~/.claude/projects/`. `decodeProjectLabel()` is best-effort display only;
the authoritative project path comes from the session's `cwd` field, not by decoding
the id. Never round-trip a real path through the encoded id.

**The parser never throws.** `parser.ts` is tolerant: invalid JSON → recorded
`ParseError` and skipped; a known event type whose Zod schema drifted → kept as a
tolerant "unknown" event so counts stay consistent. Event schemas live in `events.ts`.
`parseSessionFile` streams the file line by line (sessions can be hundreds of MB);
`parseSessionText` is the in-memory path; `streamSessionEvents` yields events one
at a time for bulk consumers. All three share `parseLineOutcome` (per line) and
`readLines` (byte streaming), so their behavior can't drift. (Only file I/O — e.g.
a missing file — throws.)

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

## Self-update subsystem

`version.ts` embeds the version by importing `package.json` (bundled by
`bun --compile`), so a compiled binary knows its own version — keep the tag and
`package.json` version in lockstep at release time. `release.ts` resolves the
latest version by following the `/releases/latest` redirect (no API token/rate
limit) and maps `process.platform`/`process.arch` to release asset names.

`update.ts` self-updates only when running as a **compiled** binary (detected via
the `$bunfs` marker in `import.meta.url`, with an `execPath`-basename fallback);
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
- Formatting/linting is **Biome** (`biome.json`): 2-space indent, width 100, double
  quotes, semicolons, trailing commas. Biome excludes `web/dist` and the placeholder
  `src/web/spa.ts`.
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
