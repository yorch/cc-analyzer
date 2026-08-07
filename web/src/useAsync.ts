import { useEffect, useState } from "react";

export interface AsyncState<T> {
  data: T | null;
  error: string | null;
  /** The rejection as caught, unstringified — lets a call site narrow it (e.g.
   *  `ambiguousProjectCandidates`) instead of pattern-matching `error` text. */
  errorCause: unknown;
  loading: boolean;
  retry: () => void;
}

/** Minimal data-fetching hook: runs `fn` when `deps` change. */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]): AsyncState<T> {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<Omit<AsyncState<T>, "retry">>({
    data: null,
    error: null,
    errorCause: null,
    loading: true,
  });
  // biome-ignore lint/correctness/useExhaustiveDependencies: deps are supplied by the caller; attempt is the explicit retry trigger
  useEffect(() => {
    void attempt;
    let cancelled = false;
    setState({ data: null, error: null, errorCause: null, loading: true });
    fn().then(
      (data) => !cancelled && setState({ data, error: null, errorCause: null, loading: false }),
      (err) =>
        !cancelled && setState({ data: null, error: String(err), errorCause: err, loading: false }),
    );
    return () => {
      cancelled = true;
    };
  }, [...deps, attempt]);
  return { ...state, retry: () => setAttempt((value) => value + 1) };
}
