import type { Database } from "bun:sqlite";
import { type ReindexOptions, type ReindexResult, reindex } from "./indexer.ts";
import { isIndexEmpty } from "./queries.ts";

export interface RefreshIndexOptions extends ReindexOptions {
  /** Refresh even when the index already contains sessions. */
  refresh?: boolean;
}

/**
 * Build an empty index, or incrementally refresh an existing one when asked.
 * Returns undefined when the existing index can be used as-is.
 */
export async function refreshIndexIfNeeded(
  db: Database,
  opts: RefreshIndexOptions = {},
): Promise<ReindexResult | undefined> {
  if (!opts.refresh && !isIndexEmpty(db)) return undefined;
  return reindex(db, opts);
}

/**
 * The warning a frontend should print when archive-during-index was requested
 * but did not run (an unresolved archive identity). Pure and returned rather
 * than printed: core never writes to the terminal. Every surface that calls
 * `reindex` must surface it — a silent skip means the backup the user turned on
 * stops happening, and sessions Claude Code later cleans up were never copied.
 */
export function archiveSkippedWarning(result: ReindexResult | undefined): string | undefined {
  return result?.archiveSkipped ? `warning: ${result.archiveSkipped}` : undefined;
}
