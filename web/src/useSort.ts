import { useState } from "react";

export type SortDir = "asc" | "desc";
export type Accessors<T> = Record<string, (t: T) => number | string>;

export interface Sort<T> {
  sorted: T[];
  key: string;
  dir: SortDir;
  toggle: (key: string) => void;
}

function compare(a: number | string, b: number | string): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b), undefined, { sensitivity: "base" });
}

/**
 * Client-side table sort. Clicking a column header sorts by it (descending
 * first); clicking the active column again flips direction.
 */
export function useSort<T>(
  rows: T[],
  accessors: Accessors<T>,
  initialKey: string,
  initialDir: SortDir = "desc",
): Sort<T> {
  const [key, setKey] = useState(initialKey);
  const [dir, setDir] = useState<SortDir>(initialDir);
  const accessor = accessors[key] ?? accessors[initialKey];
  const sorted = accessor
    ? [...rows].sort((a, b) => compare(accessor(a), accessor(b)) * (dir === "asc" ? 1 : -1))
    : rows;
  const toggle = (k: string) => {
    if (k === key) setDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setKey(k);
      setDir("desc");
    }
  };
  return { sorted, key, dir, toggle };
}
