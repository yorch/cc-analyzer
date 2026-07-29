/**
 * Explainable, portfolio-wide diagnostics — the cross-session counterpart of
 * `session-diagnostics.ts`.
 *
 * These are deliberately named heuristics, not a synthetic score. Every
 * finding carries the observed evidence (with real numbers taken from the
 * signals, never invented) and a suggested next action, and each rule's
 * threshold is documented beside it with a rationale. Bun-free so the web SPA
 * imports the same vocabulary (codes, rule count) the server computes with.
 *
 * Input is a single plain-data `PortfolioSignals` object: callers assemble it
 * (see `assemblePortfolioSignals` in `portfolio-signals.ts`), so this module
 * stays pure — no database, no filesystem, no `Date.now()`. Where a rule needs
 * "today", the freshness lives inside the data (`errorWeekly` weeks,
 * `audit.today`).
 */

import type { SetupAudit } from "./setup-audit.ts";
import type {
  AnalyticsRollup,
  CacheSummary,
  CacheTtlSplit,
  CompactionUsage,
  ContextTax,
  ErrorWeekRow,
  IdleCacheBucket,
  ParseCoverageStats,
  PortfolioStats,
  ProjectCacheRow,
  WhatIfRepricing,
} from "./stats-types.ts";

export type PortfolioDiagnosticCode =
  | "cache-leaky"
  | "cache-waste-heavy"
  | "idle-cache-pattern"
  | "compaction-pressure"
  | "context-tax-heavy"
  | "model-downshift-opportunity"
  | "retry-churn"
  | "error-rate-rising"
  | "spend-concentration"
  | "estimated-pricing-share"
  | "setup-debt"
  | "sidechain-imbalance"
  | "parse-coverage-drop"
  | "test-thrash-pattern"
  | "reread-heavy";

/** Every implemented rule code — the "N rules checked" count on render sites. */
export const PORTFOLIO_DIAGNOSTIC_CODES: readonly PortfolioDiagnosticCode[] = [
  "cache-leaky",
  "cache-waste-heavy",
  "idle-cache-pattern",
  "compaction-pressure",
  "context-tax-heavy",
  "model-downshift-opportunity",
  "retry-churn",
  "error-rate-rising",
  "spend-concentration",
  "estimated-pricing-share",
  "setup-debt",
  "sidechain-imbalance",
  "parse-coverage-drop",
  "test-thrash-pattern",
  "reread-heavy",
];

export type PortfolioDiagnosticSeverity = "info" | "warning";

export interface PortfolioDiagnostic {
  code: PortfolioDiagnosticCode;
  severity: PortfolioDiagnosticSeverity;
  title: string;
  evidence: string;
  action: string;
  /** Project the signal is scoped to (or points at), when it is one project's. */
  projectId?: string;
  projectPath?: string;
}

/**
 * Everything the rules read, assembled by the caller from the existing rollup
 * functions. Plain data only — this module never touches a database.
 */
export interface PortfolioSignals {
  /** `buildPortfolioStats()`. */
  stats: PortfolioStats;
  /** `analyticsRollup()`. */
  rollup: AnalyticsRollup;
  /** `cacheSummary()`, `cacheTtlSplit()`, `idleVsCache()`, `cacheWasteByProject()`. */
  cache: {
    summary: CacheSummary;
    ttl: CacheTtlSplit;
    idleBuckets: IdleCacheBucket[];
    /** Ranked worst-first by un-amortized write $, as `cacheWasteByProject` returns. */
    projects: ProjectCacheRow[];
  };
  /** `compactionUsage()`. */
  compactions: CompactionUsage;
  /** `errorRateByWeek()` — ascending ISO weeks. */
  errorWeekly: ErrorWeekRow[];
  /** `contextTax()`. */
  contextTax: ContextTax;
  /** `whatIfRepricing()`. */
  whatIf: WhatIfRepricing;
  /** `buildSetupAudit()` — optional: callers without filesystem access omit it. */
  audit?: SetupAudit;
  /** `parseCoverage()` — optional: a caller on an older payload omits it, and
   * the parse-coverage rule simply doesn't run. */
  parseCoverage?: ParseCoverageStats;
}

