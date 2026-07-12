import { describe, expect, test } from "bun:test";
import { isStale, notifyEnabled, updateNotice } from "../../src/core/update-check.ts";

const DAY = 24 * 60 * 60 * 1000;

describe("notifyEnabled", () => {
  test("requires a TTY", () => {
    expect(notifyEnabled({}, true)).toBe(true);
    expect(notifyEnabled({}, false)).toBe(false);
  });
  test("is disabled by opt-out and in CI", () => {
    expect(notifyEnabled({ CC_ANALYZER_NO_UPDATE_CHECK: "1" }, true)).toBe(false);
    expect(notifyEnabled({ CI: "true" }, true)).toBe(false);
  });
});

describe("isStale", () => {
  test("is stale at or beyond a day", () => {
    const now = 1_000_000_000_000;
    expect(isStale(now - DAY, now)).toBe(true);
    expect(isStale(now - DAY - 1, now)).toBe(true);
  });
  test("is fresh within a day", () => {
    const now = 1_000_000_000_000;
    expect(isStale(now - DAY + 1, now)).toBe(false);
    expect(isStale(now, now)).toBe(false);
  });
});

describe("updateNotice", () => {
  test("returns a notice only when latest is newer", () => {
    expect(updateNotice("0.2.0", "0.3.0")).toContain("v0.3.0 available");
    expect(updateNotice("0.2.0", "0.3.0")).toContain("cc-analyzer update");
  });
  test("returns undefined when up to date or ahead", () => {
    expect(updateNotice("0.2.0", "0.2.0")).toBeUndefined();
    expect(updateNotice("0.3.0", "0.2.0")).toBeUndefined();
  });
});
