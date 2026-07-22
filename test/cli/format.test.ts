import { describe, expect, test } from "bun:test";
import { formatCount, formatTokens, formatUSD } from "../../src/cli/format.ts";

describe("formatTokens", () => {
  test("shows io only when there is no cache", () => {
    expect(formatTokens(213_000_000, 0)).toBe("213.0M");
  });
  test("appends a cache annotation when present", () => {
    expect(formatTokens(213_000_000, 52_000_000_000)).toBe("213.0M +52.00B cache");
  });
  test("handles small counts", () => {
    expect(formatTokens(123, 10_000)).toBe("123 +10.0k cache");
  });
});

describe("formatUSD edge cases", () => {
  test("negative amounts keep the sign in front of the dollar", () => {
    expect(formatUSD(-1.5)).toBe("-$1.50");
    expect(formatUSD(-0.001)).toBe("-$0.0010");
  });
  test("non-finite values render as a dash", () => {
    expect(formatUSD(Number.NaN)).toBe("-");
    expect(formatUSD(Number.POSITIVE_INFINITY)).toBe("-");
  });
});

describe("formatCount rounding boundaries", () => {
  test("promotes to the next unit instead of printing 1000.0k", () => {
    expect(formatCount(999_960)).toBe("1.0M");
    expect(formatCount(999_960_000)).toBe("1.00B");
  });
  test("non-finite values render as a dash", () => {
    expect(formatCount(Number.NaN)).toBe("-");
  });
});
