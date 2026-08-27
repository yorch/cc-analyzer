---
title: Get started
description: Install cc-analyzer, build your local index, and choose the best way to explore Claude Code sessions.
---

# Get started

cc-analyzer reads the Claude Code session files already on your machine and
turns them into searchable, costed, explainable reports. The normal workflow
takes a few minutes:

## First five minutes

```sh
# 1. Install the self-contained binary (or see the full install guide)
curl -fsSL https://cc-analyzer.brnby.com/install.sh | sh

# 2. Build the local index
cc-analyzer index

# 3. See portfolio totals
cc-analyzer stats

# 4. Choose an interface
cc-analyzer                 # interactive terminal UI
cc-analyzer serve --open   # local web dashboard

# 5. Inspect one session when you have its id or path
cc-analyzer analyze <session-id>
```

The index is a disposable local cache. Run `cc-analyzer index` again after
sessions change; use `cc-analyzer index --check` to test freshness without
changing it. `analyze` and `doctor` can read a session directly and do not
require an index.

## Choose your interface

| You want to… | Use | Why |
| --- | --- | --- |
| Script or automate reports | CLI | Plain text and JSON output, meaningful exit codes |
| Browse quickly in a terminal | TUI | Keyboard-driven portfolio, session, chart, and transcript views |
| Compare projects and trends | Web app | A local dashboard with charts, search, and drill-downs |

Continue with the [workflow guide](/guide/workflows), or jump directly to:

- [Install and configure Claude data directories](/install)
- [Export and share results](/guide/export-share)
- [Diagnose a damaged or incomplete session](/guide/troubleshooting)
- [Privacy and security boundaries](/guide/privacy)

Detailed source-level behavior lives in the [Implementation reference](/docs/).
