import type { Database } from "bun:sqlite";

export interface PortfolioSummary {
  sessions: number;
  projects: number;
  cost: number;
  estimatedShare: number;
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  firstDay: string | null;
  lastDay: string | null;
}

export interface MonthRow {
  month: string;
  cost: number;
  sessions: number;
  ioTokens: number;
  cacheTokens: number;
}

/** One day of the spend burn series (day is the stored YYYY-MM-DD column). */
export interface DayRow {
  day: string;
  cost: number;
  sessions: number;
  ioTokens: number;
  cacheTokens: number;
}

/** One weekday×hour cell of the activity heatmap (local time). */
export interface HeatCell {
  /** 0=Sunday … 6=Saturday, from strftime('%w'). */
  weekday: number;
  /** 0…23, local hour. */
  hour: number;
  sessions: number;
  cost: number;
}

export interface ProjectRow {
  projectId: string;
  projectPath: string | null;
  cost: number;
  sessions: number;
  ioTokens: number;
  cacheTokens: number;
}

export interface SessionRankRow {
  sessionId: string | null;
  projectPath: string | null;
  title: string | null;
  cost: number;
  ioTokens: number;
  cacheTokens: number;
  startTime: string | null;
}

export interface ModelRow {
  model: string;
  calls: number;
  cost: number;
  ioTokens: number;
  cacheTokens: number;
}

/** Cache-efficiency metrics shared by the project and session insight rows. */
export interface CacheMetrics {
  writeTokens: number;
  readTokens: number;
  writeCost: number;
  readCost: number;
  inputCost: number;
  outputCost: number;
  totalCost: number;
  /** readTokens / writeTokens; 0 when nothing was written. */
  ratio: number;
  /** Cache-write $ that was not read back: Σ writeCost × max(0, 1 − min(1, read/write)). */
  waste: number;
}

export interface ProjectCacheRow extends CacheMetrics {
  projectId: string;
  projectPath: string | null;
  sessions: number;
}

export interface SessionCacheRow extends CacheMetrics {
  sessionId: string | null;
  title: string | null;
  startTime: string | null;
  projectPath: string | null;
}

export interface CacheSummary {
  writeCost: number;
  readCost: number;
  waste: number;
  totalCost: number;
}

export type CacheVerdict = "efficient" | "ok" | "leaky";

/** Classify cache amortization from the read:write token ratio. */
export function cacheVerdict(ratio: number): CacheVerdict {
  if (ratio >= 2) return "efficient";
  if (ratio >= 1) return "ok";
  return "leaky";
}

const IO_TOKENS = "input_tokens + output_tokens";
const CACHE_TOKENS = "cache_write_5m + cache_write_1h + cache_read";

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

