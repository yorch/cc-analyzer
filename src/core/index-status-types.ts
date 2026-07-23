/** Exact source-vs-index freshness plus the age of the last successful scan. */
export interface IndexStatus {
  lastRefreshedAt: string | null;
  ageMs: number | null;
  stale: boolean;
  added: number;
  changed: number;
  deleted: number;
}

export const INDEX_AGE_WARNING_MS = 24 * 60 * 60 * 1000;
