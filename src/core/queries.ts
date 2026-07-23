import type { Database } from "bun:sqlite";
import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

/** SQL fragments summing the two token buckets shown next to cost. */
const IO_TOKENS = "input_tokens + output_tokens";
const CACHE_TOKENS = "cache_write_5m + cache_write_1h + cache_read";

export interface IndexedProject {
  projectId: string;
  projectPath: string | null;
  sessions: number;
  cost: number;
  ioTokens: number;
  cacheTokens: number;
  lastActivityMs: number;
  /** Own main-chain compactions across the project's sessions (schema v7). */
  compactions: number;
}

export interface IndexedProjectMatch {
  projectId: string;
  projectPath: string;
}

function canonicalPath(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}

export interface IndexedSession {
  sessionId: string | null;
  path: string;
  title: string | null;
  cost: number;
  costEstimated: boolean;
  ioTokens: number;
  cacheTokens: number;
  startTime: string | null;
  turns: number;
  apiCalls: number;
  toolCalls: number;
  mtimeMs: number;
}

/** A session row that also carries its project path, for cross-project listings. */
export interface SessionWithProject extends IndexedSession {
  projectPath: string | null;
}

/** Session columns shared by the cross-project queries below. */
const SESSION_COLUMNS = `session_id AS sessionId,
  path,
  title,
  project_path AS projectPath,
  cost_total AS cost,
  cost_estimated AS costEstimated,
  (${IO_TOKENS}) AS ioTokens,
  (${CACHE_TOKENS}) AS cacheTokens,
  start_time AS startTime,
  turns,
  api_calls AS apiCalls,
  tool_calls AS toolCalls,
  mtime_ms AS mtimeMs`;

type RawSessionWithProject = Omit<SessionWithProject, "costEstimated"> & { costEstimated: number };
const toSessionWithProject = (r: RawSessionWithProject): SessionWithProject => ({
  ...r,
  costEstimated: r.costEstimated === 1,
});

/** Projects with rollups, for the TUI/web project list. */
export function listIndexedProjects(db: Database): IndexedProject[] {
  const rows = db
    .query(
      `SELECT project_id AS projectId,
        MAX(project_path) AS projectPath,
        COUNT(*) AS sessions,
        SUM(cost_total) AS cost,
        SUM(${IO_TOKENS}) AS ioTokens,
        SUM(${CACHE_TOKENS}) AS cacheTokens,
        MAX(mtime_ms) AS lastActivityMs,
        COALESCE(SUM(compactions), 0) AS compactions
      FROM sessions
      GROUP BY project_id
      ORDER BY lastActivityMs DESC`,
    )
    .all() as IndexedProject[];
  return rows;
}

/**
 * Resolve a working directory to the indexed project whose authoritative cwd
 * is its closest ancestor. This intentionally never decodes a project id back
 * into a path.
 */
export function indexedProjectForPath(
  db: Database,
  workingDirectory: string,
): IndexedProjectMatch | undefined {
  const cwd = canonicalPath(workingDirectory);
  const rows = db
    .query(
      `SELECT project_id AS projectId, project_path AS projectPath
      FROM sessions
      WHERE project_path IS NOT NULL
      GROUP BY project_id, project_path`,
    )
    .all() as IndexedProjectMatch[];

  return rows
    .filter((row) => {
      const rel = relative(canonicalPath(row.projectPath), cwd);
      return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
    })
    .sort((a, b) => canonicalPath(b.projectPath).length - canonicalPath(a.projectPath).length)[0];
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
        (${IO_TOKENS}) AS ioTokens,
        (${CACHE_TOKENS}) AS cacheTokens,
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

/** A single indexed session by its session id (for direct drill-in from the dashboard). */
export function indexedSessionById(db: Database, id: string): IndexedSession | undefined {
  const row = db
    .query(
      `SELECT session_id AS sessionId,
        path,
        title,
        cost_total AS cost,
        cost_estimated AS costEstimated,
        (${IO_TOKENS}) AS ioTokens,
        (${CACHE_TOKENS}) AS cacheTokens,
        start_time AS startTime,
        turns,
        api_calls AS apiCalls,
        tool_calls AS toolCalls,
        mtime_ms AS mtimeMs
      FROM sessions
      WHERE session_id = ?
      LIMIT 1`,
    )
    .get(id) as (Omit<IndexedSession, "costEstimated"> & { costEstimated: number }) | undefined;
  return row ? { ...row, costEstimated: row.costEstimated === 1 } : undefined;
}

/** Every session across all projects, most recent first (for TUI global search). */
export function listAllSessions(db: Database): SessionWithProject[] {
  const rows = db
    .query(`SELECT ${SESSION_COLUMNS} FROM sessions ORDER BY mtime_ms DESC`)
    .all() as RawSessionWithProject[];
  return rows.map(toSessionWithProject);
}

/** Escape LIKE wildcards so user input matches literally (used with ESCAPE '\'). */
const escapeLike = (s: string): string => s.replace(/[\\%_]/g, (ch) => `\\${ch}`);

/** Sessions across all projects matching a query on title / session id / project path. */
export function searchSessions(db: Database, q: string, limit = 100): SessionWithProject[] {
  const like = `%${escapeLike(q)}%`;
  const rows = db
    .query(
      `SELECT ${SESSION_COLUMNS} FROM sessions
      WHERE title LIKE ? ESCAPE '\\' OR session_id LIKE ? ESCAPE '\\' OR project_path LIKE ? ESCAPE '\\'
      ORDER BY mtime_ms DESC LIMIT ?`,
    )
    .all(like, like, like, limit) as RawSessionWithProject[];
  return rows.map(toSessionWithProject);
}

export function isIndexEmpty(db: Database): boolean {
  const row = db.query("SELECT COUNT(*) AS n FROM sessions").get() as { n: number };
  return row.n === 0;
}

/** Look up a session's file path from the index by session id. */
export function sessionPathById(db: Database, id: string): string | undefined {
  const row = db
    .query("SELECT path FROM sessions WHERE session_id = ? OR path LIKE ? ESCAPE '\\' LIMIT 1")
    .get(id, `%/${escapeLike(id)}.jsonl`) as { path: string } | undefined;
  return row?.path;
}
