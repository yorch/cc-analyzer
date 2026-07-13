import { describe, expect, test } from "bun:test";
import { bar, gutter, palette, selection, sparkline } from "../../src/tui/theme.ts";

describe("sparkline", () => {
  test("empty input", () => {
    expect(sparkline([])).toBe("");
  });

  test("one char per value", () => {
    expect(sparkline([1, 2, 3, 4]).length).toBe(4);
  });

  test("max value maps to the tallest block, min to the shortest", () => {
    const s = sparkline([0, 10]);
    expect(s[0]).toBe("▁");
    expect(s[1]).toBe("█");
  });

  test("all-zero is flat, not blank", () => {
    expect(sparkline([0, 0, 0])).toBe("▁▁▁");
  });
});

describe("bar", () => {
  test("full when value equals max", () => {
    expect(bar(10, 10, 8)).toBe("████████");
  });

  test("empty when max is zero", () => {
    expect(bar(5, 0)).toBe("");
  });

  test("clamps and rounds proportionally", () => {
    expect(bar(5, 10, 10)).toBe("█████");
  });
});

describe("selection + gutter", () => {
  test("selected row is amber inverse with a marker", () => {
    expect(selection(true)).toEqual({ color: palette.bg, backgroundColor: palette.amber });
    expect(gutter(true)).toBe("❯ ");
  });

  test("unselected row is unstyled with a blank gutter", () => {
    expect(selection(false)).toEqual({});
    expect(gutter(false)).toBe("  ");
  });
});
