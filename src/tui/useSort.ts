import { useState } from "react";

export interface SortField<T> {
  /** Stable key (unused for logic, handy for tests/debugging). */
  key: string;
  /** Short label shown in the list header. */
  label: string;
  /** Value to order by; numbers sort numerically, strings case-insensitively. */
  value: (item: T) => number | string;
}

export interface Sort<T> {
  sorted: (items: T[]) => T[];
  cycle: () => void;
  reverse: () => void;
  /** e.g. "cost ↓" for the header indicator. */
  label: string;
  /** The active field's `key`, and its direction (1 asc / -1 desc). Exposed so
   * a screen can react to *which* order it is in — e.g. a cumulative-share
   * column reads as a Pareto only while the list is ranked descending by the
   * column it accumulates. Parsing `label` for that would be a string trap. */
  key: string;
  dir: 1 | -1;
}

function compare(a: number | string, b: number | string): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b), undefined, { sensitivity: "base" });
}

/**
 * Client-side sort state for a list: cycle through `fields` (Tab) and flip the
 * direction (shift-Tab). The parent applies `sorted()` to its items before
 * handing them to FilterableList.
 *
 * `initialDir` defaults to descending, which is what a ranked list wants
 * (cost/recent/tokens). A list whose first field is an ordinal — a session's
 * turns, read as a narrative — passes 1 so it opens in its natural order.
 */
export function useSort<T>(fields: SortField<T>[], initialDir: 1 | -1 = -1): Sort<T> {
  const [idx, setIdx] = useState(0);
  const [dir, setDir] = useState<1 | -1>(initialDir);
  const field = fields[idx] ?? fields[0];
  if (!field) throw new Error("useSort requires at least one field");

  return {
    sorted: (items) => [...items].sort((a, b) => compare(field.value(a), field.value(b)) * dir),
    cycle: () => setIdx((i) => (i + 1) % fields.length),
    reverse: () => setDir((d) => (d === 1 ? -1 : 1)),
    label: `${field.label} ${dir === -1 ? "↓" : "↑"}`,
    key: field.key,
    dir,
  };
}