/* ——— Thresholds (conservative, each with its rationale) ————————————— */

/** Below a few dollars of cache writes the "waste" is pocket change and the
 * leak isn't worth a warning — the rule should catch a habit, not a rounding
 * error. */
export const CACHE_LEAKY_MIN_WRITE_COST = 5;

/** A fifth of cache-write spend never read back is a real inefficiency, but
 * only once the absolute number clears a floor — 20% of $2 is noise. */
export const CACHE_WASTE_SHARE = 0.2;
export const CACHE_WASTE_MIN_COST = 10;

/** Idle-bucket comparison needs a handful of sessions per bucket, and the
 * high-idle side must be *materially* worse: +15 points of waste share, or a
 * read:write ratio at half the low-idle bucket's. */
export const IDLE_MIN_BUCKET_SESSIONS = 5;
export const IDLE_WASTE_SHARE_DELTA = 0.15;
export const IDLE_RATIO_FACTOR = 0.5;

/** Half a project's sessions compacting is chronic ceiling pressure; five
 * sessions keeps one long session in a three-session project from firing it. */
export const COMPACTION_MIN_SESSIONS = 5;
export const COMPACTION_SHARE = 0.5;

/** A 30k-token median floor is ~15% of a 200k window paid before the first
 * word; 50k (a quarter of the window) escalates to a warning. Five sessions so
 * a single continuation file can't set the median by itself. */
export const CONTEXT_TAX_MIN_SESSIONS = 5;
export const CONTEXT_TAX_INFO_TOKENS = 30_000;
export const CONTEXT_TAX_WARN_TOKENS = 50_000;

/** A repricing delta worth mentioning: at least a fifth of actual spend AND at
 * least $5 — below either, the judgment-call caveat outweighs the saving. */
export const DOWNSHIFT_MIN_SHARE = 0.2;
export const DOWNSHIFT_MIN_SAVINGS = 5;

/** One tool retried 20+ times across 3+ sessions is a pattern, not a blip;
 * the portfolio fallback (an average of one retry per session over 10+
 * sessions) catches churn spread across many tools. */
export const RETRY_TOOL_MIN = 20;
export const RETRY_TOOL_MIN_SESSIONS = 3;
export const RETRY_PORTFOLIO_MIN_SESSIONS = 10;
export const RETRY_PER_SESSION = 1;

/** Error-rate trend: the newest (usually in-progress) week is dropped, then
 * the last 4 full weeks are compared to the 4 before. Both windows need real
 * volume (200 calls) and the recent rate must clear an absolute 2% floor, so
 * 1 error vs 0 can never read as "rising". */
export const ERROR_WINDOW_WEEKS = 4;
export const ERROR_MIN_WINDOW_CALLS = 200;
export const ERROR_RISE_FACTOR = 1.5;
export const ERROR_MIN_RECENT_RATE = 0.02;

/** Concentration only means anything with a real decile: 20+ sessions, and
 * the top 10% carrying 60%+ of spend. */
export const CONCENTRATION_MIN_SESSIONS = 20;
export const CONCENTRATION_SHARE = 0.6;

/** A quarter of spend on heuristic (family-matched) pricing is enough drift
 * to flag; below that the totals are still directionally solid. */
export const ESTIMATED_SHARE = 0.25;

/** Parse coverage: 1% of a version's lines unreadable is well past noise (a
 * healthy version parses at ~0%), and 10k lines is roughly a handful of real
 * sessions — below that a single corrupt file would fire the rule. Judged on
 * the NEWEST version rather than a rolling window: a format change ships with a
 * release, and old sessions keep parsing exactly as well as they always did, so
 * a 30-day window would dilute the very signal the rule is looking for. */
