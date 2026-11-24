import { maxOf } from "./extent.ts";
import { count } from "./format.ts";
import { MiniBar } from "./MiniBar.tsx";

export interface HistogramRow {
  label: string;
  count: number;
}

/** Horizontal bar histogram normalized to the fullest bucket. */
export function Histogram({ rows }: { rows: HistogramRow[] }) {
  const max = maxOf(
    rows.map((r) => r.count),
    1,
  );
  return (
    <div className="hist">
      {rows.map((r) => (
        <div className="hist-row" key={r.label}>
          <span className="hist-label">{r.label}</span>
          <MiniBar value={r.count} max={max} />
          <span className="hist-count">{count(r.count)}</span>
        </div>
      ))}
    </div>
  );
}
