import type { Database } from "bun:sqlite";
import { type Compaction, isTestCommand } from "./analyze.ts";
import { summarizeCompactions } from "./chart-series.ts";
import type {
  AnalyticsRollup,
  CacheSummary,
  CacheTtlSplit,
  CompactionProjectRow,
  CompactionUsage,
  ConcurrencySummary,
  CostBucket,
  CostDistribution,
  DayRow,
  DepthBucket,
  DurationSummary,
  ErrorWeekRow,
  EstimatedShareRow,
  HeatCell,
  HotFileRow,
  IdleCacheBucket,
  ModelDayRow,
  ModelRow,
  MonthRow,
  PortfolioStats,
  PortfolioSummary,
  ProjectCacheRow,
  ProjectRow,
  ProjectTrends,
  RunRate,
  ScatterSession,
  SessionCacheRow,
  SessionRankRow,
  SidechainDayRow,
  SidechainProjectRow,
  SidechainSummary,
  StreakSummary,
  ToolUsageRow,
  TurnDepthStats,
  WebToolsProjectRow,
  WebToolsSummary,
} from "./stats-types.ts";
import { localDayOfMs, shiftDay, weekOf } from "./stats-types.ts";

export * from "./stats-types.ts";

const IO_TOKENS = "input_tokens + output_tokens";
const CACHE_TOKENS = "cache_write_5m + cache_write_1h + cache_read";

/** `AND project_id = ?` when scoped — pair with `scopedAll` so the bind list
 * can't drift from the SQL fragment across the two branches. */
const projectScope = (projectId?: string): string => (projectId ? "AND project_id = ?" : "");

/** Run a query whose SQL embeds `projectScope(projectId)`: the project id (when
 * present) binds first, then the remaining params — one call site per query
 * instead of a hand-rolled two-branch ternary at each. */
function scopedAll<T>(
  db: Database,
  sql: string,
  projectId: string | undefined,
  ...params: (string | number)[]
): T[] {
  return (
    projectId ? db.query(sql).all(projectId, ...params) : db.query(sql).all(...params)
  ) as T[];
}

export function portfolioSummary(db: Database): PortfolioSummary {
  const r = db
    .query(
      `SELECT
        COUNT(*) AS sessions,
        COUNT(DISTINCT project_id) AS projects,
        COALESCE(SUM(cost_total), 0) AS cost,
        COALESCE(SUM(cost_total * cost_estimated), 0) AS est_cost,
        COALESCE(SUM(input_tokens), 0) AS it,
        COALESCE(SUM(output_tokens), 0) AS ot,
        COALESCE(SUM(cache_write_5m + cache_write_1h), 0) AS cw,
        COALESCE(SUM(cache_read), 0) AS cr,
        MIN(day) AS first_day,
        MAX(day) AS last_day
      FROM sessions`,
    )
    .get() as {
    sessions: number;
    projects: number;
    cost: number;
    est_cost: number;
    it: number;
    ot: number;
    cw: number;
    cr: number;
    first_day: string | null;
    last_day: string | null;
  };
  return {
    sessions: r.sessions,
    projects: r.projects,
    cost: r.cost,
    estimatedShare: r.cost > 0 ? r.est_cost / r.cost : 0,
    inputTokens: r.it,
    outputTokens: r.ot,
    cacheWriteTokens: r.cw,
    cacheReadTokens: r.cr,
    firstDay: r.first_day,
    lastDay: r.last_day,
  };
}

export function spendByMonth(db: Database): MonthRow[] {
  return db
    .query(
      `SELECT month,
        SUM(cost_total) AS cost,
        COUNT(*) AS sessions,
        SUM(${IO_TOKENS}) AS ioTokens,
        SUM(${CACHE_TOKENS}) AS cacheTokens
      FROM sessions WHERE month IS NOT NULL
      GROUP BY month ORDER BY month`,
    )
    .all() as MonthRow[];
}

export function spendByProject(db: Database, limit = 20): ProjectRow[] {
  return db
    .query(
      `SELECT project_id AS projectId,
        MAX(project_path) AS projectPath,
        SUM(cost_total) AS cost,
        COUNT(*) AS sessions,
        SUM(${IO_TOKENS}) AS ioTokens,
        SUM(${CACHE_TOKENS}) AS cacheTokens
      FROM sessions
      GROUP BY project_id ORDER BY cost DESC LIMIT ?`,
    )
    .all(limit) as ProjectRow[];
}

export function topSessions(db: Database, limit = 10): SessionRankRow[] {
  return db
    .query(
      `SELECT session_id AS sessionId,
        project_path AS projectPath,
        title,
        cost_total AS cost,
        (${IO_TOKENS}) AS ioTokens,
        (${CACHE_TOKENS}) AS cacheTokens,
        start_time AS startTime
      FROM sessions ORDER BY cost_total DESC LIMIT ?`,
    )
    .all(limit) as SessionRankRow[];
}

interface JsonTokens {
  inputTokens?: number;
  outputTokens?: number;
  cacheWrite5mTokens?: number;
  cacheWrite1hTokens?: number;
  cacheReadTokens?: number;
}

/** Aggregate per-model spend across all sessions (models live in a JSON column). */
export function spendByModel(db: Database): ModelRow[] {
  const rows = db.query("SELECT models_json FROM sessions").all() as { models_json: string }[];
  const totals = new Map<string, { calls: number; cost: number; io: number; cache: number }>();
  for (const row of rows) {
    let models: Record<
      string,
      { apiCalls?: number; cost?: { total?: number }; tokens?: JsonTokens }
    >;
    try {
      models = JSON.parse(row.models_json ?? "{}");
    } catch {
      continue;
    }
    for (const [model, usage] of Object.entries(models)) {
      const acc = totals.get(model) ?? { calls: 0, cost: 0, io: 0, cache: 0 };
      acc.calls += usage.apiCalls ?? 0;
      acc.cost += usage.cost?.total ?? 0;
      const t = usage.tokens ?? {};
      acc.io += (t.inputTokens ?? 0) + (t.outputTokens ?? 0);
      acc.cache +=
        (t.cacheWrite5mTokens ?? 0) + (t.cacheWrite1hTokens ?? 0) + (t.cacheReadTokens ?? 0);
      totals.set(model, acc);
    }
  }
  return [...totals.entries()]
    .map(([model, v]) => ({
      model,
      calls: v.calls,
      cost: v.cost,
      ioTokens: v.io,
      cacheTokens: v.cache,
    }))
    .sort((a, b) => b.cost - a.cost);
}

