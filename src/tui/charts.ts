/**
 * Pure ASCII/braille chart primitives for the trends view. Kept free of Ink and
 * of the database so they're trivially unit-testable: series in, strings out.
 */

import type { DayRow, HeatCell } from "../core/stats.ts";
import { calendarWeeks } from "../core/stats.ts";

// Series bucketing lives in bun-free core (shared with the web SPA) so the
// two frontends can't total a week or month differently; re-exported here so
// TUI callers keep one import site for chart helpers.
export {
  type BurnMetric,
  bucketSeries,
  type Granularity,
  metricValue,
  type SeriesPoint,
  weeklySeries,
} from "../core/stats-types.ts";

// Braille dot bitmasks: DOTS[row][col], 4 rows × 2 cols per cell (U+2800 base).
const DOTS = [
  [0x01, 0x08],
  [0x02, 0x10],
  [0x04, 0x20],
  [0x40, 0x80],
] as const;

/** A bad point (NaN/±Infinity) reads as "no activity" rather than poisoning the
 * whole series: `Math.max` returns NaN if ANY argument is NaN, so one stray
 * value would otherwise blank the entire chart instead of just its own cell. */
function orZero(v: number): number {
  return Number.isFinite(v) ? v : 0;
}

/**
 * A filled braille area chart of `values`, `width` cells wide × `height` tall.
 * Each cell packs 2×4 dots, so the plot resolution is 2·width × 4·height. Values
 * are bucketed and scaled to the series max — or to `ceiling` when given, so
 * headroom below a known limit (e.g. the context window) renders as empty rows
 * instead of the series always filling the chart. Returns `height` strings, top
 * row first.
 *
 * `bucket` decides which value in a downsampled column survives, and it is not
 * a cosmetic choice: it must match where the series' signal lives. For a
 * quantity (spend, tokens) the peak is the story, so `"max"` keeps spikes.
 * For a **rate** the DIPS are the story, and `"max"` erases them — a 98%
 * cache-hit series bucketed by max is a solid block at every height, because
 * the best call in each column is ~100% no matter how bad its neighbours were.
 * Such a series must pass `"min"` to plot the worst call per column.
 */
