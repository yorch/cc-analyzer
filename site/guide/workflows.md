---
title: Workflows
description: Task-oriented workflows for analyzing sessions, exploring the portfolio, using the dashboard, and keeping data fresh.
---

# Workflows

## Understand one session

Use `cc-analyzer analyze <id|path>` for a complete session report. Add
`--json` for automation, `--md` or `--html` for a shareable artifact, and
`--redact` before sharing outside your machine. `doctor <id|path>` is the
read-only structural health check when you are investigating missing parents,
tool results, interruptions, or parse coverage.

See [Export and share](/guide/export-share) for transcript and redaction
choices, and [Recipes](/docs/10-recipes) for post-mortem examples.

## Explore the portfolio

```sh
cc-analyzer index
cc-analyzer stats
cc-analyzer insights
cc-analyzer report
```

Portfolio commands read the SQLite index. If the index is empty or stale, run
`cc-analyzer index` first. `report` summarizes the last complete ISO week by
default; pass `--week YYYY-MM-DD` for another week.

## Use the local web app

```sh
cc-analyzer serve --open
```

The server binds to loopback by default and serves the dashboard from the
binary. Use `cc-analyzer serve --refresh` when you want to refresh the index
before opening it. The dashboard covers projects, trends, tools, insights,
session charts, transcript views, and export actions.

Only expose a non-loopback host when you understand the trust boundary:
there is no authentication, and the server includes transcript, export,
preference, and optional Claude-handoff routes.

## Keep data directories straight

The default is `~/.claude`. For a one-off direct-file inspection, use
`--claude-dir=<path>` with `projects`, `sessions`, `analyze`, or `doctor`.
For indexed reports over multiple roots, configure them with
`cc-analyzer claude-dir set|add` and reindex. See the [installation and data
directory guide](/install#claude-data-directories).

## What should I read next?

- [Export and share](/guide/export-share)
- [Troubleshooting](/guide/troubleshooting)
- [Privacy and security](/guide/privacy)
- [Implementation reference](/docs/)
