import { describe, expect, test } from "bun:test";
import type { DayRow, HeatCell } from "../../src/core/stats.ts";
import {
  brailleChart,
  bucketSeries,
  calendarGrid,
  heatGrid,
  markerRow,
  metricValue,
  sparkline,
  WEEKDAY_LABELS,
  weeklySkillSeries,
} from "../../src/tui/charts.ts";

const day = (d: string, cost: number, sessions = 1): DayRow => ({
  day: d,
  cost,
  sessions,
  ioTokens: cost * 10,
  cacheTokens: cost * 100,
});

describe("bucketSeries", () => {
  const daily = [day("2026-07-06", 1), day("2026-07-07", 2), day("2026-07-13", 4)];

  test("day granularity is identity", () => {
    expect(bucketSeries(daily, "day").map((p) => p.label)).toEqual([
      "2026-07-06",
      "2026-07-07",
      "2026-07-13",
    ]);
  });

  test("week granularity groups by the Monday of the ISO week", () => {
    const wk = bucketSeries(daily, "week");
    expect(wk.map((p) => p.label)).toEqual(["2026-07-06", "2026-07-13"]);
    expect(wk[0]?.cost).toBe(3); // 06 + 07 share the week of Mon 07-06
    expect(wk[1]?.cost).toBe(4);
  });

  test("month granularity groups by YYYY-MM", () => {
    const mo = bucketSeries([day("2026-06-30", 1), ...daily], "month");
    expect(mo.map((p) => p.label)).toEqual(["2026-06", "2026-07"]);
    expect(mo[1]?.cost).toBe(7);
  });

  test("metricValue selects the right field", () => {
    const p = bucketSeries(daily, "day")[1] as { cost: number };
    expect(metricValue(p as never, "cost")).toBe(2);
    expect(metricValue(p as never, "tokens")).toBe(20 + 200);
    expect(metricValue(p as never, "sessions")).toBe(1);
  });
});

describe("brailleChart", () => {
  test("empty input renders a blank grid of the requested size", () => {
    const rows = brailleChart([], 5, 2);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r === "     ")).toBe(true);
  });

  test("respects width and height", () => {
    const rows = brailleChart([1, 2, 3, 4, 5], 4, 3);
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => [...r].length === 4)).toBe(true);
  });

  test("all-max values fill every dot (⣿)", () => {
    expect(brailleChart([9, 9, 9, 9], 2, 1)).toEqual(["⣿⣿"]);
  });

  test("all-zero values render blank braille", () => {
    expect(brailleChart([0, 0, 0, 0], 3, 1)).toEqual(["⠀⠀⠀"]);
  });

  test("a NaN point doesn't blank the whole chart — the finite points still render", () => {
    // Math.max(..., NaN) is NaN, so an unguarded scale computation would blank
    // every column, not just the bad one.
    const withNaN = brailleChart([9, 9, Number.NaN, 9], 4, 1);
    expect(withNaN).toEqual(["⣿⣿⠀⣿"]); // the NaN column floors like a zero
    expect(withNaN[0]?.length).toBe(4);
  });
});

describe("sparkline", () => {
  test("empty input → empty string", () => {
    expect(sparkline([])).toBe("");
  });

  test("one char per value when under the width budget, scaled to the max", () => {
    const s = sparkline([0, 5, 10], 24);
    expect([...s]).toHaveLength(3);
    expect(s[0]).toBe("▁"); // zero → lowest block
    expect(s[2]).toBe("█"); // max → full block
  });

  test("downsamples by summing into at most `width` buckets", () => {
    expect([...sparkline([1, 1, 1, 1, 1, 1], 3)]).toHaveLength(3);
  });

  test("a NaN in the series shrinks no bucket sum — length still matches the budget", () => {
    // Before the fix, `SPARK[NaN]` was undefined and join() silently dropped
    // it, so the returned string was SHORTER than min(width, values.length).
    const s = sparkline([5, 10, Number.NaN, 8, 12], 10);
    expect([...s]).toHaveLength(5);
  });

  test("an explicit ceiling replaces the series max as the scale denominator", () => {
    // Half of the ceiling should land roughly mid-ramp, not at the top the
    // series' own (smaller) max would have produced.
    const s = sparkline([5], 1, 10);
    expect(s).not.toBe("█");
  });

  test("two series scaled to the same ceiling are comparable", () => {
    // Same absolute value in both series must produce the same glyph when
    // scaled against a shared ceiling — that's the whole point of stacking.
    const a = sparkline([5], 1, 20);
    const b = sparkline([5, 5], 2, 20);
    expect(b).toBe(a + a);
  });

  test("values above the ceiling clamp to the top glyph", () => {
    expect(sparkline([50], 1, 10)).toBe("█");
  });
});

describe("calendarGrid", () => {
  test("a NaN cost keeps every row's length — it floors instead of dropping a char", () => {
    const daily = [day("2026-07-06", Number.NaN), day("2026-07-07", 4)];
    const { rows } = calendarGrid(daily, "cost", 2);
    for (const row of rows) expect([...row]).toHaveLength(2);
  });
});

