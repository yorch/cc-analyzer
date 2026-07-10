# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

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
bun run build:web            # Vite build → embed SPA into src/web/spa.ts
bun run build                # build:web, then bun compile → dist/cc-analyzer
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

## Concepts that span multiple files (read before editing)

**Turn segmentation — duplicated logic, keep in sync.** A *turn* is one genuine user
prompt plus every assistant API call and tool loop until the next prompt. The
discriminator `isRealPrompt()` (a user event that is not `isMeta` and carries
something other than `tool_result` blocks) exists in **both** `analyze.ts` and
`transcript.ts`. Changing turn-boundary rules means editing both.

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

## Build & the generated SPA

`src/web/spa.ts` is a **generated, gitignored artifact** — do not edit it by hand.
`bun run build:web` runs Vite (which bundles the SPA to a single self-contained HTML
file via `vite-plugin-singlefile`) then `scripts/embed-spa.ts` writes that HTML as a
string into `src/web/spa.ts`. `bun build --compile` bakes it into the binary, so the
release serves the whole UI with no external assets. A placeholder `spa.ts` is
force-added to git once; regenerated content stays untracked.

## Conventions

- **Dual tsconfig**: root `tsconfig.json` targets Bun (`types: ["bun"]`, includes
  `src` + `test`); `web/tsconfig.json` targets the browser (`DOM` libs,
  `types: ["vite/client"]`). Web code (`src/web` server aside) that touches the DOM
  belongs to the web config.
- Imports use **explicit `.ts`/`.tsx` extensions** (`allowImportingTsExtensions`).
- Formatting/linting is **Biome** (`biome.json`): 2-space indent, width 100, double
  quotes, semicolons, trailing commas. Biome excludes `web/dist` and the generated
  `src/web/spa.ts`.
- Tests mirror source under `test/`, using Bun's runner and `ink-testing-library` for
  the TUI. `test/fixtures/sample-session.jsonl` is the canonical parse fixture.

## Release

CI (`.github/workflows/ci.yml`) runs lint, both typechecks, tests, and a full build on
every push/PR. Pushing a `v*` tag triggers `.github/workflows/release.yml`, which
cross-compiles binaries for Linux (x64/arm64), macOS (x64/arm64), and Windows (x64)
and attaches them to a GitHub release. Keep `package.json` `version` in sync with the
tag.
