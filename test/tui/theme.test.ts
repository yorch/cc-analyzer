import { describe, expect, test } from "bun:test";
import { bar, gutter, palette, selection } from "../../src/tui/theme.ts";

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
