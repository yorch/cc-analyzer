import { describe, expect, test } from "bun:test";
import {
  computeCost,
  type ModelPricing,
  type PricingTable,
  resolveModel,
  type TokenCounts,
} from "../../src/core/pricing.ts";

const pricing: ModelPricing = {
  inputCostPerToken: 0.00001,
  outputCostPerToken: 0.00002,
  cacheWrite5mCostPerToken: 0.0000125,
  cacheWrite1hCostPerToken: 0.00002,
  cacheReadCostPerToken: 0.000001,
};

describe("computeCost", () => {
  test("prices each token category separately", () => {
    const tokens: TokenCounts = {
      inputTokens: 10,
      outputTokens: 50,
      cacheWrite5mTokens: 1000,
      cacheWrite1hTokens: 0,
      cacheReadTokens: 2000,
    };
    const cost = computeCost(tokens, pricing);
    expect(cost.input).toBeCloseTo(0.0001, 10);
    expect(cost.output).toBeCloseTo(0.001, 10);
    expect(cost.cacheWrite).toBeCloseTo(0.0125, 10);
    expect(cost.cacheRead).toBeCloseTo(0.002, 10);
    expect(cost.total).toBeCloseTo(0.0156, 10);
    expect(cost.estimated).toBe(false);
  });

  test("flags cost as estimated when pricing is unknown", () => {
    const cost = computeCost(
      {
        inputTokens: 100,
        outputTokens: 100,
        cacheWrite5mTokens: 0,
        cacheWrite1hTokens: 0,
        cacheReadTokens: 0,
      },
      undefined,
    );
    expect(cost.total).toBe(0);
    expect(cost.estimated).toBe(true);
  });
});

describe("resolveModel", () => {
  const table: PricingTable = {
    "claude-opus-4-1": { ...pricing },
    "anthropic/claude-sonnet-4-5": { ...pricing, inputCostPerToken: 0.000003 },
  };

  test("matches an exact model id", () => {
    expect(resolveModel(table, "claude-opus-4-1")?.exact).toBe(true);
  });

  test("matches with an anthropic/ prefix", () => {
    expect(resolveModel(table, "claude-sonnet-4-5")?.exact).toBe(true);
  });

  test("falls back to a family heuristic for unknown versions (non-exact)", () => {
    const resolved = resolveModel(table, "claude-opus-4-99");
    expect(resolved).toBeDefined();
    expect(resolved?.exact).toBe(false);
  });

  test("returns undefined for a truly unknown model family", () => {
    expect(resolveModel(table, "gpt-5")).toBeUndefined();
  });
});
