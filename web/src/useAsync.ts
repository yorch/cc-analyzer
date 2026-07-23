import { useEffect, useState } from "react";

export interface AsyncState<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  retry: () => void;
}

/** Minimal data-fetching hook: runs `fn` when `deps` change. */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]): AsyncState<T> {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<Omit<AsyncState<T>, "retry">>({
    data: null,
    error: null,
    loading: true,
  });
  // biome-ignore lint/correctness/useExhaustiveDependencies: deps are supplied by the caller; attempt is the explicit retry trigger
  useEffect(() => {
    void attempt;
    let cancelled = false;
    setState({ data: null, error: null, loading: true });
    fn().then(
      (data) => !cancelled && setState({ data, error: null, loading: false }),
      (err) => !cancelled && setState({ data: null, error: String(err), loading: false }),
    );
    return () => {
      cancelled = true;
    };
  }, [...deps, attempt]);
  return { ...state, retry: () => setAttempt((value) => value + 1) };
}