const CACHE_WRITE = "cache_write_5m + cache_write_1h";
/** Per-session un-amortized cache-write cost: the write $ not read back. */
const WASTE_EXPR = `cost_cache_write * max(0.0, 1.0 - min(1.0, CASE
  WHEN (${CACHE_WRITE}) > 0 THEN CAST(cache_read AS REAL) / (${CACHE_WRITE})
  ELSE 1.0 END))`;

const withRatio = <T extends { writeTokens: number; readTokens: number }>(
  r: T,
): T & { ratio: number } => ({
  ...r,
  ratio: r.writeTokens > 0 ? r.readTokens / r.writeTokens : 0,
});

/** Portfolio-wide cache totals for the insights header. */
export function cacheSummary(db: Database): CacheSummary {
  return db
    .query(
      `SELECT COALESCE(SUM(cost_cache_write), 0) AS writeCost,
        COALESCE(SUM(cost_cache_read), 0) AS readCost,
        COALESCE(SUM(${WASTE_EXPR}), 0) AS waste,
        COALESCE(SUM(cost_total), 0) AS totalCost
      FROM sessions`,
    )
    .get() as CacheSummary;
}

/** Projects ranked by un-amortized cache-write spend (worst offenders first). */
export function cacheWasteByProject(db: Database, limit = 50): ProjectCacheRow[] {
  const rows = db
    .query(
      `SELECT project_id AS projectId,
        MAX(project_path) AS projectPath,
        COUNT(*) AS sessions,
        SUM(${CACHE_WRITE}) AS writeTokens,
        SUM(cache_read) AS readTokens,
        SUM(cost_cache_write) AS writeCost,
        SUM(cost_cache_read) AS readCost,
        SUM(cost_input) AS inputCost,
        SUM(cost_output) AS outputCost,
        SUM(cost_total) AS totalCost,
        SUM(${WASTE_EXPR}) AS waste
      FROM sessions
      GROUP BY project_id
      HAVING SUM(${CACHE_WRITE}) > 0
      ORDER BY waste DESC, writeCost DESC
      LIMIT ?`,
    )
    .all(limit) as Omit<ProjectCacheRow, "ratio">[];
  return rows.map(withRatio);
}

/** Sessions in one project ranked by un-amortized cache-write spend. */
export function cacheWasteBySession(
  db: Database,
  projectId: string,
  limit = 100,
): SessionCacheRow[] {
  const rows = db
    .query(
      `SELECT session_id AS sessionId,
        title,
        start_time AS startTime,
        project_path AS projectPath,
        (${CACHE_WRITE}) AS writeTokens,
        cache_read AS readTokens,
        cost_cache_write AS writeCost,
        cost_cache_read AS readCost,
        cost_input AS inputCost,
        cost_output AS outputCost,
        cost_total AS totalCost,
        (${WASTE_EXPR}) AS waste
      FROM sessions
      WHERE project_id = ? AND (${CACHE_WRITE}) > 0
      ORDER BY waste DESC, cost_cache_write DESC
      LIMIT ?`,
    )
    .all(projectId, limit) as Omit<SessionCacheRow, "ratio">[];
  return rows.map(withRatio);
}

/** Daily spend/activity series for the burn charts (optionally one project),
 * oldest day first. */
export function spendByDay(db: Database, projectId?: string): DayRow[] {
  const query = `SELECT day,
      SUM(cost_total) AS cost,
      COUNT(*) AS sessions,
      SUM(${IO_TOKENS}) AS ioTokens,
      SUM(${CACHE_TOKENS}) AS cacheTokens
    FROM sessions WHERE day IS NOT NULL ${projectScope(projectId)}
    GROUP BY day ORDER BY day`;
  return scopedAll<DayRow>(db, query, projectId);
}

/** Sessions and cost bucketed by local weekday × hour for the activity heatmap.
 * `localtime` converts the stored UTC start_time to the machine's timezone. */
export function activityHeatmap(db: Database): HeatCell[] {
  return db
    .query(
      `SELECT CAST(strftime('%w', start_time, 'localtime') AS INTEGER) AS weekday,
        CAST(strftime('%H', start_time, 'localtime') AS INTEGER) AS hour,
        COUNT(*) AS sessions,
        SUM(cost_total) AS cost
      FROM sessions WHERE start_time IS NOT NULL
      GROUP BY weekday, hour`,
    )
    .all() as HeatCell[];
}

function parseJson<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

/* ————————————————————————————————————————————————————————————————————————
 * Duration, distribution, cadence
 * ———————————————————————————————————————————————————————————————————————— */

/** Linear-interpolated percentile of an ascending-sorted array (p in [0,1]). */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  const a = sorted[lo] ?? 0;
  const b = sorted[hi] ?? a;
  return a + (b - a) * (idx - lo);
}

/** Portfolio-wide session-duration and active-time rollup. */
export function durationSummary(db: Database): DurationSummary {
  const rows = db
    .query(
      `SELECT duration_ms AS d, COALESCE(active_ms, 0) AS a
      FROM sessions WHERE duration_ms IS NOT NULL AND duration_ms > 0`,
    )
    .all() as { d: number; a: number }[];
  const durations = rows.map((r) => r.d).sort((x, y) => x - y);
  const totalMs = durations.reduce((s, v) => s + v, 0);
  const totalActiveMs = rows.reduce((s, r) => s + r.a, 0);
  return {
    sessions: rows.length,
    totalMs,
    avgMs: rows.length ? totalMs / rows.length : 0,
    medianMs: percentile(durations, 0.5),
    p90Ms: percentile(durations, 0.9),
    totalActiveMs,
    activeShare: totalMs > 0 ? totalActiveMs / totalMs : 0,
  };
}

