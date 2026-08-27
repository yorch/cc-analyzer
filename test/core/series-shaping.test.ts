import { describe, expect, test } from "bun:test";
import { fitGranularity, MIN_PX_PER_POINT, weeklySeries } from "../../src/core/stats-types.ts";

describe("fitGranularity", () => {
  test("keeps daily detail while the buckets still fit", () => {
    expect(fitGranularity(30, 250)).toBe("day");
    expect(fitGranularity(250, 250)).toBe("day");
  });

  test("steps up rather than letting a long range render as texture", () => {
    // The case this exists for: a real portfolio's 265 active days in a ~795px
    // chart is 99 slots, so it opens weekly instead of as moiré. At the old
    // 3px budget those same 265 points fitted "day" by a single pixel.
    const slots = Math.floor(795 / MIN_PX_PER_POINT);
    expect(fitGranularity(265, slots)).toBe("week");
    // About a quarter's worth of daily rows still fits daily in that chart.
    expect(fitGranularity(90, slots)).toBe("day");
    expect(fitGranularity(400, 40)).toBe("month");
    expect(fitGranularity(400, 60)).toBe("week");
  });

  test("degenerate slot counts fall back to the coarsest bucket, never divide by zero", () => {
    expect(fitGranularity(400, 0)).toBe("month");
    expect(fitGranularity(400, -1)).toBe("month");
    expect(fitGranularity(0, 0)).toBe("month");
  });
});

describe("weeklySeries", () => {
  const daily = [
    { day: "2025-07-17", count: 2 },
    { day: "2025-07-28", count: 5 },
  ];

  test("without a span it covers only the data's own weeks", () => {
    // 2025-07-17 → week of 07-14; 2025-07-28 is its own week, with the gap
    // week between them densified to 0.
    expect(weeklySeries(daily)).toEqual([2, 0, 5]);
  });

  test("a span pads the series so stacked rows share one x-axis", () => {
    // Two models charted one above the other are read as sharing an axis, so
    // each must be padded to the union range or week 1 of a model adopted last
    // month lines up with week 1 of one running since spring.
    const span = { start: "2025-06-30", end: "2025-08-10" };
    const padded = weeklySeries(daily, span);
    expect(padded).toEqual([0, 0, 2, 0, 5, 0]);
    // A model with no activity at all still occupies the full width, rather
    // than collapsing to nothing and shifting the rows below it.
    expect(weeklySeries([], span)).toEqual([0, 0, 0, 0, 0, 0]);
  });

  test("an empty series with no span stays empty", () => {
    expect(weeklySeries([])).toEqual([]);
  });
});
