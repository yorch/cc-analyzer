# cc-analyzer

[![CI](https://github.com/yorch/cc-analyzer/actions/workflows/ci.yml/badge.svg)](https://github.com/yorch/cc-analyzer/actions/workflows/ci.yml)
[![Docs](https://img.shields.io/badge/docs-cc--analyzer-3451b2)](https://cc-analyzer.brnby.com/)

A read-only CLI to browse and analyze [Claude Code](https://claude.com/claude-code)
sessions stored in `~/.claude` — or in any other Claude data directory, several
at once — reporting tokens, cost, tools, skills, models, and a per-turn
breakdown. Built with TypeScript + Bun; ships as a single binary.

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
separately, which is where most of the real spend hides. Where a published list
price and the rate Claude Code actually bills disagree, cc-analyzer follows
Claude Code, so its numbers stay comparable with `claude /usage`.

### Comparing against `claude /usage`

A single session's numbers should match Claude Code's own accounting. This has
been verified by running a session with `--output-format stream-json` and
diffing its terminal `result` event (Claude Code's own `total_cost_usd` and
`usage`) against what cc-analyzer computes from the same session's files —
exact to the token, and to the cent, both for a plain session and for one that
spawns a subagent.

Two things still make a *portfolio* comparison differ, by design:

- **`/usage` counts the CLI process, cc-analyzer counts a session.** Its
  "Session" panel accumulates over the running `claude` process, which can span
  more than the one session file you are looking at. Its wall-clock duration is
  also measured to *now*, while cc-analyzer measures last-event-minus-first.
- **Some usage is never written to the transcript.** Background work — session
  titling in particular — is recorded as events carrying no `usage` field at
  all, so it exists only in Claude Code's internal accounting. cc-analyzer
  cannot see it, and no amount of parsing will recover it.

Local JSONL is also not a bill: other machines, claude.ai, and non-CLI API use
never appear in it.

During ordinary indexing and analysis the tool is **read-only** over Claude's
source transcripts and configuration. Its own state
(pricing cache, and later the session index) lives under `~/.config/cc-analyzer/`.

**Cost basis.** Every dollar figure is always computed the same way — tokens ×
API rates. If you're on a flat-plan subscription (Pro/Max) rather than
pay-as-you-go API billing, those numbers are API-equivalent *value*, not a
bill. Run `cc-analyzer cost-basis subscription` to frame them that way across
the CLI, TUI, and web app (`cc-analyzer cost-basis` shows the current setting;
`api` is the default) — or, in the web app, flip the toggle beside the
Dashboard's cost figure.

**What the numbers aren't.** cc-analyzer never reads the deprecated
pre-computed `costUSD` field some older Claude Code JSONL files carry — it
always recomputes from token counts, the same choice as ccusage's
`--mode calculate`, so totals can differ from tools that trust `costUSD` by
default on old logs. And local JSONL files aren't the billing ground truth:
usage from other machines, claude.ai web, or non-Claude-Code API use never
shows up in them.

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
cc-analyzer analyze <id|path> --md --out share.md --redact  # shareable Markdown/HTML/JSON (also --html/--json, --include-transcript)
cc-analyzer analyze <id|path> --with-claude [--model <id>]
                                     # run a Claude Code retrospective of the session
                                     # (read-only; needs the `claude` CLI installed)
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
cc-analyzer export [--project <id>] [--session <id|path>]
                                     [--format json,csv,md,html|all] [--out <dir>]
                                     [--redact|--split] [--include-transcript] [--zip]
                                     # bulk export portfolio/project/session — folder by default,
                                     # --zip for archive; --split emits private/ + shareable/
                                     # reuses same builders as analyze; parquet deferred
cc-analyzer serve [--port=4317] [--host=127.0.0.1] [--refresh] [--open]
                                     # launch the local web app
cc-analyzer pricing update           # refresh the pricing cache
cc-analyzer update [--check]         # self-update to the latest release (or just check)
cc-analyzer version                  # print the version
cc-analyzer telemetry [on|off|status]
                                     # view or change anonymous usage telemetry
cc-analyzer cost-basis [api|subscription]
                                     # view or change how dollar figures are framed
cc-analyzer claude-dir [show|set <path>|add <path>|remove <path>|reset]
                                     # view or change which Claude data dirs are read

# global: read a different Claude data dir for one invocation (repeatable).
# Only for the commands that read session files directly.
cc-analyzer --claude-dir=/path/to/.claude projects
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

### Sharing a session

Every session can be exported as a **single-file, shareable artifact** — Markdown, standalone HTML (inline dark theme, print stylesheet) or JSON — built by the same bun-free `src/core/session-markdown.ts` so the CLI, web (`GET /api/sessions/:id/report?format=md&redact=1&transcript=1`) and TUI (`e` → `f`/`r`/`t` → `w` writes `./cc-analyzer-<id>.*`) are byte-identical. By default exports omit the transcript (opt-in with `--include-transcript`, capped at 600 items × 2000 chars, sampled charts at 300) and show file paths; add `--redact` to hide prompts, transcript bodies, title, project path and file lists for external sharing (sanitized filenames, `Content-Disposition: attachment` on the web). See the [Recipes & Use Cases](https://cc-analyzer.brnby.com/docs/10-recipes) for redacted team share, pre-standup thrash triage, post-mortem with transcript, what-if, and weekly digest recipes.

### Bulk export (portfolio / project / session)

`cc-analyzer export` writes a **folder** (add `--zip` for `...zip`) covering all three scopes — portfolio (default), `--project <id>`, or `--session <id|path>` — in any mix of formats via `--format json,csv,md,html|all` (default `json`). It reuses the same bun-free builders as `analyze` (`session-markdown.ts`, `analyze.ts`) so the Web `GET /api/export?format=&project=&session=&redact=&split=&transcript=` and CLI are byte-identical. Output is `manifest.json` + `portfolio.json`/`project.json`/`session.json` + `sessions.json` + `sessions/<id>.json` + `markdown/<id>.md` + `html/<id>.html` + `csv/sessions.csv` + `csv/turns.csv` + `csv/models.csv`. Privacy is `private` by default, `--redact` for shareable, or `--split` for both trees `private/` + `shareable/` (shareable hides prompts/transcript, title, project path, files). Add `--include-transcript` to embed the capped transcript (600×2000). Examples:

```bash
cc-analyzer export --format all --out ./export --split   # whole portfolio, both trees
cc-analyzer export --project <id> --format json,csv --out ./proj
cc-analyzer export --session <id> --format md --redact --out ./share
curl "http://localhost:4317/api/export?format=json,csv&project=<id>&redact=1" -o export.zip
```

CSV is `sessions.csv` (one row per session) + `turns.csv` (one row per turn, prompt redacted when `--redact`) + `models.csv` (one row per model per session). Parquet is deferred — CSV covers the analytics use-case for now. See `cc-analyzer help` for export flags and the web Dashboard/Project/Session **Export** panels.

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
- **Subagent bursts**: per-burst sidechain spend (calls, cost, spawning turn).
  Claude Code writes each subagent's transcript beside the session, so bursts are
  normally typed from the subagent's own metadata; older sessions that recorded
  subagent work inline are typed best-effort by matching burst root prompts to
  `Task` spawns, and each view says which it did.
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

### Analyze with Claude Code

Every session view can hand the session off to a locally-installed Claude Code
CLI for a natural-language retrospective — what you were trying to do, where time
and tokens went, and how to run a similar task better. cc-analyzer's own metrics
are embedded in the prompt so Claude reasons from real numbers, not just the raw
transcript.

- **CLI**: `cc-analyzer analyze <id|path> --with-claude [--model <id>]` streams
  the retrospective to stdout and prints the run's cost.
- **Web**: the session page's **Claude** tab has an "Analyze with Claude Code"
  button and a model picker.
- **TUI**: press `a` on a session's detail screen (`r` to run, `m` to switch
  model).

It runs `claude -p` headless, pointed at the session file with the `Read` tool
only — it never `--resume`s the reviewed session. Because this starts a normal
Claude Code process, session content may be sent to the model provider and your
normal hooks/configuration may run. It uses your normal Claude Code login (no API
key needed), and each run is a real, billable Claude Code session, so it only
starts when you ask. Default model is `sonnet`; override per run, or set a default with
`cc-analyzer analyze … --model` / the web picker. Requires the `claude` CLI on
your `PATH`.

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

### Claude data directories

Find your case below — most people are the first one and have nothing to do.

**Default `~/.claude`.** Nothing to configure:

```bash
cc-analyzer index && cc-analyzer stats
```

**Relocated data directory.** If you set `CLAUDE_CONFIG_DIR` for Claude Code,
cc-analyzer reads the same variable — no cc-analyzer configuration at all:

```bash
export CLAUDE_CONFIG_DIR=~/dotfiles/claude   # you already have this
cc-analyzer index
```

**Several profiles** (work + personal, or several machines synced into one
folder). Name each once; they are analyzed together as a single portfolio:

```bash
cc-analyzer claude-dir set ~/work/.claude       # start the list with this one
cc-analyzer claude-dir add ~/personal/.claude   # append the next
cc-analyzer index          # the index mirrors the configured set
cc-analyzer stats          # both profiles, one report
```

`set` first, `add` after: `add` appends to whatever is already in effect, which
before any configuration is `~/.claude` (or `CLAUDE_CONFIG_DIR`) — so two `add`s
from a clean slate keep the default alongside the two you named.

`cc-analyzer projects` then gains a **claude dir** column, and other lists name
the directory only where two labels would otherwise be identical.

**A one-off peek at another directory:**

```bash
cc-analyzer --claude-dir=/mnt/backup/.claude projects
```

Managing the persisted list:

```bash
cc-analyzer claude-dir                      # what is in effect, and why
cc-analyzer claude-dir add|set|remove <path>
cc-analyzer claude-dir reset                # back to the default resolution
cc-analyzer index                           # after any change
```

The `--claude-dir=<path>` flag (repeatable, or a `:`-separated list — `;` on
Windows, always inline with `=`) applies **only** to the commands that read
session files directly: `projects`, `sessions`, `analyze`, `doctor`. It is
refused on anything index-backed (`index`, `stats`, `audit`, `insights`,
`report`, `serve`, the TUI), because the index always covers every configured
directory: a one-off scope would be silently ignored on a report and would drop
the other directories' rows on `index`. Configure with `claude-dir set` and
reindex to scope those for real.

Directories resolve in this order, first tier that names anything wins — so a
directory you configure is never silently mixed with `~/.claude`:

1. `--claude-dir=<path>`
2. `CC_ANALYZER_CLAUDE_DIR` (a `PATH`-style list; also the test/CI hook)
3. `cc-analyzer claude-dir` (persisted in `~/.config/cc-analyzer/prefs.json`)
4. `CLAUDE_CONFIG_DIR` (Claude Code's own)
5. `~/.claude`

If your portfolio looks empty, `cc-analyzer claude-dir` prints every directory
searched, the setting that put it there, and marks any holding no `projects/`
directory.

Notes when several directories are configured:

- Two directories can each hold sessions for the *same* working directory. They
  stay separate projects rather than merging, and the directory is named
  wherever the labels would collide.
- The index mirrors your configured list: **removing a directory removes its
  sessions from the index** on the next `cc-analyzer index`. A directory that is
  merely unreadable right now (an unmounted volume) keeps its data instead.
- Adding a directory never re-parses the ones you already had.

### Environment overrides

- `CC_ANALYZER_CLAUDE_DIR` — Claude Code data dir(s) (default `~/.claude`).
- `CC_ANALYZER_STATE_DIR` — cc-analyzer state dir (default `~/.config/cc-analyzer`).
- `CLAUDE_CONFIG_DIR` — read, not written; Claude Code's own relocation variable.

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
  state lives in the cc-analyzer state directory — by default
  `~/.config/cc-analyzer/`, or `$XDG_CONFIG_HOME/cc-analyzer` /
  `CC_ANALYZER_STATE_DIR` — never in Claude's session directory.
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

`cc-analyzer index` scans every session under each configured Claude data
directory's `projects/` (`~/.claude/projects` by default), computes its metrics,
and stores them in a local SQLite cache at `~/.config/cc-analyzer/index.db`. It
is **incremental** — only new or changed files (by size + mtime) are re-parsed —
and the cache is disposable (delete and rebuild anytime).

`cc-analyzer stats` reports:

- Total spend, and spend by month, project, and model.
- The most expensive sessions.
- Your **skills ranked by the cost of the turns that invoked them**.
- **What-if model repricing** — replays each model's actual token mix (all four
  categories, both cache-write TTLs) at the rates of the other models you ran. A
  rate comparison only: a different model would produce different tokens, and
  quality is not priced in.
- **Context tax** — the median/p90 tokens each project's sessions pay before you
  type anything (system prompt + CLAUDE.md + MCP tool schemas, from the first
  main-chain API call). Continuation sessions and large opening pastes inflate
  it, so read the median rather than any single session.

Human-readable reports use a compact headline, grouped activity/reliability
sections, and aligned numeric tables; terminals get restrained color while
pipes, redirects, `NO_COLOR`, and `--json` stay automation-safe. JSON reports
carry a discriminated `scope` object identifying the portfolio or the selected
project.

Run `cc-analyzer stats --current` from a project — or any directory beneath it —
to scope every metric to that project's indexed sessions. Matching uses the
authoritative session `cwd`; if it is missing from the cache, refresh it with
`cc-analyzer index`.

### Setup audit

`cc-analyzer audit` reads your *setup* — skills, subagents, plugins, MCP
servers, hooks, and permission rules under each configured Claude data directory
(plus its `.claude.json` MCP config, read from either the sibling
`~/.claude.json` of a default install or from inside a relocated dir) — and
cross-references it with what the indexed sessions actually used. It reports an
inventory summary plus findings:

- **Unused MCP server** (a warning: its tool schemas are re-sent to the model
  every turn, so an unused one is pure context tax).
- **Unused skill or subagent**.
- **Error-prone skill** (≥25% errors over ≥5 invocations).
- **Stale skill** (unused for 30+ days).
- **Unused plugin** — nothing it ships (skills, subagents, or MCP servers) was
  ever used; reported once for the plugin, not once per dead component.
- Skills or subagents that sessions used but that are **no longer installed**.

With plugins installed it also prints a **Plugins** table: per plugin, how many
of its skills and subagents you use, its invocation count, the turn-scoped
dollars attributed to its skills, and when it last ran.

The scan is read-only and tolerant — a missing or malformed config file is
skipped, never fatal. Findings are machine-local and historical (the index can
cover sessions predating the current setup, and project-scoped items live
outside the Claude config dir), so treat them as prompts to look, not verdicts.
The same audit is served at `/api/audit` and rendered on the web app's Tools
view.

### Portfolio insights

`cc-analyzer insights` is the portfolio-wide counterpart of the per-session
"actionable diagnostics". A bun-free rules engine folds every portfolio signal —
cache efficiency, compaction pressure, context tax, what-if repricing, retry
churn, edit-test thrash, redundant file re-reads, correction-heavy prompting,
weekly error trend, spend concentration, pricing confidence, the setup audit,
subagent balance, and parse coverage — into a ranked list of explainable
findings, warnings before infos and dollar-backed findings first within a
severity.

These are deliberately named heuristics with conservative, documented thresholds
— **not a score**: every finding shows the observed numbers as evidence and
suggests a concrete next action (e.g. "batch related work so the 5-minute cache
TTL amortizes", "trim that project's CLAUDE.md"). The same findings open the web
app's Insights page (via `/api/insights`) and appear as a compact list in the
TUI insights view; the full rule table with thresholds lives in the wiki's
Analytics & Insights page.

### Weekly digest

`cc-analyzer report` turns all of the above from something you go looking for
into something you read on a schedule: one week of usage, what changed against
the week before, and what to fix. It prints:

- A headline (cost, sessions, active time, tokens) with signed deltas.
- The week's top projects, model mix, and cache economics.
- Reliability — tool errors, test runs, retries, thrash, corrections.
- The skills that cost the most turn-scoped dollars.
- A snapshot of the portfolio insights.

`--md` writes paste-ready markdown to stdout for notes or chat
(`cc-analyzer report --md > week.md`); `--json` emits the plain object. Both are
renderings of the same digest, so asking for both is an error, not a silent
choice.

The default period is the **last complete ISO week** (Monday–Sunday) — a
half-finished current week would always read as a decline; `--week YYYY-MM-DD`
reports the week containing any given day. Sessions are attributed to their
**start day**, so one running past midnight counts entirely in the period it
began (the digest says so wherever it renders). The insight snapshot is
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
with an **amber-phosphor** retro-terminal look. It's a persistent shell: a title
bar, a **nav rail** (portfolio · projects · sessions · insights · trends ·
tools), and a **two-pane master-detail** body where a list on the left drives a
live **preview** on the right as you move the cursor. It reads from the index and
builds an empty cache on first use; later source changes are flagged in the shell
so you know when to run `cc-analyzer index`.

The views:

- **Projects preview** — spend/tokens/activity vitals, per-project chart lines, a
  **cache-efficiency** line (verdict, read:write ratio, un-amortized waste $), a
  **findings** line counting the portfolio-insight findings scoped to that
  project (the same signals the web Projects page shows as columns), and a top-3
  **hot files** teaser. On short terminals it drops its lowest-priority blocks
  rather than overflowing.
- **Insights** — a cache-efficiency hit-list: projects ranked by un-amortized
  cache-write spend (cache you paid to write but didn't read back), with a
  read:write verdict, drilling into the leakiest sessions. Its header opens with
  the top **portfolio insight** findings (severity glyph + title; full evidence
  in `cc-analyzer insights`), plus the portfolio **context tax** (median/p90
  tokens spent before you type) and the cheapest single model your token mix
  could have run on.
- **Trends** — a four-panel time-series dashboard (`tab` / `1`·`2`·`3`·`4`): a
  braille **burn** chart with y-axis value labels (`m` cycles cost/tokens/sessions,
  `g` the day/week/month granularity — it now opens at the finest bucketing that
  still fits the chart's width instead of always starting at day, so a long
  portfolio history opens weekly or monthly rather than cramming hundreds of
  daily points into however many terminal columns there are), an activity **heatmap** by local
  weekday × hour (`m` toggles to cost), a contribution-style **calendar** (`m`
  toggles cost/sessions), and a **models** panel with a date-range line under the
  header and each model's weekly sparkline padded to that shared range and scaled
  to one shared ceiling — so rows stacked above one another read as one timeline
  instead of each implying its own — alongside total and share.
- **Tools** — a four-panel view (`tab` / `1`·`2`·`3`·`4`): **tools** ranked by
  invocations with error count and rate (`s` sorts); **skills** in more depth
  (invocations, sessions, distinct projects, error rate, turn- and
  session-scoped cost, plus an adoption strip of first/last-used + a weekly
  sparkline for the selected skill); **subagents** by how many sessions used
  each; and a **reliability** panel (test runs and failures, tool-call churn,
  edit-test thrash and redundant re-reads with the most re-read files, correction
  and interruption turns, and parse coverage with an update prompt when the
  parser lags the newest Claude Code format).

Skill cost is reported at two scopes: *turn-scoped* (the cost of the turns that
invoked the skill, subagent bursts inside them included) is the primary number,
and *session-scoped* is the whole-session upper bound. Both are correlational,
not causal — a turn or session touching several skills counts its full cost
toward each.

Opening a session zooms to a full-screen view with a vitals band and its own
two-pane **turns → steps** (each step expands an amber card with its
input/result), plus **charts**, **transcript**, and **summary** modes
(`c` / `t` / `s`):

- **Charts** — the braille context-window sawtooth (`▼` compaction markers,
  "% of window", and a headroom projection when the context is growing), a
  per-call **cache-hit chart** with cold-call count (each column shows its
  worst call, since a rate's dips are its signal; drawn only when the screen's
  row budget allows real height, and omitted otherwise — at the fixed one-row
  height it used to have, any hit rate above ~87% read as a solid block),
  cost-per-call and cost-per-turn sparklines annotated with idle
  gaps and `▲` markers on interrupted/correction/thrash turns, plus in-session
  model-mix and per-burst subagent spend lines.
- **Summary** — the same evidence-backed context and cost diagnostics as the CLI
  and web app, plus **cost-per-outcome** ratios and a session-scoped **what-if
  repricing** line (each with its caveat).

Navigation is a two-zone focus model. In a list, start typing to **filter**,
`tab`/`shift-tab` cycles the **sort**, `↑/↓` moves (updating the preview), and
`enter` drills in. Press `esc` on an empty filter to focus the nav rail, then
`↑/↓` (or `1`-`6`) to switch views and `enter`/`→` to return to the list. `?`
shows the full keybinding cheatsheet; `ctrl-c` quits. The layout is responsive —
the rail collapses to icons, then to a single pane, on narrow terminals — and
requires an interactive terminal (TTY); piped/non-interactive use falls back to a
hint about the scriptable commands.

### Web app

`cc-analyzer serve` builds the index when it is empty, then starts a local web
server (Hono API + an embedded React SPA). Pass `--refresh` to incrementally
refresh an existing index before serving, and `--open` to launch the URL in your
default browser (best-effort, loopback hosts only). The server listens on
loopback only (`127.0.0.1`) and rejects non-local `Host` headers, since sessions
contain full conversation transcripts; pass `--host=0.0.0.0` only if you
deliberately want to expose it to your network.

The UI's pages:

- **Dashboard** — the portfolio overview, with a monthly spend bar chart above
  its sortable table and a top-15 project table.
- **Projects** — every indexed project, unpaginated and sortable/filterable, with
  cache-waste and portfolio-finding counts folded in from the same signals as
  Insights. Each drills into Overview, Sessions, Trends, and Files views.
- **Insights** — opens with the ranked **portfolio insight** findings (warnings
  first, each with evidence, a next action, and a project link when the signal is
  project-scoped), then the same cache-efficiency hit-list as the TUI, plus
  **context tax** per project and the **what-if model repricing** table, each
  carrying its caveat inline.
- **Trends** — 30-day, peak-spend, and error-rate headlines plus burn (opens at
  the finest day/week/month granularity that still fits the chart's width, so a
  long portfolio history doesn't cram hundreds of daily points into it; the
  granularity toggle still overrides it), calendar, model-mix, activity, scatter,
  reliability, subagent, and concurrency charts.
- **Tools** — organized into Tools, Reliability, Compactions, Skills, Agents, and
  Environment views.

Every chart is interactive: hovering shows a crosshair and a themed tooltip with
the value at that point (line/area charts snap to the nearest point, bars and
the scatter hit-test the nearest mark). On charts that aren't driven by a shared
cursor, **clicking pins** the tooltip so a value can be read or compared without
holding the pointer still, and **dragging across a trend line zooms** to that
range (with a reset control). The context and cache session charts instead share
one cursor — hovering either lights up the same call on the other — so they read
the shared position rather than pinning. Section and chart controls are
URL-backed, keyboard navigable, and shareable; each major chart includes a
collapsible data table so its values stay usable without a pointer. Projects and
sessions can be **filtered** by name.

A **color-theme toggle** (System / Light / Dark) sits in the masthead. The
choice is stored per-browser in `localStorage` (a theme follows the display, not
the data — unlike the server-side cost-basis setting), and "System" tracks your
OS preference live. An inline script applies the resolved theme before first
paint, so there is no flash of the wrong theme on load.

The per-session view offers:

- **Turns** — expands each turn into a **step timeline** (assistant narration,
  thinking markers, and tool operations with a one-line summary and a result
  status/hint like `✓ 71 lines` or `✗ error…`), each step click-to-expand for its
  full input and result. The list is **sortable** by turn number, cost, tokens,
  calls, or wall time, so the expensive turn is one click away instead of buried
  at #480, and every turn states its **share of the session** (`18% of
  session`) plus a **cost shape** naming why it was expensive — subagent burst,
  cache churn, long generation, or a long context read many times over. The color-coded **transcript** reader is windowed
  ("show more") so very large sessions stay responsive.
- **Charts** — context-window fill per API call (compaction markers annotated
  with the tokens each reclaimed, a dashed window-limit line, and a headroom
  projection when the context is growing), a **cache-efficiency** chart (per-call
  hit rate against a fixed 0–100% y-axis, cold calls), cumulative cost with
  **idle-gap** markers, per-turn bars toggling cost/tokens/calls/depth/time (the
  cost metric stacks the four token categories; interrupted/correction/thrash
  turns carry warning markers) and switchable between session order and a
  **cost-ranked Pareto** view with a cumulative-share curve, plus
  **tool-activity** bars, an in-session
  **model mix**, and a **subagent bursts** table attributing sidechain spend to
  the specific agents that ran (typed best-effort from their spawn prompts when
  metadata is unavailable).
- **Summary** — groups spend/tokens, execution, and environment details, then
  explainable context and cost diagnostics with suggested next actions,
  **cost-per-outcome** ratios, a **costliest turns** block with share and
  cumulative-share columns that jumps straight into the Turns tab, a session-scoped **what-if repricing** summary, and
  a **cost rank** card placing the session's spend among its project's (and the
  portfolio's) sessions.

The SPA is built by Vite into a single self-contained HTML file
(`bun run build:web`) and baked into the binary, so the release build serves the
whole UI with no external assets.

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
- Ideas: live-follow of active sessions; diff/compare two sessions.

## License

Licensed under the [MIT License](LICENSE).
