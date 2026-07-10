import type { Sort } from "./useSort.ts";

/** A clickable table header that drives a useSort() instance. */
export function SortTh<T>({
  label,
  col,
  sort,
  className,
}: {
  label: string;
  col: string;
  sort: Sort<T>;
  className?: string;
}) {
  const active = sort.key === col;
  const arrow = active ? (sort.dir === "asc" ? " ▲" : " ▼") : "";
  return (
    <th
      className={className}
      onClick={() => sort.toggle(col)}
      aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : undefined}
      style={{ cursor: "pointer", userSelect: "none" }}
    >
      {label}
      {arrow}
    </th>
  );
}
