// DOM-free so the root (Bun) typecheck and tests can import it, like theme.ts.

/** Pure read of one hash-query param: the value when present and permitted,
 *  otherwise the fallback. Split from the hook so it is testable without a DOM. */
export function resolveHashParam<T extends string>(
  hash: string,
  key: string,
  fallback: T,
  allowed?: readonly T[],
): T {
  const value = new URLSearchParams(hash.split("?")[1] ?? "").get(key) as T | null;
  return value && (!allowed || allowed.includes(value)) ? value : fallback;
}
