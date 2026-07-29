/**
 * Bun-side assembler for the weekly digest: reads the index, folds it into the
 * plain-data `WeeklyDigest` the bun-free `digest.ts` renders. Same two-layer
 * split as `portfolio-signals.ts` / `portfolio-diagnostics.ts` — everything
 * that touches `bun:sqlite`, the filesystem, or `Date.now()` lives here, so the
 * shapes and the markdown stay pure (and importable by the SPA).
 *
 * PERIOD SCOPING (the one thing to be honest about): the index stores one row
 * per session, dated by the session's START day (the `day` column). So a
 * period's metrics are "the sessions that STARTED in the period", counted with
 * their full cost — a session that ran past midnight is not split across days,
 * and a session begun on Sunday night lands in that week entirely. Every
 * period-scoped query below filters `day BETWEEN start AND end`, and the
 * rendered digest says so in its footer.
 */

import type { Database } from "bun:sqlite";
import type { WeeklyDigest } from "./digest.ts";
import { digestDelta, lastCompleteWeek, priorPeriod, weekPeriod } from "./digest.ts";
import type { PortfolioDiagnostic } from "./portfolio-diagnostics.ts";
import { buildPortfolioDiagnostics } from "./portfolio-diagnostics.ts";
import { assemblePortfolioSignals } from "./portfolio-signals.ts";
import { getCostBasis } from "./prefs.ts";
import type { PricingTable } from "./pricing.ts";
import {
  addModelTotalsRow,
  analyticsRollup,
  CACHE_TOKENS,
  cacheSummary,
  IO_TOKENS,
  localDayOfMs,
  type ModelTotals,
  spendByProject,
} from "./stats.ts";
import type { DayRange } from "./stats-types.ts";

export interface WeeklyDigestOptions {
  /**
   * Any day inside the wanted ISO week; the digest period becomes that whole
   * Monday–Sunday week. This is what the CLI's `--week` and the API's `?week=`
   * pass through.
   */
  week?: string;
  /**
   * "Today" as a local YYYY-MM-DD day, used to resolve the default period (the
   * last COMPLETE week before it). Defaults to `localDayOfMs(Date.now())`;
   * tests pin it so the resolution is deterministic.
   */
  today?: string;
  /** Skip the insight snapshot's setup-audit filesystem scan. */
  audit?: boolean;
  /**
   * Pre-built current-state diagnostics for the insight snapshot. The web
   * server already memoizes these per index fingerprint for `/api/insights`, so
   * `/api/report` hands them over instead of re-assembling the same signals
   * (an index scan plus the audit's filesystem walk). Omitted — the CLI path —
   * the digest assembles its own.
   */
  insights?: PortfolioDiagnostic[];
}

/** The headline aggregates, straight off indexed columns. Cache economics come
 * from `cacheSummary(db, period)` instead — same table, one shared definition
 * of "waste". */
interface PeriodTotals {
  sessions: number;
  cost: number;
  activeMs: number;
  ioTokens: number;
  cacheTokens: number;
}

function periodTotals(db: Database, p: DayRange): PeriodTotals {
  return db
    .query(
      `SELECT COUNT(*) AS sessions,
          COALESCE(SUM(cost_total), 0) AS cost,
          COALESCE(SUM(active_ms), 0) AS activeMs,
          COALESCE(SUM(${IO_TOKENS}), 0) AS ioTokens,
          COALESCE(SUM(${CACHE_TOKENS}), 0) AS cacheTokens
        FROM sessions WHERE day BETWEEN ? AND ?`,
    )
    .get(p.start, p.end) as PeriodTotals;
}

/** Per-model totals for one period, through the same fold `spendByModel` uses. */
function periodModels(db: Database, p: DayRange): Map<string, ModelTotals> {
  const rows = db
    .query("SELECT models_json FROM sessions WHERE day BETWEEN ? AND ?")
    .all(p.start, p.end) as { models_json: string | null }[];
  const acc = new Map<string, ModelTotals>();
  for (const row of rows) addModelTotalsRow(acc, row.models_json);
  return acc;
}

/** How many projects the digest lists — a digest is a glance, not a report. */
const TOP_PROJECTS = 5;
/**
 * Row cap for the two per-project period queries. The digest renders the top
 * `TOP_PROJECTS`, but the prior period must be looked up in full: a project big
 * this week may sit far down last week's ranking, and a truncated baseline
 * would report it as "new". Far above any realistic count of projects touched
 * in one week, so it bounds the query without cutting a real ranking.
 */
const PERIOD_PROJECT_CAP = 2000;
/** Same reasoning for skills, ranked by turn-scoped (attributed) cost. */
const TOP_SKILLS = 5;

