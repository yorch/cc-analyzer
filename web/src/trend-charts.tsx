/**
 * Chart building blocks shared by the Trends page and the per-project page:
 * the burn line/area chart (with metric + granularity controls), the model-mix
 * stacked area, and the cost×duration scatter. Series shapes come from core
 * `stats-types.ts`, so both pages chart the same numbers.
 */

import { type CSSProperties, memo } from "react";
import { EmptyNotice } from "./AsyncNotice.tsx";
import type { DayRow, ModelDayRow, ScatterSession } from "./api.ts";
import {
  type BurnMetric,
  bucketSeries,
  type Granularity,
  metricValue,
  shiftDay,
  weekOf,
} from "./api.ts";
import { count, duration, usd } from "./format.ts";
import { link, useHashParam } from "./router.ts";
import { Seg } from "./Seg.tsx";

export type { BurnMetric, Granularity };
export type HeatMetric = "sessions" | "cost";

/** Metric label: dollars for cost, compact counts for everything else. */
export const fmt = (m: string, v: number): string => (m === "cost" ? usd(v) : count(Math.round(v)));

/* ——— Shared SVG line-chart geometry ————————————————————————————————— */

/** One viewport for every wide chart in the SPA (`.burnchart` CSS). */
export const CHART_W = 900;
export const CHART_PAD = 6;
/** Long series would drown in hover dots; past this the path stands alone. */
export const MAX_LINE_DOTS = 366;

/**
 * The box a chart occupies. Every chart is `width: 100%`, so the element must
 * carry its viewBox's own ratio: a fixed CSS height against a differently
 * shaped viewBox scales x and y by different factors, which turns dots into
 * slivers and makes a chart's `height` argument meaningless. Paired with the
 * default `preserveAspectRatio` (never `none`), this keeps marks in shape and
 * makes taller viewBoxes actually render taller.
 */
export const chartBox = (w: number, h: number): CSSProperties => ({ aspectRatio: `${w} / ${h}` });

/**
 * The one y-scale affordance these charts get: a faint gridline at the top and
 * middle of the value scale, each labelled in the chart's own formatter. Not a
 * full axis — just enough to read a height off the page instead of hovering.
 */
export function YAxis({
  max,
  y,
  format,
  width = CHART_W,
  pad = CHART_PAD,
}: {
  max: number;
  y: (v: number) => number;
  format: (v: number) => string;
  width?: number;
  pad?: number;
}) {
  if (!(max > 0)) return null;
  const ticks = [
    { key: "max", value: max },
    { key: "mid", value: max / 2 },
  ];
  // No aria-hidden: the enclosing svg is role="img" with its own label, so
  // assistive tech never walks into these marks anyway.
  return (
    <g className="y-axis">
      {ticks.map((t) => (
        <g key={t.key}>
          <line className="y-grid" x1={pad} x2={width - pad} y1={y(t.value)} y2={y(t.value)} />
          <text className="y-tick" x={pad + 2} y={Math.max(y(t.value) - 3, 9)}>
            {format(t.value)}
          </text>
        </g>
      ))}
    </g>
  );
}

/** The tabular fallback every chart carries: exact values for keyboard, touch,
 *  and assistive-technology users, and the app's copy/export escape hatch. */
