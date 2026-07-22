/**
 * Chart building blocks shared by the Trends page and the per-project page:
 * the burn line/area chart (with metric + granularity controls), the model-mix
 * stacked area, and the cost×duration scatter. Series shapes come from core
 * `stats-types.ts`, so both pages chart the same numbers.
 */

import { memo, useState } from "react";
import type { DayRow, ModelDayRow, ScatterSession } from "./api.ts";
import { shiftDay, weekOf } from "./api.ts";
import { count, duration, usd } from "./format.ts";
import { link } from "./router.ts";
import { Seg } from "./Seg.tsx";

export type BurnMetric = "cost" | "tokens" | "sessions";
export type Granularity = "day" | "week" | "month";
export type HeatMetric = "sessions" | "cost";

export interface Point {
  label: string;
  cost: number;
  sessions: number;
  ioTokens: number;
  cacheTokens: number;
}

export function bucketSeries(daily: DayRow[], granularity: Granularity): Point[] {
  if (granularity === "day") return daily.map((d) => ({ ...d, label: d.day }));
  const out: Point[] = [];
  let curKey = "";
  for (const d of daily) {
    const key = granularity === "month" ? d.day.slice(0, 7) : weekOf(d.day);
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

export const seriesValue = (p: Point, m: BurnMetric): number =>
  m === "cost" ? p.cost : m === "sessions" ? p.sessions : p.ioTokens + p.cacheTokens;

export const fmt = (m: BurnMetric | HeatMetric, v: number): string =>
  m === "cost" ? usd(v) : count(Math.round(v));

/* ——— Line chart ————————————————————————————————————————————————————— */

/** Long series would drown in hover dots; past this the path stands alone. */
const MAX_LINE_DOTS = 366;

export function LineChart({
  values,
  labels,
  format,
  height = 140,
  area = false,
  title = "Series",
}: {
  values: number[];
  labels: string[];
  format?: (v: number) => string;
  height?: number;
  area?: boolean;
  title?: string;
}) {
  const W = 900;
  const H = height;
  const pad = 6;
  const max = Math.max(...values, 1e-9);
  const n = values.length;
  const x = (i: number) => (n <= 1 ? pad : (i / (n - 1)) * (W - pad * 2) + pad);
  const y = (v: number) => H - pad - (v / max) * (H - pad * 2);
  const line = values.map((v, i) => `${i === 0 ? "M" : "L"} ${x(i).toFixed(1)},${y(v).toFixed(1)}`);
  const areaPath = area
    ? `M ${x(0).toFixed(1)},${H} ${line.join(" ").replace(/^M/, "L")} L ${x(n - 1).toFixed(1)},${H} Z`
    : undefined;
  return (
    <>
      <svg className="burnchart" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img">
        <title>{title}</title>
        {areaPath && <path className="burn-area" d={areaPath} />}
        <path className="burn-line" d={line.join(" ")} />
        {format &&
          n <= MAX_LINE_DOTS &&
          values.map((v, i) => (
            <circle key={labels[i]} cx={x(i)} cy={y(v)} r={5} className="dot">
              <title>{`${labels[i]} — ${format(v)}`}</title>
            </circle>
          ))}
      </svg>
      <div className="axis">
        <span>{labels[0]}</span>
        <span>{labels[n - 1]}</span>
      </div>
    </>
  );
}

/* ——— Burn panel (owns its metric/granularity controls) ———————————————— */

export function BurnPanel({ daily }: { daily: DayRow[] }) {
  const [metric, setMetric] = useState<BurnMetric>("cost");
  const [granularity, setGranularity] = useState<Granularity>("day");
  const series = bucketSeries(daily, granularity);
  const values = series.map((p) => seriesValue(p, metric));
  const total = values.reduce((s, v) => s + v, 0);
  const peakIdx = values.reduce((b, v, i) => (v > (values[b] ?? -1) ? i : b), 0);
  const avg = values.length ? total / values.length : 0;
  return (
    <>
      <div className="trend-head">
        <h2>Burn</h2>
        <span className="seg-group">
          metric{" "}
          <Seg options={["cost", "tokens", "sessions"]} value={metric} onChange={setMetric} />
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
            {fmt(metric, total)} total · peak {fmt(metric, values[peakIdx] ?? 0)} (
            {series[peakIdx]?.label}) · {fmt(metric, avg)}/{granularity} avg
          </p>
          <LineChart
            values={values}
            labels={series.map((p) => p.label)}
            format={(v) => fmt(metric, v)}
            height={220}
            area
            title="Spend over time"
          />
        </>
      )}
    </>
  );
}

/* ——— Model mix stacked area ————————————————————————————————————————— */

/** Every day from `from` to `to` inclusive (rows arrive sorted ascending). */
function fillDays(from: string, to: string): string[] {
  const out: string[] = [];
  for (let day = from; day <= to; day = shiftDay(day, 1)) out.push(day);
  return out;
}

