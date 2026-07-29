import { describe, expect, test } from "bun:test";
import {
  formatCompactDuration,
  formatCount,
  formatDuration,
  formatSignedCount,
  formatUSD,
} from "../../src/core/format-shared.ts";

describe("formatCount rounding buckets", () => {
  test("promotes to the next unit instead of printing 1000.0k", () => {
    // The regression this module exists to prevent: the digest's own copy of
    // this helper bucketed on the raw value and rendered "1000.0k" here.
    expect(formatCount(999_960)).toBe("1.0M");
    expect(formatCount(999_960_000)).toBe("1.00B");
    expect(formatSignedCount(-999_960)).toBe("-1.0M");
  });

  test("leaves values below a bucket alone", () => {
    expect(formatCount(999)).toBe("999");
    expect(formatCount(999_940)).toBe("999.9k");
    expect(formatCount(1_500)).toBe("1.5k");
  });

  test("non-finite values render as a dash", () => {
    expect(formatCount(Number.NaN)).toBe("-");
    expect(formatSignedCount(Number.POSITIVE_INFINITY)).toBe("-");
  });

  test("only the signed mode abbreviates negatives — plain counts never are", () => {
    expect(formatSignedCount(-30_000)).toBe("-30.0k");
    expect(formatSignedCount(-500)).toBe("-500");
    expect(formatCount(-30_000)).toBe("-30000");
  });
});

describe("formatUSD", () => {
  test("keeps the sign in front of the dollar and widens sub-cent amounts", () => {
    expect(formatUSD(-1.5)).toBe("-$1.50");
    expect(formatUSD(-0.001)).toBe("-$0.0010");
    expect(formatUSD(0)).toBe("$0.00");
  });

  test("non-finite values render as a dash", () => {
    expect(formatUSD(Number.NaN)).toBe("-");
  });
});

describe("durations", () => {
  test("the terminal form carries the leftover seconds, the compact one doesn't", () => {
    expect(formatDuration(1000 * 60 * 3 + 20_000)).toBe("3m 20s");
    expect(formatCompactDuration(1000 * 60 * 3 + 20_000)).toBe("3m");
    // Both agree below a minute and above an hour.
    expect(formatDuration(45_000)).toBe("45s");
    expect(formatCompactDuration(45_000)).toBe("45s");
    expect(formatDuration(1000 * 60 * 95)).toBe("1h 35m");
    expect(formatCompactDuration(1000 * 60 * 95)).toBe("1h 35m");
  });

  test("negative durations (deltas) keep their sign", () => {
    expect(formatCompactDuration(-1000 * 60 * 10)).toBe("-10m");
    expect(formatDuration(-45_000)).toBe("-45s");
  });

  test("an absent or unparseable duration renders as a dash", () => {
    expect(formatDuration(undefined)).toBe("-");
    expect(formatCompactDuration(Number.NaN)).toBe("-");
  });
});