export const PARSE_COVERAGE_MAX_UNPARSED_SHARE = 0.01;
export const PARSE_COVERAGE_MIN_LINES = 10_000;

/** Test thrash: ≥ 3 sessions hitting a failing-test streak of ≥ 3
 * (`THRASH_STREAK_MIN`, judged in the rollup) is a pattern, not one bad
 * afternoon — but only when those sessions are ≥ 10% of the sessions that ran
 * tests at all, so a heavy test-running portfolio isn't flagged for its
 * ordinary tail. */
export const TEST_THRASH_MIN_SESSIONS = 3;
export const TEST_THRASH_SESSION_SHARE = 0.1;

/** Reread-heavy: 200 redundant reads portfolio-wide is real token volume
 * (whole files re-paid into context), and 10 affected sessions keep one
 * pathological session from firing a portfolio-wide habit finding. */
export const REREAD_MIN_TOTAL = 200;
export const REREAD_MIN_SESSIONS = 10;

/** Sidechain imbalance: half of spend on subagents merits a look at whether
 * delegation earns its keep; zero subagent use only becomes remarkable once
 * the portfolio is large enough (50+ sessions) that it's clearly a habit. */
export const SIDECHAIN_HEAVY_SHARE = 0.5;
export const SIDECHAIN_NONE_MIN_SESSIONS = 50;

/* ——— Formatting helpers (deterministic, locale-pinned) ———————————————— */

const pct = (value: number): string => `${Math.round(value * 100)}%`;

const usd = (value: number): string =>
  value >= 100 ? `$${Math.round(value).toLocaleString("en-US")}` : `$${value.toFixed(2)}`;

const tok = (value: number): string => Math.round(value).toLocaleString("en-US");

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

/* ——— The rules ———————————————————————————————————————————————————————— */

/** A finding plus its rough dollar impact, used only for intra-severity rank. */
interface Ranked extends PortfolioDiagnostic {
  impact: number;
}

/**
 * Fold every portfolio signal into a ranked list of findings: warnings before
 * infos, and within a severity by rough impact — the addressable dollar
 * magnitude where a rule has one (cache waste, repricing savings), insertion
 * order otherwise. None of these rules lean on the session-scoped
 * correlational cost rollups (skill / permission-mode / branch cost); the one
 * correlational signal used (idle share × cache waste) carries its caveat in
 * the finding text.
 */