export const ModelMix = memo(function ModelMix({ rows }: { rows: ModelDayRow[] }) {
  const first = rows[0];
  const last = rows[rows.length - 1];
  if (!first || !last) return <p className="muted">No dated model spend in the index.</p>;
  const totals = new Map<string, number>();
  for (const r of rows) totals.set(r.model, (totals.get(r.model) ?? 0) + r.cost);
  const models = [...totals.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] === "other" ? 1 : -1))
    .map(([m]) => m);
  const days = fillDays(first.day, last.day);
  const byDay = new Map<string, Map<string, number>>();
  for (const r of rows) {
    let m = byDay.get(r.day);
    if (!m) {
      m = new Map();
      byDay.set(r.day, m);
    }
    m.set(r.model, (m.get(r.model) ?? 0) + r.cost);
  }
  const W = 900;
  const H = 220;
  const pad = 6;
  const maxTotal = Math.max(
    ...days.map((d) => models.reduce((s, m) => s + (byDay.get(d)?.get(m) ?? 0), 0)),
    1e-9,
  );
  const x = (i: number) => (days.length <= 1 ? pad : (i / (days.length - 1)) * (W - pad * 2) + pad);
  const y = (v: number) => H - pad - (v / maxTotal) * (H - pad * 2);
  // Cumulative tops per band: band k fills between top(k-1) and top(k).
  const cum = days.map(() => 0);
  const bands = models.map((model, mi) => {
    const lower = [...cum];
    days.forEach((d, i) => {
      cum[i] = (cum[i] ?? 0) + (byDay.get(d)?.get(model) ?? 0);
    });
    const upper = [...cum];
    const fwd = upper.map((v, i) => `${i === 0 ? "M" : "L"} ${x(i).toFixed(1)},${y(v).toFixed(1)}`);
    const back = lower
      .map((v, i) => `L ${x(i).toFixed(1)},${y(v).toFixed(1)}`)
      .reverse()
      .join(" ");
    return { model, path: `${fwd.join(" ")} ${back} Z`, cls: `mix-${mi % 7}` };
  });
  return (
    <>
      <svg className="burnchart" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img">
        <title>Spend per model over time</title>
        {bands.map((b) => (
          <path key={b.model} className={`mix-band ${b.cls}`} d={b.path}>
            <title>{b.model}</title>
          </path>
        ))}
      </svg>
      <div className="axis">
        <span>{days[0]}</span>
        <span>{days[days.length - 1]}</span>
      </div>
      <div className="legend">
        {bands.map((b) => (
          <span key={b.model} className="legend-item">
            <span className={`legend-swatch ${b.cls}`} />
            {b.model} · {usd(totals.get(b.model) ?? 0)}
          </span>
        ))}
      </div>
    </>
  );
});

/* ——— Cost × duration scatter (efficiency frontier) ————————————————— */

export type ScatterX = "wall" | "active";

function ScatterDot({ p, cx, cy }: { p: ScatterSession; cx: number; cy: number }) {
  return (
    <circle cx={cx} cy={cy} r={3.5} className="dot">
      <title>{`${p.title ?? p.sessionId ?? "?"}\n${usd(p.cost)} · ${duration(p.durationMs)} wall · ${duration(p.activeMs)} active · ${p.turns} turns`}</title>
    </circle>
  );
}

export const Scatter = memo(function Scatter({
  points,
  xAxis,
}: {
  points: ScatterSession[];
  xAxis: ScatterX;
}) {
  const usable = points.filter((p) => p.cost > 0);
  if (usable.length === 0) return <p className="muted">No timed, costed sessions yet.</p>;
  const W = 900;
  const H = 260;
  const pad = 10;
  const xv = (p: ScatterSession) => (xAxis === "wall" ? p.durationMs : p.activeMs);
  const maxX = Math.max(...usable.map(xv), 1);
  const maxY = Math.max(...usable.map((p) => p.cost), 1e-9);
  // sqrt scales keep the dense cheap-and-short corner readable.
  const x = (p: ScatterSession) => pad + Math.sqrt(xv(p) / maxX) * (W - pad * 2);
  const y = (p: ScatterSession) => H - pad - Math.sqrt(p.cost / maxY) * (H - pad * 2);
  return (
    <>
      <svg className="scatter" viewBox={`0 0 ${W} ${H}`} role="img">
        <title>Session cost vs duration</title>
        {usable.map((p) =>
          p.sessionId ? (
            <a key={`${p.sessionId}-${p.durationMs}-${p.cost}`} href={link.session(p.sessionId)}>
              <ScatterDot p={p} cx={x(p)} cy={y(p)} />
            </a>
          ) : (
            <ScatterDot key={`?-${p.durationMs}-${p.cost}`} p={p} cx={x(p)} cy={y(p)} />
          ),
        )}
      </svg>
      <div className="axis">
        <span>0</span>
        <span>
          {xAxis} time → {duration(maxX)}
        </span>
      </div>
    </>
  );
});

/** Scatter with its own x-axis toggle and section head. */
export function ScatterPanel({ points }: { points: ScatterSession[] }) {
  const [xAxis, setXAxis] = useState<ScatterX>("wall");
  return (
    <>
      <div className="trend-head">
        <h2>Cost × duration</h2>
        <span className="seg-group">
          x-axis <Seg options={["wall", "active"]} value={xAxis} onChange={setXAxis} />
          <span className="muted"> · sqrt scales · click a dot to open the session</span>
        </span>
      </div>
      <Scatter points={points} xAxis={xAxis} />
    </>
  );
}
