# cc-analyzer

## 0.24.0

### Minor Changes

- [#131](https://github.com/yorch/cc-analyzer/pull/131) [`0430f37`](https://github.com/yorch/cc-analyzer/commit/0430f37e19ae3321f5e63e95ee1d670b8bbc49f0) Thanks [@yorch](https://github.com/yorch)! - Add `fable` to the one-click model choices for "Analyze with Claude Code" in the TUI and web dashboard, and document index schema versions v17 through v20 in the wiki.

### Patch Changes

- [#124](https://github.com/yorch/cc-analyzer/pull/124) [`c20a206`](https://github.com/yorch/cc-analyzer/commit/c20a2062ada249f51481121809f52ba0cc1c35c1) Thanks [@yorch](https://github.com/yorch)! - Document the contributor workflow for AI agents in AGENTS.md: work in a git worktree, commit in logical groups, and use Conventional Commits.

- [#129](https://github.com/yorch/cc-analyzer/pull/129) [`a459771`](https://github.com/yorch/cc-analyzer/commit/a459771a61279c2ba18af94b21a1cdc1d8d3e716) Thanks [@yorch](https://github.com/yorch)! - Improve landing-page accessibility and load: add a `<main>` landmark, raise the contrast of the terminal mock's rule lines in both themes, and stop preloading the unused Inter font.

- [#130](https://github.com/yorch/cc-analyzer/pull/130) [`695e542`](https://github.com/yorch/cc-analyzer/commit/695e54232143a9658c7ffa08bd8f1090778e909f) Thanks [@yorch](https://github.com/yorch)! - Speed up the landing page's first paint: inline its critical CSS at build time and load the rest of the stylesheet without blocking rendering.

- [#127](https://github.com/yorch/cc-analyzer/pull/127) [`2305caa`](https://github.com/yorch/cc-analyzer/commit/2305caadc0715ff4feb8e5623e4316989c2bc254) Thanks [@yorch](https://github.com/yorch)! - Improve SEO across the docs site: unique, length-appropriate meta descriptions and keyword-bearing titles on every docs, guide, and install page, `TechArticle` + `BreadcrumbList` structured data, sitemap `lastmod` for every page, a `Content-Signal` preference in `robots.txt`, an `llms.txt` page index, and short intros on the Workflows and Troubleshooting guides.

- [#126](https://github.com/yorch/cc-analyzer/pull/126) [`27d9bb4`](https://github.com/yorch/cc-analyzer/commit/27d9bb43402f9ec9f8d3735b2fb2b829dd2b6ba9) Thanks [@yorch](https://github.com/yorch)! - Improve landing-page SEO on the docs site: a dedicated 1200×630 social card image, `SoftwareApplication` structured data, `robots.txt` advertising the sitemap, a keyword-bearing page title, and a descriptive (screen-reader) H1 suffix.

- [#128](https://github.com/yorch/cc-analyzer/pull/128) [`ebe3ec1`](https://github.com/yorch/cc-analyzer/commit/ebe3ec18b914eaf73f293db0a78cfec76ad3fd98) Thanks [@yorch](https://github.com/yorch)! - Fix the landing page's `SoftwareApplication` JSON-LD: replace the unrecognized `codeRepository` property with `sameAs` so the schema validator reports no warnings.

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
