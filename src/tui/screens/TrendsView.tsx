import type { Database } from "bun:sqlite";
import { Box, Text, useInput } from "ink";
import { useMemo, useState } from "react";
import { formatCount, formatUSD } from "../../cli/format.ts";
import { activityHeatmap, spendByDay } from "../../core/stats.ts";
import {
  type BurnMetric,
  brailleChart,
  bucketSeries,
  type Granularity,
  heatGrid,
  metricValue,
  WEEKDAY_LABELS,
} from "../charts.ts";
import { palette, role, selection } from "../theme.ts";

type Panel = "burn" | "heatmap";
type HeatMetric = "sessions" | "cost";
const BURN_METRICS: BurnMetric[] = ["cost", "tokens", "sessions"];
const GRANULARITIES: Granularity[] = ["day", "week", "month"];

interface Props {
  db: Database;
  columns: number;
  rows: number;
  isActive: boolean;
  onBack: () => void;
}

const fmt = (metric: BurnMetric | HeatMetric, v: number): string =>
  metric === "cost" ? formatUSD(v) : formatCount(Math.round(v));

/** Trends: a two-panel dashboard of time-series charts (burn + activity heatmap). */
export function TrendsView({ db, columns, rows, isActive, onBack }: Props) {
  const daily = useMemo(() => spendByDay(db), [db]);
  const heat = useMemo(() => activityHeatmap(db), [db]);

  const [panel, setPanel] = useState<Panel>("burn");
  const [burnMetric, setBurnMetric] = useState<BurnMetric>("cost");
  const [granularity, setGranularity] = useState<Granularity>("day");
  const [heatMetric, setHeatMetric] = useState<HeatMetric>("sessions");

  useInput(
    (input, key) => {
      if (key.escape) return onBack();
      if (key.tab) return setPanel((p) => (p === "burn" ? "heatmap" : "burn"));
      if (input === "1") return setPanel("burn");
      if (input === "2") return setPanel("heatmap");
      if (input === "m") {
        if (panel === "burn") {
          setBurnMetric((m) => BURN_METRICS[(BURN_METRICS.indexOf(m) + 1) % 3] as BurnMetric);
        } else {
          setHeatMetric((m) => (m === "sessions" ? "cost" : "sessions"));
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
        {(["burn", "heatmap"] as Panel[]).map((p) => (
          <Text key={p} {...(p === panel ? selection(true) : { color: role.muted })}>
            {" "}
            {p}{" "}
          </Text>
        ))}
        <Text color={role.muted}> tab · 1/2 · esc menu</Text>
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
        ) : (
          <HeatPanel cells={heat} metric={heatMetric} />
        )}
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
      <Text color={role.muted}>{"    0h      6h      12h     18h   23h"}</Text>
      {grid.map((line, i) => (
        <Text key={WEEKDAY_LABELS[i]}>
          <Text color={role.muted}>{WEEKDAY_LABELS[i]} </Text>
          <Text color={palette.amber}>{line}</Text>
        </Text>
      ))}
      <Box marginTop={1}>
        <Text color={role.muted}>
          less <Text color={palette.amber}> ·░▒▓█</Text> more · busiest {fmt(metric, max)}
        </Text>
      </Box>
    </Box>
  );
}
