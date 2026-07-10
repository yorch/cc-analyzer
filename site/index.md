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
  - icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2.5h12v17l-2-1.4-2 1.4-2-1.4-2 1.4-2-1.4-2 1.4z"/><path d="M9 8h6M9 11h6M9 14h4"/></svg>'
    title: Real cost & cache accounting
    details: Sessions record token counts but not cost. cc-analyzer derives it from a per-model pricing table, pricing input, output, and cache read/write tokens separately — where most real spend hides.
  - icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="4" width="19" height="16" rx="2.5"/><path d="M7 9.5l3 2.5-3 2.5M13 15h4"/></svg>'
    title: Interactive terminal UI
    details: Browse projects → sessions → per-turn detail in an Ink TUI with inline filtering and Summary / Turns / Transcript tabs.
  - icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="4" width="19" height="16" rx="2.5"/><path d="M2.5 8.5h19"/><circle cx="5.8" cy="6.25" r=".7" fill="currentColor" stroke="none"/><circle cx="8.3" cy="6.25" r=".7" fill="currentColor" stroke="none"/></svg>'
    title: Local web app
    details: "cc-analyzer serve launches a Hono API and an embedded React dashboard: portfolio overview, project drill-down, and a windowed transcript reader."
  - icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5.5" rx="7" ry="2.8"/><path d="M5 5.5v6c0 1.55 3.13 2.8 7 2.8s7-1.25 7-2.8v-6"/><path d="M5 11.5v6c0 1.55 3.13 2.8 7 2.8s7-1.25 7-2.8v-6"/></svg>'
    title: Incremental SQLite index
    details: A disposable local index that re-parses only changed sessions (by size + mtime), then powers portfolio-wide analytics — spend by month, project, and model.
  - icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2.8l8 4.4v9.6l-8 4.4-8-4.4V7.2z"/><path d="M12 11.6v9.6M4 7.2l8 4.4 8-4.4"/></svg>'
    title: Single-binary distribution
    details: Ships as one self-contained executable — CLI, TUI, API, and web UI baked in — cross-compiled for macOS, Linux, and Windows.
  - icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="4.5" y="10.5" width="15" height="10" rx="2.5"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/><path d="M12 14.5v2.5"/></svg>'
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
