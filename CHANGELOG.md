# cc-analyzer

## 0.23.1

### Patch Changes

- [#122](https://github.com/yorch/cc-analyzer/pull/122) [`2ce60d0`](https://github.com/yorch/cc-analyzer/commit/2ce60d0cbeb8bde3ac1f7676030add2c9ef41621) Thanks [@yorch](https://github.com/yorch)! - Retire the `claude-sonnet-5` price correction and refresh the bundled pricing snapshot.
  
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

## 0.23.0

### Minor Changes

- [#121](https://github.com/yorch/cc-analyzer/pull/121) [`cf6eb70`](https://github.com/yorch/cc-analyzer/commit/cf6eb70af4869d912fbbef7c9c3b1dda41db86c7) Thanks [@yorch](https://github.com/yorch)! - Add an opt-in Git-backed raw session archive. Configure a dedicated repository, archive and commit complete session trees locally, and include archived sessions in the ordinary index and portfolio reports. Remote pushes remain manual; archive data is unencrypted and the CLI documents its sensitivity.

### Patch Changes

- [#118](https://github.com/yorch/cc-analyzer/pull/118) [`1aeb243`](https://github.com/yorch/cc-analyzer/commit/1aeb2430450f2208083f40c1d3965fa30b0c964c) Thanks [@yorch](https://github.com/yorch)! - Document why a session's cost reads below Claude Code's own `total_cost_usd`.
  
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

## 0.22.1

### Patch Changes

- [#115](https://github.com/yorch/cc-analyzer/pull/115) [`99ad3c7`](https://github.com/yorch/cc-analyzer/commit/99ad3c78a399189338f5db16ee575fcf75d69720) Thanks [@yorch](https://github.com/yorch)! - Automate reviewed version PRs and hardened GitHub binary releases.
