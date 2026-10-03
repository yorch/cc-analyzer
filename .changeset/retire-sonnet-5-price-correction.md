---
"cc-analyzer": patch
---

Retire the `claude-sonnet-5` price correction and refresh the bundled pricing snapshot.

Claude Code 2.1.288 now bills `claude-sonnet-5` at the $2/$10 rate LiteLLM
publishes — its embedded catalog reads `tier_2_10`, and a controlled `claude -p`
probe (`total_cost_usd` $0.0586304 for 2 in / 4 out / 14,130 1h cache writes /
10,332 cache reads) matches that rate exactly. The standing `PRICE_CORRECTIONS`
entry forced $3/$15 and so overstated every Sonnet 5 session by 1.5x; it is
removed. **Schema v20** forces the rebuild that recomputes the affected indexed
rows.

`bundled-pricing.json` is refreshed from live LiteLLM: it gains the current
models (`claude-opus-5-5`, `claude-sonnet-5-5`, `claude-fable-5-1`,
`claude-mythos-5`, `claude-mythos-5-1`, `claude-mythos-preview`) and fixes a
stale `maxInputTokens` (200K → 1M) on `claude-sonnet-4-5`. The what-if fallback
ladder moves to the newest model of each family (`claude-opus-5-5`,
`claude-sonnet-5-5`, `claude-haiku-4-5`).
