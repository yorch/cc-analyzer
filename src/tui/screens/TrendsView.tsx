import type { Database } from "bun:sqlite";
import { Box, Text, useInput } from "ink";
import { useMemo, useState } from "react";
import { formatCount, formatUSD, truncate } from "../../cli/format.ts";
import { activityHeatmap, type ModelDayRow, modelMixByDay, spendByDay } from "../../core/stats.ts";
import { weeklySeries } from "../../core/stats-types.ts";
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
// column `4 + hour` so they land over their cell; "23h" would run 3 columns
// past the 28-char row at that position, so it right-aligns to the last
// column instead (still readable as "the row's final hour").
const HEATMAP_AXIS_PREFIX = 4;
const HEATMAP_AXIS_HOURS = 24;
const HEATMAP_TICKS: { hour: number; label: string }[] = [
  { hour: 0, label: "0h" },
  { hour: 6, label: "6h" },
  { hour: 12, label: "12h" },
  { hour: 18, label: "18h" },
  { hour: 23, label: "23h" },
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
  const [granularity, setGranularity] = useState<Granularity>("day");
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
        setGranularity((gr) => GRANULARITIES[(GRANULARITIES.indexOf(gr) + 1) % 3] as Granularity);
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
 */
function ModelsPanel({ mix, columns }: { mix: ModelDayRow[]; columns: number }) {
  const ranked = useMemo(() => {
    const byModel = new Map<string, { total: number; daily: { day: string; count: number }[] }>();
    for (const r of mix) {
      const m = byModel.get(r.model) ?? { total: 0, daily: [] };
      m.total += r.cost;
      m.daily.push({ day: r.day, count: r.cost });
      byModel.set(r.model, m);
    }
    return [...byModel.entries()]
      .map(([model, m]) => ({ model, total: m.total, weekly: weeklySeries(m.daily) }))
      .sort((a, b) => b.total - a.total);
  }, [mix]);
  if (ranked.length === 0) {
    return <Text color={role.muted}>No dated sessions in the index.</Text>;
  }
  const grand = ranked.reduce((s, m) => s + m.total, 0);
  const nameW = Math.max(
    8,
    Math.min(
      ranked.reduce((w, m) => Math.max(w, m.model.length), 0),
      Math.max(8, Math.floor(columns / 3)),
    ),
  );
  const sparkW = Math.max(10, Math.min(columns - nameW - 22, 40));
  return (
    <Box flexDirection="column">
      <Text color={role.muted}>
        models · <Text color={role.accent}>weekly spend</Text> per model, ranked by total
      </Text>
      <Box marginTop={1} flexDirection="column">
        {ranked.map((m) => (
          <Text key={m.model}>
            <Text color={role.body}>{truncate(m.model, nameW).padEnd(nameW)} </Text>
            <Text color={palette.amber}>{sparkline(m.weekly, sparkW).padEnd(sparkW)}</Text>
            <Text color={role.cost}>{formatUSD(m.total).padStart(10)}</Text>
            <Text color={role.muted}>
              {" "}
              {grand > 0 ? `${Math.round((m.total / grand) * 100)}%`.padStart(4) : ""}
            </Text>
          </Text>
        ))}
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

  const width = Math.max(12, columns - 18);
  const height = Math.max(3, rows - 12);
  const chart = brailleChart(values, width, height);

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
        {chart.map((line, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed-order chart rows
          <Text key={i} color={palette.amberDim}>
            {line}
          </Text>
        ))}
      </Box>
      <Text color={role.muted}>
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
