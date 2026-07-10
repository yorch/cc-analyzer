---
layout: home

hero:
  name: cc-analyzer
  text: Analyze your Claude Code sessions
  tagline: Cost, tokens, tools, skills, models, and per-turn breakdowns — from the JSONL transcripts already sitting in ~/.claude. Read-only, local, single binary.
  actions:
    - theme: brand
      text: Get Started
      link: /docs/
    - theme: alt
      text: View on GitHub
      link: https://github.com/yorch/cc-analyzer

features:
  - icon: 🧮
    title: Real cost & cache accounting
    details: Sessions record token counts but not cost. cc-analyzer derives it from a per-model pricing table, pricing input, output, and cache read/write tokens separately — where most real spend hides.
  - icon: 🖥️
    title: Interactive terminal UI
    details: Browse projects → sessions → per-turn detail in an Ink TUI with inline filtering and Summary / Turns / Transcript tabs.
  - icon: 🌐
    title: Local web app
    details: "cc-analyzer serve launches a Hono API and an embedded React dashboard: portfolio overview, project drill-down, and a windowed transcript reader."
  - icon: 🗃️
    title: Incremental SQLite index
    details: A disposable local index that re-parses only changed sessions (by size + mtime), then powers portfolio-wide analytics — spend by month, project, and model.
  - icon: 📦
    title: Single-binary distribution
    details: Ships as one self-contained executable — CLI, TUI, API, and web UI baked in — cross-compiled for macOS, Linux, and Windows.
  - icon: 🔒
    title: Read-only & private
    details: Never writes to ~/.claude. Its own state (pricing cache, index) lives under ~/.config/cc-analyzer. Your session data stays on your machine.
---

## Quick start

Requires [Bun](https://bun.sh) ≥ 1.3.

```bash
# install dependencies
bun install

# build the portfolio index from ~/.claude, then see totals
bun start index
bun start stats

# analyze a single session (human-readable or --json)
bun start analyze <session-id>

# launch the interactive TUI (no arguments)
bun start

# or the local web app
bun start serve
```

Build a single self-contained binary:

```bash
bun run build   # -> dist/cc-analyzer
```

## The web dashboard

The `serve` command exposes a portfolio dashboard with project drill-down, an
expandable per-turn view, and a color-coded transcript reader — all served from
the compiled binary with no external assets.

![cc-analyzer web dashboard](/screenshots/dashboard.png)

## What it reports

Totals (cost, turns, API calls, tool calls, tokens, duration, web search/fetch),
a cost breakdown by token category and model, the tools, skills, and subagents
used, files touched, and a per-turn breakdown — where a *turn* is one genuine
user prompt plus every assistant API call and tool loop until the next prompt.

Dive into the [documentation](/docs/) for the full architecture, or jump to the
[cost & pricing model](/docs/2-2-cost-and-pricing) and the
[glossary](/docs/glossary).