export function ChartData({
  labels,
  values,
  format = String,
  labelHeading = "Period",
  valueHeading = "Value",
}: {
  labels: string[];
  values: number[];
  format?: (value: number) => string;
  labelHeading?: string;
  valueHeading?: string;
}) {
  return (
    <details className="chart-data">
      <summary>View Chart Data</summary>
      <div className="tablewrap">
        <table>
          <thead>
            <tr>
              <th>{labelHeading}</th>
              <th className="num">{valueHeading}</th>
            </tr>
          </thead>
          <tbody>
            {labels.map((label, index) => (
              <tr key={label}>
                <td>{label}</td>
                <td className="num">{format(values[index] ?? 0)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

/** x position of point i out of n across a `width` viewport. */
export const xScale =
  (n: number, width = CHART_W, pad = CHART_PAD) =>
  (i: number): number =>
    n <= 1 ? pad : (i / (n - 1)) * (width - pad * 2) + pad;

/** SVG path ("M … L …") through every value. */
export function linePath(
  values: number[],
  x: (i: number) => number,
  y: (v: number) => number,
): string {
  return values
    .map((v, i) => `${i === 0 ? "M" : "L"} ${x(i).toFixed(1)},${y(v).toFixed(1)}`)
    .join(" ");
}

/** Close a line path down to the baseline, for area fills. */
export function areaPath(line: string, x: (i: number) => number, n: number, h: number): string {
  return `M ${x(0).toFixed(1)},${h} ${line.replace(/^M/, "L")} L ${x(n - 1).toFixed(1)},${h} Z`;
}

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
  const H = height;
  const max = Math.max(...values, 1e-9);
  const n = values.length;
  const x = xScale(n);
  const y = (v: number) => H - CHART_PAD - (v / max) * (H - CHART_PAD * 2);
  const line = linePath(values, x, y);
  const tick = format ?? ((v: number) => count(Math.round(v)));
  return (
    <>
      <svg
        className="burnchart"
        viewBox={`0 0 ${CHART_W} ${H}`}
        style={chartBox(CHART_W, H)}
        role="img"
        aria-label={`${title} line chart with ${values.length} points, peak ${tick(max)}`}
      >
        <title>{title}</title>
        <YAxis max={max} y={y} format={tick} />
        {area && <path className="burn-area" d={areaPath(line, x, n, H)} />}
        <path className="burn-line" d={line} />
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
      <ChartData labels={labels} values={values} format={format} />
    </>
  );
}

/* ——— Burn panel (owns its metric/granularity controls) ———————————————— */

export const BurnPanel = memo(function BurnPanel({ daily }: { daily: DayRow[] }) {
  const metrics = ["cost", "tokens", "sessions"] as const;
  const granularities = ["day", "week", "month"] as const;
  const [metric, setMetric] = useHashParam<BurnMetric>("burn", "cost", metrics);
  const [granularity, setGranularity] = useHashParam<Granularity>("by", "day", granularities);
  const series = bucketSeries(daily, granularity);
  const values = series.map((p) => metricValue(p, metric));
  const total = values.reduce((s, v) => s + v, 0);
  const peakIdx = values.reduce((b, v, i) => (v > (values[b] ?? -1) ? i : b), 0);
  const avg = values.length ? total / values.length : 0;
  return (
    <>
      <div className="trend-head">
        <h2>Burn</h2>
        <span className="seg-group">
          metric{" "}
          <Seg
            label="Burn metric"
            options={["cost", "tokens", "sessions"]}
            value={metric}
            onChange={setMetric}
          />
          <span className="seg-gap" />
          by{" "}
          <Seg
            label="Granularity"
            options={["day", "week", "month"]}
            value={granularity}
            onChange={setGranularity}
          />
        </span>
      </div>
      {series.length === 0 ? (
        <EmptyNotice>No dated sessions in the index.</EmptyNotice>
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
});

/* ——— Model mix stacked area ————————————————————————————————————————— */

/** Every day from `from` to `to` inclusive (rows arrive sorted ascending). */
function fillDays(from: string, to: string): string[] {
  const out: string[] = [];
  for (let day = from; day <= to; day = shiftDay(day, 1)) out.push(day);
  return out;
}

/** Distinct band colors (`mix-0`…`mix-6`). Past this the tail folds into one
 *  "other" band — reusing a color would make two bands claim one swatch. */
const MAX_MIX_BANDS = 7;
/** Past this many days the tabular fallback buckets by ISO week; a two-year
 *  daily table is data, not a reading. */
const MIX_TABLE_MAX_DAYS = 92;

export const ModelMix = memo(function ModelMix({ rows }: { rows: ModelDayRow[] }) {
  const first = rows[0];
  const last = rows[rows.length - 1];
  if (!first || !last) return <EmptyNotice>No dated model spend in the index.</EmptyNotice>;
  const modelTotals = new Map<string, number>();
  for (const r of rows) modelTotals.set(r.model, (modelTotals.get(r.model) ?? 0) + r.cost);
  const ranked = [...modelTotals.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] === "other" ? 1 : -1))
    .map(([m]) => m);
  // Keep the top N-1 as themselves and fold the tail into one labelled band, so
  // every band on screen owns exactly one color.
  const folded = ranked.length > MAX_MIX_BANDS ? ranked.slice(MAX_MIX_BANDS - 1) : [];
  const otherLabel = folded.length > 0 ? `other (${folded.length} models)` : null;
  const foldedSet = new Set(folded);
  const bandOf = (model: string) => (foldedSet.has(model) ? (otherLabel as string) : model);
  const models = otherLabel ? [...ranked.slice(0, MAX_MIX_BANDS - 1), otherLabel] : [...ranked];
  const totals = new Map<string, number>();
  for (const [model, cost] of modelTotals) {
    const band = bandOf(model);
    totals.set(band, (totals.get(band) ?? 0) + cost);
  }
  const grandTotal = [...totals.values()].reduce((s, v) => s + v, 0);
  const days = fillDays(first.day, last.day);
  const byDay = new Map<string, Map<string, number>>();
  for (const r of rows) {
    let m = byDay.get(r.day);
    if (!m) {
      m = new Map();
      byDay.set(r.day, m);
    }
    const band = bandOf(r.model);
    m.set(band, (m.get(band) ?? 0) + r.cost);
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
    return { model, path: `${fwd.join(" ")} ${back} Z`, cls: `mix-${mi}` };
  });
  const share = (v: number) => (grandTotal > 0 ? `${((v / grandTotal) * 100).toFixed(0)}%` : "—");
  return (
    <>
      <svg
        className="burnchart"
        viewBox={`0 0 ${W} ${H}`}
        style={chartBox(W, H)}
        role="img"
        aria-label={`Daily model spend as a stacked area chart across ${bands.length} models`}
      >
        <title>Spend per model over time</title>
        <YAxis max={maxTotal} y={y} format={usd} width={W} pad={pad} />
        {bands.map((b) => (
          <path key={b.model} className={`mix-band ${b.cls}`} d={b.path}>
            <title>{`${b.model} — ${usd(totals.get(b.model) ?? 0)} total · ${share(
              totals.get(b.model) ?? 0,
            )} of ${usd(grandTotal)}`}</title>
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
            {b.model} · {usd(totals.get(b.model) ?? 0)} · {share(totals.get(b.model) ?? 0)}
          </span>
        ))}
      </div>
      {otherLabel && (
        <p className="muted spark-cap">
          “{otherLabel}” folds {folded.join(", ")}.
        </p>
      )}
      <ModelMixTable bands={models} days={days} byDay={byDay} />
    </>
  );
});

/** The model mix's tabular fallback: the daily series the bands are built from,
 *  bucketed by ISO week once a daily table stops being readable. */
function ModelMixTable({
  bands,
  days,
  byDay,
}: {
  bands: string[];
  days: string[];
  byDay: Map<string, Map<string, number>>;
}) {
  const bucketed = days.length > MIX_TABLE_MAX_DAYS;
  const periods = new Map<string, Map<string, number>>();
  for (const day of days) {
    const key = bucketed ? `wk ${weekOf(day)}` : day;
    let into = periods.get(key);
    if (!into) {
      into = new Map<string, number>();
      periods.set(key, into);
    }
    for (const [band, cost] of byDay.get(day) ?? []) into.set(band, (into.get(band) ?? 0) + cost);
  }
  const entries = [...periods.entries()].filter(([, m]) => [...m.values()].some((v) => v > 0));
  return (
    <details className="chart-data">
      <summary>View Chart Data</summary>
      <p className="muted spark-cap">
        {bucketed ? "bucketed by ISO week" : "one row per day"} · {entries.length} periods · dollars
        per model
      </p>
      <div className="tablewrap">
        <table>
          <thead>
            <tr>
              <th>Period</th>
              {bands.map((b) => (
                <th key={b} className="num">
                  {b}
                </th>
              ))}
              <th className="num">Total</th>
            </tr>
          </thead>
          <tbody>
            {entries.map(([key, m]) => (
              <tr key={key}>
                <td>{key}</td>
                {bands.map((b) => (
                  <td key={b} className="num">
                    {usd(m.get(b) ?? 0)}
                  </td>
                ))}
                <td className="num">{usd(bands.reduce((s, b) => s + (m.get(b) ?? 0), 0))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

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
  if (usable.length === 0) return <EmptyNotice>No timed, costed sessions yet.</EmptyNotice>;
  const W = 900;
  const H = 260;
  const pad = 10;
  const xv = (p: ScatterSession) => (xAxis === "wall" ? p.durationMs : p.activeMs);
  const maxX = Math.max(...usable.map(xv), 1);
  const maxY = Math.max(...usable.map((p) => p.cost), 1e-9);
  // sqrt scales keep the dense cheap-and-short corner readable.
  const x = (p: ScatterSession) => pad + Math.sqrt(xv(p) / maxX) * (W - pad * 2);
  const y = (p: ScatterSession) => H - pad - Math.sqrt(p.cost / maxY) * (H - pad * 2);
  // The y grid is drawn on the same sqrt scale the dots sit on, so a labelled
  // line means what it says.
  const yOf = (v: number) => H - pad - Math.sqrt(v / maxY) * (H - pad * 2);
  return (
    <>
      <svg
        className="scatter"
        viewBox={`0 0 ${W} ${H}`}
        style={chartBox(W, H)}
        role="img"
        aria-label={`Session cost by ${xAxis === "wall" ? "wall time" : "active time"} scatter plot`}
      >
        <title>Session cost vs duration</title>
        <YAxis max={maxY} y={yOf} format={usd} width={W} pad={pad} />
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
      <details className="chart-data">
        <summary>View Session Data</summary>
        <div className="tablewrap">
          <table>
            <thead>
              <tr>
                <th>Session</th>
                <th className="num">Cost</th>
                <th className="num">Wall</th>
                <th className="num">Active</th>
              </tr>
            </thead>
            <tbody>
              {usable.map((point) => (
                <tr
                  key={`${point.sessionId ?? point.title ?? "session"}-${point.durationMs}-${point.cost}`}
                >
                  <td>
                    {point.sessionId ? (
                      <a href={link.session(point.sessionId)}>{point.title ?? point.sessionId}</a>
                    ) : (
                      (point.title ?? "(untitled)")
                    )}
                  </td>
                  <td className="num">{usd(point.cost)}</td>
                  <td className="num">{duration(point.durationMs)}</td>
                  <td className="num">{duration(point.activeMs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </>
  );
});

/** Scatter with its own x-axis toggle and section head. */
export const ScatterPanel = memo(function ScatterPanel({ points }: { points: ScatterSession[] }) {
  const axes = ["wall", "active"] as const;
  const [xAxis, setXAxis] = useHashParam<ScatterX>("scatter", "wall", axes);
  return (
    <>
      <div className="trend-head">
        <h2>Cost × duration</h2>
        <span className="seg-group">
          x-axis{" "}
          <Seg
            label="Scatter x-axis"
            options={["wall", "active"]}
            value={xAxis}
            onChange={setXAxis}
          />
          <span className="muted"> · sqrt scales · click a dot to open the session</span>
        </span>
      </div>
      <Scatter points={points} xAxis={xAxis} />
    </>
  );
});
