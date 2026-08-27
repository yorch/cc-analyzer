import type { Database } from "bun:sqlite";
import { Box, Text, useInput } from "ink";
import { useMemo, useState } from "react";
import { formatCount, formatUSD, truncate } from "../../cli/format.ts";
import { activityHeatmap, type ModelDayRow, modelMixByDay, spendByDay } from "../../core/stats.ts";
import {
  type DayRange,
  fitGranularity,
  INDEXED_COST_CAVEAT,
  weeklySeries,
} from "../../core/stats-types.ts";
import {
  type BurnMetric,
  brailleChart,
  bucketSeries,
  calendarGrid,
  type Granularity,
  heatGrid,
  metricValue,
  RAMP,
  sparkline,
  WEEKDAY_LABELS,
} from "../charts.ts";
import { palette, role, selection } from "../theme.ts";

type Panel = "burn" | "heatmap" | "calendar" | "models";
type HeatMetric = "sessions" | "cost";
const BURN_METRICS: BurnMetric[] = ["cost", "tokens", "sessions"];
const GRANULARITIES: Granularity[] = ["day", "week", "month"];

// The heatmap grid row is a 4-char weekday label ("Mon ") followed by 24
// one-char hour cells (heatGrid), 28 columns total. Ticks are placed at
// column `4 + hour` so they land over their cell. A trailing "23h" tick was
// tried and dropped: at 3 chars wide it would need to start at column 25 to
// fit inside the 28-char row, which butts it directly against "18h" (ending
// at column 24) with no separating space — "18h    " reads as a clean final
// stretch of the row, and the last hour is still legible as "wherever the
// row ends."
const HEATMAP_AXIS_PREFIX = 4;
const HEATMAP_AXIS_HOURS = 24;
const HEATMAP_TICKS: { hour: number; label: string }[] = [
  { hour: 0, label: "0h" },
  { hour: 6, label: "6h" },
  { hour: 12, label: "12h" },
  { hour: 18, label: "18h" },
];

function buildHeatmapAxis(): string {
  const total = HEATMAP_AXIS_PREFIX + HEATMAP_AXIS_HOURS;
  const chars = new Array<string>(total).fill(" ");
  for (const { hour, label } of HEATMAP_TICKS) {
    const start = Math.min(HEATMAP_AXIS_PREFIX + hour, total - label.length);
    for (let i = 0; i < label.length; i++) chars[start + i] = label[i] as string;
  }
  return chars.join("");
}

/** Built once at module load — the axis has no runtime inputs. */
const HEATMAP_HOUR_AXIS = buildHeatmapAxis();

/**
 * Width available to the burn chart's plot, before its y-axis gutter is
 * carved out of it. Shared between the granularity default (computed here,
 * at the `TrendsView` level, where `g` cycles) and `BurnPanel`'s own layout,
 * so the two can't disagree about how much room the plot has — `fitGranularity`
 * only approximates bucket counts from a slot count in the first place, so a
 * second, drifting estimate would compound that.
 */
function burnPlotWidth(columns: number): number {
  return Math.max(12, columns - 18);
}

interface Props {
  db: Database;
  columns: number;
  rows: number;
  isActive: boolean;
  onBack: () => void;
}

const fmt = (metric: BurnMetric | HeatMetric, v: number): string =>
  metric === "cost" ? formatUSD(v) : formatCount(Math.round(v));

/** Trends: a three-panel dashboard of time-series charts (burn, activity
 * heatmap, and contribution calendar). */