export function brailleChart(
  values: number[],
  width: number,
  height: number,
  ceiling?: number,
  bucket: "max" | "min" = "max",
): string[] {
  const W = Math.max(1, Math.floor(width));
  const H = Math.max(1, Math.floor(height));
  const dotCols = 2 * W;
  const dotRows = 4 * H;
  if (values.length === 0) return Array.from({ length: H }, () => " ".repeat(W));

  const cols: number[] = [];
  for (let i = 0; i < dotCols; i++) {
    const lo = Math.floor((i * values.length) / dotCols);
    const hi = Math.max(lo + 1, Math.floor(((i + 1) * values.length) / dotCols));
    let m = bucket === "min" ? Number.POSITIVE_INFINITY : 0;
    for (let j = lo; j < hi && j < values.length; j++) {
      const v = orZero(values[j] ?? 0);
      m = bucket === "min" ? Math.min(m, v) : Math.max(m, v);
    }
    cols.push(Number.isFinite(m) ? m : 0);
  }
  const max = Math.max(1e-9, ...cols, orZero(ceiling ?? 0));
  // Floor nonzero values to one dot (like the sparkline) so a low-activity
  // column is distinguishable from a truly empty one.
  const heights = cols.map((v) => (v > 0 ? Math.max(1, Math.round((v / max) * dotRows)) : 0));

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

/**
 * A one-line marker row aligned with `brailleChart`'s column bucketing: for a
 * series of `seriesLen` values plotted `width` cells wide, place `mark` on the
 * cell covering each series position. Positions may equal `seriesLen` (a
 * marker after the last point); they clamp to the final cell.
 */
export function markerRow(
  positions: number[],
  seriesLen: number,
  width: number,
  mark = "▼",
): string {
  const W = Math.max(1, Math.floor(width));
  if (seriesLen <= 0) return " ".repeat(W);
  const cells = new Array<boolean>(W).fill(false);
  for (const pos of positions) {
    const p = Math.max(0, Math.min(pos, seriesLen - 1));
    cells[Math.min(W - 1, Math.floor((p * W) / seriesLen))] = true;
  }
  return cells.map((on) => (on ? mark : " ")).join("");
}

const SPARK = "▁▂▃▄▅▆▇█";
const SPARK_FLOOR = SPARK[0] ?? " ";
/**
 * A one-line block-eighths sparkline of `values`, downsampled to at most `width`
 * buckets (summing within each bucket so totals survive) and scaled to the series
 * max — or to `ceiling` when given (a value > 0), so several sparklines stacked
 * above one another can share one scale: without it, a `█` in one row and a `█`
 * in the next mean different absolute amounts, which defeats stacking them at
 * all. Values above the ceiling clamp to the top glyph instead of overflowing
 * the block-eighths alphabet. Empty string for no data; always exactly
 * `Math.min(width, values.length)` chars, so callers aligning a marker row
 * against it never drift.
 */
export function sparkline(values: number[], width = 24, ceiling?: number): string {
  if (values.length === 0) return "";
  const n = Math.min(Math.max(1, Math.floor(width)), values.length);
  const buckets = new Array<number>(n).fill(0);
  for (let i = 0; i < values.length; i++) {
    const b = Math.floor((i * n) / values.length);
    // A NaN/±Infinity value reads as 0 (no contribution) rather than poisoning
    // its whole bucket's sum — see brailleChart's `orZero` for the same reasoning.
    buckets[b] = (buckets[b] ?? 0) + orZero(values[i] ?? 0);
  }
  const safeCeiling =
    ceiling !== undefined && Number.isFinite(ceiling) && ceiling > 0 ? ceiling : undefined;
  const max = safeCeiling ?? Math.max(1e-9, ...buckets);
  const last = SPARK.length - 1;
  return buckets
    .map((v) => {
      if (v <= 0) return SPARK_FLOOR;
      const idx = Math.min(last, Math.max(1, Math.round((v / max) * last)));
      // Defensive fallback: an out-of-range index must never drop a character
      // (join() silently swallows undefined entries, which shortens the string).
      return SPARK[idx] ?? SPARK_FLOOR;
    })
    .join("");
}

// The skill-adoption sparkline series is the shared core `weeklySeries`
// (also used by the web Tools view); the historical TUI name is kept.
export { weeklySeries as weeklySkillSeries } from "../core/stats-types.ts";

/** Shade ramp shared by every TUI density grid (and their legends). */
export const RAMP = " ·░▒▓█";
/** strftime %w weekday for each display row, Monday first. */
const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;
export const WEEKDAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

const RAMP_FLOOR = RAMP[0] ?? " ";
/** Shade a value against the busiest cell using the RAMP characters. A
 * non-finite `v` floors like an empty cell, and an out-of-range index falls
 * back to the floor glyph rather than dropping a character (see `sparkline`). */
function rampChar(v: number, max: number): string {
  if (!Number.isFinite(v) || v <= 0) return RAMP_FLOOR;
  const last = RAMP.length - 1;
  const idx = Math.min(last, Math.max(1, Math.round((v / max) * last)));
  return RAMP[idx] ?? RAMP_FLOOR;
}

/**
 * Render a GitHub-style contribution calendar: 7 rows (Mon…Sun) of ramp-shaded
 * chars, one column per week, ending at the newest day in `daily`. The grid
 * math lives in core `calendarWeeks` (shared with the web calendar); this only
 * turns its cells into ramp characters — days past the newest stay blank.
 */
export function calendarGrid(
  daily: DayRow[],
  metric: "sessions" | "cost",
  weeks = 26,
): { rows: string[]; max: number; firstDay: string; lastDay: string } {
  // Sanitize before calendarWeeks: it stores each cell's `v` verbatim (its own
  // `max` tracking is NaN-safe since `NaN > max` is always false, but a NaN
  // cell would still reach rampChar below and drop a character off its row).
  const grid = calendarWeeks(
    daily.map((d) => ({ day: d.day, v: orZero(metric === "cost" ? d.cost : d.sessions) })),
    weeks,
  );
  if (grid.weeks.length === 0) return { rows: [], max: 0, firstDay: "", lastDay: "" };
  const max = Math.max(1e-9, grid.max);
  const rows = Array.from({ length: 7 }, (_, r) =>
    grid.weeks.map((col) => (col[r] ? rampChar((col[r] as { v: number }).v, max) : " ")).join(""),
  );
  return { rows, max: grid.max, firstDay: grid.firstDay, lastDay: grid.lastDay };
}

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
    if (row) row[c.hour] = orZero(metric === "cost" ? c.cost : c.sessions);
  }
  const max = Math.max(1e-9, ...grid.flat());
  const rows = grid.map((row) => row.map((v) => rampChar(v, max)).join(""));
  return { rows, max };
}
