import { describe, expect, test } from "bun:test";
import { costFramingNote, costNoun } from "../../src/core/cost-framing.ts";

describe("costFramingNote", () => {
  test("api basis has no note", () => {
    expect(costFramingNote("api")).toBeUndefined();
  });

  test("subscription basis returns the canonical sentence", () => {
    const note = costFramingNote("subscription");
    expect(note).toBeDefined();
    expect(note).toContain("API-equivalent value");
    expect(note).toContain("not a bill");
  });
});

describe("costNoun", () => {
  test('api basis is "spend"', () => {
    expect(costNoun("api")).toBe("spend");
  });

  test('subscription basis is "API-equivalent value"', () => {
    expect(costNoun("subscription")).toBe("API-equivalent value");
  });
});