export function TrendsView({ db, columns, rows, isActive, onBack }: Props) {
  const daily = useMemo(() => spendByDay(db), [db]);
  const heat = useMemo(() => activityHeatmap(db), [db]);
  const modelMix = useMemo(() => modelMixByDay(db), [db]);

  const [panel, setPanel] = useState<Panel>("burn");
  const [burnMetric, setBurnMetric] = useState<BurnMetric>("cost");
  // `undefined` means "no manual choice yet" — the displayed granularity
  // defaults to whatever fits the plot's width, so a long portfolio opens
  // readable instead of opening as 13 months of daily moiré. Once `g` is
  // pressed the override wins permanently (it must not be recomputed away
  // on a resize), so it's tracked separately from the derived default.
  const [granularityOverride, setGranularityOverride] = useState<Granularity | undefined>(
    undefined,
  );
  const granularity = granularityOverride ?? fitGranularity(daily.length, burnPlotWidth(columns));
  const [heatMetric, setHeatMetric] = useState<HeatMetric>("sessions");
  const [calMetric, setCalMetric] = useState<HeatMetric>("cost");

  const PANELS: Panel[] = ["burn", "heatmap", "calendar", "models"];
  useInput(
    (input, key) => {
      if (key.escape) return onBack();
      if (key.tab) return setPanel((p) => PANELS[(PANELS.indexOf(p) + 1) % PANELS.length] as Panel);
      if (input === "1") return setPanel("burn");
      if (input === "2") return setPanel("heatmap");
      if (input === "3") return setPanel("calendar");
      if (input === "4") return setPanel("models");
      if (input === "m") {
        if (panel === "burn") {
          setBurnMetric((m) => BURN_METRICS[(BURN_METRICS.indexOf(m) + 1) % 3] as BurnMetric);
        } else if (panel === "heatmap") {
          setHeatMetric((m) => (m === "sessions" ? "cost" : "sessions"));
        } else if (panel === "calendar") {
          setCalMetric((m) => (m === "sessions" ? "cost" : "sessions"));
        }
        return;
      }
      if (input === "g" && panel === "burn") {
        // Cycle from whatever is CURRENTLY displayed (the override once set,
        // else the density-fit default), not from a fixed starting point —
        // otherwise the first press could jump backwards past what's on screen.
        setGranularityOverride((prev) => {
          const current = prev ?? fitGranularity(daily.length, burnPlotWidth(columns));
          return GRANULARITIES[(GRANULARITIES.indexOf(current) + 1) % 3] as Granularity;
        });
      }
    },
    { isActive },
  );

  return (
    <Box flexDirection="column">
      <Box>
        {PANELS.map((p) => (
          <Text key={p} {...(p === panel ? selection(true) : { color: role.muted })}>
            {" "}
            {p}{" "}
          </Text>
        ))}
        <Text color={role.muted}> tab · 1/2/3/4 · esc menu</Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        {panel === "burn" ? (
          <BurnPanel
            daily={daily}
            metric={burnMetric}
            granularity={granularity}
            columns={columns}
            rows={rows}
          />
        ) : panel === "heatmap" ? (
          <HeatPanel cells={heat} metric={heatMetric} />
        ) : panel === "calendar" ? (
          <CalendarPanel daily={daily} metric={calMetric} columns={columns} />
        ) : (
          <ModelsPanel mix={modelMix} columns={columns} />
        )}
      </Box>
    </Box>
  );
}

/**
 * Spend per model over time: one line per model (ranked by total spend, the
 * rest already folded into "other" by `modelMixByDay`) with a weekly-bucketed
 * sparkline — the terminal-friendly reading of the web Trends model-mix bands,
 * fed by the same fold so the totals cannot disagree.
 *
 * Rows stacked one above another are read as sharing an x-axis and a scale,
 * so both must actually be shared: every row's sparkline covers the same
 * union week span (`weeklySeries`'s `span`) and is scaled against the same
 * `ceiling` (the max weekly value across ALL models). Without them, a model
 * used for 12 weeks and one adopted 7 months ago both fill their row edge to
 * edge, in the same column — read as concurrent when they are not, and with
 * a `█` in one row meaning a different dollar amount than a `█` in the next.
 */
