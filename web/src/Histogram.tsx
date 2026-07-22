import { count } from "./format.ts";

export interface HistogramRow {
  label: string;
  count: number;
}

/** Horizontal bar histogram normalized to the fullest bucket. */
export function Histogram({ rows }: { rows: HistogramRow[] }) {
  const max = Math.max(...rows.map((r) => r.count), 1);
  return (
    <div className="hist">
      {rows.map((r) => (
        <div className="hist-row" key={r.label}>
          <span className="hist-label">{r.label}</span>
          <div className="bar">
            <span style={{ width: `${(r.count / max) * 100}%` }} />
          </div>
          <span className="hist-count">{count(r.count)}</span>
        </div>
      ))}
    </div>
  );
}
