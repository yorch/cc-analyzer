import type { Database } from "bun:sqlite";
import { listAllSessions } from "./discover.ts";
import type { IndexStatus } from "./index-status-types.ts";

export const LAST_SCAN_KEY = "last_scan_at";

export function lastIndexScanAt(db: Database): number | null {
  const row = db.query("SELECT value FROM meta WHERE key = ?").get(LAST_SCAN_KEY) as
    | { value: string }
    | undefined;
  if (!row) return null;
  const value = Number(row.value);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

/** Compare source file metadata with the SQLite cache without parsing sessions. */
export async function inspectIndexStatus(db: Database, now = Date.now()): Promise<IndexStatus> {
  const files = await listAllSessions();
  const existingRows = db.query("SELECT path, mtime_ms, size_bytes FROM sessions").all() as {
    path: string;
    mtime_ms: number;
    size_bytes: number;
  }[];
  const existing = new Map(existingRows.map((row) => [row.path, row]));
  const sourcePaths = new Set<string>();
  let added = 0;
  let changed = 0;

  for (const file of files) {
    sourcePaths.add(file.path);
    const row = existing.get(file.path);
    if (!row) added++;
    else if (row.mtime_ms !== file.mtimeMs || row.size_bytes !== file.sizeBytes) changed++;
  }

  let deleted = 0;
  for (const path of existing.keys()) {
    if (!sourcePaths.has(path)) deleted++;
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