function ModelsPanel({ mix, columns }: { mix: ModelDayRow[]; columns: number }) {
  const { rows, ceiling, span } = useMemo(() => {
    const byModel = new Map<string, { total: number; daily: { day: string; count: number }[] }>();
    let minDay: string | undefined;
    let maxDay: string | undefined;
    for (const r of mix) {
      const m = byModel.get(r.model) ?? { total: 0, daily: [] };
      m.total += r.cost;
      m.daily.push({ day: r.day, count: r.cost });
      byModel.set(r.model, m);
      if (minDay === undefined || r.day < minDay) minDay = r.day;
      if (maxDay === undefined || r.day > maxDay) maxDay = r.day;
    }
    const unionSpan: DayRange | undefined =
      minDay !== undefined && maxDay !== undefined ? { start: minDay, end: maxDay } : undefined;
    const rankedRows = [...byModel.entries()]
      .map(([model, m]) => ({ model, total: m.total, weekly: weeklySeries(m.daily, unionSpan) }))
      .sort((a, b) => b.total - a.total);
    const sharedCeiling = rankedRows.reduce((mx, r) => Math.max(mx, ...r.weekly, 0), 0);
    return { rows: rankedRows, ceiling: sharedCeiling, span: unionSpan };
  }, [mix]);
  if (rows.length === 0) {
    return <Text color={role.muted}>No dated sessions in the index.</Text>;
  }
  const grand = rows.reduce((s, m) => s + m.total, 0);
  const nameW = Math.max(
    8,
    Math.min(
      rows.reduce((w, m) => Math.max(w, m.model.length), 0),
      Math.max(8, Math.floor(columns / 3)),
    ),
  );
  const sparkW = Math.max(10, Math.min(columns - nameW - 22, 40));
  return (
    <Box flexDirection="column">
      <Text color={role.muted}>
        models · <Text color={role.accent}>weekly spend</Text> per model, ranked by total
      </Text>
      {span && (
        <Text color={role.muted}>
          {span.start} → {span.end} · one shared scale
        </Text>
      )}
      <Box marginTop={1} flexDirection="column">
        {rows.map((m) => (
          <Text key={m.model}>
            <Text color={role.body}>{truncate(m.model, nameW).padEnd(nameW)} </Text>
            <Text color={palette.amber}>{sparkline(m.weekly, sparkW, ceiling).padEnd(sparkW)}</Text>
            <Text color={role.cost}>{formatUSD(m.total).padStart(10)}</Text>
            <Text color={role.muted}>
              {" "}
              {grand > 0 ? `${Math.round((m.total / grand) * 100)}%`.padStart(4) : ""}
            </Text>
          </Text>
        ))}
      </Box>
      <Box marginTop={1}>
        <Text color={role.muted}>{INDEXED_COST_CAVEAT}</Text>
      </Box>
    </Box>
  );
}

function BurnPanel({
  daily,
  metric,
  granularity,
  columns,
  rows,
}: {
  daily: ReturnType<typeof spendByDay>;
  metric: BurnMetric;
  granularity: Granularity;
  columns: number;
  rows: number;
}) {
  const series = useMemo(() => bucketSeries(daily, granularity), [daily, granularity]);
  const values = series.map((p) => metricValue(p, metric));
  const total = values.reduce((s, v) => s + v, 0);
  const peakIdx = values.reduce((best, v, i) => (v > (values[best] ?? -1) ? i : best), 0);
  const peak = values[peakIdx] ?? 0;
  const avg = values.length ? total / values.length : 0;

  // 13, not 12: the panel's chrome is one row taller than the old constant
  // assumed, so the whole app overflowed the terminal by a row and scrolled the
  // topmost chart row away. That was invisible while the top row was blank
  // braille, and stopped being invisible the moment it started carrying the
  // y-axis max label — the one label most worth reading.
  const height = Math.max(3, rows - 13);
  // A left gutter of 3 right-aligned labels (scale max / midpoint / 0 baseline)
  // so a value can be read off the plot instead of only off the peak/avg text
  // above it — mirrors the web chart's YAxis. `peak` IS the plot's own scale
  // max (brailleChart takes the values' own max with no ceiling here), so no
  // second computation can disagree with what's actually drawn. Sized to the
  // labels themselves, then carved out of the plot's width so the chart still
  // fits `columns`.
  const yLabels = [fmt(metric, peak), fmt(metric, peak / 2), fmt(metric, 0)];
  const gutterW = Math.max(...yLabels.map((l) => l.length));
  const width = Math.max(12, burnPlotWidth(columns) - gutterW - 1);
  const chart = brailleChart(values, width, height);
  const midRow = Math.floor(height / 2);
  const bottomRow = height - 1;

  if (series.length === 0) {
    return <Text color={role.muted}>No dated sessions in the index.</Text>;
  }

  return (
    <Box flexDirection="column">
      <Text color={role.muted}>
        burn · <Text color={role.accent}>{metric}</Text> ·{" "}
        <Text color={role.accent}>{granularity}</Text>
        {"   "}m metric · g granularity
      </Text>
      <Text>
        <Text color={role.cost}>{fmt(metric, total)}</Text>
        <Text color={role.muted}> total · peak </Text>
        <Text color={role.cost}>{fmt(metric, peak)}</Text>
        <Text color={role.muted}> ({series[peakIdx]?.label}) · </Text>
        <Text color={role.body}>{fmt(metric, avg)}</Text>
        <Text color={role.muted}>/{granularity} avg</Text>
      </Text>
      <Box marginTop={1} flexDirection="column">
        {chart.map((line, i) => {
          const label =
            i === 0 ? yLabels[0] : i === bottomRow ? yLabels[2] : i === midRow ? yLabels[1] : "";
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: fixed-order chart rows
            <Text key={i}>
              <Text color={role.muted}>{(label ?? "").padStart(gutterW)} </Text>
              <Text color={palette.amberDim}>{line}</Text>
            </Text>
          );
        })}
      </Box>
      <Text color={role.muted}>
        {" ".repeat(gutterW + 1)}
        {series[0]?.label}{" "}
        {"─".repeat(
          Math.max(
            0,
            width - (series[0]?.label?.length ?? 0) - (series.at(-1)?.label?.length ?? 0) - 2,
          ),
        )}{" "}
        {series.at(-1)?.label}
      </Text>
    </Box>
  );
}

