import { useState } from "react";
import {
  api,
  type ConcurrencySummary,
  type DayRow,
  type ErrorWeekRow,
  type HeatCell,
  type ModelDayRow,
  type ScatterSession,
  type SidechainDayRow,
} from "../api.ts";
import { count, duration, usd } from "../format.ts";
import { link } from "../router.ts";
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

/* ——— Contribution calendar ——————————————————————————————————————————— */

const CAL_WEEKS = 53;

function calendarGrid(daily: DayRow[], metric: HeatMetric) {
  const byDay = new Map(daily.map((d) => [d.day, metric === "cost" ? d.cost : d.sessions]));
  const last = daily.length ? (daily[daily.length - 1]?.day as string) : "";
  if (!last) return { weeks: [] as { day: string; v: number }[][], max: 0, last };
  const end = new Date(`${last}T00:00:00Z`);
  // Pad the final column out to its Sunday, then walk back 53 whole weeks.
  end.setUTCDate(end.getUTCDate() + ((7 - ((end.getUTCDay() + 6) % 7) - 1) % 7));
  const weeks: { day: string; v: number }[][] = [];
  let max = 0;
  for (let w = CAL_WEEKS - 1; w >= 0; w--) {
    const col: { day: string; v: number }[] = [];
    for (let r = 6; r >= 0; r--) {
      const d = new Date(end);
      d.setUTCDate(d.getUTCDate() - w * 7 - r);
      const day = d.toISOString().slice(0, 10);
      const v = byDay.get(day) ?? 0;
      if (v > max) max = v;
      col.push({ day, v });
    }
    weeks.push(col);
  }
  return { weeks, max, last };
}

function Calendar({ daily, metric }: { daily: DayRow[]; metric: HeatMetric }) {
  const { weeks, max, last } = calendarGrid(daily, metric);
  if (weeks.length === 0) return <p className="muted">No dated sessions in the index.</p>;
  const cell = 11;
  const gap = 2;
  const W = weeks.length * (cell + gap);
  const H = 7 * (cell + gap);
  const first = weeks[0]?.[0]?.day;
  return (
    <>
      <svg className="calendar" viewBox={`0 0 ${W} ${H}`} role="img">
        <title>Daily activity calendar</title>
        {weeks.map((col, wi) =>
          col.map((c, ri) =>
            // The final column is padded out to Sunday; days after the newest
            // indexed day haven't happened and must not render as idle cells.
            c.day > last ? null : (
              <rect
                key={c.day}
                x={wi * (cell + gap)}
                y={ri * (cell + gap)}
                width={cell}
                height={cell}
                rx={2}
                className={c.v > 0 ? "cal-cell on" : "cal-cell"}
                style={c.v > 0 ? { opacity: 0.25 + 0.75 * Math.sqrt(c.v / (max || 1)) } : undefined}
              >
                <title>{`${c.day} — ${fmt(metric, c.v)}`}</title>
              </rect>
            ),
          ),
        )}
      </svg>
      <div className="axis">
        <span>{first}</span>
        <span>{last}</span>
      </div>
    </>
  );
}

/* ——— Model mix stacked area ————————————————————————————————————————— */

function fillDays(from: string, to: string): string[] {
  const out: string[] = [];
  const cur = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  while (cur <= end) {
    out.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out;
}

function ModelMix({ rows }: { rows: ModelDayRow[] }) {
  if (rows.length === 0) return <p className="muted">No dated model spend in the index.</p>;
  const totals = new Map<string, number>();
  for (const r of rows) totals.set(r.model, (totals.get(r.model) ?? 0) + r.cost);
  const models = [...totals.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] === "other" ? 1 : -1))
    .map(([m]) => m);
  const first = rows[0]?.day as string;
  const last = rows[rows.length - 1]?.day as string;
  const days = fillDays(first < last ? first : last, first < last ? last : first);
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
}

/* ——— Small line charts: error rate, sidechain share, concurrency ————— */

