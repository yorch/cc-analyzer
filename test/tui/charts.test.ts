import { describe, expect, test } from "bun:test";
import type { DayRow, HeatCell } from "../../src/core/stats.ts";
import {
  brailleChart,
  bucketSeries,
  heatGrid,
  metricValue,
  WEEKDAY_LABELS,
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
});
