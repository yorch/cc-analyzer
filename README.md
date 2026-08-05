# cc-analyzer

[![CI](https://github.com/yorch/cc-analyzer/actions/workflows/ci.yml/badge.svg)](https://github.com/yorch/cc-analyzer/actions/workflows/ci.yml)
[![Docs](https://img.shields.io/badge/docs-cc--analyzer-3451b2)](https://cc-analyzer.brnby.com/)

A read-only CLI to browse and analyze [Claude Code](https://claude.com/claude-code)
sessions stored in `~/.claude` — tokens, cost, tools, skills, models, and a
per-turn breakdown. Built with TypeScript + Bun; ships as a single binary.

**Docs & landing page:** <https://cc-analyzer.brnby.com/>

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

**Cost basis.** Every dollar figure is always computed the same way — tokens ×
API rates. If you're on a flat-plan subscription (Pro/Max) rather than
pay-as-you-go API billing, those numbers are API-equivalent *value*, not a
bill. Run `cc-analyzer cost-basis subscription` to frame them that way across
the CLI, TUI, and web app (`cc-analyzer cost-basis` shows the current setting;
`api` is the default) — or, in the web app, flip the toggle beside the
Dashboard's cost figure.

## Install

### One-line install (recommended)

**macOS / Linux:**

```bash
curl -fsSL https://cc-analyzer.brnby.com/install.sh | sh
```

**Windows (PowerShell):**

```powershell
irm https://cc-analyzer.brnby.com/install.ps1 | iex
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
against corrupted or tampered downloads, but since the manifest ships from the
same release it only proves integrity, not origin.

For origin, every release binary carries a signed [build provenance
attestation](https://docs.github.com/actions/security-guides/using-artifact-attestations)
tying it to the exact workflow run and commit that produced it — something code
inside the job cannot forge. Verify a download with the GitHub CLI:

```bash
gh attestation verify cc-analyzer-linux-x64 --repo yorch/cc-analyzer
```

### From source

Requires [Bun](https://bun.sh) ≥ 1.3.

```bash
bun install
bun run src/cli/index.ts <command>   # or: bun start <command>
bun run build                        # compile a single binary -> dist/cc-analyzer
```

## Usage

```bash
cc-analyzer                          # launch the interactive TUI (builds an empty index)
cc-analyzer projects                 # list all projects, by session count
cc-analyzer sessions <projectId>     # list sessions in a project
cc-analyzer analyze <id|path>        # analyze one session (human-readable)
cc-analyzer analyze <id|path> --json # analyze one session (machine-readable)
cc-analyzer doctor <id|path>         # check structural health and recoverability
cc-analyzer doctor <id|path> --json  # emit the health report as JSON
cc-analyzer index [--rebuild]        # build/refresh the portfolio index
cc-analyzer index --check            # check for new/changed/deleted sessions
cc-analyzer stats [--current] [--json]
                                     # portfolio or current-project analytics (needs an index)
cc-analyzer audit [--json]           # cross-reference your installed setup with observed usage
cc-analyzer insights [--json]        # ranked, actionable findings across the whole portfolio
cc-analyzer report [--week YYYY-MM-DD] [--md|--json]
                                     # weekly digest: last complete week vs the week before
cc-analyzer serve [--port=4317] [--host=127.0.0.1] [--refresh] [--open]
                                     # launch the local web app
cc-analyzer pricing update           # refresh the pricing cache
cc-analyzer update [--check]         # self-update to the latest release (or just check)
cc-analyzer version                  # print the version
cc-analyzer cost-basis [api|subscription]
                                     # view or change how dollar figures are framed
```

The CLI checks for a newer release at most once a day and prints a one-line
notice when one is available (`cc-analyzer update` to install it). Set
`CC_ANALYZER_NO_UPDATE_CHECK=1` to disable that check; it is also skipped in CI
and non-interactive shells. `update` replaces the installed binary in place on
macOS/Linux; on Windows it points you at the PowerShell installer.

Index-backed reports include the last successful refresh time. `index --check`
compares source file metadata with the cache without parsing sessions and exits
non-zero when it finds new, changed, or deleted files. The TUI, `stats`, and
web app surface the same freshness status so an older cache is never silent.
`index --check` also prints one line of **parse coverage** — the share of
indexed lines this build of the parser fully understood — read from the index
rows, so the no-parse guarantee holds.

`<id>` is a session uuid (searched across all projects) or a path to a `.jsonl`
file. `<projectId>` is the encoded directory name shown by `projects`.

### What the analysis reports

- **Totals**: cost, turns, API calls, tool calls, tokens, duration, web search/fetch.
- **Cost breakdown** by token category (input / output / cache-write / cache-read)
  and by model.
- **Tokens alongside cost** everywhere the Web UI and TUI show a cost figure —
  shown as input+output with the (much larger) cache volume broken out, e.g.
  `213M +52B cache`.
- **Tools**, **skills**, and **subagents** used; files touched. Skills carry the
  cost of the turns that invoked them (turn-scoped attribution).
- **Cost per outcome**: spend divided into observable units — per turn, per file
  touched, per test run, per active hour (a ratio is absent, not $0, when its
  denominator is zero; the ratios measure activity, not value).
- **What-if repricing** of this session's token mix at the other models' rates —
  a rate comparison only, with the caveat printed alongside.
- **Subagent bursts**: per-burst sidechain spend (calls, cost, spawning turn),
  typed best-effort by matching burst root prompts to `Task` spawns.
- **Per-turn** breakdown, where a *turn* is one genuine user prompt plus every
  assistant API call and tool loop until the next prompt.
- **Actionable diagnostics** with observed evidence and a suggested next step for
  context pressure, large context jumps, cache rewrites after idle gaps,
  post-compaction refills, concentrated per-turn spend, edit-test thrash
  (consecutive failing test runs without a pass), repeated re-reads of the
  same file (each re-read pays the file into context again), and correction
  loops (prompts opening with "no, …" / "that's not what I meant" / "still
  broken", plus mid-flight interruptions — detected by a conservative
  English-only keyword heuristic that undercounts by design). These are named
  heuristics, not a session-quality score.
- **Parse coverage**: how much of the session file this build actually
  understood — lines skipped as unreadable, and lines kept as tolerant
  "unknown" events. The JSONL format is undocumented and changes between Claude
  Code releases, so the parser is tolerant by design; this makes that tolerance
  visible instead of silent. `cc-analyzer insights` warns (and points at
  `cc-analyzer update`) when the newest Claude Code version's sessions stop
  parsing cleanly.

### Session health checks

`cc-analyzer doctor <id|path>` reads one source session directly; it does not
require the SQLite index. It checks whether the JSONL can be represented safely,
whether event UUIDs and session IDs are internally consistent, whether parent and
leaf references resolve locally, whether tool calls pair with results, and whether
the session ends with an unanswered human prompt or interrupted response.

The report distinguishes **healthy**, **warning**, and **damaged** sessions. A
missing parent or tool call is a warning rather than proof of corruption because a
continuation file can legitimately begin mid-chain. Every finding includes its
evidence and a read-only next step. Exit code `0` means healthy, `1` means findings
were reported (or the session was not found), and `2` means invalid usage. Use
`--json` for automation.

## Configuration

Environment overrides (mainly for testing):

- `CC_ANALYZER_CLAUDE_DIR` — Claude Code data dir (default `~/.claude`).
- `CC_ANALYZER_STATE_DIR` — cc-analyzer state dir (default `~/.config/cc-analyzer`).

## Telemetry & privacy

cc-analyzer reports **anonymous, cookieless** usage stats to a self-hosted
[Plausible](https://plausible.io) instance so its author can see which features
are used. It is designed to respect the tool's read-only, privacy-first nature:

- **Never sent:** session content, prompts, file paths, project names, tokens,
  costs, or anything identifying. Each CLI event carries only the command name
  (`stats`, `index`, …), the cc-analyzer version, your OS/arch, and a coarse
  session-count bucket (e.g. `11-100`). The web app reports only which **view**
  you open (`/session`, `/project`, …) — the session id or project path in the
  URL is stripped before anything is sent.
- **Where:** the CLI/TUI send server-side events; the local web app bundles the
  Plausible tracker and the docs site loads its cookieless script. Telemetry
  state lives only in `~/.config/cc-analyzer/` — **never** in `~/.claude`.
- **Never in your way.** A CLI command never waits on the network to report
  itself: it hands the event to a short-lived background copy of `cc-analyzer`
  and exits immediately. That is the second `cc-analyzer` process you may see
  briefly in `ps` — it sends one small request and stops. When telemetry is off,
  nothing is spawned and nothing is sent.
- **On by default, easy to opt out.** The first run prints a one-time notice.

Opt out in any of these ways (any one is enough):

```bash
cc-analyzer telemetry off        # persisted setting
export CC_ANALYZER_TELEMETRY=0   # per-shell / per-run
export DO_NOT_TRACK=1            # honored globally
```

Telemetry is also **automatically disabled in CI** (`CI` env set). Check the
current state with `cc-analyzer telemetry status`. The `DO_NOT_TRACK` environment
variable also governs the locally served web app; in the web app and docs site,
`localStorage.plausible_ignore = "true"` disables browser analytics.

## Development

```bash
bun test               # run the test suite
bun run check          # Biome lint + format (autofix)
bun run typecheck      # core/CLI/TUI/server TypeScript
bun run typecheck:web  # browser SPA TypeScript
bun run build:web      # production single-file SPA build
```

Use [Conventional Commits](https://www.conventionalcommits.org/) for commit
messages and pull request titles, such as
`feat(web): improve analytics navigation`. Keep relevant README, wiki, site,
architecture, examples, and help text accurate in the same change.

### Portfolio analytics

`cc-analyzer index` scans every session under `~/.claude/projects`, computes its
metrics, and stores them in a local SQLite cache at
`~/.config/cc-analyzer/index.db`. It is **incremental** — only new or changed
files (by size + mtime) are re-parsed — and the cache is disposable (delete and
rebuild anytime). `cc-analyzer stats` then reports total spend, spend by
month/project/model, the most expensive sessions, and your **skills ranked by
the cost of the turns that invoked them**. Two cost-optimization
sections round it out: **what-if model repricing** replays each model's actual
token mix — all four categories, both cache-write TTLs — at the rates of the
other models you ran, and **context tax** reports the median/p90 tokens each
project's sessions pay before you type anything (system prompt + CLAUDE.md +
MCP tool schemas, taken from the first main-chain API call). Both are
heuristics: repricing is a rate comparison only — a different model would
produce different tokens, and quality is not priced in — and the context-tax
baseline is inflated by continuation sessions and large opening pastes, so read
the median rather than any single session. Human-readable reports
use a compact headline, grouped activity/reliability sections, and aligned
numeric tables; terminals receive restrained color while pipes, redirects,
`NO_COLOR`, and `--json` stay automation-safe. JSON reports include a
discriminated `scope` object identifying either the portfolio or the selected
project.

Run `cc-analyzer stats --current` from a project—or any directory beneath
it—to scope every metric to that project's indexed sessions. Project matching
uses the authoritative session `cwd`; if it is missing from the cache, refresh
it with `cc-analyzer index`.

### Setup audit

`cc-analyzer audit` reads your *setup* — skills, subagents, plugins, MCP
servers, hooks, and permission rules under `~/.claude` (plus the `~/.claude.json`
MCP config) — and cross-references it with what the indexed sessions actually
used. It reports an inventory summary and findings such as an **unused MCP
server** (a warning: its tool schemas are re-sent to the model every turn, so an
unused one is pure context tax), an **unused skill or subagent**, an
**error-prone skill** (≥25% errors over ≥5 invocations), a **stale skill**
(unused for 30+ days), an **unused plugin** (nothing it ships — skills,
subagents, or MCP servers — was ever used; reported once for the plugin rather
than once per dead component), and skills or subagents that sessions used but
that are no longer installed. When you have plugins installed it also prints a
**Plugins** table: per plugin, how many of its skills and subagents you actually
use, its invocation count, the turn-scoped dollars attributed to its skills, and
when it last ran — so you can see what each plugin is doing for you. The scan is read-only and tolerant: a missing or malformed
config file is skipped, never fatal. Findings are machine-local and historical —
the index can cover sessions that predate the current setup, and project-scoped
skills, subagents, and MCP servers live outside the Claude config dir — so treat
them as prompts to look, not verdicts. The same audit is served at `/api/audit`
and rendered on the web app's Tools view.

### Portfolio insights

`cc-analyzer insights` is the portfolio-wide counterpart of the per-session
"actionable diagnostics": a bun-free rules engine folds every portfolio signal —
cache efficiency, compaction pressure, context tax, what-if repricing, retry
churn, edit-test thrash, redundant file re-reads, correction-heavy prompting,
weekly error trend, spend
concentration, pricing confidence, the setup audit, subagent balance, and parse
coverage — into a ranked list of explainable findings.
Warnings rank before infos, and dollar-backed findings rank first within a
severity. These are deliberately named heuristics with conservative,
documented thresholds — **not a score**: every finding shows the observed
numbers as evidence and suggests a concrete next action (e.g. "batch related
work so the 5-minute cache TTL amortizes", "trim that project's CLAUDE.md").
The same findings appear at the top of the web app's Insights page (via
`/api/insights`) and as a compact list in the TUI insights view. The full rule
table with thresholds lives in the wiki's Analytics & Insights page.

### Weekly digest

`cc-analyzer report` turns all of the above from something you go looking for
into something you can read on a schedule: one week of usage, what changed
against the week before, and what to fix. It prints a headline (cost, sessions,
active time, tokens) with signed deltas, the week's top projects, model mix,
cache economics, reliability (tool errors, test runs, retries, thrash,
corrections), the skills that cost the most turn-scoped dollars, and a snapshot
of the portfolio insights. `--md` writes paste-ready markdown to stdout for
notes or chat (`cc-analyzer report --md > week.md`); `--json` emits the plain
object. They are two renderings of the same digest, so asking for both is an
error rather than a silent choice.

The default period is the **last complete ISO week** (Monday–Sunday) — a
half-finished current week would always read as a decline. `--week YYYY-MM-DD`
reports the week containing any given day. Sessions are attributed to their
**start day**, so a session that runs past midnight counts entirely in the
period it began; the digest says so wherever it renders. The insight snapshot is
deliberately **not** period-scoped — it is current state across the whole
portfolio, because one week rarely carries enough evidence to fire those
thresholds honestly. The same digest is served at `/api/report` and summarized
in a card on the web app's Dashboard, which can copy the identical markdown to
your clipboard.

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
drills into the leakiest sessions; its header opens with a compact list of the
top **portfolio insight** findings (severity glyph + title — the full evidence
lives in `cc-analyzer insights`) and also carries the portfolio
**context tax** (median/p90 tokens spent before you type) and the cheapest
single model your token mix could have run on. The **trends** view is a two-panel
time-series dashboard (`tab` / `1`·`2`): a braille **burn** chart of spend over
time — `m` cycles the metric (cost/tokens/sessions), `g` the granularity
(day/week/month) — and an activity **heatmap** of sessions by local weekday ×
hour (`m` toggles to cost). The **tools** view (`tab` / `1`·`2`·`3`) ranks your
**tools** by invocations with an error count and error rate (`s` sorts); goes
deeper on **skills** — invocations, sessions, distinct projects, error rate,
turn-scoped cost and session-scoped cost (`s` sorts), with an adoption detail
strip (first/last used + a weekly invocation sparkline) for the selected skill;
and lists **subagents** by how many sessions used each. (Skill cost is reported
at two scopes: *turn-scoped* — the cost of the turns that invoked the skill,
including any subagent burst inside them — is the primary number, and
*session-scoped* is the whole-session upper bound. Both are correlational, not
causal: a turn or session touching several skills counts its full cost toward
each.) Opening a session
zooms to
a full-screen view with a vitals band and its own two-pane **turns → steps**
(each step expands an amber card with its input/result), plus **charts**,
**transcript**, and **summary** modes (`c` / `t` / `s`). The charts mode draws
the braille context-window sawtooth (with `▼` compaction markers, "% of
window", and a headroom projection when the context is growing), a per-call
**cache-hit sparkline** with cold-call count, cost-per-call and cost-per-turn
sparklines annotated with idle gaps and `▲` markers on
interrupted/correction/thrash turns, plus in-session model-mix and per-burst
subagent spend lines. The summary includes the same evidence-backed
context and cost diagnostics as the CLI and web app, along with
**cost-per-outcome** ratios and a session-scoped **what-if repricing** line
(each with its caveat). It reads from the index;
on first use it builds an empty cache automatically. Later source changes are
reported in the shell so you know when to run `cc-analyzer index`.

Navigation uses a two-zone focus model: in a list, just start typing to
**filter**, `tab`/`shift-tab` cycles the **sort**, `↑/↓` moves (updating the
preview), and `enter` drills in. Press `esc` on an empty filter to focus the nav
rail, then `↑/↓` (or `1`-`5`) to switch views and `enter`/`→` to return to the
list. `?` shows the full keybinding cheatsheet; `ctrl-c` quits. The layout is
responsive — the rail collapses to icons, then to a single pane, on narrow
terminals. It requires an interactive terminal (TTY); piped/non-interactive use
falls back to a hint about the scriptable commands.

### Web app

`cc-analyzer serve` builds the index when it is empty, then starts a local web
server (Hono API + an embedded React SPA). Pass `--refresh` to incrementally
refresh an existing index before serving, and `--open` to launch the URL in
your default browser. Browser opening is best-effort and limited to loopback
hosts. The server listens on loopback only (`127.0.0.1`) and rejects non-local `Host`
headers, since sessions contain full conversation transcripts; pass
`--host=0.0.0.0` only if you deliberately want to expose it to your network.
The UI ships a portfolio dashboard, project drill-down, a per-session view, an
**Insights** page — opening with the ranked **portfolio insight** findings
(warnings first, each with evidence, a next action, and a project link when the
signal is project-scoped), followed by the same cache-efficiency hit-list as
the TUI (projects ranked by un-amortized cache-write spend, with a read:write
verdict, drilling into the leakiest sessions), plus the **context tax** per
project and the **what-if model repricing** table, each carrying its caveat
inline — a
**Trends** page with 30-day, peak-spend, and
error-rate headlines plus burn, calendar, model-mix, activity, scatter,
reliability, subagent, and concurrency charts — and a **Tools** page organized
into Tools, Reliability, Compactions, Skills, Agents, and Environment views.
Projects are organized into Overview, Sessions, Trends, and Files views. These
section and chart controls are URL-backed, keyboard navigable, and shareable;
each major chart includes a collapsible data table so its values remain usable
without hover or a pointer. Projects and sessions can be **filtered** by name;
the **Turns** tab expands each turn
into a **step timeline** — assistant narration, thinking markers, and tool
operations with a one-line summary and a result status/hint (`✓ 71 lines`,
`✗ error…`), each step click-to-expand for its full input and result; and the
color-coded **transcript** reader is windowed ("show more") so very large
sessions stay responsive. The session **Charts** tab renders the
context-window fill per API call (with compaction markers annotated with the
tokens each compaction reclaimed, a dashed window-limit line, and a headroom
projection when the context is growing), a **cache-efficiency** chart (per-call
hit rate, cold calls), cumulative cost with **idle-gap** markers, per-turn bars
toggling cost/tokens/calls/depth/time — the cost metric stacks the four token
categories, and turns flagged as interrupted/correction/thrash carry warning
markers — plus **tool-activity** bars, an in-session **model mix**, and a
**subagent bursts** table attributing sidechain spend to the specific agents
that ran (typed best-effort from their spawn prompts). Session summaries group
spend/tokens, execution, and
environment details, followed by explainable context and cost diagnostics with
suggested next actions, **cost-per-outcome** ratios, a session-scoped
**what-if repricing** summary, and a **cost rank** card placing the session's
spend among its project's (and the portfolio's) sessions. The SPA is built
by Vite into a single self-contained HTML file (`bun run build:web`) and baked
into the binary, so the release build serves the whole UI with no external
assets.

## Building the release binary

```bash
bun run build   # vite build → disposable SPA embed → bun compile
```

This produces a single ~63 MB executable containing the CLI, TUI, API, and web
UI. `bun run build:web` writes the single-file SPA to `web/dist/`; the full build
embeds it in a disposable source copy while compiling, leaving tracked source untouched.

### Releases (CI)

Every push and PR runs lint, typechecks, tests, and a build via GitHub Actions
(`.github/workflows/ci.yml`), across a macOS + Ubuntu matrix. Pushing a `v*` tag
triggers `.github/workflows/release.yml`, which cross-compiles binaries for
Linux (x64/arm64), macOS (x64/arm64), and Windows (x64), generates a `SHA256SUMS`
manifest, signs a build-provenance attestation for each binary, and publishes a
GitHub release with auto-generated notes.

**To cut a release** — the compiled binary embeds `package.json`'s version, so the
bump must land on `main` before the tag. The steps below are the reference; for a
guided, gated run, agents can invoke the `cut-release` skill
(`.claude/skills/cut-release/`).

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

## License

Licensed under the [MIT License](LICENSE).
