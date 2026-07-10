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
}

function compare(a: number | string, b: number | string): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b), undefined, { sensitivity: "base" });
}

/**
 * Client-side sort state for a list: cycle through `fields` (Tab) and flip the
 * direction (shift-Tab). The parent applies `sorted()` to its items before
 * handing them to FilterableList.
 */
export function useSort<T>(fields: SortField<T>[]): Sort<T> {
  const [idx, setIdx] = useState(0);
  const [dir, setDir] = useState<1 | -1>(-1); // descending default (cost/recent/tokens)
  const field = fields[idx] ?? fields[0];
  if (!field) throw new Error("useSort requires at least one field");

  return {
    sorted: (items) => [...items].sort((a, b) => compare(field.value(a), field.value(b)) * dir),
    cycle: () => setIdx((i) => (i + 1) % fields.length),
    reverse: () => setDir((d) => (d === 1 ? -1 : 1)),
    label: `${field.label} ${dir === -1 ? "↓" : "↑"}`,
  };
}
