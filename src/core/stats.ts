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
