import type { Database } from "bun:sqlite";
import { listArchiveRoots } from "./archive.ts";
import { type ClaudeRoot, claudeRoots } from "./claude-roots.ts";
import { planSessions, retainsMissingRows, scanRoots } from "./discover.ts";
import type { IndexStatus } from "./index-status-types.ts";
import { aliasNeedsReindex, readProjectAliases } from "./project-aliases.ts";

export const LAST_SCAN_KEY = "last_scan_at";

export function lastIndexScanAt(db: Database): number | null {
  const row = db.query("SELECT value FROM meta WHERE key = ?").get(LAST_SCAN_KEY) as
    | { value: string }
    | undefined;
  if (!row) return null;
  const value = Number(row.value);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * Session keys whose surviving rows owe a re-analysis (see `reanalyze_keys` in
 * db.ts). Read by both `reindex` and `inspectIndexStatus` so `--check` reports
 * exactly the work the next `index` does.
 */
export function readReanalyzeKeys(db: Database): Set<string> {
  const rows = db.query("SELECT key FROM reanalyze_keys").all() as { key: string }[];
  return new Set(rows.map((r) => r.key));
}

/** Compare source file metadata with the SQLite cache without parsing sessions. */
export async function inspectIndexStatus(
  db: Database,
  now = Date.now(),
  roots: ClaudeRoot[] = claudeRoots(),
): Promise<IndexStatus> {
  // Include archive roots exactly as the indexer does; `planSessions` then
  // drops archived copies of sessions that exist elsewhere, per session.
  roots = [...roots, ...(await listArchiveRoots())];
  // Same prune rule the indexer applies, from the same helper, so `--check`
  // cannot report a deletion that `reindex` would not actually make.
  const retained = retainsMissingRows(await scanRoots(roots));

  const aliases = await readProjectAliases();
  const existingRows = db
    .query(
      "SELECT path, mtime_ms, size_bytes, claude_dir, project_path, project_alias FROM sessions",
    )
    .all() as {
    path: string;
    mtime_ms: number;
    size_bytes: number;
    claude_dir: string;
    project_path: string | null;
    project_alias: string | null;
  }[];
  const existing = new Map(existingRows.map((row) => [row.path, row]));
  const { sessions: files, reingest } = await planSessions(
    roots,
    existing,
    retained,
    readReanalyzeKeys(db),
  );
  const sourcePaths = new Set<string>();
  let added = 0;
  let changed = 0;

  for (const file of files) {
    sourcePaths.add(file.path);
    const row = existing.get(file.path);
    if (!row) added++;
    else if (
      row.mtime_ms !== file.mtimeMs ||
      row.size_bytes !== file.sizeBytes ||
      reingest.has(file.path) ||
      // Same predicate the indexer uses, so `--check` reports exactly the work
      // `reindex` will do for alias edits.
      aliasNeedsReindex(row.project_path, row.project_alias, aliases.byPath)
    )
      changed++;
  }

  let deleted = 0;
  for (const [path, row] of existing) {
    if (sourcePaths.has(path)) continue;
    if (retained(row.claude_dir)) continue;
    deleted++;
  }

  const lastScan = lastIndexScanAt(db);
  return {
    lastRefreshedAt: lastScan === null ? null : new Date(lastScan).toISOString(),
    ageMs: lastScan === null ? null : Math.max(0, now - lastScan),
    stale: added + changed + deleted > 0,
    added,
    changed,
    deleted,
  };
}
