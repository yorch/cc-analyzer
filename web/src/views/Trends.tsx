import { useState } from "react";
import { api, type DayRow, type HeatCell } from "../api.ts";
import { count, usd } from "../format.ts";
import { useAsync } from "../useAsync.ts";

type BurnMetric = "cost" | "tokens" | "sessions";
type Granularity = "day" | "week" | "month";
type HeatMetric = "sessions" | "cost";

const WEEKDAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0]; // strftime %w, Monday first

interface Point {
  label: string;
  cost: number;
  sessions: number;
  ioTokens: number;
  cacheTokens: number;
}

function weekKey(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); // back to Monday
  return d.toISOString().slice(0, 10);
}

function bucketSeries(daily: DayRow[], granularity: Granularity): Point[] {
  if (granularity === "day") return daily.map((d) => ({ ...d, label: d.day }));
  const out: Point[] = [];
  let curKey = "";
  for (const d of daily) {
    const key = granularity === "month" ? d.day.slice(0, 7) : weekKey(d.day);
    let p = out[out.length - 1];
    if (!p || key !== curKey) {
      p = { label: key, cost: 0, sessions: 0, ioTokens: 0, cacheTokens: 0 };
      out.push(p);
      curKey = key;
    }
    p.cost += d.cost;
    p.sessions += d.sessions;
    p.ioTokens += d.ioTokens;
    p.cacheTokens += d.cacheTokens;
  }
  return out;
}

const seriesValue = (p: Point, m: BurnMetric): number =>
  m === "cost" ? p.cost : m === "sessions" ? p.sessions : p.ioTokens + p.cacheTokens;

const fmt = (m: BurnMetric | HeatMetric, v: number): string =>
  m === "cost" ? usd(v) : count(Math.round(v));

function Seg<T extends string>({
  options,
  value,
  onChange,
}: {
  options: readonly T[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <span className="seg">
      {options.map((o) => (
        <button
          type="button"
          key={o}
          className={o === value ? "active" : ""}
          onClick={() => onChange(o)}
        >
          {o}
        </button>
      ))}
    </span>
  );
}

function BurnChart({ series, metric }: { series: Point[]; metric: BurnMetric }) {
  const values = series.map((p) => seriesValue(p, metric));
  const W = 900;
  const H = 220;
  const pad = 6;
  const max = Math.max(...values, 1e-9);
  const n = values.length;
  const x = (i: number) => (n <= 1 ? pad : (i / (n - 1)) * (W - pad * 2) + pad);
  const y = (v: number) => H - pad - (v / max) * (H - pad * 2);
  const line = values.map((v, i) => `${i === 0 ? "M" : "L"} ${x(i).toFixed(1)},${y(v).toFixed(1)}`);
  const area = `M ${x(0).toFixed(1)},${H} ${line.join(" ").replace(/^M/, "L")} L ${x(n - 1).toFixed(1)},${H} Z`;
  return (
    <svg className="burnchart" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img">
      <title>Spend over time</title>
      <path className="burn-area" d={area} />
      <path className="burn-line" d={line.join(" ")} />
    </svg>
  );
}

function Heatmap({ cells, metric }: { cells: HeatCell[]; metric: HeatMetric }) {
  const grid = WEEKDAY_ORDER.map(() => new Array<number>(24).fill(0));
  for (const c of cells) {
    const ri = WEEKDAY_ORDER.indexOf(c.weekday);
    if (ri >= 0 && c.hour >= 0 && c.hour < 24) {
      (grid[ri] as number[])[c.hour] = metric === "cost" ? c.cost : c.sessions;
    }
  }
  const max = Math.max(...grid.flat(), 1e-9);
  return (
    <div className="heatmap">
      <div className="heat-row heat-axis">
        <span className="heat-label" />
        {Array.from({ length: 24 }, (_, h) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed 24-hour columns
          <span key={h} className="heat-hour">
            {h % 6 === 0 ? `${h}` : ""}
          </span>
        ))}
      </div>
      {grid.map((row, ri) => (
        <div className="heat-row" key={WEEKDAY_LABELS[ri]}>
          <span className="heat-label">{WEEKDAY_LABELS[ri]}</span>
          {row.map((v, h) => (
            <span
              // biome-ignore lint/suspicious/noArrayIndexKey: fixed 24-hour columns
              key={h}
              className="heat-cell"
              style={{ opacity: v > 0 ? 0.12 + 0.88 * (v / max) : 0 }}
              title={`${WEEKDAY_LABELS[ri]} ${h}:00 — ${fmt(metric, v)}`}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

export function Trends() {
  const { data, error, loading } = useAsync(() => api.trends(), []);
  const [burnMetric, setBurnMetric] = useState<BurnMetric>("cost");
  const [granularity, setGranularity] = useState<Granularity>("day");
  const [heatMetric, setHeatMetric] = useState<HeatMetric>("sessions");
  if (loading) return <div className="loading">Loading trends…</div>;
  if (error) return <div className="loading err">Error: {error}</div>;
  if (!data) return null;

  const series = bucketSeries(data.daily, granularity);
  const values = series.map((p) => seriesValue(p, burnMetric));
  const total = values.reduce((s, v) => s + v, 0);
  const peakIdx = values.reduce((b, v, i) => (v > (values[b] ?? -1) ? i : b), 0);
  const avg = values.length ? total / values.length : 0;

  return (
    <>
      <header className="top">
        <h1>Trends</h1>
        <span className="muted">spend over time and when you work</span>
      </header>

      <section className="trend-panel">
        <div className="trend-head">
          <h2>Burn</h2>
          <span className="seg-group">
            metric{" "}
            <Seg
              options={["cost", "tokens", "sessions"]}
              value={burnMetric}
              onChange={setBurnMetric}
            />
            <span className="seg-gap" />
            by{" "}
            <Seg options={["day", "week", "month"]} value={granularity} onChange={setGranularity} />
          </span>
        </div>
        {series.length === 0 ? (
          <p className="muted">No dated sessions in the index.</p>
        ) : (
          <>
            <p className="muted">
              {fmt(burnMetric, total)} total · peak {fmt(burnMetric, values[peakIdx] ?? 0)} (
              {series[peakIdx]?.label}) · {fmt(burnMetric, avg)}/{granularity} avg
            </p>
            <BurnChart series={series} metric={burnMetric} />
            <div className="axis">
              <span>{series[0]?.label}</span>
              <span>{series[series.length - 1]?.label}</span>
            </div>
          </>
        )}
      </section>

      <section className="trend-panel">
        <div className="trend-head">
          <h2>Activity heatmap</h2>
          <span className="seg-group">
            metric{" "}
            <Seg options={["sessions", "cost"]} value={heatMetric} onChange={setHeatMetric} />
            <span className="muted"> · local time</span>
          </span>
        </div>
        {data.heatmap.length === 0 ? (
          <p className="muted">No dated sessions in the index.</p>
        ) : (
          <Heatmap cells={data.heatmap} metric={heatMetric} />
        )}
      </section>
    </>
  );
}