/** Per-session points for the cost/duration and prompt-length/cost scatters
 * (optionally one project). */
export function sessionScatter(db: Database, limit = 1000, projectId?: string): ScatterSession[] {
  const query = `SELECT session_id AS sessionId,
      title,
      project_path AS projectPath,
      cost_total AS cost,
      duration_ms AS durationMs,
      COALESCE(active_ms, 0) AS activeMs,
      turns,
      COALESCE(prompt_chars, 0) AS promptChars
    FROM sessions
    WHERE duration_ms IS NOT NULL AND duration_ms > 0 ${projectScope(projectId)}
    ORDER BY cost_total DESC LIMIT ?`;
  return scopedAll<ScatterSession>(db, query, projectId, limit);
}

/** Buckets are ascending with an Infinity-capped tail, so every value lands. */
function bucketIndex(value: number, buckets: { max: number }[]): number {
  const i = buckets.findIndex((b) => value < b.max);
  return i === -1 ? buckets.length - 1 : i;
}

const COST_BUCKETS: { label: string; max: number }[] = [
  { label: "<1¢", max: 0.01 },
  { label: "1–10¢", max: 0.1 },
  { label: "10¢–$1", max: 1 },
  { label: "$1–10", max: 10 },
  { label: "$10–100", max: 100 },
  { label: "$100+", max: Number.POSITIVE_INFINITY },
];

/** Distribution of per-session cost (optionally one project): percentiles,
 * histogram, spend concentration. */
export function costDistribution(db: Database, projectId?: string): CostDistribution {
  const query = `SELECT cost_total AS c FROM sessions
    WHERE cost_total > 0 ${projectScope(projectId)} ORDER BY cost_total ASC`;
  const rows = scopedAll<{ c: number }>(db, query, projectId);
  const costs = rows.map((r) => r.c);
  const total = costs.reduce((s, v) => s + v, 0);
  const buckets = COST_BUCKETS.map((b) => ({ label: b.label, count: 0 }));
  for (const c of costs) {
    (buckets[bucketIndex(c, COST_BUCKETS)] as CostBucket).count += 1;
  }
  // A "top 10%" cohort only exists with ≥10 sessions; below that the slice
  // would just be the single most expensive session, mislabeled — null.
  const topDecileShare =
    costs.length >= 10 && total > 0
      ? costs.slice(Math.floor(costs.length * 0.9)).reduce((s, v) => s + v, 0) / total
      : null;
  return {
    sessions: costs.length,
    mean: costs.length ? total / costs.length : 0,
    p50: percentile(costs, 0.5),
    p90: percentile(costs, 0.9),
    p99: percentile(costs, 0.99),
    max: costs[costs.length - 1] ?? 0,
    topDecileShare,
    buckets,
  };
}

/** Active-day streaks. `today` is the caller's local YYYY-MM-DD. */
export function streaks(db: Database, today: string): StreakSummary {
  const rows = db
    .query("SELECT DISTINCT day FROM sessions WHERE day IS NOT NULL ORDER BY day")
    .all() as { day: string }[];
  const days = rows.map((r) => r.day);
  const daySet = new Set(days);

  let longest = 0;
  let run = 0;
  let prev: string | undefined;
  for (const day of days) {
    run = prev !== undefined && shiftDay(prev, 1) === day ? run + 1 : 1;
    if (run > longest) longest = run;
    prev = day;
  }

  // The streak is alive if the last active day is today or yesterday.
  let current = 0;
  let cursor = daySet.has(today)
    ? today
    : daySet.has(shiftDay(today, -1))
      ? shiftDay(today, -1)
      : "";
  while (cursor && daySet.has(cursor)) {
    current += 1;
    cursor = shiftDay(cursor, -1);
  }

  const windowStart = shiftDay(today, -29);
  const last30 = days.filter((d) => d >= windowStart && d <= today).length;

  return {
    activeDays: days.length,
    longestStreak: longest,
    currentStreak: current,
    last30ActiveDays: last30,
  };
}

/** Month-to-date spend vs last month, plus a run-rate projection. */
export function runRate(db: Database, today: string): RunRate {
  const month = today.slice(0, 7);
  const dayOfMonth = Number(today.slice(8, 10));
  const [y, m] = [Number(today.slice(0, 4)), Number(today.slice(5, 7))];
  const prev = new Date(Date.UTC(y, m - 2, 1));
  const prevMonth = prev.toISOString().slice(0, 7);
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const prevSamePointEnd = `${prevMonth}-${String(Math.min(dayOfMonth, new Date(Date.UTC(y, m - 1, 0)).getUTCDate())).padStart(2, "0")}`;

  const sum = (from: string, to: string): number =>
    (
      db
        .query("SELECT COALESCE(SUM(cost_total), 0) AS c FROM sessions WHERE day >= ? AND day <= ?")
        .get(from, to) as { c: number }
    ).c;

  const monthToDate = sum(`${month}-01`, today);
  const prevMonthSamePoint = sum(`${prevMonth}-01`, prevSamePointEnd);
  const prevMonthTotal = sum(`${prevMonth}-01`, `${prevMonth}-31`);
  return {
    month,
    monthToDate,
    prevMonth,
    prevMonthSamePoint,
    prevMonthTotal,
    // dayOfMonth ≥ 1 for any YYYY-MM-DD input.
    projected: (monthToDate / dayOfMonth) * daysInMonth,
  };
}

/* ————————————————————————————————————————————————————————————————————————
 * Cache TTL split, web tools, estimated share, sidechain
 * ———————————————————————————————————————————————————————————————————————— */

/** How cache writes split between the 5-minute and 1-hour (2× priced) TTLs. */
export function cacheTtlSplit(db: Database): CacheTtlSplit {
  return db
    .query(
      `SELECT COALESCE(SUM(cache_write_5m), 0) AS write5mTokens,
        COALESCE(SUM(cache_write_1h), 0) AS write1hTokens,
        COALESCE(SUM(cost_cache_write), 0) AS writeCost
      FROM sessions`,
    )
    .get() as CacheTtlSplit;
}

