/** Small keyed in-memory cache for GET payloads several views share
 *  (`/api/prefs`, `/api/insights`, `/api/analytics`). It dedupes concurrent
 *  requests and serves a settled payload for `TTL_MS`, so hopping between
 *  Insights, Projects and Tools doesn't re-run the same server scan.
 *
 *  Invalidation is explicit: `invalidate(key)` after a write that changes the
 *  payload (`api.setCostBasis`/`setAnalysisModel` drop `"prefs"`), `invalidateAll()`
 *  for anything keyed on the index fingerprint. The SPA has no in-page index
 *  refresh (`serve --refresh` runs at startup), so the TTL is the backstop for
 *  a long-open tab. Only payloads that DON'T embed cost-basis framing text may
 *  be cached under a plain key — `/api/stats` and `/api/report` carry
 *  `costBasis`, so they stay uncached (or must put the basis in their key). */
export const CACHE_TTL_MS = 60_000;

interface Entry {
  data?: unknown;
  at: number;
  promise?: Promise<unknown>;
}

const entries = new Map<string, Entry>();
/** Bumped on invalidation so a request in flight at that moment can't write
 *  its (now stale) result back into the cache. */
let generation = 0;

const fresh = (e: Entry | undefined): e is Entry & { data: unknown } =>
  !!e && "data" in e && Date.now() - e.at < CACHE_TTL_MS;

/** The settled, unexpired value for `key`, if any (synchronous). */
export function peek<T>(key: string): T | undefined {
  const e = entries.get(key);
  return fresh(e) ? (e.data as T) : undefined;
}

/** Resolve `key` from cache, join an in-flight request, or run `fn`. */
export function cachedFetch<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const e = entries.get(key);
  if (fresh(e)) return Promise.resolve(e.data as T);
  if (e?.promise) return e.promise as Promise<T>;
  const gen = generation;
  const promise = fn().then(
    (data) => {
      if (gen === generation) entries.set(key, { data, at: Date.now() });
      else if (entries.get(key)?.promise === promise) entries.delete(key);
      return data;
    },
    (err) => {
      // Failures are never cached: the next mount or retry asks again.
      if (entries.get(key)?.promise === promise) entries.delete(key);
      throw err;
    },
  );
  entries.set(key, { at: 0, promise });
  return promise;
}

export function invalidate(key: string): void {
  generation++;
  entries.delete(key);
}

export function invalidateAll(): void {
  generation++;
  entries.clear();
}
