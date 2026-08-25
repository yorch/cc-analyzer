# Recipes & Use Cases

> Indexed at commit `345633c` on 2026-08-25 · [view on GitHub](https://github.com/yorch/cc-analyzer/tree/345633c)

## Relevant source files

- [src/core/session-markdown.ts](https://github.com/yorch/cc-analyzer/blob/345633c/src/core/session-markdown.ts)
- [src/core/digest.ts](https://github.com/yorch/cc-analyzer/blob/345633c/src/core/digest.ts)
- [src/core/session-insights.ts](https://github.com/yorch/cc-analyzer/blob/345633c/src/core/session-insights.ts)
- [src/cli/index.ts](https://github.com/yorch/cc-analyzer/blob/345633c/src/cli/index.ts)
- [src/web/api.ts](https://github.com/yorch/cc-analyzer/blob/345633c/src/web/api.ts)
- [src/tui/screens/SessionDetailScreen.tsx](https://github.com/yorch/cc-analyzer/blob/345633c/src/tui/screens/SessionDetailScreen.tsx)
- [web/src/views/Session.tsx](https://github.com/yorch/cc-analyzer/blob/345633c/web/src/views/Session.tsx)

## Overview

`cc-analyzer` is read-only over `~/.claude` — the one place every frontend agrees. The same bun-free builders in `src/core` drive the CLI, the TUI and the web SPA, so a number you see in the terminal, in the browser, or in a shared Markdown file is always the same number. These recipes show how to turn that single source of truth into artifacts you can share.

All session exports are **shareable, single-file artifacts** (Markdown, HTML, JSON) built by `src/core/session-markdown.ts` (`buildSessionMarkdown`/`buildSessionHtml` + `sanitizeFilename`). They embed cost, diagnostics, health, what-if repricing, chart data and — optionally — the transcript, in one linear document. The CLI, the web `GET /api/sessions/:id/report` and the TUI `export` mode all call the same builders, so the three surfaces are byte-identical for the same flags.

> **Prerequisites:** Recipes 1–4 and 6–7 read the session `.jsonl` directly (`cc-analyzer analyze`/`doctor`) and need no index. Recipes 2 (find step) and 5 use the portfolio index — run `cc-analyzer index` first.

Sources: [src/core/session-markdown.ts:L1-L40](https://github.com/yorch/cc-analyzer/blob/345633c/src/core/session-markdown.ts#L1-L40)

## Recipe 1 — Share a costly session with your team (redacted)

A session hit `$18.43` and mixed `opus` + `haiku`. Your teammate doesn't have your `~/.claude`.

**CLI (paste-ready Markdown, PII stripped):**

```bash
cc-analyzer analyze 01a02b3c --md --redact --out ./share/
# → ./share/cc-analyzer-01a02b3c.md  (prompts → [redacted], files → count only)
cat ./share/cc-analyzer-01a02b3c.md | pbcopy
```

**Web:** Open `http://127.0.0.1:4317/#/session/01a02b3c` → check **redact** → **Copy as Markdown** (or **Download MD/HTML/JSON**). The page fetches `GET /api/sessions/:id/report?format=md&redact=1&transcript=1` — loopback-only, `Content-Disposition: attachment`.

**TUI:** `cc-analyzer` → `portfolio` → `sessions` → `↵` on the session → `e` → `f` to cycle format (`md` default) → `r` (redact on) → `w` writes `./cc-analyzer-01a02b3c.md`.

What you share: `Overview` (rank `p94`), `Actionable diagnostics` (e.g. `context-pressure`), `Health`, `Cost breakdown`, `Cost per outcome`, `What-if` (`WHATIF_CAVEAT`), `Models`/`Tools`/`Skills` (`SKILL_COST_CAVEAT`), `Subagent bursts`, `Session facts`, sampled `Turns` (300) and chart tables. No `~/.claude` paths leave your machine.

Sources: [src/core/session-markdown.ts:L46-L180](https://github.com/yorch/cc-analyzer/blob/345633c/src/core/session-markdown.ts#L46-L180) [src/cli/index.ts:L510-L650](https://github.com/yorch/cc-analyzer/blob/345633c/src/cli/index.ts#L510-L650)

## Recipe 2 — Pre-standup triage: thrash, retries, corrections

You want the *one* session that wasted the morning.

**Find it:**

```bash
cc-analyzer insights            # ranked portfolio diagnostics (warnings first)
cc-analyzer stats --json | jq '.bash'   # top shell commands; try .skills for skill thrash
```

**Deep-dive and share the diagnosis:**

```bash
cc-analyzer analyze ./projects/my-proj/SESSION.jsonl --md --out triage.md
# Highlights: test-fail streak 5, 12 redundant reads, 4 correction turns (33% — CORRECTION_CAVEAT)
```

Or in the **TUI**: `insights` → `↵` on `edit-test-thrash` → `↵` on the session → `s` (summary) shows the same `Actionable diagnostics` the CLI printed. `e` → `f` → `w` exports it.

**Share as HTML for Slack:** `cc-analyzer analyze SESSION --html --redact --out triage.html` — single file with inline dark theme, print stylesheet, no server needed.

Sources: [src/core/session-diagnostics.ts](https://github.com/yorch/cc-analyzer/blob/345633c/src/core/session-diagnostics.ts) [src/tui/screens/SessionDetailScreen.tsx:L1001-L1150](https://github.com/yorch/cc-analyzer/blob/345633c/src/tui/screens/SessionDetailScreen.tsx#L1001-L1150)

## Recipe 3 — Post-mortem with transcript (opt-in)

Transcripts are huge and sensitive — they are **omitted by default** in every export.

**Include it when you need it:**

```bash
cc-analyzer analyze SESSION --md --include-transcript --out postmortem.md
# Markdown: 600 items × 2000 chars cap, “ … 412 more truncated” note
# HTML: same cap, code-fenced, standalone
# JSON: same 600×2000 cap, highest fidelity (still capped) — jq it:
cc-analyzer analyze SESSION --json --include-transcript --redact | jq '.transcript | length'

cc-analyzer analyze SESSION --md --include-transcript --redact --out postmortem-redacted.md
# transcript bodies → [redacted], prompts → [redacted], files → count
```

**Web:** check **transcript** + **redact** → **Download MD** (or `&transcript=1` + `format=html|json`). **TUI:** `e` → `t` (transcript included) → `f` (format) → `r` → `w`.

The builder samples chart tables at `SAMPLE_CAP=300` and the turns table at `300`, so a 2 000-turn session still produces a readable file.

Sources: [src/core/session-markdown.ts:L580-L650](https://github.com/yorch/cc-analyzer/blob/345633c/src/core/session-markdown.ts#L580-L650)

## Recipe 4 — “Should I have used a cheaper model?” (what-if)

**CLI single session:**

```bash
cc-analyzer analyze SESSION --md
# What-if: claude-sonnet-4-5 at $0.42 (-$1.20 vs actual) — stock alternatives
# _What-if repricing replays the actual token mix at other models’ rates…_
```

**Portfolio:**

```bash
cc-analyzer stats --json | jq '.whatIf'
cc-analyzer report --md | pbcopy   # weekly digest What-if, same caveat
```

**Web:** Session → `What-if repricing` table; **TUI:** `summary` mode shows the same `sessionWhatIf` rows. All three call `repriceModelMixes` in `src/core/session-insights.ts`, so they cannot disagree.

Sources: [src/core/session-insights.ts](https://github.com/yorch/cc-analyzer/blob/345633c/src/core/session-insights.ts) [src/core/stats-types.ts:L841-L850](https://github.com/yorch/cc-analyzer/blob/345633c/src/core/stats-types.ts#L841-L850)

## Recipe 5 — Weekly digest for the team

Portfolio-level, not per-session — the only artifact that is *period-scoped*.

```bash
cc-analyzer report --md --week 2026-07-07 | pbcopy
# ## Claude Code weekly digest — 2026-07-07 → 2026-07-13 vs 2026-06-30 → 2026-07-06
# Summary, Top projects (with claude dir disambiguation), Models, Cache, Reliability, Skills, Insights

cc-analyzer report --week 2026-07-07 --json | jq '.headline'
```

**Web:** Dashboard → **Weekly digest** → **Copy as markdown** (builds `buildDigestMarkdown` client-side, same builder the CLI uses — no extra endpoint). **TUI:** no digest (by design — interactive).

Sources: [src/core/digest.ts](https://github.com/yorch/cc-analyzer/blob/345633c/src/core/digest.ts) [web/src/views/Dashboard.tsx:L359-L410](https://github.com/yorch/cc-analyzer/blob/345633c/web/src/views/Dashboard.tsx#L359-L410)

## Recipe 6 — Health check without an index

`doctor` is the only command that bypasses the index — useful for a freshly received `.jsonl`.

```bash
cc-analyzer doctor ./SESSION.jsonl
# ✓ healthy — 42 events · 0 parse errors

cc-analyzer doctor SESSION --json | jq '.findings'
# Every session export also embeds this as ## Health (same inspectSessionHealth)
```

Cost framing follows the data, not the surface: `cc-analyzer cost-basis subscription` makes every export render `costFramingNote` verbatim — dollars read as API-equivalent value, not a bill.

Sources: [src/core/session-health.ts](https://github.com/yorch/cc-analyzer/blob/345633c/src/core/session-health.ts) [src/core/cost-framing.ts](https://github.com/yorch/cc-analyzer/blob/345633c/src/core/cost-framing.ts)

## Appendix — Surface parity at a glance

| Need | Command |
| ------ | --------- |
| Script it, pipe to `jq` | `cc-analyzer analyze SESSION --json` / `stats --json` / `report --json` |
| Browse interactively, no browser | `cc-analyzer` (TUI: `portfolio`/`projects`/`sessions`/`insights`/`trends`/`tools`, session `turns`/`charts`/`transcript`/`summary`/`claude`/`export`) |
| Share a file, no `serve` on receiver | `analyze --md/--html --out --redact` (or TUI `e` → `f` → `w`, or Web **Download MD/HTML/JSON**) |
| Check health without index | `cc-analyzer doctor SESSION --json` (also embedded in every session export `## Health`) |
| Cost framing | `cc-analyzer cost-basis subscription` (frames `$` as API-equivalent value, verbatim `costFramingNote` in every export) |

All three call `analyzeSession` → `SessionAnalysis` → `buildSessionDiagnostics`/`sessionOutcomes`/`sessionWhatIf`/`buildContextSeries` etc. The TUI reads the DB directly, the web reads it via `src/web/api.ts`, the CLI reads the `.jsonl` directly for `analyze`/`doctor` — the analysis is identical. See [glossary](./glossary.md) for `thrash`, `correctionTurns`, `compaction` and other heuristics.

Sources: [src/tui/App.tsx](https://github.com/yorch/cc-analyzer/blob/345633c/src/tui/App.tsx) [src/web/api.ts:L441-L510](https://github.com/yorch/cc-analyzer/blob/345633c/src/web/api.ts#L441-L510)

## Related Pages

- Single-session export implementation: [CLI](./3-cli.md) · [TUI](./4-tui.md) · [Web Server & API](./5-web-server-and-api.md) · [Web SPA](./6-web-spa-frontend.md)
- Analysis behind the numbers: [Core Analysis Engine](./2-core-analysis-engine.md) · [Analytics & Insights](./7-analytics-and-insights.md)
- Digests and distribution: [Updates & Distribution](./8-updates-and-distribution.md)
