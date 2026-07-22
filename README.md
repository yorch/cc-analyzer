# cc-analyzer

[![CI](https://github.com/yorch/cc-analyzer/actions/workflows/ci.yml/badge.svg)](https://github.com/yorch/cc-analyzer/actions/workflows/ci.yml)
[![Docs](https://img.shields.io/badge/docs-cc--analyzer-3451b2)](https://yorch.github.io/cc-analyzer/)

A read-only CLI to browse and analyze [Claude Code](https://claude.com/claude-code)
sessions stored in `~/.claude` — tokens, cost, tools, skills, models, and a
per-turn breakdown. Built with TypeScript + Bun; ships as a single binary.

**Docs & landing page:** <https://yorch.github.io/cc-analyzer/>

> Status: **Complete** — analysis core, SQLite index, portfolio analytics,
> interactive TUI, and a local web app, all in one binary. See
> [`docs/superpowers/specs`](docs/superpowers/specs) for the full design.

## Why

Claude Code stores every session as a JSONL transcript under
`~/.claude/projects/<project>/<session>.jsonl`. Those files record token usage
per API call but **not cost** — cost is derived here from token counts and a
per-model pricing table (fetched from [LiteLLM](https://github.com/BerriAI/litellm),
cached locally, with a bundled fallback). Cache-read/write tokens are priced
separately, which is where most of the real spend hides.

The tool is **read-only**: it never writes to `~/.claude`. Its own state
(pricing cache, and later the session index) lives under `~/.config/cc-analyzer/`.

## Install

### One-line install (recommended)

**macOS / Linux:**

```bash
curl -fsSL https://yorch.github.io/cc-analyzer/install.sh | sh
```

**Windows (PowerShell):**

```powershell
irm https://yorch.github.io/cc-analyzer/install.ps1 | iex
```

The script detects your OS and architecture, downloads the matching binary from
the latest [release](https://github.com/yorch/cc-analyzer/releases/latest), and
installs it to `~/.local/bin` (macOS/Linux) or `%LOCALAPPDATA%\cc-analyzer\bin`
(Windows). Override the target with `CC_ANALYZER_INSTALL_DIR`, or pin a version
with `CC_ANALYZER_VERSION=v0.2.0`. Prefer to inspect first? The scripts are
[`install.sh`](site/public/install.sh) and [`install.ps1`](site/public/install.ps1).

### Download a prebuilt binary (manual)

Every [release](https://github.com/yorch/cc-analyzer/releases/latest) ships a
self-contained binary for each platform — no Bun, Node, or other runtime
required.

**macOS / Linux** — pick the asset for your platform from the table below:

```bash
curl -fL -o cc-analyzer \
  https://github.com/yorch/cc-analyzer/releases/latest/download/cc-analyzer-darwin-arm64
chmod +x cc-analyzer
sudo mv cc-analyzer /usr/local/bin/     # or anywhere on your PATH
cc-analyzer --help
```

On macOS the binary is unsigned, so Gatekeeper quarantines the download. Clear it once:

```bash
xattr -d com.apple.quarantine /usr/local/bin/cc-analyzer
```

**Windows (PowerShell):**

```powershell
curl.exe -fL -o cc-analyzer.exe `
  https://github.com/yorch/cc-analyzer/releases/latest/download/cc-analyzer-windows-x64.exe
.\cc-analyzer.exe --help
```

| Platform               | Asset                          |
| ---------------------- | ------------------------------ |
| macOS (Apple silicon)  | `cc-analyzer-darwin-arm64`     |
| macOS (Intel)          | `cc-analyzer-darwin-x64`       |
| Linux (x64)            | `cc-analyzer-linux-x64`        |
| Linux (arm64)          | `cc-analyzer-linux-arm64`      |
| Windows (x64)          | `cc-analyzer-windows-x64.exe`  |

`…/releases/latest/download/…` always resolves to the newest release; pin a
version by swapping `latest/download` for `download/v0.1.0`.

Each release publishes a `SHA256SUMS` manifest. `cc-analyzer update` requires
it: the downloaded binary is verified before installing, and the update aborts
if the manifest can't be fetched. The install scripts verify too (skipping
gracefully only for older releases that predate the manifest). This guards
against corrupted or tampered downloads; it is not a substitute for signing,
since the manifest is served from the same release.

### From source

Requires [Bun](https://bun.sh) ≥ 1.3.

```bash
bun install
bun run src/cli/index.ts <command>   # or: bun start <command>
bun run build                        # compile a single binary -> dist/cc-analyzer
```

## Usage

```bash
cc-analyzer                          # launch the interactive TUI (needs an index)
cc-analyzer projects                 # list all projects, by session count
cc-analyzer sessions <projectId>     # list sessions in a project
cc-analyzer analyze <id|path>        # analyze one session (human-readable)
cc-analyzer analyze <id|path> --json # analyze one session (machine-readable)
cc-analyzer index [--rebuild]        # build/refresh the portfolio index
cc-analyzer stats [--json]           # portfolio-wide analytics (needs an index)
cc-analyzer serve [--port=4317] [--host=127.0.0.1]
                                     # launch the local web app (needs an index)
cc-analyzer pricing update           # refresh the pricing cache
cc-analyzer update [--check]         # self-update to the latest release (or just check)
cc-analyzer version                  # print the version
```

The CLI checks for a newer release at most once a day and prints a one-line
notice when one is available (`cc-analyzer update` to install it). Set
`CC_ANALYZER_NO_UPDATE_CHECK=1` to disable that check; it is also skipped in CI
and non-interactive shells. `update` replaces the installed binary in place on
macOS/Linux; on Windows it points you at the PowerShell installer.

`<id>` is a session uuid (searched across all projects) or a path to a `.jsonl`
file. `<projectId>` is the encoded directory name shown by `projects`.

### What the analysis reports

- **Totals**: cost, turns, API calls, tool calls, tokens, duration, web search/fetch.
- **Cost breakdown** by token category (input / output / cache-write / cache-read)
  and by model.
- **Tokens alongside cost** everywhere the Web UI and TUI show a cost figure —
  shown as input+output with the (much larger) cache volume broken out, e.g.
  `213M +52B cache`.
- **Tools**, **skills**, and **subagents** used; files touched.
- **Per-turn** breakdown, where a *turn* is one genuine user prompt plus every
  assistant API call and tool loop until the next prompt.

## Configuration

Environment overrides (mainly for testing):

- `CC_ANALYZER_CLAUDE_DIR` — Claude Code data dir (default `~/.claude`).
- `CC_ANALYZER_STATE_DIR` — cc-analyzer state dir (default `~/.config/cc-analyzer`).

## Development

```bash
bun test            # run the test suite
bun run check       # Biome lint + format (autofix)
bun run typecheck   # tsc --noEmit
```

### Portfolio analytics

`cc-analyzer index` scans every session under `~/.claude/projects`, computes its
metrics, and stores them in a local SQLite cache at
`~/.config/cc-analyzer/index.db`. It is **incremental** — only new or changed
files (by size + mtime) are re-parsed — and the cache is disposable (delete and
rebuild anytime). `cc-analyzer stats` then reports total spend, spend by
month/project/model, and the most expensive sessions.

The index carries a schema version; when it changes (e.g. new columns for the
tools analytics), the next run rebuilds the cache from scratch — just re-run
`cc-analyzer index` after upgrading.

### Interactive TUI

Running `cc-analyzer` with no arguments launches a terminal UI (built with Ink)
with an **amber-phosphor** retro-terminal look. It's a persistent shell — a
title bar, a **nav rail** (portfolio · projects · sessions · insights · trends ·
tools), and a **two-pane master-detail** body: a list on the left drives a
live **preview** on the right as you move the cursor. The **insights** view is a
cache-efficiency hit-list — projects ranked by un-amortized cache-write spend
(cache you paid to write but didn't read back), with a read:write verdict, that
drills into the leakiest sessions. The **trends** view is a two-panel
time-series dashboard (`tab` / `1`·`2`): a braille **burn** chart of spend over
time — `m` cycles the metric (cost/tokens/sessions), `g` the granularity
(day/week/month) — and an activity **heatmap** of sessions by local weekday ×
hour (`m` toggles to cost). The **tools** view (`tab` / `1`·`2`·`3`) ranks your
**tools** by invocations with an error count and error rate (`s` sorts); goes
deeper on **skills** — invocations, sessions, distinct projects, error rate, and
session-scoped cost (`s` sorts), with an adoption detail strip (first/last used +
a weekly invocation sparkline) for the selected skill; and lists **subagents** by
how many sessions used each. (Skill cost is *correlational*: a session using
several skills counts its full cost toward each.) Opening a session
zooms to
a full-screen view with a vitals band and its own two-pane **turns → steps**
(each step expands an amber card with its input/result), plus **transcript** and
**summary** modes (`t` / `s`). It reads from the index, so run `cc-analyzer
index` first.

Navigation uses a two-zone focus model: in a list, just start typing to
**filter**, `tab`/`shift-tab` cycles the **sort**, `↑/↓` moves (updating the
preview), and `enter` drills in. Press `esc` on an empty filter to focus the nav
rail, then `↑/↓` (or `1`-`5`) to switch views and `enter`/`→` to return to the
list. `?` shows the full keybinding cheatsheet; `ctrl-c` quits. The layout is
responsive — the rail collapses to icons, then to a single pane, on narrow
terminals. It requires an interactive terminal (TTY); piped/non-interactive use
falls back to a hint about the scriptable commands.

### Web app

`cc-analyzer serve` starts a local web server (Hono API + an embedded React
SPA). It listens on loopback only (`127.0.0.1`) and rejects non-local `Host`
headers, since sessions contain full conversation transcripts; pass
`--host=0.0.0.0` only if you deliberately want to expose it to your network.
The UI ships a portfolio dashboard, project drill-down, a per-session view, an
**Insights** page — the same cache-efficiency hit-list as the TUI (projects
ranked by un-amortized cache-write spend, with a read:write verdict, drilling
into the leakiest sessions) — a **Trends** page mirroring the TUI's
time-series view (an SVG spend burn chart with metric/granularity toggles and a
weekday × hour activity heatmap) — and a **Tools** page ranking tools (by
invocations, with error rate), **skills** (invocations, sessions, projects, error
rate, and session-scoped cost — click a row for its adoption sparkline and
first/last-used), and subagents (by sessions). Projects
and sessions can be **filtered** by name; the **Turns** tab expands each turn
into a **step timeline** — assistant narration, thinking markers, and tool
operations with a one-line summary and a result status/hint (`✓ 71 lines`,
`✗ error…`), each step click-to-expand for its full input and result; and the
color-coded **transcript** reader is windowed ("show more") so very large
sessions stay responsive. The SPA is built
by Vite into a single self-contained HTML file (`bun run build:web`) and baked
into the binary, so the release build serves the whole UI with no external
assets.

## Building the release binary

```bash
bun run build   # vite build → embed SPA → bun compile → dist/cc-analyzer
```

This produces a single ~63 MB executable containing the CLI, TUI, API, and web
UI. `bun run build:web` builds and embeds only the SPA (used by the full build).

### Releases (CI)

Every push and PR runs lint, typechecks, tests, and a build via GitHub Actions
(`.github/workflows/ci.yml`). Pushing a `v*` tag triggers
`.github/workflows/release.yml`, which cross-compiles binaries for
Linux (x64/arm64), macOS (x64/arm64), and Windows (x64), generates a `SHA256SUMS`
manifest, and publishes a GitHub release with auto-generated notes.

**To cut a release** — the compiled binary embeds `package.json`'s version, so the
bump must land on `main` before the tag:

1. Bump `package.json` `version` to the new `X.Y.Z` in a `chore(release): prepare
   vX.Y.Z` pull request, and merge it.
2. Tag the merge commit and push the tag (this is what builds and publishes the
   release):

   ```bash
   git checkout main && git pull
   git tag -a vX.Y.Z -m vX.Y.Z && git push origin vX.Y.Z
   ```

The release workflow then attaches the five platform binaries and `SHA256SUMS` to the
`vX.Y.Z` release.

## Roadmap

- ~~SQLite index + portfolio analytics~~ ✓
- ~~Interactive TUI (Ink)~~ ✓
- ~~Local web app (Hono + React SPA)~~ ✓
- Ideas: live-follow of active sessions; diff/compare two sessions; export reports.