function CalendarPanel({
  daily,
  metric,
  columns,
}: {
  daily: ReturnType<typeof spendByDay>;
  metric: HeatMetric;
  columns: number;
}) {
  const weeks = Math.max(8, Math.min(52, columns - 8));
  const {
    rows: grid,
    max,
    firstDay,
    lastDay,
  } = useMemo(() => calendarGrid(daily, metric, weeks), [daily, metric, weeks]);
  if (grid.length === 0) {
    return <Text color={role.muted}>No dated sessions in the index.</Text>;
  }
  return (
    <Box flexDirection="column">
      <Text color={role.muted}>
        calendar · <Text color={role.accent}>{metric}</Text> · one column per week{"   "}m metric
      </Text>
      <Text color={role.muted}>
        {firstDay} → {lastDay}
      </Text>
      {grid.map((line, i) => (
        <Text key={WEEKDAY_LABELS[i]}>
          <Text color={role.muted}>{WEEKDAY_LABELS[i]} </Text>
          <Text color={palette.amber}>{line}</Text>
        </Text>
      ))}
      <Box marginTop={1}>
        <Text color={role.muted}>
          less <Text color={palette.amber}>{RAMP}</Text> more · busiest day {fmt(metric, max)}
        </Text>
      </Box>
    </Box>
  );
}

function HeatPanel({
  cells,
  metric,
}: {
  cells: ReturnType<typeof activityHeatmap>;
  metric: HeatMetric;
}) {
  const { rows: grid, max } = useMemo(() => heatGrid(cells, metric), [cells, metric]);
  if (cells.length === 0) {
    return <Text color={role.muted}>No dated sessions in the index.</Text>;
  }
  return (
    <Box flexDirection="column">
      <Text color={role.muted}>
        heatmap · <Text color={role.accent}>{metric}</Text> · local time{"   "}m metric
      </Text>
      <Text color={role.muted}>{HEATMAP_HOUR_AXIS}</Text>
      {grid.map((line, i) => (
        <Text key={WEEKDAY_LABELS[i]}>
          <Text color={role.muted}>{WEEKDAY_LABELS[i]} </Text>
          <Text color={palette.amber}>{line}</Text>
        </Text>
      ))}
      <Box marginTop={1}>
        <Text color={role.muted}>
          less <Text color={palette.amber}>{RAMP}</Text> more · busiest {fmt(metric, max)}
        </Text>
      </Box>
    </Box>
  );
}
