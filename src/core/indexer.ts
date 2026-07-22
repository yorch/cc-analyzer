import type { Database } from "bun:sqlite";
import type { SessionAnalysis } from "./analyze.ts";
import { analyzeSession } from "./analyze.ts";
import { listAllSessions, type SessionInfo } from "./discover.ts";
import { parseSessionFile } from "./parser.ts";
import type { PricingTable } from "./pricing.ts";
import { loadPricing } from "./pricing-source.ts";

export interface SessionRow {
  path: string;
  project_id: string;
  project_path: string | null;
  session_id: string | null;
  title: string | null;
  start_time: string | null;
  end_time: string | null;
  day: string | null;
  month: string | null;
  duration_ms: number | null;
  turns: number;
  api_calls: number;
  tool_calls: number;
  input_tokens: number;
  output_tokens: number;
  cache_write_5m: number;
  cache_write_1h: number;
  cache_read: number;
  cost_input: number;
  cost_output: number;
  cost_cache_write: number;
  cost_cache_read: number;
  cost_total: number;
  cost_estimated: number;
  web_searches: number;
  web_fetches: number;
  active_ms: number;
  sidechain_calls: number;
  sidechain_cost: number;
  prompt_chars: number;
  test_runs: number;
  test_failures: number;
  retries: number;
  models_json: string;
  tools_json: string;
  tool_errors_json: string;
  skills_json: string;
  skill_errors_json: string;
  subagents_json: string;
  turn_depths_json: string;
  permission_modes_json: string;
  stop_reasons_json: string;
  files_json: string;
  branches_json: string;
  versions_json: string;
  bash_json: string;
  bash_errors_json: string;
  retries_json: string;
  size_bytes: number;
  mtime_ms: number;
  indexed_at: number;
}

/**
 * Local-time YYYY-MM-DD for an ISO timestamp. `day`/`month` must agree with
 * the activity heatmap, which buckets by `strftime(..., 'localtime')`.
 */
function localDay(iso: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Flatten a session analysis + file metadata into a database row. */
export function toSessionRow(
  analysis: SessionAnalysis,
  info: SessionInfo,
  now: number,
): SessionRow {
  const t = analysis.totals.tokens;
  const c = analysis.totals.cost;
  const day = analysis.startTime ? localDay(analysis.startTime) : null;
  return {
    path: info.path,
    project_id: info.projectId,
    project_path: analysis.projectPath ?? null,
    session_id: analysis.sessionId ?? info.id,
    title: analysis.title ?? null,
    start_time: analysis.startTime ?? null,
    end_time: analysis.endTime ?? null,
    day,
    month: day ? day.slice(0, 7) : null,
    duration_ms: analysis.durationMs ?? null,
    turns: analysis.totals.turns,
    api_calls: analysis.totals.apiCalls,
    tool_calls: analysis.totals.toolCalls,
    input_tokens: t.inputTokens,
    output_tokens: t.outputTokens,
    cache_write_5m: t.cacheWrite5mTokens,
    cache_write_1h: t.cacheWrite1hTokens,
    cache_read: t.cacheReadTokens,
    cost_input: c.input,
    cost_output: c.output,
    cost_cache_write: c.cacheWrite,
    cost_cache_read: c.cacheRead,
    cost_total: c.total,
    cost_estimated: c.estimated ? 1 : 0,
    web_searches: analysis.totals.webSearches,
    web_fetches: analysis.totals.webFetches,
    active_ms: analysis.totals.activeMs,
    sidechain_calls: analysis.totals.sidechainApiCalls,
    sidechain_cost: analysis.totals.sidechainCost,
    prompt_chars: analysis.turns.reduce((sum, turn) => sum + turn.prompt.length, 0),
    test_runs: analysis.testRuns,
    test_failures: analysis.testFailures,
    retries: analysis.retries,
    models_json: JSON.stringify(analysis.models),
    tools_json: JSON.stringify(analysis.tools),
    tool_errors_json: JSON.stringify(analysis.toolErrors),
    skills_json: JSON.stringify(analysis.skills),
    skill_errors_json: JSON.stringify(analysis.skillErrors),
    subagents_json: JSON.stringify(analysis.subagents),
    turn_depths_json: JSON.stringify(analysis.turns.map((turn) => turn.apiCalls.length)),
    permission_modes_json: JSON.stringify(analysis.permissionModes),
    stop_reasons_json: JSON.stringify(analysis.stopReasons),
    files_json: JSON.stringify(analysis.filesTouched),
    branches_json: JSON.stringify(analysis.gitBranches),
    versions_json: JSON.stringify(analysis.versions),
    bash_json: JSON.stringify(analysis.bashCommands),
    bash_errors_json: JSON.stringify(analysis.bashErrors),
    retries_json: JSON.stringify(analysis.retriesByTool),
    size_bytes: info.sizeBytes,
    mtime_ms: info.mtimeMs,
    indexed_at: now,
  };
}

const COLUMNS: (keyof SessionRow)[] = [
  "path",
  "project_id",
  "project_path",
  "session_id",
  "title",
  "start_time",
  "end_time",
  "day",
  "month",
  "duration_ms",
  "turns",
  "api_calls",
  "tool_calls",
  "input_tokens",
  "output_tokens",
  "cache_write_5m",
  "cache_write_1h",
  "cache_read",
  "cost_input",
  "cost_output",
  "cost_cache_write",
  "cost_cache_read",
  "cost_total",
  "cost_estimated",
  "web_searches",
  "web_fetches",
  "active_ms",
  "sidechain_calls",
  "sidechain_cost",
  "prompt_chars",
  "test_runs",
  "test_failures",
  "retries",
  "models_json",
  "tools_json",
  "tool_errors_json",
  "skills_json",
  "skill_errors_json",
  "subagents_json",
  "turn_depths_json",
  "permission_modes_json",
  "stop_reasons_json",
  "files_json",
  "branches_json",
  "versions_json",
  "bash_json",
  "bash_errors_json",
  "retries_json",
  "size_bytes",
  "mtime_ms",
  "indexed_at",
];

function upsertStatement(db: Database) {
  const cols = COLUMNS.join(", ");
  const placeholders = COLUMNS.map(() => "?").join(", ");
  return db.query(`INSERT OR REPLACE INTO sessions (${cols}) VALUES (${placeholders})`);
}

function rowValues(row: SessionRow): (string | number | null)[] {
  return COLUMNS.map((c) => row[c]);
}

/** Run an async mapper over items with a bounded concurrency. */
async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) break;
      results[i] = await fn(items[i] as T);
    }
  });
  await Promise.all(workers);
  return results;
}

