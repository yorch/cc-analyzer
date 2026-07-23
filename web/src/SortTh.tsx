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
      aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}
    >
      <button type="button" className="sort-button" onClick={() => sort.toggle(col)}>
        {label}
        <span aria-hidden="true">{arrow}</span>
        <span className="sr-only">
          {active
            ? `, sorted ${sort.dir === "asc" ? "ascending" : "descending"}`
            : ", activate to sort"}
        </span>
      </button>
    </th>
  );
}
