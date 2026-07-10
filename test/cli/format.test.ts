import { describe, expect, test } from "bun:test";
import { formatTokens } from "../../src/cli/format.ts";

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