function LineChart({
  values,
  labels,
  format,
  height = 140,
}: {
  values: number[];
  labels: string[];
  format: (v: number) => string;
  height?: number;
}) {
  const W = 900;
  const H = height;
  const pad = 6;
  const max = Math.max(...values, 1e-9);
  const n = values.length;
  const x = (i: number) => (n <= 1 ? pad : (i / (n - 1)) * (W - pad * 2) + pad);
  const y = (v: number) => H - pad - (v / max) * (H - pad * 2);
  const line = values.map((v, i) => `${i === 0 ? "M" : "L"} ${x(i).toFixed(1)},${y(v).toFixed(1)}`);
  return (
    <>
      <svg className="burnchart" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img">
        <title>Series</title>
        <path className="burn-line" d={line.join(" ")} />
        {values.map((v, i) => (
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

function ErrorTrend({ rows }: { rows: ErrorWeekRow[] }) {
  if (rows.length === 0) return <p className="muted">No tool calls in the index.</p>;
  return (
    <LineChart
      values={rows.map((r) => r.errorRate * 100)}
      labels={rows.map((r) => `wk ${r.week} (${count(r.errors)}/${count(r.toolCalls)})`)}
      format={(v) => `${v.toFixed(1)}% errors`}
    />
  );
}

function SidechainTrend({ rows }: { rows: SidechainDayRow[] }) {
  const active = rows.filter((r) => r.totalCost > 0);
  if (active.length === 0 || !active.some((r) => r.sidechainCost > 0))
    return <p className="muted">No subagent (sidechain) spend recorded yet.</p>;
  // Weekly buckets keep the share line readable on long histories.
  const byWeek = new Map<string, { side: number; total: number }>();
  for (const r of active) {
    const d = new Date(`${r.day}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
    const wk = d.toISOString().slice(0, 10);
    const a = byWeek.get(wk) ?? { side: 0, total: 0 };
    a.side += r.sidechainCost;
    a.total += r.totalCost;
    byWeek.set(wk, a);
  }
  const weeks = [...byWeek.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  return (
    <LineChart
      values={weeks.map(([, v]) => (v.total > 0 ? (v.side / v.total) * 100 : 0))}
      labels={weeks.map(([wk, v]) => `wk ${wk} (${usd(v.side)} of ${usd(v.total)})`)}
      format={(v) => `${v.toFixed(1)}% of spend`}
    />
  );
}

function Concurrency({ summary }: { summary: ConcurrencySummary }) {
  if (summary.days.length === 0) return <p className="muted">No timed sessions in the index.</p>;
  return (
    <>
      <p className="muted">
        peak <strong>{summary.peak}</strong> sessions open at once ·{" "}
        {(summary.parallelDayShare * 100).toFixed(0)}% of active days ran ≥2 in parallel
      </p>
      <LineChart
        values={summary.days.map((d) => d.maxConcurrent)}
        labels={summary.days.map((d) => d.day)}
        format={(v) => `${v} concurrent`}
        height={100}
      />
    </>
  );
}

/* ——— Cost × duration scatter (efficiency frontier) ————————————————— */

type ScatterX = "wall" | "active";

function ScatterDot({ p, cx, cy }: { p: ScatterSession; cx: number; cy: number }) {
  return (
    <circle cx={cx} cy={cy} r={3.5} className="dot">
      <title>{`${p.title ?? p.sessionId ?? "?"}\n${usd(p.cost)} · ${duration(p.durationMs)} wall · ${duration(p.activeMs)} active · ${p.turns} turns`}</title>
    </circle>
  );
}

function Scatter({ points, xAxis }: { points: ScatterSession[]; xAxis: ScatterX }) {
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
}

export function Trends() {
  const { data, error, loading } = useAsync(() => api.trends(), []);
  const [burnMetric, setBurnMetric] = useState<BurnMetric>("cost");
  const [granularity, setGranularity] = useState<Granularity>("day");
  const [heatMetric, setHeatMetric] = useState<HeatMetric>("sessions");
  const [calMetric, setCalMetric] = useState<HeatMetric>("cost");
  const [scatterX, setScatterX] = useState<ScatterX>("wall");
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
          <h2>Calendar</h2>
          <span className="seg-group">
            metric <Seg options={["cost", "sessions"]} value={calMetric} onChange={setCalMetric} />
            <span className="muted"> · last {CAL_WEEKS} weeks</span>
          </span>
        </div>
        <Calendar daily={data.daily} metric={calMetric} />
      </section>

      <section className="trend-panel">
        <div className="trend-head">
          <h2>Model mix</h2>
          <span className="muted">daily spend per model — watch migrations happen</span>
        </div>
        <ModelMix rows={data.modelMix} />
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

      <section className="trend-panel">
        <div className="trend-head">
          <h2>Cost × duration</h2>
          <span className="seg-group">
            x-axis <Seg options={["wall", "active"]} value={scatterX} onChange={setScatterX} />
            <span className="muted"> · sqrt scales · click a dot to open the session</span>
          </span>
        </div>
        <Scatter points={data.scatter} xAxis={scatterX} />
      </section>

      <section className="trend-panel">
        <div className="trend-head">
          <h2>Tool error rate</h2>
          <span className="muted">per week, across all tools</span>
        </div>
        <ErrorTrend rows={data.errorWeekly} />
      </section>

      <section className="trend-panel">
        <div className="trend-head">
          <h2>Subagent share</h2>
          <span className="muted">sidechain spend as % of weekly total</span>
        </div>
        <SidechainTrend rows={data.sidechainDaily} />
      </section>

      <section className="trend-panel">
        <div className="trend-head">
          <h2>Parallel sessions</h2>
          <span className="muted">max sessions open at once, per day</span>
        </div>
        <Concurrency summary={data.concurrency} />
      </section>
    </>
  );
}