/** Server-side web search/fetch usage: portfolio summary + top projects. */
export function webToolUsage(
  db: Database,
  limit = 20,
): { summary: WebToolsSummary; byProject: WebToolsProjectRow[] } {
  const summary = db
    .query(
      `SELECT COALESCE(SUM(web_searches), 0) AS searches,
        COALESCE(SUM(web_fetches), 0) AS fetches,
        COALESCE(SUM(web_searches + web_fetches > 0), 0) AS sessions
      FROM sessions`,
    )
    .get() as WebToolsSummary;
  const byProject = db
    .query(
      `SELECT project_id AS projectId,
        MAX(project_path) AS projectPath,
        SUM(web_searches) AS searches,
        SUM(web_fetches) AS fetches
      FROM sessions
      GROUP BY project_id
      HAVING SUM(web_searches + web_fetches) > 0
      ORDER BY SUM(web_searches + web_fetches) DESC LIMIT ?`,
    )
    .all(limit) as WebToolsProjectRow[];
  return { summary, byProject };
}

/** Projects whose totals lean on heuristic (non-exact) pricing. */
export function estimatedShareByProject(db: Database, limit = 20): EstimatedShareRow[] {
  return db
    .query(
      `SELECT project_id AS projectId,
        MAX(project_path) AS projectPath,
        SUM(cost_total) AS cost,
        SUM(cost_total * cost_estimated) AS estimatedCost,
        CASE WHEN SUM(cost_total) > 0
          THEN SUM(cost_total * cost_estimated) / SUM(cost_total) ELSE 0 END AS share
      FROM sessions
      GROUP BY project_id
      HAVING SUM(cost_total * cost_estimated) > 0
      ORDER BY estimatedCost DESC LIMIT ?`,
    )
    .all(limit) as EstimatedShareRow[];
}

/** How much of the portfolio's spend ran on sidechains (subagents). */
export function sidechainSummary(db: Database): SidechainSummary {
  const r = db
    .query(
      `SELECT COALESCE(SUM(sidechain_cost), 0) AS cost,
        COALESCE(SUM(sidechain_calls), 0) AS calls,
        COALESCE(SUM(cost_total), 0) AS totalCost,
        COALESCE(SUM(api_calls), 0) AS totalCalls
      FROM sessions`,
    )
    .get() as Omit<SidechainSummary, "share">;
  return { ...r, share: r.totalCost > 0 ? r.cost / r.totalCost : 0 };
}

/** Daily sidechain vs total spend, oldest first (delegation trend). */
export function sidechainByDay(db: Database): SidechainDayRow[] {
  return db
    .query(
      `SELECT day,
        COALESCE(SUM(sidechain_cost), 0) AS sidechainCost,
        SUM(cost_total) AS totalCost
      FROM sessions WHERE day IS NOT NULL
      GROUP BY day ORDER BY day`,
    )
    .all() as SidechainDayRow[];
}

/** Projects ranked by sidechain (subagent) spend. */
export function sidechainByProject(db: Database, limit = 20): SidechainProjectRow[] {
  return db
    .query(
      `SELECT project_id AS projectId,
        MAX(project_path) AS projectPath,
        SUM(cost_total) AS cost,
        COALESCE(SUM(sidechain_cost), 0) AS sidechainCost,
        CASE WHEN SUM(cost_total) > 0
          THEN COALESCE(SUM(sidechain_cost), 0) / SUM(cost_total) ELSE 0 END AS share
      FROM sessions
      GROUP BY project_id
      HAVING COALESCE(SUM(sidechain_cost), 0) > 0
      ORDER BY sidechainCost DESC LIMIT ?`,
    )
    .all(limit) as SidechainProjectRow[];
}

/* ————————————————————————————————————————————————————————————————————————
 * JSON-blob rollups: files, model mix, modes, stop reasons, depth, bash, …
 * ———————————————————————————————————————————————————————————————————————— */

/** Files Claude keeps coming back to, across sessions (optionally one project). */
export function hotFiles(db: Database, projectId?: string, limit = 30): HotFileRow[] {
  const rows = (
    projectId
      ? db.query("SELECT files_json AS j, day FROM sessions WHERE project_id = ?").all(projectId)
      : db.query("SELECT files_json AS j, day FROM sessions").all()
  ) as { j: string | null; day: string | null }[];
  const acc = new Map<string, { sessions: number; lastDay: string | null }>();
  for (const r of rows) {
    for (const file of new Set(parseJson<string[]>(r.j, []))) {
      const a = acc.get(file) ?? { sessions: 0, lastDay: null };
      a.sessions += 1;
      if (r.day && (a.lastDay === null || r.day > a.lastDay)) a.lastDay = r.day;
      acc.set(file, a);
    }
  }
  return [...acc.entries()]
    .map(([file, a]) => ({ file, sessions: a.sessions, lastDay: a.lastDay }))
    .sort((a, b) => b.sessions - a.sessions || (a.file < b.file ? -1 : 1))
    .slice(0, limit);
}

/**
 * Daily spend per model (top `topN` models by total cost; the rest fold into
 * "other"), for the model-mix stacked chart, optionally for one project.
 * Attribution is by session day.
 */