/** Daily spend/activity series for the trends burn chart, oldest day first. */
export function spendByDay(db: Database): DayRow[] {
  return db
    .query(
      `SELECT day,
        SUM(cost_total) AS cost,
        COUNT(*) AS sessions,
        SUM(${IO_TOKENS}) AS ioTokens,
        SUM(${CACHE_TOKENS}) AS cacheTokens
      FROM sessions WHERE day IS NOT NULL
      GROUP BY day ORDER BY day`,
    )
    .all() as DayRow[];
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

/** Aggregate tool usage across all sessions, with error counts and rate. */
export interface ToolUsageRow {
  tool: string;
  uses: number;
  errors: number;
  /** errors / uses, in [0, 1]. */
  errorRate: number;
  sessions: number;
}

/** A name (subagent) and how many sessions used it. */
export interface NameUsageRow {
  name: string;
  sessions: number;
}

/** A day and how many times a skill was invoked on it (adoption sparkline). */
export interface SkillDayCount {
  day: string;
  count: number;
}

/** Rich per-skill analytics: invocation depth, reach, reliability, adoption, and
 * (session-scoped, correlational) cost. */
export interface SkillUsageRow {
  name: string;
  /** Total `Skill` invocations across all sessions. */
  invocations: number;
  /** Sessions that invoked the skill at least once. */
  sessions: number;
  /** Distinct projects that invoked the skill. */
  projects: number;
  /** Invocations whose result was an error. */
  errors: number;
  /** errors / invocations, in [0, 1]. */
  errorRate: number;
  /** Earliest / latest day (YYYY-MM-DD) the skill was used, or null if undated. */
  firstUsed: string | null;
  lastUsed: string | null;
  /** Σ cost_total over sessions that used the skill. Correlational, not causal:
   * a session using N skills counts its full cost toward each of them. */
  totalCost: number;
  avgCostPerSession: number;
  /** Per-day invocation counts, oldest first, for the adoption sparkline. */
  daily: SkillDayCount[];
}

function parseJson<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

/** Tools ranked by total invocations, folding the per-session count and error
 * JSON blobs. `sessions` is how many sessions used the tool at least once. */
export function toolUsage(db: Database): ToolUsageRow[] {
  const rows = db.query("SELECT tools_json, tool_errors_json FROM sessions").all() as {
    tools_json: string | null;
    tool_errors_json: string | null;
  }[];
  const uses = new Map<string, number>();
  const errors = new Map<string, number>();
  const sessions = new Map<string, number>();
  for (const r of rows) {
    const tools = parseJson<Record<string, number>>(r.tools_json, {});
    const errs = parseJson<Record<string, number>>(r.tool_errors_json, {});
    for (const [t, n] of Object.entries(tools)) {
      uses.set(t, (uses.get(t) ?? 0) + n);
      sessions.set(t, (sessions.get(t) ?? 0) + 1);
    }
    for (const [t, n] of Object.entries(errs)) errors.set(t, (errors.get(t) ?? 0) + n);
  }
  return [...uses.entries()]
    .map(([tool, u]) => {
      const e = errors.get(tool) ?? 0;
      return {
        tool,
        uses: u,
        errors: e,
        errorRate: u > 0 ? e / u : 0,
        sessions: sessions.get(tool) ?? 0,
      };
    })
    .sort((a, b) => b.uses - a.uses);
}

/** Subagent names ranked by how many sessions used each (the JSON column holds a
 * per-session deduped list). */
function nameFrequency(db: Database, column: "subagents_json"): NameUsageRow[] {
  const rows = db.query(`SELECT ${column} AS j FROM sessions`).all() as { j: string | null }[];
  const freq = new Map<string, number>();
  for (const r of rows) {
    for (const name of new Set(parseJson<string[]>(r.j, []))) {
      freq.set(name, (freq.get(name) ?? 0) + 1);
    }
  }
  return [...freq.entries()]
    .map(([name, sessions]) => ({ name, sessions }))
    .sort((a, b) => b.sessions - a.sessions);
}

export const subagentUsage = (db: Database): NameUsageRow[] => nameFrequency(db, "subagents_json");

/** Rich per-skill analytics, folding the per-session skill count/error blobs with
 * the project, day, and cost columns already on each row. Ranked by invocations. */
export function skillAnalytics(db: Database): SkillUsageRow[] {
  const rows = db
    .query("SELECT skills_json, skill_errors_json, project_id, day, cost_total FROM sessions")
    .all() as {
    skills_json: string | null;
    skill_errors_json: string | null;
    project_id: string;
    day: string | null;
    cost_total: number | null;
  }[];

  interface Acc {
    invocations: number;
    sessions: number;
    errors: number;
    projects: Set<string>;
    firstUsed: string | null;
    lastUsed: string | null;
    totalCost: number;
    daily: Map<string, number>;
  }
  const acc = new Map<string, Acc>();
  const get = (name: string): Acc => {
    let a = acc.get(name);
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
      acc.set(name, a);
    }
    return a;
  };

  for (const r of rows) {
    const skills = parseJson<Record<string, number>>(r.skills_json, {});
    const errs = parseJson<Record<string, number>>(r.skill_errors_json, {});
    const cost = r.cost_total ?? 0;
    for (const [name, n] of Object.entries(skills)) {
      const a = get(name);
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
    for (const [name, n] of Object.entries(errs)) get(name).errors += n;
  }

  return [...acc.entries()]
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
    .sort((a, b) => b.invocations - a.invocations);
}
