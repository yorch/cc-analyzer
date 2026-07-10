# cc-analyzer

A read-only CLI to browse and analyze [Claude Code](https://claude.com/claude-code)
sessions stored in `~/.claude` — tokens, cost, tools, skills, models, and a
per-turn breakdown. Built with TypeScript + Bun; ships as a single binary.

> Status: **Phase 1 (analysis core + scriptable CLI)**. TUI and web app are planned.
> See [`docs/superpowers/specs`](docs/superpowers/specs) for the full design.

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
cc-analyzer projects                 # list all projects, by session count
cc-analyzer sessions <projectId>     # list sessions in a project
cc-analyzer analyze <id|path>        # analyze one session (human-readable)
cc-analyzer analyze <id|path> --json # analyze one session (machine-readable)
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

## Roadmap

- Phase 2: SQLite index + portfolio analytics (`stats`, cross-project rollups).
- Phase 3: interactive TUI (Ink).
- Phase 4: embedded local web app (Hono + React SPA).
