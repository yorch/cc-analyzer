---
title: Troubleshooting
description: Fix empty portfolios, stale indexes, missing sessions, TUI startup issues, and export or Claude-handoff failures.
---

# Troubleshooting

## The portfolio is empty or stale

Run:

```sh
cc-analyzer claude-dir
cc-analyzer index --check
cc-analyzer index
```

The first command shows every configured Claude root and its source. The index
only includes the configured roots, so reindex after changing them.

## A session cannot be found

`analyze` and `doctor` accept either a session id or a `.jsonl` path. Confirm
the file exists under the configured Claude directory. For another directory,
use `--claude-dir=<path>` on those direct-file commands.

## The TUI does not start

The TUI needs an interactive terminal. Use `cc-analyzer stats` or
`cc-analyzer serve --open` in scripts, CI, or terminals without a TTY.

## A report is missing newer sessions

Index-backed views read the cache. Run `cc-analyzer index`; for the web app use
`cc-analyzer serve --refresh`.

## Analyze-with-Claude is unavailable

The optional handoff needs a local `claude` executable on `PATH` (or Claude
Code's local installation). Without it, ordinary parsing and analysis still
work.

## Export or parsing problems

Use `doctor <id|path> --json` and inspect parse coverage in the report. ZIP
exports additionally require the system `zip` command. Exported artifacts can
be large when transcripts are included, so try without `--include-transcript`
first.

For implementation details, see the [CLI reference](/docs/3-cli), [Web/API
reference](/docs/5-web-server-and-api), and [Core analysis reference](/docs/2-core-analysis-engine).
