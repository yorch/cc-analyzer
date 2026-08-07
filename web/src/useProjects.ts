import { useEffect, useState } from "react";
import { api, type IndexedProject } from "./api.ts";

/** `GET /api/projects` returns the whole portfolio and doesn't change while
 *  the tab is open, but the Project and Session pages both need it just to
 *  resolve one id's display name/path — a module-level cache shared across
 *  every `useProjects()` caller means only the first mount of either page (or
 *  the first "Try Again") ever pays for the request. */
interface ProjectsCache {
  promise: Promise<IndexedProject[]> | null;
  data: IndexedProject[] | null;
  error: unknown;
}

let cache: ProjectsCache = { promise: null, data: null, error: null };
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

function load(): Promise<IndexedProject[]> {
  if (cache.promise) return cache.promise;
  // Captured by reference so the callbacks below can tell whether *this*
  // attempt is still the current one by the time it settles — without it,
  // an in-flight fetch resolving after a retry() reset the cache would read
  // the live (by-then-different) `cache.promise` and could overwrite a
  // fresher result with its own stale one, in either direction.
  const attempt: Promise<IndexedProject[]> = api.projects().then(
    (data) => {
      if (cache.promise === attempt) {
        cache = { promise: attempt, data, error: null };
        notify();
      }
      return data;
    },
    (error) => {
      if (cache.promise === attempt) {
        // Clear the promise (not the rest of the cache) so the next mount —
        // or an explicit retry() — gets a fresh attempt instead of a
        // permanently-rejected one.
        cache = { promise: null, data: null, error };
        notify();
      }
      throw error;
    },
  );
  cache.promise = attempt;
  return attempt;
}

export interface ProjectsState {
  data: IndexedProject[] | null;
  error: unknown;
  loading: boolean;
  retry: () => void;
}

/** The shared `/api/projects` list. Fetched once per page load (cached
 *  module-wide, not per component), refreshed only via `retry()`. */
export function useProjects(): ProjectsState {
  const [, setTick] = useState(0);
  useEffect(() => {
    const listener = () => setTick((value) => value + 1);
    listeners.add(listener);
    // Swallow here — the rejection already lands in `cache.error` via
    // `notify()`; an unhandled promise rejection would just be console noise.
    load().catch(() => {});
    return () => {
      listeners.delete(listener);
    };
  }, []);
  return {
    data: cache.data,
    error: cache.error,
    loading: !cache.data && !cache.error,
    retry: () => {
      cache = { promise: null, data: null, error: null };
      notify();
      load().catch(() => {});
    },
  };
}