/**
 * Build one week's digest off the index.
 *
 * The period defaults to the last complete ISO week relative to today (a
 * half-finished current week would always read as a decline); `opts.week`
 * selects the week containing any given day. Deltas compare against the
 * equally long period immediately before.
 *
 * The insight snapshot is deliberately NOT period-scoped: it is the portfolio
 * diagnostics computed on everything indexed, i.e. current state. One week
 * rarely carries enough evidence to fire those thresholds honestly, and the
 * user wants "what should I fix now", not "what fired last week".
 */
export function buildWeeklyDigest(
  db: Database,
  pricing: PricingTable,
  opts: WeeklyDigestOptions = {},
): WeeklyDigest {
  const today = opts.today ?? localDayOfMs(Date.now());
  const period = opts.week ? weekPeriod(opts.week) : lastCompleteWeek(today);
  const prior = priorPeriod(period);

  const cur = periodTotals(db, period);
  const prev = periodTotals(db, prior);

  // The same project ranking the portfolio view uses, period-filtered — so the
  // digest's "top projects" and `cc-analyzer stats` rank projects identically.
  const priorProjects = new Map(
    spendByProject(db, PERIOD_PROJECT_CAP, prior).map((r) => [r.projectId, r.cost]),
  );
  const projects = spendByProject(db, PERIOD_PROJECT_CAP, period)
    .slice(0, TOP_PROJECTS)
    .map((r) => ({
      projectId: r.projectId,
      projectPath: r.projectPath,
      cost: r.cost,
      sessions: r.sessions,
      delta: digestDelta(r.cost, priorProjects.get(r.projectId) ?? 0),
    }));

  // Union of both periods' models, not just this week's: a model the user
  // STOPPED running is exactly the change a digest exists to show (it renders
  // with 0 calls this period against its prior cost). Ranked by whichever side
  // is larger, so a dropped model sorts by what it used to cost.
  const curModels = periodModels(db, period);
  const prevModels = periodModels(db, prior);
  const models = [...new Set([...curModels.keys(), ...prevModels.keys()])]
    .map((model) => ({
      model,
      calls: curModels.get(model)?.calls ?? 0,
      cost: curModels.get(model)?.cost ?? 0,
      priorCost: prevModels.get(model)?.cost ?? 0,
    }))
    .sort((a, b) => Math.max(b.cost, b.priorCost) - Math.max(a.cost, a.priorCost));

  // One period-scoped scan for every JSON-blob signal (tools, tests, retries,
  // thrash, corrections, skills) — the same folds the portfolio rollup uses,
  // so a digest number and the analytics number for the same span agree.
  const rollup = analyticsRollup(db, undefined, period);
  const toolCalls = rollup.tools.reduce((s, t) => s + t.uses, 0);
  const toolErrors = rollup.tools.reduce((s, t) => s + t.errors, 0);

  return {
    period,
    prior,
    today,
    headline: {
      cost: digestDelta(cur.cost, prev.cost),
      sessions: digestDelta(cur.sessions, prev.sessions),
      activeMs: digestDelta(cur.activeMs, prev.activeMs),
      ioTokens: digestDelta(cur.ioTokens, prev.ioTokens),
      cacheTokens: digestDelta(cur.cacheTokens, prev.cacheTokens),
    },
    projects,
    models,
    cache: cacheSummary(db, period),
    reliability: {
      toolCalls,
      toolErrors,
      toolErrorRate: toolCalls > 0 ? toolErrors / toolCalls : 0,
      testRuns: rollup.tests.runs,
      testFailures: rollup.tests.failures,
      retries: rollup.retries.total,
      worstTestFailStreak: rollup.thrash.worstTestFailStreak,
      redundantReads: rollup.thrash.redundantReads,
      correctionTurns: rollup.corrections.correctionTurns,
      interruptionTurns: rollup.corrections.interruptionTurns,
      turns: rollup.corrections.turns,
      correctionShare: rollup.corrections.correctionShare,
    },
    skills: [...rollup.skills]
      .sort((a, b) => b.attributedCost - a.attributedCost || b.invocations - a.invocations)
      .slice(0, TOP_SKILLS)
      .map((s) => ({
        name: s.name,
        invocations: s.invocations,
        attributedTurns: s.attributedTurns,
        attributedCost: s.attributedCost,
      })),
    insights:
      opts.insights ??
      buildPortfolioDiagnostics(assemblePortfolioSignals(db, pricing, { audit: opts.audit })),
    // Display-only framing, read at this boundary like every other surface.
    costBasis: getCostBasis(),
  };
}
