import type { Database } from "bun:sqlite";
import { listArchiveRoots } from "./archive.ts";
import { type ClaudeRoot, claudeRoots } from "./claude-roots.ts";
import { listAllSessions, retainsMissingRows, scanRoots } from "./discover.ts";
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

/** Set by `archive machine adopt|keep`; cleared by `index --rebuild`. */
export const REBUILD_REQUIRED_KEY = "rebuild_required";

/**
 * Changing archive identity prunes or leaves duplicate rows whose `usage_keys`
 * claims do not transfer, so per-session cost stays wrong until a rebuild — and
 * `--check` would otherwise call that index fresh. Persist the debt.
 */
export function markRebuildRequired(db: Database): void {
  db.query("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(
    REBUILD_REQUIRED_KEY,
    String(Date.now()),
  );
}

export function rebuildRequired(db: Database): boolean {
  return db.query("SELECT 1 FROM meta WHERE key = ?").get(REBUILD_REQUIRED_KEY) !== null;
}

export const REBUILD_REQUIRED_MESSAGE =
  "Run `cc-analyzer index --rebuild`: changing this computer's archive identity leaves " +
  "per-session and per-project cost wrong until usage claims are re-derived.";

/** Compare source file metadata with the SQLite cache without parsing sessions. */
export async function inspectIndexStatus(
  db: Database,
  now = Date.now(),
  roots: ClaudeRoot[] = claudeRoots(),
): Promise<IndexStatus> {
  // Include archive roots exactly as the indexer does, preferring this machine's
  // live root over its own backup copy while that source remains available.
  roots = [...roots, ...(await listArchiveRoots(undefined, roots))];
  // Same prune rule the indexer applies, from the same helper, so `--check`
  // cannot report a deletion that `reindex` would not actually make.
  const retained = retainsMissingRows(await scanRoots(roots));

  const aliases = await readProjectAliases();
  const files = await listAllSessions(roots);
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
