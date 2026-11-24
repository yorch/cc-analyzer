import { useEffect, useState } from "react";

export interface AsyncState<T> {
  data: T | null;
  error: string | null;
  /** The rejection as caught, unstringified — lets a call site narrow it (e.g.
   *  `ambiguousProjectCandidates`) instead of pattern-matching `error` text. */
  errorCause: unknown;
  /** True only while there is nothing to show yet (first load). A refetch with
   *  data already on screen sets `refreshing` instead, so views don't blank. */
  loading: boolean;
  /** True while any fetch is in flight, including a revalidation. */
  refreshing: boolean;
  retry: () => void;
}

/** Minimal data-fetching hook: runs `fn` when `deps` change. Previous data is
 *  kept while the next fetch is in flight; the in-flight request is aborted
 *  when deps change or the component unmounts. */
export function useAsync<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  deps: unknown[],
): AsyncState<T> {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<Omit<AsyncState<T>, "retry" | "loading">>({
    data: null,
    error: null,
    errorCause: null,
    refreshing: true,
  });
  // biome-ignore lint/correctness/useExhaustiveDependencies: deps are supplied by the caller; attempt is the explicit retry trigger
  useEffect(() => {
    void attempt;
    const controller = new AbortController();
    setState((prev) => ({ ...prev, error: null, errorCause: null, refreshing: true }));
    fn(controller.signal).then(
      (data) => {
        if (controller.signal.aborted) return;
        setState({ data, error: null, errorCause: null, refreshing: false });
      },
      (err) => {
        if (controller.signal.aborted) return;
        setState({ data: null, error: String(err), errorCause: err, refreshing: false });
      },
    );
    return () => controller.abort();
  }, [...deps, attempt]);
  return {
    ...state,
    loading: state.refreshing && state.data === null,
    retry: () => setAttempt((value) => value + 1),
  };
}
