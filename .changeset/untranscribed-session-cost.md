---
"cc-analyzer": patch
---

Document why a session's cost reads below Claude Code's own `total_cost_usd`.

Claude Code bills 33 internal query sources (session titling, away recaps,
compaction, auto mode, subagent naming, tool-result summaries, hook prompts)
plus credited stream retries to a session, and writes none of them into the
transcript. A transcript-derived session cost is therefore a floor, measured
7-9% below `total_cost_usd` on long, hook-heavy, auto-mode sessions.

The README previously claimed a single session matched Claude Code's accounting
"exact to the cent"; that holds only for short controlled sessions and is now
scoped accordingly. The Cost & Pricing reference gains a full write-up with the
checks that rule out a pricing or token-counting cause, and the commands to
re-verify against a future Claude Code release. No behavior changes.
