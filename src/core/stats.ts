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
  tokens: number;
}

export interface ProjectRow {
  projectId: string;
  projectPath: string | null;
  cost: number;
  sessions: number;
  tokens: number;
}

export interface SessionRankRow {
  sessionId: string | null;
  projectPath: string | null;
  title: string | null;
  cost: number;
  startTime: string | null;
}

export interface ModelRow {
  model: string;
  calls: number;
  cost: number;
}

const TOKEN_SUM = "input_tokens + output_tokens + cache_write_5m + cache_write_1h + cache_read";

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
        SUM(${TOKEN_SUM}) AS tokens
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
        SUM(${TOKEN_SUM}) AS tokens
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
        start_time AS startTime
      FROM sessions ORDER BY cost_total DESC LIMIT ?`,
    )
    .all(limit) as SessionRankRow[];
}

/** Aggregate per-model spend across all sessions (models live in a JSON column). */
export function spendByModel(db: Database): ModelRow[] {
  const rows = db.query("SELECT models_json FROM sessions").all() as { models_json: string }[];
  const totals = new Map<string, { calls: number; cost: number }>();
  for (const row of rows) {
    let models: Record<string, { apiCalls?: number; cost?: { total?: number } }>;
    try {
      models = JSON.parse(row.models_json ?? "{}");
    } catch {
      continue;
    }
    for (const [model, usage] of Object.entries(models)) {
      const acc = totals.get(model) ?? { calls: 0, cost: 0 };
      acc.calls += usage.apiCalls ?? 0;
      acc.cost += usage.cost?.total ?? 0;
      totals.set(model, acc);
    }
  }
  return [...totals.entries()]
    .map(([model, v]) => ({ model, calls: v.calls, cost: v.cost }))
    .sort((a, b) => b.cost - a.cost);
}
