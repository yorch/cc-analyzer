# cc-analyzer

A read-only CLI to browse and analyze [Claude Code](https://claude.com/claude-code)
sessions stored in `~/.claude` — tokens, cost, tools, skills, models, and a
per-turn breakdown. Built with TypeScript + Bun; ships as a single binary.

> Status: **Phase 3 (core + index + analytics + interactive TUI)**.
> The web app is planned. See [`docs/superpowers/specs`](docs/superpowers/specs)
> for the full design.

## Why

Claude Code stores every session as a JSONL transcript under
`~/.claude/projects/<project>/<session>.jsonl`. Those files record token usage
per API call but **not cost** — cost is derived here from token counts and a
per-model pricing table (fetched from [LiteLLM](https://github.com/BerriAI/litellm),
cached locally, with a bundled fallback). Cache-read/write tokens are priced
separately, which is where most of the real spend hides.

The tool is **read-only**: it never writes to `~/.claude`. Its own state
(pricing cache, and later the session index) lives under `~/.config/cc-analyzer/`.

## Install / run

Requires [Bun](https://bun.sh) ≥ 1.3.

```bash
bun install
bun run src/cli/index.ts <command>   # or: bun start <command>
```

Build a single binary:

```bash
bun run build          # -> dist/cc-analyzer
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
cc-analyzer pricing update           # refresh the pricing cache
```

`<id>` is a session uuid (searched across all projects) or a path to a `.jsonl`
file. `<projectId>` is the encoded directory name shown by `projects`.

### What the analysis reports

- **Totals**: cost, turns, API calls, tool calls, tokens, duration, web search/fetch.
- **Cost breakdown** by token category (input / output / cache-write / cache-read)
  and by model.
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

### Interactive TUI

Running `cc-analyzer` with no arguments launches a terminal UI (built with Ink):
browse **projects → sessions → session detail**, where the detail view has
**Summary**, **Turns**, and **Transcript** tabs. It reads from the index, so run
`cc-analyzer index` first. Keys: `↑/↓` or `j/k` move, `enter` open, `esc` back,
`1/2/3` or `tab` switch detail tabs, `q` quit. It requires an interactive
terminal (TTY); piped/non-interactive use falls back to a hint about the
scriptable commands above.

## Roadmap

- ~~SQLite index + portfolio analytics~~ ✓
- ~~Interactive TUI (Ink)~~ ✓
- Phase 4: embedded local web app (Hono + React SPA).
