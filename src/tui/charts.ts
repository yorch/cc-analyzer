/**
 * Pure ASCII/braille chart primitives for the trends view. Kept free of Ink and
 * of the database so they're trivially unit-testable: series in, strings out.
 */

import type { DayRow, HeatCell } from "../core/stats.ts";

export interface SeriesPoint {
  label: string;
  cost: number;
  sessions: number;
  ioTokens: number;
  cacheTokens: number;
}

export type Granularity = "day" | "week" | "month";
export type BurnMetric = "cost" | "tokens" | "sessions";

/** Monday (UTC) of the ISO week containing `day` (YYYY-MM-DD), as YYYY-MM-DD. */
function weekKey(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  const mondayOffset = (d.getUTCDay() + 6) % 7; // Mon=0 … Sun=6
  d.setUTCDate(d.getUTCDate() - mondayOffset);
  return d.toISOString().slice(0, 10);
}

/**
 * Regroup the daily series into day / week / month buckets, summing each metric.
 * Relies on `daily` being sorted ascending (as `spendByDay` returns it) so equal
 * bucket keys are contiguous.
 */
export function bucketSeries(daily: DayRow[], granularity: Granularity): SeriesPoint[] {
  if (granularity === "day") {
    return daily.map((d) => ({
      label: d.day,
      cost: d.cost,
      sessions: d.sessions,
      ioTokens: d.ioTokens,
      cacheTokens: d.cacheTokens,
    }));
  }
  const out: SeriesPoint[] = [];
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

export function metricValue(p: SeriesPoint, metric: BurnMetric): number {
  if (metric === "cost") return p.cost;
  if (metric === "sessions") return p.sessions;
  return p.ioTokens + p.cacheTokens;
}

// Braille dot bitmasks: DOTS[row][col], 4 rows × 2 cols per cell (U+2800 base).
const DOTS = [
  [0x01, 0x08],
  [0x02, 0x10],
  [0x04, 0x20],
  [0x40, 0x80],
] as const;

/**
 * A filled braille area chart of `values`, `width` cells wide × `height` tall.
 * Each cell packs 2×4 dots, so the plot resolution is 2·width × 4·height. Values
 * are bucketed (max per column, so spikes survive downsampling) and scaled to
 * the series max. Returns `height` strings, top row first.
 */
export function brailleChart(values: number[], width: number, height: number): string[] {
  const W = Math.max(1, Math.floor(width));
  const H = Math.max(1, Math.floor(height));
  const dotCols = 2 * W;
  const dotRows = 4 * H;
  if (values.length === 0) return Array.from({ length: H }, () => " ".repeat(W));

  const cols: number[] = [];
  for (let i = 0; i < dotCols; i++) {
    const lo = Math.floor((i * values.length) / dotCols);
    const hi = Math.max(lo + 1, Math.floor(((i + 1) * values.length) / dotCols));
    let m = 0;
    for (let j = lo; j < hi && j < values.length; j++) m = Math.max(m, values[j] ?? 0);
    cols.push(m);
  }
  const max = Math.max(1e-9, ...cols);
  const heights = cols.map((v) => Math.round((Math.max(0, v) / max) * dotRows));

  const rows: string[] = [];
  for (let cy = 0; cy < H; cy++) {
    let line = "";
    for (let cx = 0; cx < W; cx++) {
      let mask = 0;
      for (let lr = 0; lr < 4; lr++) {
        const ry = cy * 4 + lr; // dot-row from the top
        for (let lc = 0; lc < 2; lc++) {
          const h = heights[cx * 2 + lc] ?? 0;
          if (h > 0 && ry >= dotRows - h) mask |= DOTS[lr]?.[lc] ?? 0;
        }
      }
      line += String.fromCharCode(0x2800 + mask);
    }
    rows.push(line);
  }
  return rows;
}

const RAMP = " ·░▒▓█";
/** strftime %w weekday for each display row, Monday first. */
const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;
export const WEEKDAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

/**
 * Render the activity heatmap as 7 rows (Mon…Sun) of 24 ramp-shaded chars,
 * normalized to the busiest cell. Returns the rows plus that max (for a legend).
 */
export function heatGrid(
  cells: HeatCell[],
  metric: "sessions" | "cost",
): { rows: string[]; max: number } {
  const grid = WEEKDAY_ORDER.map(() => new Array<number>(24).fill(0));
  for (const c of cells) {
    const ri = WEEKDAY_ORDER.indexOf(c.weekday as (typeof WEEKDAY_ORDER)[number]);
    if (ri < 0 || c.hour < 0 || c.hour > 23) continue;
    const row = grid[ri];
    if (row) row[c.hour] = metric === "cost" ? c.cost : c.sessions;
  }
  const max = Math.max(1e-9, ...grid.flat());
  const last = RAMP.length - 1;
  const rows = grid.map((row) =>
    row.map((v) => (v <= 0 ? RAMP[0] : RAMP[Math.max(1, Math.round((v / max) * last))])).join(""),
  );
  return { rows, max };
}