export interface ReindexResult {
  total: number;
  indexed: number;
  skipped: number;
  deleted: number;
}

export interface ReindexOptions {
  /** Ignore existing state and re-parse everything. */
  rebuild?: boolean;
  concurrency?: number;
  pricing?: PricingTable;
  /** Progress callback: (done, toDo). */
  onProgress?: (done: number, total: number) => void;
}

/**
 * Incrementally (re)build the session index. Files whose size and mtime are
 * unchanged since the last index are skipped; deleted files are pruned.
 */
export async function reindex(db: Database, opts: ReindexOptions = {}): Promise<ReindexResult> {
  const concurrency = opts.concurrency ?? 16;
  const pricing = opts.pricing ?? (await loadPricing()).table;
  const now = Date.now();

  const files = await listAllSessions();
  const currentPaths = new Set(files.map((f) => f.path));

  const existing = new Map<string, { mtime_ms: number; size_bytes: number }>();
  {
    const rows = db.query("SELECT path, mtime_ms, size_bytes FROM sessions").all() as {
      path: string;
      mtime_ms: number;
      size_bytes: number;
    }[];
    for (const r of rows) existing.set(r.path, { mtime_ms: r.mtime_ms, size_bytes: r.size_bytes });
  }

  // On rebuild, ignore existing state for skipping — but still prune below.
  const toIngest = opts.rebuild
    ? files
    : files.filter((f) => {
        const prev = existing.get(f.path);
        return !prev || prev.mtime_ms !== f.mtimeMs || prev.size_bytes !== f.sizeBytes;
      });

  let done = 0;
  const rows = await mapPool(toIngest, concurrency, async (info) => {
    try {
      const { events } = await parseSessionFile(info.path);
      const analysis = analyzeSession(events, pricing);
      return toSessionRow(analysis, info, now);
    } catch {
      return null;
    } finally {
      done++;
      opts.onProgress?.(done, toIngest.length);
    }
  });

  const upsert = upsertStatement(db);
  const deleteStmt = db.query("DELETE FROM sessions WHERE path = ?");

  let deleted = 0;
  const writeAll = db.transaction(() => {
    for (const row of rows) {
      if (row) upsert.run(...rowValues(row));
    }
    for (const path of existing.keys()) {
      if (!currentPaths.has(path)) {
        deleteStmt.run(path);
        deleted++;
      }
    }
  });
  writeAll();

  const indexed = rows.filter((r) => r !== null).length;
  return {
    total: files.length,
    indexed,
    skipped: files.length - toIngest.length,
    deleted,
  };
}
