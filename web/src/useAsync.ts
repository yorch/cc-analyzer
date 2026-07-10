import { useEffect, useState } from "react";

export interface AsyncState<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
}

/** Minimal data-fetching hook: runs `fn` when `deps` change. */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]): AsyncState<T> {
  const [state, setState] = useState<AsyncState<T>>({ data: null, error: null, loading: true });
  useEffect(() => {
    let cancelled = false;
    setState({ data: null, error: null, loading: true });
    fn().then(
      (data) => !cancelled && setState({ data, error: null, loading: false }),
      (err) => !cancelled && setState({ data: null, error: String(err), loading: false }),
    );
    return () => {
      cancelled = true;
    };
    // biome-ignore lint/correctness/useExhaustiveDependencies: deps are supplied by the caller of this generic hook
  }, deps);
  return state;
}
