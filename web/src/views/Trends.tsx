import { memo } from "react";
import { EmptyNotice, ErrorNotice, LoadingNotice } from "../AsyncNotice.tsx";
import {
  api,
  type ConcurrencyDayRow,
  type ConcurrencySummary,
  calendarWeeks,
  type DayRow,
  type ErrorWeekRow,
  fitGranularity,
  type Granularity,
  type HeatCell,
  MIN_PX_PER_POINT,
  type SidechainDayRow,
  shiftDay,
  weekOf,
} from "../api.ts";
import { Card } from "../Card.tsx";
import { count, usd } from "../format.ts";
import { useHashParam } from "../router.ts";
import { Seg } from "../Seg.tsx";
import {
  BurnPanel,
  CHART_PAD,
  CHART_W,
  fmt,
  type HeatMetric,
  LineChart,
  ModelMix,
  ScatterPanel,
} from "../trend-charts.tsx";
import { useAsync } from "../useAsync.ts";

const WEEKDAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0]; // strftime %w, Monday first

const Heatmap = memo(function Heatmap({
  cells,
  metric,
}: {
  cells: HeatCell[];
  metric: HeatMetric;
}) {
  const grid = WEEKDAY_ORDER.map(() => new Array<number>(24).fill(0));
  for (const c of cells) {
    const ri = WEEKDAY_ORDER.indexOf(c.weekday);
    if (ri >= 0 && c.hour >= 0 && c.hour < 24) {
      (grid[ri] as number[])[c.hour] = metric === "cost" ? c.cost : c.sessions;
    }
  }
  const max = Math.max(...grid.flat(), 1e-9);
  return (
    <>
      <div className="heatmap" aria-hidden="true">
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
                // An empty hour keeps a faint presence: a fully transparent
                // cell reads as a gap in the grid, not as "nothing happened".
                className={v > 0 ? "heat-cell" : "heat-cell empty"}
                style={v > 0 ? { opacity: 0.12 + 0.88 * (v / max) } : undefined}
                title={`${WEEKDAY_LABELS[ri]} ${h}:00 — ${fmt(metric, v)}`}
              />
            ))}
          </div>
        ))}
      </div>
      <details className="chart-data">
        <summary>View Activity Data</summary>
        <div className="tablewrap">
          <table>
            <thead>
              <tr>
                <th>Day</th>
                <th>Hour</th>
                <th className="num">{metric}</th>
              </tr>
            </thead>
            <tbody>
              {grid
                .flatMap((row, ri) =>
                  row.map((value, hour) => ({ day: WEEKDAY_LABELS[ri], hour, value })),
                )
                .filter((entry) => entry.value > 0)
                .map((entry) => (
                  <tr key={`${entry.day}-${entry.hour}`}>
                    <td>{entry.day}</td>
                    <td>{`${entry.hour}:00`}</td>
                    <td className="num">{fmt(metric, entry.value)}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </details>
    </>
  );
});

/* ——— Contribution calendar ——————————————————————————————————————————— */

const CAL_WEEKS = 53;
const MONTH_LABELS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];
/** The four filled steps of the calendar's intensity ramp, least to most. */
const CAL_LEGEND_STEPS = [0.4, 0.6, 0.8, 1];