export function buildPortfolioDiagnostics(signals: PortfolioSignals): PortfolioDiagnostic[] {
  const {
    stats,
    rollup,
    cache,
    compactions,
    errorWeekly,
    contextTax,
    whatIf,
    audit,
    parseCoverage,
  } = signals;
  const findings: Ranked[] = [];
  const summary = stats.summary;

  // 1. cache-leaky — portfolio-wide reads don't cover writes.
  const writeTokens = summary.cacheWriteTokens;
  const readTokens = summary.cacheReadTokens;
  const ratio = writeTokens > 0 ? readTokens / writeTokens : 0;
  if (writeTokens > 0 && ratio < 1 && cache.summary.writeCost >= CACHE_LEAKY_MIN_WRITE_COST) {
    findings.push({
      code: "cache-leaky",
      severity: "warning",
      title: "Cache writes are not being read back",
      evidence:
        `Portfolio read:write token ratio is ${ratio.toFixed(1)}× — ` +
        `${usd(cache.summary.writeCost)} paid to write cache, ${usd(cache.summary.waste)} of it never read back.`,
      action:
        "Batch related work so the cache amortizes: avoid long idle gaps mid-task and finish " +
        "related turns together — the prompt cache expires after 5 minutes.",
      impact: cache.summary.waste,
    });
  }

  // 2. cache-waste-heavy — a large share of write $ evaporated; name the top offender.
  if (
    cache.summary.writeCost > 0 &&
    cache.summary.waste >= cache.summary.writeCost * CACHE_WASTE_SHARE &&
    cache.summary.waste >= CACHE_WASTE_MIN_COST
  ) {
    const top = cache.projects[0];
    findings.push({
      code: "cache-waste-heavy",
      severity: "warning",
      title: "A large share of cache-write spend never amortized",
      evidence:
        `${usd(cache.summary.waste)} of ${usd(cache.summary.writeCost)} cache-write spend ` +
        `(${pct(cache.summary.waste / cache.summary.writeCost)}) was never read back` +
        (top ? `; the top wasting project alone accounts for ${usd(top.waste)}.` : "."),
      action:
        "Start with the worst project in the cache hit-list: its sessions rebuild cache they " +
        "then abandon — shorter, more focused sessions usually fix it.",
      ...(top ? { projectId: top.projectId, projectPath: top.projectPath ?? undefined } : {}),
      impact: cache.summary.waste,
    });
  }

  // 3. idle-cache-pattern — waste concentrates in idle-heavy sessions.
  {
    const low = cache.idleBuckets[0]; // "<25% idle"
    const highs = cache.idleBuckets.slice(2); // "50–75% idle", "75%+ idle"
    const high = highs
      .filter((b) => b.sessions >= IDLE_MIN_BUCKET_SESSIONS)
      .sort((a, b) => b.wasteShare - a.wasteShare)[0];
    if (
      low &&
      high &&
      low.sessions >= IDLE_MIN_BUCKET_SESSIONS &&
      (high.wasteShare >= low.wasteShare + IDLE_WASTE_SHARE_DELTA ||
        (low.ratio > 0 && high.ratio <= low.ratio * IDLE_RATIO_FACTOR))
    ) {
      findings.push({
        code: "idle-cache-pattern",
        severity: "info",
        title: "Idle-heavy sessions waste more of their cache",
        evidence:
          `Sessions ${high.bucket} (${high.sessions}) run a ${high.ratio.toFixed(1)}× read:write ratio with ` +
          `${pct(high.wasteShare)} of write $ wasted, vs ${low.ratio.toFixed(1)}× and ${pct(low.wasteShare)} ` +
          `for sessions ${low.bucket} (${low.sessions}).`,
        action:
          "Idle-heavy sessions rewrite their cache after the 5-minute TTL expires — close out " +
          "or split long-lived sessions instead of leaving them open. Correlational, not causal: " +
          "idle share and cache behavior are both properties of the same sessions.",
        impact: 0,
      });
    }
  }

  // 4. compaction-pressure — one project chronically hits the context ceiling.
  {
    const worst = compactions.byProject
      .filter((p) => p.sessions >= COMPACTION_MIN_SESSIONS && p.share >= COMPACTION_SHARE)
      .sort((a, b) => b.share - a.share || b.sessions - a.sessions)[0];
    if (worst) {
      findings.push({
        code: "compaction-pressure",
        severity: "warning",
        title: "One project compacts in most of its sessions",
        evidence:
          `${worst.sessionsWithCompaction} of ${plural(worst.sessions, "session")} ` +
          `(${pct(worst.share)}) hit the context ceiling and compacted — ` +
          `${plural(worst.compactions, "compaction")} in total.`,
        action:
          "Trim that project's CLAUDE.md and default context, split work into smaller " +
          "sessions, or delegate bulk reading to subagents (they use their own context windows).",
        projectId: worst.projectId,
        projectPath: worst.projectPath ?? undefined,
        impact: 0,
      });
    }
  }

  // 5. context-tax-heavy — a project's sessions start with a huge fixed prompt.
  {
    const heavy = contextTax.byProject
      .filter(
        (p) => p.sessions >= CONTEXT_TAX_MIN_SESSIONS && p.medianTokens >= CONTEXT_TAX_INFO_TOKENS,
      )
      .sort((a, b) => b.medianTokens - a.medianTokens)[0];
    if (heavy) {
      const unusedServers = (audit?.findings ?? [])
        .filter((f) => f.code === "unused-mcp-server")
        .map((f) => f.subject);
      findings.push({
        code: "context-tax-heavy",
        severity: heavy.medianTokens >= CONTEXT_TAX_WARN_TOKENS ? "warning" : "info",
        title: "Sessions in one project start with a heavy context tax",
        evidence:
          `Median ${tok(heavy.medianTokens)} tokens (p90 ${tok(heavy.p90Tokens)}) on the first ` +
          `API call across ${plural(heavy.sessions, "session")} — a floor every session pays ` +
          "before you type.",
        action:
          "Audit that project's CLAUDE.md size, MCP servers, and startup hooks." +
          (unusedServers.length > 0
            ? ` The setup audit already flags unused MCP servers (${unusedServers.join(", ")}) — their tool schemas are part of this tax.`
            : ""),
        projectId: heavy.projectId,
        projectPath: heavy.projectPath ?? undefined,
        impact: 0,
      });
    }
  }

  // 6. model-downshift-opportunity — repricing shows a large single-model saving.
  {
    const s = whatIf.summary;
    const savings = -s.bestDelta;
    if (
      s.bestModel !== null &&
      s.actualCost > 0 &&
      savings >= s.actualCost * DOWNSHIFT_MIN_SHARE &&
      savings >= DOWNSHIFT_MIN_SAVINGS
    ) {
      findings.push({
        code: "model-downshift-opportunity",
        severity: "info",
        title: "The same tokens priced on one cheaper model save real money",
        evidence:
          `Routing every repriced token to ${s.bestModel} would have cost ${usd(s.bestCost)} ` +
          `instead of ${usd(s.actualCost)} — ${usd(savings)} (${pct(savings / s.actualCost)}) lower.`,
        action:
          "A judgment call, not a directive: this replays your actual token counts at other " +
          "rates — a different model produces different tokens, and quality is not priced in. " +
          "Try the cheaper model on routine work and compare.",
        impact: savings,
      });
    }
  }

  // 7. retry-churn — one tool (or the portfolio overall) repeats identical calls.
  {
    const top = rollup.retries.byTool[0];
    const perSession = summary.sessions > 0 ? rollup.retries.total / summary.sessions : 0;
    const toolChurn =
      top !== undefined && top.retries >= RETRY_TOOL_MIN && top.sessions >= RETRY_TOOL_MIN_SESSIONS;
    const portfolioChurn =
      summary.sessions >= RETRY_PORTFOLIO_MIN_SESSIONS && perSession >= RETRY_PER_SESSION;
    if (top && (toolChurn || portfolioChurn)) {
      findings.push({
        code: "retry-churn",
        severity: "info",
        title: "Tool calls are being retried verbatim",
        evidence:
          `${top.tool} was retried ${plural(top.retries, "time")} across ` +
          `${plural(top.sessions, "session")} (${rollup.retries.total} identical repeats portfolio-wide).`,
        action:
          "A repeated identical call is usually a tool fighting its input — open the sessions " +
          "with the most retries and read the failing calls before tweaking anything else.",
        impact: 0,
      });
    }
  }

  // 8. error-rate-rising — tool-error rate trending up across full weeks.
  {
    // The newest week is usually in progress; drop it so a half-week of bad
    // luck never fires the trend. With < 8 full weeks left there is no trend.
    const weeks = errorWeekly.slice(0, -1);
    if (weeks.length >= ERROR_WINDOW_WEEKS * 2) {
      const recent = weeks.slice(-ERROR_WINDOW_WEEKS);
      const prior = weeks.slice(-ERROR_WINDOW_WEEKS * 2, -ERROR_WINDOW_WEEKS);
      const calls = (rows: ErrorWeekRow[]) => rows.reduce((s, r) => s + r.toolCalls, 0);
      const errors = (rows: ErrorWeekRow[]) => rows.reduce((s, r) => s + r.errors, 0);
      const recentCalls = calls(recent);
      const priorCalls = calls(prior);
      const recentRate = recentCalls > 0 ? errors(recent) / recentCalls : 0;
      const priorRate = priorCalls > 0 ? errors(prior) / priorCalls : 0;
      if (
        recentCalls >= ERROR_MIN_WINDOW_CALLS &&
        priorCalls >= ERROR_MIN_WINDOW_CALLS &&
        recentRate >= ERROR_MIN_RECENT_RATE &&
        recentRate >= priorRate * ERROR_RISE_FACTOR
      ) {
        findings.push({
          code: "error-rate-rising",
          severity: "warning",
          title: "Tool-error rate is rising",
          evidence:
            `${(recentRate * 100).toFixed(1)}% of tool calls errored over the last 4 full weeks ` +
            `(${tok(recentCalls)} calls) vs ${(priorRate * 100).toFixed(1)}% in the 4 weeks before ` +
            `(${tok(priorCalls)} calls).`,
          action:
            "Something recently started failing: check for a changed tool, a new MCP server, " +
            "moved paths, or permission rules — the weekly error chart on the Trends page shows " +
            "when it began.",
          impact: 0,
        });
      }
    }
  }

  // 9. spend-concentration — a few sessions carry most of the spend.
  {
    const dist = stats.distribution;
    if (
      dist.topDecileShare !== null &&
      dist.topDecileShare >= CONCENTRATION_SHARE &&
      dist.sessions >= CONCENTRATION_MIN_SESSIONS
    ) {
      findings.push({
        code: "spend-concentration",
        severity: "info",
        title: "A few sessions carry most of the spend",
        evidence:
          `The most expensive 10% of ${plural(dist.sessions, "session")} carry ` +
          `${pct(dist.topDecileShare)} of total spend (portfolio total ${usd(summary.cost)}).`,
        action:
          "Open the most expensive sessions and read their per-session diagnostics — " +
          "optimizing anything outside that top slice moves little.",
        impact: 0,
      });
    }
  }

  // 10. estimated-pricing-share — a big slice of the totals is heuristic.
  if (summary.estimatedShare >= ESTIMATED_SHARE) {
    findings.push({
      code: "estimated-pricing-share",
      severity: "info",
      title: "A large share of computed spend used heuristic pricing",
      evidence:
        `${pct(summary.estimatedShare)} of the ${usd(summary.cost)} total was priced by the ` +
        "model-family heuristic rather than an exact rate match.",
      action:
        "Refresh the pricing table (`cc-analyzer pricing update`); until the model ids resolve " +
        "exactly, expect the affected totals to drift from the true numbers.",
      impact: 0,
    });
  }

  // 11. setup-debt — the setup audit has warnings worth reading.
  if (audit) {
    const warnings = audit.findings.filter((f) => f.severity === "warning");
    const top = warnings[0];
    if (top) {
      findings.push({
        code: "setup-debt",
        severity: "info",
        title: "The setup audit has open warnings",
        evidence: `${plural(warnings.length, "warning")} — the top one: "${top.title}".`,
        action:
          "Run `cc-analyzer audit` (or open the web Tools → Setup tab) for the full " +
          "cross-reference of what's installed against what sessions actually use.",
        impact: 0,
      });
    }
  }

  // 12. sidechain-imbalance — subagents dominate spend, or are never used.
  //     The two sides are mutually exclusive by construction.
  {
    const sc = stats.sidechain;
    if (sc.share >= SIDECHAIN_HEAVY_SHARE) {
      findings.push({
        code: "sidechain-imbalance",
        severity: "info",
        title: "Subagents account for most of the spend",
        evidence:
          `${usd(sc.cost)} of ${usd(sc.totalCost)} (${pct(sc.share)}) ran on subagent ` +
          `sidechains, over ${tok(sc.calls)} API calls.`,
        action:
          "Verify the delegation earns its keep: every subagent re-reads context into its own " +
          "window. Spot-check the biggest sessions' sidechain spend before delegating more.",
        impact: 0,
      });
    } else if (sc.cost === 0 && summary.sessions >= SIDECHAIN_NONE_MIN_SESSIONS) {
      findings.push({
        code: "sidechain-imbalance",
        severity: "info",
        title: "Subagents are never used",
        evidence: `0 of ${plural(summary.sessions, "session")} spent anything on a subagent sidechain.`,
        action:
          "Subagents can offload bulk reading and exploration from the main context window " +
          "(reducing compactions and cache churn) — worth trying on large tasks.",
        impact: 0,
      });
    }
  }

  // 13. parse-coverage-drop — the newest Claude Code version's sessions no
  //     longer parse cleanly, i.e. the format has moved ahead of this build.
  {
    const newest = parseCoverage?.byVersion[0];
    if (
      newest &&
      newest.lines >= PARSE_COVERAGE_MIN_LINES &&
      newest.unparsedShare >= PARSE_COVERAGE_MAX_UNPARSED_SHARE
    ) {
      findings.push({
        code: "parse-coverage-drop",
        severity: "warning",
        title: "The newest Claude Code version's sessions don't fully parse",
        evidence:
          `${(newest.unparsedShare * 100).toFixed(1)}% of the ${tok(newest.lines)} lines written by ` +
          `Claude Code ${newest.version} (${plural(newest.sessions, "session")}) were not fully ` +
          `understood — ${tok(newest.parseErrors)} unreadable, ` +
          `${tok(newest.unknownEvents)} kept as unknown events.`,
        action:
          "Update cc-analyzer (`cc-analyzer update`) — the session format may have moved ahead " +
          "of this parser version. Unparsed lines are excluded from every metric, so totals for " +
          "those sessions read low until the parser catches up.",
        impact: 0,
      });
    }
  }

  // 14. test-thrash-pattern — edit→test→fail loops recur across sessions.
  {
    const th = rollup.thrash;
    const testSessions = rollup.tests.sessions;
    if (
      th.testThrashSessions >= TEST_THRASH_MIN_SESSIONS &&
      testSessions > 0 &&
      th.testThrashSessions >= testSessions * TEST_THRASH_SESSION_SHARE
    ) {
      findings.push({
        code: "test-thrash-pattern",
        severity: "warning",
        title: "Edit-test loops repeat without progress across sessions",
        evidence:
          `${plural(th.testThrashSessions, "session")} hit 3+ consecutive failing test runs ` +
          `without a pass (worst streak: ${th.worstTestFailStreak}) — ` +
          `${pct(th.testThrashSessions / testSessions)} of the ${plural(testSessions, "session")} that ran tests.`,
        action:
          "When a test fails twice in a row, step back and read the failure output carefully " +
          "or bisect — repeated blind edit-test cycles burn tokens; consider asking for a " +
          "different approach.",
        impact: 0,
      });
    }
  }

  // 15. reread-heavy — redundant same-file reads add up portfolio-wide.
  {
    const th = rollup.thrash;
    const top = th.topRereadFiles[0];
    if (th.redundantReads >= REREAD_MIN_TOTAL && th.rereadSessions >= REREAD_MIN_SESSIONS) {
      findings.push({
        code: "reread-heavy",
        severity: "info",
        title: "The same files are re-read over and over",
        evidence:
          `${tok(th.redundantReads)} redundant reads (3rd+ read of a file) across ` +
          `${plural(th.rereadSessions, "session")} with 4 or more` +
          (top
            ? `; the most re-read file is ${top.file} (${plural(top.sessions, "session")}).`
            : "."),
        action:
          "Put hot reference files in CLAUDE.md summaries or delegate bulk reading to " +
          "subagents — every re-read pays the whole file into context again.",
        impact: 0,
      });
    }
  }

  // Warnings first; within a severity by addressable dollar impact, then
  // insertion order (Array.prototype.sort is stable).
  const rank = (f: Ranked): number => (f.severity === "warning" ? 0 : 1);
  findings.sort((a, b) => rank(a) - rank(b) || b.impact - a.impact);
  return findings.map(({ impact: _impact, ...finding }) => finding);
}
