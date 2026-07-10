import type { Database } from "bun:sqlite";

export interface IndexedProject {
  projectId: string;
  projectPath: string | null;
  sessions: number;
  cost: number;
  lastActivityMs: number;
}

export interface IndexedSession {
  sessionId: string | null;
  path: string;
  title: string | null;
  cost: number;
  costEstimated: boolean;
  startTime: string | null;
  turns: number;
  apiCalls: number;
  toolCalls: number;
  mtimeMs: number;
}

/** Projects with rollups, for the TUI/web project list. */
export function listIndexedProjects(db: Database): IndexedProject[] {
  const rows = db
    .query(
      `SELECT project_id AS projectId,
        MAX(project_path) AS projectPath,
        COUNT(*) AS sessions,
        SUM(cost_total) AS cost,
        MAX(mtime_ms) AS lastActivityMs
      FROM sessions
      GROUP BY project_id
      ORDER BY lastActivityMs DESC`,
    )
    .all() as IndexedProject[];
  return rows;
}

/** Sessions within a project, most recent first. */
export function listIndexedSessions(db: Database, projectId: string): IndexedSession[] {
  const rows = db
    .query(
      `SELECT session_id AS sessionId,
        path,
        title,
        cost_total AS cost,
        cost_estimated AS costEstimated,
        start_time AS startTime,
        turns,
        api_calls AS apiCalls,
        tool_calls AS toolCalls,
        mtime_ms AS mtimeMs
      FROM sessions
      WHERE project_id = ?
      ORDER BY mtime_ms DESC`,
    )
    .all(projectId) as (Omit<IndexedSession, "costEstimated"> & { costEstimated: number })[];
  return rows.map((r) => ({ ...r, costEstimated: r.costEstimated === 1 }));
}

export function isIndexEmpty(db: Database): boolean {
  const row = db.query("SELECT COUNT(*) AS n FROM sessions").get() as { n: number };
  return row.n === 0;
}

/** Look up a session's file path from the index by session id. */
export function sessionPathById(db: Database, id: string): string | undefined {
  const row = db
    .query("SELECT path FROM sessions WHERE session_id = ? OR path LIKE ? LIMIT 1")
    .get(id, `%/${id}.jsonl`) as { path: string } | undefined;
  return row?.path;
}