const Calendar = memo(function Calendar({
  daily,
  metric,
}: {
  daily: DayRow[];
  metric: HeatMetric;
}) {
  const grid = calendarWeeks(
    daily.map((d) => ({ day: d.day, v: metric === "cost" ? d.cost : d.sessions })),
    CAL_WEEKS,
  );
  if (grid.weeks.length === 0) return <EmptyNotice>No dated sessions in the index.</EmptyNotice>;
  const cell = 11;
  const gap = 2;
  // Room above the grid for the month row.
  const top = 14;
  const W = grid.weeks.length * (cell + gap);
  const H = 7 * (cell + gap) + top;
  // One label per column that opens a new month. The month is read off the day
  // string, never through a Date: parsing "YYYY-MM-DD" is UTC, and formatting
  // it locally would shift the 1st into the previous month west of Greenwich.
  const monthOf = (day: string) => day.slice(0, 7);
  const months = grid.weeks.flatMap((col, wi) => {
    const day = col[0]?.day;
    if (!day) return [];
    const previous = grid.weeks[wi - 1]?.[0]?.day;
    if (previous && monthOf(previous) === monthOf(day)) return [];
    return [
      {
        key: monthOf(day),
        x: wi * (cell + gap),
        label: MONTH_LABELS[Number(day.slice(5, 7)) - 1] ?? "",
      },
    ];
  });
  return (
    <>
      <svg
        className="calendar"
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`Calendar heatmap of ${metric} over the last ${CAL_WEEKS} weeks`}
      >
        <title>Daily activity calendar</title>
        {months.map((m) => (
          <text key={m.key} className="cal-month" x={m.x} y={10}>
            {m.label}
          </text>
        ))}
        {grid.weeks.map((col, wi) =>
          col.map((c, ri) => (
            <rect
              key={c.day}
              x={wi * (cell + gap)}
              y={ri * (cell + gap) + top}
              width={cell}
              height={cell}
              rx={2}
              className={c.v > 0 ? "cal-cell on" : "cal-cell"}
              style={
                c.v > 0 ? { opacity: 0.25 + 0.75 * Math.sqrt(c.v / (grid.max || 1)) } : undefined
              }
            >
              <title>{`${c.day} — ${fmt(metric, c.v)}`}</title>
            </rect>
          )),
        )}
      </svg>
      <div className="axis">
        <span>{grid.firstDay}</span>
        <span>{grid.lastDay}</span>
      </div>
      <div className="cal-legend">
        <span>less</span>
        <span className="cal-swatch empty" title={`no ${metric}`} />
        {CAL_LEGEND_STEPS.map((step) => (
          <span key={step} className="cal-swatch" style={{ opacity: step }} />
        ))}
        <span>more</span>
        <span className="muted">· up to {fmt(metric, grid.max)} in a day</span>
      </div>
      <details className="chart-data">
        <summary>View Calendar Data</summary>
        <div className="tablewrap">
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th className="num">{metric}</th>
              </tr>
            </thead>
            <tbody>
              {grid.weeks
                .flat()
                .filter((cell) => cell.v > 0)
                .map((cell) => (
                  <tr key={cell.day}>
                    <td>{cell.day}</td>
                    <td className="num">{fmt(metric, cell.v)}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </details>
    </>
  );
});

/* ——— Weekly trends (error rate, sidechain share, concurrency) ————————— */

const ErrorTrend = memo(function ErrorTrend({ rows }: { rows: ErrorWeekRow[] }) {
  if (rows.length === 0) return <EmptyNotice>No tool calls in the index.</EmptyNotice>;
  return (
    <LineChart
      values={rows.map((r) => r.errorRate * 100)}
      labels={rows.map((r) => `wk ${r.week} (${count(r.errors)}/${count(r.toolCalls)})`)}
      format={(v) => `${v.toFixed(1)}% errors`}
    />
  );
});

const SidechainTrend = memo(function SidechainTrend({ rows }: { rows: SidechainDayRow[] }) {
  const active = rows.filter((r) => r.totalCost > 0);
  if (active.length === 0 || !active.some((r) => r.sidechainCost > 0))
    return <EmptyNotice>No subagent (sidechain) spend recorded yet.</EmptyNotice>;
  // Weekly buckets keep the share line readable on long histories.
  const byWeek = new Map<string, { side: number; total: number }>();
  for (const r of active) {
    const wk = weekOf(r.day);
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
});

/**
 * Bucket the day-scale concurrency series the same way the Burn chart buckets
 * spend — by whatever granularity `fitGranularity` says fits the plot width —
 * but by max rather than sum: "max concurrent sessions in a week" is the
 * meaningful rollup for a peak, where a total would just double-count overlap.
 */
function bucketConcurrency(
  days: ConcurrencyDayRow[],
  granularity: Granularity,
): { label: string; maxConcurrent: number }[] {
  if (granularity === "day")
    return days.map((d) => ({ label: d.day, maxConcurrent: d.maxConcurrent }));
  const out: { label: string; maxConcurrent: number }[] = [];
  let curKey = "";
  for (const d of days) {
    const key = granularity === "month" ? d.day.slice(0, 7) : weekOf(d.day);
    let p = out[out.length - 1];
    if (!p || key !== curKey) {
      p = { label: key, maxConcurrent: 0 };
      out.push(p);
      curKey = key;
    }
    p.maxConcurrent = Math.max(p.maxConcurrent, d.maxConcurrent);
  }
  return out;
}

const Concurrency = memo(function Concurrency({ summary }: { summary: ConcurrencySummary }) {
  if (summary.days.length === 0) return <EmptyNotice>No timed sessions in the index.</EmptyNotice>;
  // Same density fit the Burn chart uses (see trend-charts.tsx): a year of
  // daily peaks in a fixed-width chart is as unreadable as a year of daily
  // spend. No user-facing granularity toggle here, so this is the only
  // choice, not a default with an override.
  const granularity = fitGranularity(
    summary.days.length,
    Math.floor((CHART_W - CHART_PAD * 2) / MIN_PX_PER_POINT),
  );
  const series = bucketConcurrency(summary.days, granularity);
  return (
    <>
      <p className="muted">
        peak <strong>{summary.peak}</strong> sessions open at once ·{" "}
        {(summary.parallelDayShare * 100).toFixed(0)}% of active days ran ≥2 in parallel
      </p>
      <LineChart
        values={series.map((d) => d.maxConcurrent)}
        labels={series.map((d) => d.label)}
        format={(v) => `${v} concurrent`}
        height={100}
      />
    </>
  );
});

/**
 * Two equal-length calendar windows ending on the newest indexed day: the last
 * `days` days and the `days` before those. Days without sessions count as $0,
 * which is the point — a quiet fortnight should read as a decline.
 */
function calendarWindows(
  daily: DayRow[],
  days: number,
): { recent: number; previous: number } | null {
  const last = daily[daily.length - 1]?.day;
  if (!last) return null;
  const start = shiftDay(last, -(days - 1));
  const priorEnd = shiftDay(start, -1);
  const priorStart = shiftDay(start, -days);
  const sum = (from: string, to: string) =>
    daily.reduce((total, d) => (d.day >= from && d.day <= to ? total + d.cost : total), 0);
  return { recent: sum(start, last), previous: sum(priorStart, priorEnd) };
}

/** Signed, coloured percent change — up is red because this is spend. */
function CostDelta({ recent, previous }: { recent: number; previous: number }) {
  if (previous <= 0) return <>no spend in the previous 30 days</>;
  const change = ((recent - previous) / previous) * 100;
  return (
    <>
      <span className={change >= 0 ? "delta-up" : "delta-down"}>
        {change >= 0 ? "+" : "−"}
        {Math.abs(change).toFixed(0)}%
      </span>{" "}
      vs previous 30 days ({usd(previous)})
    </>
  );
}

export function Trends() {
  const { data, error, loading, retry } = useAsync(() => api.trends(), []);
  const metrics = ["sessions", "cost"] as const;
  const [heatMetric, setHeatMetric] = useHashParam<HeatMetric>("heat", "sessions", metrics);
  const [calMetric, setCalMetric] = useHashParam<HeatMetric>("calendar", "cost", metrics);
  if (loading) return <LoadingNotice>Loading trends…</LoadingNotice>;
  if (error) return <ErrorNotice error={error} retry={retry} label="Couldn’t load trends." />;
  if (!data) return null;
  // Calendar windows, not "the last 30 rows": `daily` only carries days that
  // had sessions, so slicing rows compares 30 *active* days against however
  // long the 30 before them took — two windows of different lengths.
  const last30 = calendarWindows(data.daily, 30);
  const peakDay = data.daily.reduce<DayRow | null>(
    (peak, day) => (!peak || day.cost > peak.cost ? day : peak),
    null,
  );
  const latestError = data.errorWeekly[data.errorWeekly.length - 1];

  return (
    <>
      <header className="top">
        <h1>Trends</h1>
        <span className="muted">spend over time and when you work</span>
      </header>
      <section className="trend-summary" aria-labelledby="trend-summary-heading">
        <h2 id="trend-summary-heading">At a Glance</h2>
        <div className="cards trend-kpis">
          <Card
            label="Latest 30 Days"
            value={usd(last30?.recent ?? 0)}
            sub={
              last30 ? (
                <CostDelta recent={last30.recent} previous={last30.previous} />
              ) : (
                "No dated sessions"
              )
            }
          />
          <Card
            label="Peak Spend Day"
            value={peakDay ? usd(peakDay.cost) : "—"}
            sub={peakDay?.day ?? "No dated sessions"}
          />
          <Card
            label="Latest Tool Error Rate"
            value={latestError ? `${(latestError.errorRate * 100).toFixed(1)}%` : "—"}
            sub={latestError ? `week ${latestError.week}` : "No tool calls"}
          />
        </div>
        <p className="muted">Every metric choice is saved in this URL.</p>
      </section>

      <section className="trend-panel">
        <BurnPanel daily={data.daily} />
      </section>

      <section className="trend-panel">
        <div className="trend-head">
          <h2>Calendar</h2>
          <span className="seg-group">
            metric{" "}
            <Seg
              label="Calendar metric"
              options={["cost", "sessions"]}
              value={calMetric}
              onChange={setCalMetric}
            />
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
            <Seg
              label="Heatmap metric"
              options={["sessions", "cost"]}
              value={heatMetric}
              onChange={setHeatMetric}
            />
            <span className="muted"> · local time</span>
          </span>
        </div>
        {data.heatmap.length === 0 ? (
          <EmptyNotice>No dated sessions in the index.</EmptyNotice>
        ) : (
          <Heatmap cells={data.heatmap} metric={heatMetric} />
        )}
      </section>

      <section className="trend-panel">
        <ScatterPanel points={data.scatter} />
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