describe("weeklySkillSeries", () => {
  test("empty input → empty series", () => {
    expect(weeklySkillSeries([])).toEqual([]);
  });

  test("dense weekly totals with gap weeks as zero, oldest first", () => {
    // Mon 2026-07-06 week, then skip a week, then Mon 2026-07-20 week.
    const series = weeklySkillSeries([
      { day: "2026-07-06", count: 2 },
      { day: "2026-07-08", count: 1 }, // same ISO week as 07-06
      { day: "2026-07-20", count: 5 },
    ]);
    expect(series).toEqual([3, 0, 5]);
  });
});

describe("heatGrid", () => {
  test("empty cells → 7 blank rows of 24 columns", () => {
    const { rows, max } = heatGrid([], "sessions");
    expect(rows).toHaveLength(7);
    expect(rows.every((r) => r === " ".repeat(24))).toBe(true);
    expect(max).toBeCloseTo(0, 5);
    expect(WEEKDAY_LABELS[0]).toBe("Mon");
  });

  test("a cell lands on the right Mon-first row/hour and shades by the metric", () => {
    const cells: HeatCell[] = [{ weekday: 1, hour: 9, sessions: 5, cost: 2 }]; // Monday 9am
    const { rows, max } = heatGrid(cells, "sessions");
    expect(max).toBe(5);
    expect(rows[0]?.[9]).toBe("█"); // busiest cell → full block
    expect(rows[0]?.[0]).toBe(" "); // empty hour → space
    expect(rows[6]).toBe(" ".repeat(24)); // Sunday empty
  });

  test("a NaN cell keeps every row 24 chars — it floors instead of dropping a char", () => {
    const cells: HeatCell[] = [
      { weekday: 1, hour: 9, sessions: Number.NaN, cost: 2 },
      { weekday: 1, hour: 10, sessions: 5, cost: 2 },
    ];
    const { rows } = heatGrid(cells, "sessions");
    for (const row of rows) expect([...row]).toHaveLength(24);
    expect(rows[0]?.[9]).toBe(" "); // the NaN cell floors like an empty one
  });
});

describe("markerRow", () => {
  test("blank when there is nothing to mark", () => {
    expect(markerRow([], 10, 6)).toBe("      ");
    expect(markerRow([1], 0, 6)).toBe("      ");
  });

  test("maps series positions to brailleChart's column buckets", () => {
    // 4 points across 4 cells (8 dot-cols): each point owns 2 dot-cols = 1 cell.
    expect(markerRow([0], 4, 4)).toBe("▼   ");
    expect(markerRow([3], 4, 4)).toBe("   ▼");
    expect(markerRow([1, 2], 4, 4)).toBe(" ▼▼ ");
  });

  test("clamps a past-the-end position to the final cell", () => {
    // pos === seriesLen means "after the last call" — still rendered.
    expect(markerRow([4], 4, 4)).toBe("   ▼");
    expect(markerRow([99], 4, 4)).toBe("   ▼");
  });
});

describe("brailleChart · bucket aggregation", () => {
  // A rate series' signal is its dips, and max bucketing erases them: the best
  // call in a downsampled column is ~100% however bad its neighbours were, so
  // a real 98% cache-hit series painted a solid block at every chart height.
  const rate = Array.from({ length: 200 }, (_, i) => (i === 100 ? 4 : 98));

  test("max bucketing hides a dip in a high, flat rate series", () => {
    const rows = brailleChart(rate, 40, 4, 100);
    expect(new Set(rows.join(""))).toEqual(new Set(["\u28ff"]));
  });

  test("min bucketing keeps the dip, which is the whole signal", () => {
    const rows = brailleChart(rate, 40, 4, 100, "min");
    expect(rows.join("")).toContain("\u28ff");
    // The dip's column is not full, so the notch is visible.
    expect(new Set(rows.join("")).size).toBeGreaterThan(1);
  });

  test("max stays the default, so quantity charts keep their spikes", () => {
    const spiky = [1, 1, 9, 1, 1, 1, 1, 1];
    expect(brailleChart(spiky, 4, 2)).toEqual(brailleChart(spiky, 4, 2, undefined, "max"));
  });

  test("an all-non-finite column floors instead of rendering Infinity", () => {
    const rows = brailleChart([Number.NaN, Number.NaN], 2, 2, 100, "min");
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.length === 2)).toBe(true);
  });
});

describe("brailleChart · ceiling", () => {
  test("scales to the ceiling so headroom renders as empty rows", () => {
    const BLANK = "⠀";
    const full = brailleChart([4, 4], 1, 2); // no ceiling: series fills the chart
    expect(full[0]).not.toBe(BLANK);
    const half = brailleChart([4, 4], 1, 2, 8); // ceiling 2× peak: top row empty
    expect(half[0]).toBe(BLANK);
    expect(half[1]).not.toBe(BLANK);
  });
});