export function modelMixByDay(db: Database, topN = 6, projectId?: string): ModelDayRow[] {
  const query = `SELECT day, models_json AS j FROM sessions
    WHERE day IS NOT NULL ${projectScope(projectId)}`;
  const rows = scopedAll<{ day: string; j: string | null }>(db, query, projectId);
  const perDay = new Map<string, Map<string, number>>();
  const totals = new Map<string, number>();
  for (const r of rows) {
    const models = parseJson<Record<string, { cost?: { total?: number } }>>(r.j, {});
    for (const [model, usage] of Object.entries(models)) {
      const cost = usage.cost?.total ?? 0;
      if (cost <= 0) continue;
      let day = perDay.get(r.day);
      if (!day) {
        day = new Map();
        perDay.set(r.day, day);
      }
      day.set(model, (day.get(model) ?? 0) + cost);
      totals.set(model, (totals.get(model) ?? 0) + cost);
    }
  }
  const top = new Set(
    [...totals.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, topN)
      .map(([m]) => m),
  );
  const out: ModelDayRow[] = [];
  for (const [day, models] of [...perDay.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    let other = 0;
    for (const [model, cost] of models) {
      if (top.has(model)) out.push({ day, model, cost });
      else other += cost;
    }
    if (other > 0) out.push({ day, model: "other", cost: other });
  }
  return out;
}

const DEPTH_BUCKETS: { label: string; max: number }[] = [
  { label: "1", max: 2 },
  { label: "2–3", max: 4 },
  { label: "4–7", max: 8 },
  { label: "8–15", max: 16 },
  { label: "16+", max: Number.POSITIVE_INFINITY },
];

/* Shared row folds: `analyticsRollup`'s single portfolio scan and the
 * per-project slices below feed rows through the SAME accumulator, so the
 * portfolio Tools view and the project pages can never disagree about
 * error rates or bucket boundaries. */

interface ToolFold {
  uses: Map<string, number>;
  errors: Map<string, number>;
  sessions: Map<string, number>;
}

const newToolFold = (): ToolFold => ({ uses: new Map(), errors: new Map(), sessions: new Map() });

function addToolRow(acc: ToolFold, toolsJson: string | null, errorsJson: string | null): void {
  for (const [tool, n] of Object.entries(parseJson<Record<string, number>>(toolsJson, {}))) {
    acc.uses.set(tool, (acc.uses.get(tool) ?? 0) + n);
    acc.sessions.set(tool, (acc.sessions.get(tool) ?? 0) + 1);
  }
  for (const [tool, n] of Object.entries(parseJson<Record<string, number>>(errorsJson, {}))) {
    acc.errors.set(tool, (acc.errors.get(tool) ?? 0) + n);
  }
}

function toolRows(acc: ToolFold): ToolUsageRow[] {
  return [...acc.uses.entries()]
    .map(([tool, uses]) => {
      const errors = acc.errors.get(tool) ?? 0;
      return {
        tool,
        uses,
        errors,
        errorRate: uses > 0 ? errors / uses : 0,
        sessions: acc.sessions.get(tool) ?? 0,
      };
    })
    .sort((a, b) => b.uses - a.uses);
}

interface DepthFold {
  buckets: DepthBucket[];
  byMonth: Map<string, { sum: number; turns: number }>;
  turns: number;
  sum: number;
  maxDepth: number;
}

const newDepthFold = (): DepthFold => ({
  buckets: DEPTH_BUCKETS.map((b) => ({ label: b.label, turns: 0 })),
  byMonth: new Map(),
  turns: 0,
  sum: 0,
  maxDepth: 0,
});

function addDepthRow(acc: DepthFold, depthsJson: string | null, month: string | null): void {
  for (const depth of parseJson<number[]>(depthsJson, [])) {
    if (depth <= 0) continue;
    acc.turns += 1;
    acc.sum += depth;
    if (depth > acc.maxDepth) acc.maxDepth = depth;
    (acc.buckets[bucketIndex(depth, DEPTH_BUCKETS)] as DepthBucket).turns += 1;
    if (month) {
      const m = acc.byMonth.get(month) ?? { sum: 0, turns: 0 };
      m.sum += depth;
      m.turns += 1;
      acc.byMonth.set(month, m);
    }
  }
}

function depthStats(acc: DepthFold): TurnDepthStats {
  return {
    turns: acc.turns,
    avgDepth: acc.turns > 0 ? acc.sum / acc.turns : 0,
    maxDepth: acc.maxDepth,
    buckets: acc.buckets,
    byMonth: [...acc.byMonth.entries()]
      .map(([month, m]) => ({ month, avgDepth: m.sum / m.turns, turns: m.turns }))
      .sort((a, b) => (a.month < b.month ? -1 : 1)),
  };
}

/** Aggregate tool usage with error rates, optionally for one project. The
 * portfolio-wide Tools view uses `analyticsRollup` (one scan for everything);
 * this is the standalone slice for project pages. */
export function toolUsage(db: Database, projectId?: string): ToolUsageRow[] {
  const query = `SELECT tools_json AS t, tool_errors_json AS e FROM sessions
    WHERE 1 = 1 ${projectScope(projectId)}`;
  const rows = scopedAll<{ t: string | null; e: string | null }>(db, query, projectId);
  const acc = newToolFold();
  for (const r of rows) addToolRow(acc, r.t, r.e);
  return toolRows(acc);
}

/** Turn-depth stats (buckets + monthly trend), optionally for one project. */
export function turnDepthStats(db: Database, projectId?: string): TurnDepthStats {
  const query = `SELECT turn_depths_json AS j, month FROM sessions
    WHERE 1 = 1 ${projectScope(projectId)}`;
  const rows = scopedAll<{ j: string | null; month: string | null }>(db, query, projectId);
  const acc = newDepthFold();
  for (const r of rows) addDepthRow(acc, r.j, r.month);
  return depthStats(acc);
}

/** Everything the project page charts need, in one bundle. */
export function projectTrends(db: Database, projectId: string): ProjectTrends {
  return {
    daily: spendByDay(db, projectId),
    modelMix: modelMixByDay(db, 6, projectId),
    scatter: sessionScatter(db, 500, projectId),
    distribution: costDistribution(db, projectId),
    turnDepth: turnDepthStats(db, projectId),
    tools: toolUsage(db, projectId),
  };
}

/**
 * Compaction pressure: which sessions/projects chronically hit the context
 * ceiling. The summary is single-sourced from `compactions_json` via the
 * shared `summarizeCompactions` split (own = not subagent, not inherited —
 * the same rule the indexer bakes into the `compactions` INT column, which
 * stays as a SUM-able convenience for the per-project rollup).
 */
export function compactionUsage(db: Database, limit = 30): CompactionUsage {
  const totalSessions = (db.query("SELECT COUNT(*) AS n FROM sessions").get() as { n: number }).n;
  const rows = db
    .query(
      `SELECT compactions_json AS j FROM sessions
      WHERE compactions_json IS NOT NULL AND compactions_json != '[]'`,
    )
    .all() as { j: string | null }[];
  let sessions = 0;
  let compactions = 0;
  let auto = 0;
  let manual = 0;
  let unknown = 0;
  let sidechain = 0;
  let inherited = 0;
  for (const r of rows) {
    const b = summarizeCompactions(parseJson<Compaction[]>(r.j, []));
    if (b.own.length > 0) sessions += 1;
    compactions += b.own.length;
    auto += b.triggers.auto ?? 0;
    manual += b.triggers.manual ?? 0;
    unknown += b.own.length - (b.triggers.auto ?? 0) - (b.triggers.manual ?? 0);
    sidechain += b.sidechain;
    inherited += b.inherited;
  }
  const byProject = (
    db
      .query(
        `SELECT project_id AS projectId,
          MAX(project_path) AS projectPath,
          COUNT(*) AS sessions,
          COALESCE(SUM(compactions > 0), 0) AS sessionsWithCompaction,
          COALESCE(SUM(compactions), 0) AS compactions
        FROM sessions
        GROUP BY project_id
        HAVING SUM(compactions) > 0
        ORDER BY compactions DESC LIMIT ?`,
      )
      .all(limit) as Omit<CompactionProjectRow, "share">[]
  ).map((p) => ({ ...p, share: p.sessions > 0 ? p.sessionsWithCompaction / p.sessions : 0 }));
  return {
    summary: { sessions, totalSessions, compactions, auto, manual, unknown, sidechain, inherited },
    byProject,
  };
}

/* ————————————————————————————————————————————————————————————————————————
 * Concurrency and cross-insights
 * ———————————————————————————————————————————————————————————————————————— */

/** Sanity cap on one session's wall-clock span: a garbage-but-parseable
 * end_time must not make the day walk crawl to the year 3000. */
const MAX_SESSION_SPAN_MS = 7 * 24 * 60 * 60 * 1000;

/** How many sessions overlap in time — parallel-Claude usage, per day. */
export function concurrency(db: Database): ConcurrencySummary {
  const rows = db
    .query(
      `SELECT start_time AS s, end_time AS e FROM sessions
      WHERE start_time IS NOT NULL AND end_time IS NOT NULL`,
    )
    .all() as { s: string; e: string }[];
  interface Edge {
    ms: number;
    delta: 1 | -1;
  }
  const edges: Edge[] = [];
  for (const r of rows) {
    const start = Date.parse(r.s);
    const end = Date.parse(r.e);
    if (Number.isNaN(start) || Number.isNaN(end) || end < start) continue;
    // A zero-duration session still counts: give it a 1ms floor so its start
    // edge isn't cancelled before it is observed.
    const clampedEnd = Math.min(Math.max(end, start + 1), start + MAX_SESSION_SPAN_MS);
    edges.push({ ms: start, delta: 1 }, { ms: clampedEnd, delta: -1 });
  }
  // Ends sort before starts at the same instant so touching sessions don't
  // count as overlapping.
  edges.sort((a, b) => a.ms - b.ms || a.delta - b.delta);
  const perDay = new Map<string, number>();
  let open = 0;
  let peak = 0;
  // Rolling local-day cursor: consecutive edges almost always share a day, so
  // recompute the day string only on rollover instead of per edge.
  let dayStr = "";
  let dayEndMs = Number.NEGATIVE_INFINITY;
  const dayAt = (ms: number): string => {
    if (ms >= dayEndMs || dayStr === "") {
      dayStr = localDayOfMs(ms);
      const next = new Date(ms);
      next.setHours(24, 0, 0, 0);
      dayEndMs = next.getTime();
    }
    return dayStr;
  };
  for (let i = 0; i < edges.length; i++) {
    open += (edges[i] as Edge).delta;
    if (open <= 0) continue;
    if (open > peak) peak = open;
    // `open` holds until the next edge; credit every local day that span
    // touches, so a session pair overlapping across midnight still marks the
    // morning side (a start-edge-only walk would skip days where the overlap
    // merely persists).
    const spanEnd = edges[i + 1]?.ms ?? (edges[i] as Edge).ms;
    for (let ms = (edges[i] as Edge).ms; ; ) {
      const day = dayAt(ms);
      if (open > (perDay.get(day) ?? 0)) perDay.set(day, open);
      if (dayEndMs >= spanEnd) break;
      ms = dayEndMs;
    }
  }
  const days = [...perDay.entries()]
    .map(([day, maxConcurrent]) => ({ day, maxConcurrent }))
    .sort((a, b) => (a.day < b.day ? -1 : 1));
  const parallel = days.filter((d) => d.maxConcurrent >= 2).length;
  return {
    peak,
    parallelDayShare: days.length > 0 ? parallel / days.length : 0,
    days,
  };
}

const IDLE_BUCKETS: { label: string; max: number }[] = [
  { label: "<25% idle", max: 0.25 },
  { label: "25–50% idle", max: 0.5 },
  { label: "50–75% idle", max: 0.75 },
  { label: "75%+ idle", max: Number.POSITIVE_INFINITY },
];

/**
 * Cross-insight: does cache waste concentrate in sessions that sat idle
 * (cache TTL expiring between turns)? Sessions bucketed by idle share.
 */
export function idleVsCache(db: Database): IdleCacheBucket[] {
  const rows = db
    .query(
      `SELECT duration_ms AS d,
        COALESCE(active_ms, 0) AS a,
        (${CACHE_WRITE}) AS w,
        cache_read AS r,
        cost_cache_write AS wc,
        (${WASTE_EXPR}) AS waste
      FROM sessions
      WHERE duration_ms > 0 AND (${CACHE_WRITE}) > 0`,
    )
    .all() as { d: number; a: number; w: number; r: number; wc: number; waste: number }[];
  const acc = IDLE_BUCKETS.map(() => ({ sessions: 0, w: 0, r: 0, wc: 0, waste: 0 }));
  for (const row of rows) {
    const idle = Math.max(0, Math.min(1, 1 - row.a / row.d));
    const a = acc[bucketIndex(idle, IDLE_BUCKETS)] as (typeof acc)[number];
    a.sessions += 1;
    a.w += row.w;
    a.r += row.r;
    a.wc += row.wc;
    a.waste += row.waste;
  }
  return acc.map((a, i) => ({
    bucket: IDLE_BUCKETS[i]?.label ?? "?",
    sessions: a.sessions,
    ratio: a.w > 0 ? a.r / a.w : 0,
    wasteShare: a.wc > 0 ? a.waste / a.wc : 0,
  }));
}

/** Tool-error rate per ISO week (attributed to each session's day). */
export function errorRateByWeek(db: Database): ErrorWeekRow[] {
  const rows = db
    .query("SELECT day, tools_json AS t, tool_errors_json AS e FROM sessions WHERE day IS NOT NULL")
    .all() as { day: string; t: string | null; e: string | null }[];
  const acc = new Map<string, { calls: number; errors: number }>();
  for (const r of rows) {
    const week = weekOf(r.day);
    const a = acc.get(week) ?? { calls: 0, errors: 0 };
    for (const n of Object.values(parseJson<Record<string, number>>(r.t, {}))) a.calls += n;
    for (const n of Object.values(parseJson<Record<string, number>>(r.e, {}))) a.errors += n;
    acc.set(week, a);
  }
  return [...acc.entries()]
    .map(([week, a]) => ({
      week,
      toolCalls: a.calls,
      errors: a.errors,
      errorRate: a.calls > 0 ? a.errors / a.calls : 0,
    }))
    .sort((a, b) => (a.week < b.week ? -1 : 1));
}

/* ————————————————————————————————————————————————————————————————————————
 * Single-pass analytics rollup
 * ———————————————————————————————————————————————————————————————————————— */

/**
 * Every per-session JSON rollup, folded in ONE table scan. The Tools surfaces
 * (web `/api/analytics`, the TUI tools view, CLI stats) need most of these at
 * once; scanning per metric multiplied full-table JSON parsing by the metric
 * count. Bash families and test runs are classified here — at query time —
 * from the raw command heads stored in the index (schema v6), so those
 * heuristics can change without a reindex.
 */
export function analyticsRollup(db: Database): AnalyticsRollup {
  interface Row {
    project_id: string;
    day: string | null;
    month: string | null;
    cost: number | null;
    retriesN: number;
    tools_json: string | null;
    tool_errors_json: string | null;
    skills_json: string | null;
    skill_errors_json: string | null;
    subagents_json: string | null;
    commands_json: string | null;
    command_errors_json: string | null;
    retries_json: string | null;
    permission_modes_json: string | null;
    stop_reasons_json: string | null;
    turn_depths_json: string | null;
    versions_json: string | null;
    branches_json: string | null;
  }
  const rows = db
    .query(
      `SELECT project_id, day, month, cost_total AS cost,
        COALESCE(retries, 0) AS retriesN,
        tools_json, tool_errors_json, skills_json, skill_errors_json,
        subagents_json, commands_json, command_errors_json, retries_json,
        permission_modes_json, stop_reasons_json, turn_depths_json,
        versions_json, branches_json
      FROM sessions`,
    )
    .all() as Row[];

  const toolFold = newToolFold();

  interface SkillAcc {
    invocations: number;
    sessions: number;
    errors: number;
    projects: Set<string>;
    firstUsed: string | null;
    lastUsed: string | null;
    totalCost: number;
    daily: Map<string, number>;
  }
  const skillAcc = new Map<string, SkillAcc>();
  const skillOf = (name: string): SkillAcc => {
    let a = skillAcc.get(name);
    if (!a) {
      a = {
        invocations: 0,
        sessions: 0,
        errors: 0,
        projects: new Set(),
        firstUsed: null,
        lastUsed: null,
        totalCost: 0,
        daily: new Map(),
      };
      skillAcc.set(name, a);
    }
    return a;
  };

  const subagentFreq = new Map<string, number>();
  const bashAcc = new Map<string, { uses: number; errors: number; sessions: number }>();
  // Distinct heads repeat across sessions — classify each once.
  const isTestHead = new Map<string, boolean>();
  const testOf = (head: string): boolean => {
    let t = isTestHead.get(head);
    if (t === undefined) {
      t = isTestCommand(head);
      isTestHead.set(head, t);
    }
    return t;
  };
  let testRuns = 0;
  let testFailures = 0;
  let testSessions = 0;

  let retryTotal = 0;
  let retrySessions = 0;
  const retryAcc = new Map<string, { retries: number; sessions: number }>();

  const modeAcc = new Map<string, { turns: number; sessions: number; totalCost: number }>();
  const reasonAcc = new Map<string, { count: number; sessions: number }>();

  const depthFold = newDepthFold();

  const versionAcc = new Map<
    string,
    { sessions: number; firstDay: string | null; lastDay: string | null }
  >();
  const branchAcc = new Map<string, { sessions: number; cost: number }>();

  for (const r of rows) {
    const cost = r.cost ?? 0;

    addToolRow(toolFold, r.tools_json, r.tool_errors_json);

    for (const [name, n] of Object.entries(parseJson<Record<string, number>>(r.skills_json, {}))) {
      const a = skillOf(name);
      a.invocations += n;
      a.sessions += 1;
      a.projects.add(r.project_id);
      a.totalCost += cost;
      if (r.day) {
        if (a.firstUsed === null || r.day < a.firstUsed) a.firstUsed = r.day;
        if (a.lastUsed === null || r.day > a.lastUsed) a.lastUsed = r.day;
        a.daily.set(r.day, (a.daily.get(r.day) ?? 0) + n);
      }
    }
    for (const [name, n] of Object.entries(
      parseJson<Record<string, number>>(r.skill_errors_json, {}),
    )) {
      skillOf(name).errors += n;
    }

    for (const name of new Set(parseJson<string[]>(r.subagents_json, []))) {
      subagentFreq.set(name, (subagentFreq.get(name) ?? 0) + 1);
    }

    // Bash families and test runs, classified from the raw heads.
    const heads = parseJson<Record<string, number>>(r.commands_json, {});
    const headErrors = parseJson<Record<string, number>>(r.command_errors_json, {});
    const familiesThisSession = new Set<string>();
    let ranTests = false;
    for (const [head, n] of Object.entries(heads)) {
      const family = head.split(" ", 1)[0] as string;
      const a = bashAcc.get(family) ?? { uses: 0, errors: 0, sessions: 0 };
      a.uses += n;
      if (!familiesThisSession.has(family)) {
        a.sessions += 1;
        familiesThisSession.add(family);
      }
      bashAcc.set(family, a);
      if (testOf(head)) {
        testRuns += n;
        ranTests = true;
      }
    }
    for (const [head, n] of Object.entries(headErrors)) {
      const family = head.split(" ", 1)[0] as string;
      const a = bashAcc.get(family);
      if (a) a.errors += n;
      if (testOf(head)) testFailures += n;
    }
    if (ranTests) testSessions += 1;

    retryTotal += r.retriesN;
    if (r.retriesN > 0) retrySessions += 1;
    for (const [tool, n] of Object.entries(parseJson<Record<string, number>>(r.retries_json, {}))) {
      const a = retryAcc.get(tool) ?? { retries: 0, sessions: 0 };
      a.retries += n;
      a.sessions += 1;
      retryAcc.set(tool, a);
    }

    for (const [mode, turns] of Object.entries(
      parseJson<Record<string, number>>(r.permission_modes_json, {}),
    )) {
      const a = modeAcc.get(mode) ?? { turns: 0, sessions: 0, totalCost: 0 };
      a.turns += turns;
      a.sessions += 1;
      a.totalCost += cost;
      modeAcc.set(mode, a);
    }

    for (const [reason, n] of Object.entries(
      parseJson<Record<string, number>>(r.stop_reasons_json, {}),
    )) {
      const a = reasonAcc.get(reason) ?? { count: 0, sessions: 0 };
      a.count += n;
      a.sessions += 1;
      reasonAcc.set(reason, a);
    }

    addDepthRow(depthFold, r.turn_depths_json, r.month);

    for (const v of new Set(parseJson<string[]>(r.versions_json, []))) {
      const a = versionAcc.get(v) ?? { sessions: 0, firstDay: null, lastDay: null };
      a.sessions += 1;
      if (r.day) {
        if (a.firstDay === null || r.day < a.firstDay) a.firstDay = r.day;
        if (a.lastDay === null || r.day > a.lastDay) a.lastDay = r.day;
      }
      versionAcc.set(v, a);
    }

    for (const b of new Set(parseJson<string[]>(r.branches_json, []))) {
      if (!b) continue;
      const a = branchAcc.get(b) ?? { sessions: 0, cost: 0 };
      a.sessions += 1;
      a.cost += cost;
      branchAcc.set(b, a);
    }
  }

  return {
    tools: toolRows(toolFold),
    skills: [...skillAcc.entries()]
      .map(([name, a]) => ({
        name,
        invocations: a.invocations,
        sessions: a.sessions,
        projects: a.projects.size,
        errors: a.errors,
        errorRate: a.invocations > 0 ? a.errors / a.invocations : 0,
        firstUsed: a.firstUsed,
        lastUsed: a.lastUsed,
        totalCost: a.totalCost,
        avgCostPerSession: a.sessions > 0 ? a.totalCost / a.sessions : 0,
        daily: [...a.daily.entries()]
          .map(([day, count]) => ({ day, count }))
          .sort((x, y) => (x.day < y.day ? -1 : 1)),
      }))
      .sort((a, b) => b.invocations - a.invocations),
    subagents: [...subagentFreq.entries()]
      .map(([name, sessions]) => ({ name, sessions }))
      .sort((a, b) => b.sessions - a.sessions),
    bash: [...bashAcc.entries()]
      .map(([command, a]) => ({
        command,
        uses: a.uses,
        errors: a.errors,
        errorRate: a.uses > 0 ? a.errors / a.uses : 0,
        sessions: a.sessions,
      }))
      .sort((a, b) => b.uses - a.uses)
      .slice(0, 30),
    tests: {
      runs: testRuns,
      failures: testFailures,
      sessions: testSessions,
      failureRate: testRuns > 0 ? testFailures / testRuns : 0,
    },
    retries: {
      total: retryTotal,
      sessions: retrySessions,
      byTool: [...retryAcc.entries()]
        .map(([tool, a]) => ({ tool, ...a }))
        .sort((a, b) => b.retries - a.retries),
    },
    permissionModes: [...modeAcc.entries()]
      .map(([mode, a]) => ({
        mode,
        turns: a.turns,
        sessions: a.sessions,
        totalCost: a.totalCost,
        avgCostPerSession: a.sessions > 0 ? a.totalCost / a.sessions : 0,
      }))
      .sort((a, b) => b.turns - a.turns),
    stopReasons: [...reasonAcc.entries()]
      .map(([reason, a]) => ({ reason, count: a.count, sessions: a.sessions }))
      .sort((a, b) => b.count - a.count),
    turnDepth: depthStats(depthFold),
    versions: [...versionAcc.entries()]
      .map(([version, a]) => ({ version, ...a }))
      .sort((a, b) => ((b.lastDay ?? "") < (a.lastDay ?? "") ? -1 : 1)),
    branches: [...branchAcc.entries()]
      .map(([branch, a]) => ({ branch, ...a }))
      .sort((a, b) => b.sessions - a.sessions || b.cost - a.cost)
      .slice(0, 30),
  };
}

/**
 * The shared portfolio view behind both `cc-analyzer stats` and the web
 * `/api/stats` route. Frontends may append extras, but the common shape is
 * assembled in exactly one place.
 */
export function buildPortfolioStats(
  db: Database,
  today: string,
  opts: { projectLimit?: number; topLimit?: number } = {},
): PortfolioStats {
  return {
    summary: portfolioSummary(db),
    byMonth: spendByMonth(db),
    byProject: spendByProject(db, opts.projectLimit ?? 20),
    byModel: spendByModel(db),
    top: topSessions(db, opts.topLimit ?? 10),
    duration: durationSummary(db),
    distribution: costDistribution(db),
    streaks: streaks(db, today),
    runRate: runRate(db, today),
    sidechain: sidechainSummary(db),
    estimatedByProject: estimatedShareByProject(db),
  };
}
