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
