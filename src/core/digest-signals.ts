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
import type { DigestPeriod, WeeklyDigest } from "./digest.ts";
import { digestDelta, lastCompleteWeek, priorPeriod, weekPeriod } from "./digest.ts";
import { buildPortfolioDiagnostics } from "./portfolio-diagnostics.ts";
import { assemblePortfolioSignals } from "./portfolio-signals.ts";
import { getCostBasis } from "./prefs.ts";
import type { PricingTable } from "./pricing.ts";
import {
  addModelTotalsRow,
  analyticsRollup,
  CACHE_WASTE_EXPR,
  localDayOfMs,
  type ModelTotals,
} from "./stats.ts";

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
}

/** Per-period aggregates that come straight off indexed columns. */
interface PeriodTotals {
  sessions: number;
  cost: number;
  activeMs: number;
  ioTokens: number;
  cacheTokens: number;
  writeCost: number;
  readCost: number;
  waste: number;
}

function periodTotals(db: Database, p: DigestPeriod): PeriodTotals {
  return db
    .query(
      `SELECT COUNT(*) AS sessions,
          COALESCE(SUM(cost_total), 0) AS cost,
          COALESCE(SUM(active_ms), 0) AS activeMs,
          COALESCE(SUM(input_tokens + output_tokens), 0) AS ioTokens,
          COALESCE(SUM(cache_write_5m + cache_write_1h + cache_read), 0) AS cacheTokens,
          COALESCE(SUM(cost_cache_write), 0) AS writeCost,
          COALESCE(SUM(cost_cache_read), 0) AS readCost,
          COALESCE(SUM(${CACHE_WASTE_EXPR}), 0) AS waste
        FROM sessions WHERE day BETWEEN ? AND ?`,
    )
    .get(p.start, p.end) as PeriodTotals;
}

interface ProjectTotals {
  projectId: string;
  projectPath: string | null;
  cost: number;
  sessions: number;
}

function periodProjects(db: Database, p: DigestPeriod): ProjectTotals[] {
  return db
    .query(
      `SELECT project_id AS projectId,
          MAX(project_path) AS projectPath,
          COALESCE(SUM(cost_total), 0) AS cost,
          COUNT(*) AS sessions
        FROM sessions WHERE day BETWEEN ? AND ?
        GROUP BY project_id`,
    )
    .all(p.start, p.end) as ProjectTotals[];
}

/** Per-model totals for one period, through the same fold `spendByModel` uses. */
function periodModels(db: Database, p: DigestPeriod): Map<string, ModelTotals> {
  const rows = db
    .query("SELECT models_json FROM sessions WHERE day BETWEEN ? AND ?")
    .all(p.start, p.end) as { models_json: string | null }[];
  const acc = new Map<string, ModelTotals>();
  for (const row of rows) addModelTotalsRow(acc, row.models_json);
  return acc;
}

/** How many projects the digest lists — a digest is a glance, not a report. */
const TOP_PROJECTS = 5;
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

  const priorProjects = new Map(periodProjects(db, prior).map((r) => [r.projectId, r.cost]));
  const projects = periodProjects(db, period)
    .sort((a, b) => b.cost - a.cost)
    .slice(0, TOP_PROJECTS)
    .map((r) => ({
      projectId: r.projectId,
      projectPath: r.projectPath,
      cost: r.cost,
      sessions: r.sessions,
      delta: digestDelta(r.cost, priorProjects.get(r.projectId) ?? 0),
    }));

  const curModels = periodModels(db, period);
  const prevModels = periodModels(db, prior);
  const models = [...curModels.entries()]
    .map(([model, v]) => ({
      model,
      calls: v.calls,
      cost: v.cost,
      priorCost: prevModels.get(model)?.cost ?? 0,
    }))
    .sort((a, b) => b.cost - a.cost);

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
    cache: {
      writeCost: cur.writeCost,
      readCost: cur.readCost,
      waste: cur.waste,
      totalCost: cur.cost,
    },
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
    insights: buildPortfolioDiagnostics(
      assemblePortfolioSignals(db, pricing, opts.audit === false ? { audit: false } : {}),
    ),
    // Display-only framing, read at this boundary like every other surface.
    costBasis: getCostBasis(),
  };
}
