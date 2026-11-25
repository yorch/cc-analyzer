# cc-analyzer

## 0.27.1

### Patch Changes

- [#147](https://github.com/yorch/cc-analyzer/pull/147) [`dcfadfb`](https://github.com/yorch/cc-analyzer/commit/dcfadfb1f155d30d599900b5c18e83c70c95502e) Thanks [@yorch](https://github.com/yorch)! - Small fixes found by a real-browser pass and a review of the multi-root labelling work.
  
  - Web: the Tools tab (and any other hash-param control) now follows in-page hash changes and Back/Forward; the Dashboard digest card tags its top project with its root; the Projects filter matches path and alias like the other lists; the Session page and Tools > setup no longer overflow horizontally at phone width.
  - `report --json` and `/api/report` no longer carry the render-only `knownLabels` list.
  - The telemetry poster's stdin read is bounded (2s), so it can never hang on a pipe whose writer died.

## 0.27.0

### Minor Changes

- [#143](https://github.com/yorch/cc-analyzer/pull/143) [`78744c4`](https://github.com/yorch/cc-analyzer/commit/78744c4fbc6d18a222947424cd8aed4623782d0d) Thanks [@yorch](https://github.com/yorch)! - Review-driven fixes and hardening. Schema v23 triggers a one-time automatic reindex.
  
  **Security**
  
  - `serve` on a non-loopback `--host` is now read-only for writes: `PUT`/`POST /api/prefs`, `POST /api/sessions/:id/analyze` and `GET /api/export` return `403`. Write routes require `Content-Type: application/json` and, when an `Origin` header is sent, a same-origin one. Responses carry `X-Content-Type-Options: nosniff`.
  - `--redact` is now allowlist-based: one shared redactor (`src/core/redact.ts`) feeds the CLI, TUI, web, and export payloads, so string fields not known to be safe are redacted by default. Shareable export bundles carry aggregates only, and the HTML report has no script and a restrictive Content-Security-Policy.
  - Analyze-with-Claude-Code also denies `Bash,Edit,Write,NotebookEdit,WebFetch,WebSearch,mcp__*`, fences the session title and project path as untrusted data, and kills the `claude` child on abort, client disconnect, or early stop.
  - `archive` refuses a path inside another Git repository and never writes through symlinked destinations (reported as refused).
  - The telemetry poster payload is passed over stdin instead of argv.
  
  **Fixes**
  
  - `index --rebuild` is atomic: an interrupted rebuild no longer leaves an empty usage ledger, and a failed analysis releases its claims and leaves a re-analysis debt.
  - Bundled prices are layered under the remote/cached LiteLLM table, so ids LiteLLM dropped keep pricing.
  - Analyzer hardening for drifted events, replayed tool blocks, late test results, and turn depth for cross-file refused calls.
  - Diagnostics: idle-cache rewrites respect the previous call's cache TTL and require write > read; repeated-file-reads triggers per chain; cache-churn needs at least two writes; error-rate-rising zero-fills gap weeks and drops only the current week.
  - Web: data stays visible while refetching and requests abort; error boundary, not-found route, per-route title and focus, and better light-theme text contrast.
  
  **Behavior changes**
  
  - Schema v23: the index rebuilds once on first run.
  - Non-loopback `serve` can no longer change prefs, run Analyze-with-Claude, or export.
  - CLI is stricter: `--help`/`-h` after a subcommand never runs it; unknown flags and valueless flag values exit 2; `serve --port N` / `--host x` space forms work; unknown commands print to stderr and exit 2; `doctor` exits 0 healthy, 1 warning/damaged, 2 usage; `FORCE_COLOR` is honored; valueless `--project`/`--session` are errors.

### Patch Changes

- [#145](https://github.com/yorch/cc-analyzer/pull/145) [`7f45dfc`](https://github.com/yorch/cc-analyzer/commit/7f45dfc938daf67620b21404d0038beebac5e8f7) Thanks [@yorch](https://github.com/yorch)! - Follow-ups to the review hardening release.
  
  - Web: prefs, insights and analytics are fetched once and shared across views (60s cache, invalidated when prefs change); one shared mini-bar component; 44px touch targets for interactive controls; heatmap and calendar charts expose a visible "show data table" path for touch and keyboard users.
  - TUI: opening session search or help no longer discards the session screen; session search expands `~`, strips pasted quotes, finds bare ids across roots (including archives) and says why a lookup failed; Insights shows a loading frame instead of freezing the first render.
  - Setup audit: installed plugins are read from `installed_plugins.json` when present (so plugin names are never invented from record fields and merely-cloned marketplaces are not reported as installed), and `plugins/cache` is no longer skipped.
  - Per-root project labels now work for the compaction, web-tools, estimated-share and sidechain rollups, and the compaction-pressure rule can see small projects with a high compaction share.
  - Chart markers no longer land after untimed points that precede them.

- [#146](https://github.com/yorch/cc-analyzer/pull/146) [`962bfc3`](https://github.com/yorch/cc-analyzer/commit/962bfc320203bb3c097ca9862e90bddfcaf0bbd9) Thanks [@yorch](https://github.com/yorch)! - Tell same-named projects from different Claude roots apart everywhere they are listed.
  
  - The web Dashboard (heuristically priced spend), Tools (compactions, sidechain, web search/fetch) and Insights tables, plus the `insights` command's and the web's finding lines, now show `name [root]` when two roots hold a project of the same name — even when the other copy was cut from a limited list.
  - A project group merged by an alias that spans several roots is no longer tagged with an arbitrary one of them.
  - Web project filters also match the root tag; a project with no recorded path shows its decoded name instead of the raw stored id.

## 0.26.0

### Minor Changes

- [#141](https://github.com/yorch/cc-analyzer/pull/141) [`2e730e5`](https://github.com/yorch/cc-analyzer/commit/2e730e58ac808a340e3a0b65f84347ca02df56ac) Thanks [@yorch](https://github.com/yorch)! - Store project aliases per computer so editing them can never cause a Git merge conflict. Each computer now writes its alias edits only under its own `machines/<id>/` (in `project-aliases.json`), and the effective alias for a path is the most recent edit across all computers (removals are recorded so they win too). Computers that edit aliases at different times merge with a plain `git pull`; there is no shared JSON file to hand-merge.
  
  The old shared `project-aliases.json` is still read, as the lowest-priority source, and is never rewritten, so existing aliases keep working. An older cc-analyzer on another computer will not see aliases written by this version, so update every computer before editing aliases from more than one.
  
  `archive alias set`, `current`, and `remove` now need this computer to have a recorded identity (`archive machine keep`, `archive machine adopt <id>`, or a first `archive run`). Each edit commits this computer's `machine.json` in the same commit as its alias file. Commands that read aliases now report an unreadable alias file as a clean error that names the computer that wrote it and how to recover, instead of a stack trace.

### Patch Changes

- [#137](https://github.com/yorch/cc-analyzer/pull/137) [`224608e`](https://github.com/yorch/cc-analyzer/commit/224608e30c586e0ce11694c9b3df1b2af70c1aa0) Thanks [@yorch](https://github.com/yorch)! - Make multi-computer archives trustworthy, and stop alias edits re-reading the whole portfolio.
  
  A computer's archive identity used to be a random id recorded only in local state. Losing it (a cleared state directory, a fresh install, a restored home) made the computer's own archived copy look like a *different* computer, so its sessions were counted twice, inflating session counts and activity metrics while the de-duplicated portfolio cost stayed correct. Identity is now recorded in the archive itself as `machines/<id>/machine.json`, and resolution never guesses:
  
  - A computer with no recorded identity is not assigned one silently. `archive machine` lists the archived machines until the user acts, and `archive run` refuses to write into the archive's permanent history while identity is unresolved, naming both remedies.
  - A matching hostname is only a **suggestion**. Recovery is always explicit: `cc-analyzer archive machine adopt <id>`, or `cc-analyzer archive machine keep` for a genuinely new computer. Auto-adopting on a hostname match could make two computers archive into one machine directory, mixing their raw transcripts in Git history.
  - `adopt` refuses an identity whose recorded hostnames exclude this computer unless `--force` is given.
  - `archive show` lists every machine directory it recognises with its full id, marks which one is this computer, and marks ones that predate `machine.json` as unidentified instead of hiding them.
  
  Changing a project alias now re-analyzes only the sessions whose project label actually changed, instead of the entire portfolio. The selection compares each indexed row's own recorded alias against the current map, so it cannot be thrown off by a partially failed scan or an unreadable root, and `index --check` reports exactly the work `index` will do. Archiving also compares file contents by streaming instead of hashing every session twice per run.

- [#140](https://github.com/yorch/cc-analyzer/pull/140) [`1e70869`](https://github.com/yorch/cc-analyzer/commit/1e70869dd85b67d3495ac8d45bf7022afb064117) Thanks [@yorch](https://github.com/yorch)! - Match archived sessions to live sessions one session at a time, not by hiding a whole computer's archive.
  
  Before, a computer's archived copy of its own sessions was hidden from the index whenever its live Claude data directory was readable, and that decision depended on which archived machine was "this computer". Sessions disappeared from reports after emptying `~/.claude/projects`, after a parent transcript was deleted, or when two computers shared a hostname. Now every archived copy is matched to its live session by project and session id. A copy is left out only when another copy already holds everything in it, so a session's cost is never counted twice, and a session that is only in the archive is kept. Copies that differ, for example because a session was continued on another computer, are both kept, so no activity is lost. Their cost is still counted once.
  
  - `archive run` no longer overwrites a complete archived transcript with a shorter live copy. It keeps the archived file and reports the session as not updated.
  - When archive-during-index cannot copy because this computer's archive identity is unresolved, `index`, the TUI, and `serve` all print a warning saying so. A skipped backup is otherwise lost for good once Claude Code deletes the live transcript.
  - `index --rebuild` no longer double-counts a session for good when one of its transcripts cannot be read during the rebuild. The total corrects itself on the next run that can read the file.
  - `cc-analyzer sessions <project>` points you to another project only when that project really holds the sessions.
  - The index schema is now 22, so an existing index is dropped and rebuilt on the next index refresh.

- [#139](https://github.com/yorch/cc-analyzer/pull/139) [`f115593`](https://github.com/yorch/cc-analyzer/commit/f1155935e9b7b8318a706f75348b7ce4aa3f2551) Thanks [@yorch](https://github.com/yorch)! - Build the docs site in CI on every pull request, so a broken docs link or anchor fails the PR instead of the post-merge site deploy. The CLI telemetry test now asserts that the event is delivered by a process that outlives the command, instead of comparing arrival times, which a busy machine could reorder and fail about a third of the time.

## 0.25.1

### Patch Changes

- [#135](https://github.com/yorch/cc-analyzer/pull/135) [`ca0f761`](https://github.com/yorch/cc-analyzer/commit/ca0f7613990e043d26d29878540b98c5544a80de) Thanks [@yorch](https://github.com/yorch)! - Preserve a shell's logical working-directory path when creating a current-directory archive alias.

## 0.25.0

### Minor Changes

- [#132](https://github.com/yorch/cc-analyzer/pull/132) [`464c17c`](https://github.com/yorch/cc-analyzer/commit/464c17c9b955eb17b56853a641428bb3385c96d1) Thanks [@yorch](https://github.com/yorch)! - Add shared project aliases to Git-backed session archives so reports can merge project activity across computers.

### Patch Changes

- [#134](https://github.com/yorch/cc-analyzer/pull/134) [`3e195cd`](https://github.com/yorch/cc-analyzer/commit/3e195cddd0d742245c406b456da51ffd7206971f) Thanks [@yorch](https://github.com/yorch)! - Add a current-directory project-alias shortcut and publish a multi-computer archive setup guide.

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
