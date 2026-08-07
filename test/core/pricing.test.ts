import { describe, expect, test } from "bun:test";
import {
  computeCost,
  effectivePricing,
  LONG_CONTEXT_THRESHOLD,
  type ModelPricing,
  type PricingTable,
  promptTokens,
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

describe("resolveModel · family fallback choice", () => {
  const mk = (input: number): ModelPricing => ({
    inputCostPerToken: input,
    outputCostPerToken: input * 5,
    cacheWrite5mCostPerToken: input * 1.25,
    cacheWrite1hCostPerToken: input * 2,
    cacheReadCostPerToken: input * 0.1,
  });

  test("prefers the newest bare anthropic id over table order", () => {
    const oldOpus = mk(0.000015);
    const currentOpus = mk(0.000005);
    const bedrockOpus = mk(0.000099);
    const table: PricingTable = {
      "bedrock/anthropic.claude-3-opus-20240229-v1:0": bedrockOpus,
      "claude-3-opus-20240229": oldOpus,
      "claude-opus-4-1": currentOpus,
    };
    const r = resolveModel(table, "claude-opus-9-9");
    expect(r?.exact).toBe(false);
    expect(r?.pricing).toBe(currentOpus);
  });

  test("falls back to any family match when no bare claude id exists", () => {
    const only = mk(0.000003);
    const table: PricingTable = { "vertex/claude-3-5-sonnet": only };
    const r = resolveModel(table, "claude-sonnet-4-5");
    expect(r?.exact).toBe(false);
    expect(r?.pricing).toBe(only);
  });

  test("a release-dated id does not out-rank a newer generation", () => {
    const gen4 = mk(0.00001);
    const gen41 = mk(0.000005);
    // Lexicographically "claude-opus-4-20250514" > "claude-opus-4-1-…" (2 > 1),
    // but the version key ignores the date, so 4-1 wins as the newer generation.
    const table: PricingTable = {
      "claude-opus-4-20250514": gen4,
      "claude-opus-4-1-20250805": gen41,
    };
    const r = resolveModel(table, "claude-opus-9-9");
    expect(r?.pricing).toBe(gen41);
  });
});

describe("effectivePricing · long-context tier", () => {
  const above200k = {
    inputCostPerToken: 0.000006,
    outputCostPerToken: 0.0000225,
    cacheWrite5mCostPerToken: 0.0000075,
    cacheWrite1hCostPerToken: 0.000012,
    cacheReadCostPerToken: 0.0000006,
  };
  const tiered: ModelPricing = {
    inputCostPerToken: 0.000003,
    outputCostPerToken: 0.000015,
    cacheWrite5mCostPerToken: 0.00000375,
    cacheWrite1hCostPerToken: 0.000006,
    cacheReadCostPerToken: 0.0000003,
    maxInputTokens: 200_000,
    above200k,
  };
  const tokensWithPrompt = (prompt: number): TokenCounts => ({
    inputTokens: prompt,
    outputTokens: 50_000,
    cacheWrite5mTokens: 0,
    cacheWrite1hTokens: 0,
    cacheReadTokens: 0,
  });

  test("switches the whole request to tier rates above the threshold", () => {
    const p = effectivePricing(tiered, tokensWithPrompt(LONG_CONTEXT_THRESHOLD + 1));
    expect(p.inputCostPerToken).toBe(above200k.inputCostPerToken);
    expect(p.outputCostPerToken).toBe(above200k.outputCostPerToken);
    // Window metadata survives the switch.
    expect(p.maxInputTokens).toBe(200_000);
  });

  test("stays on base rates at or below the threshold, and without a tier", () => {
    expect(effectivePricing(tiered, tokensWithPrompt(LONG_CONTEXT_THRESHOLD))).toBe(tiered);
    const { above200k: _tier, ...untiered } = tiered;
    expect(effectivePricing(untiered, tokensWithPrompt(500_000))).toBe(untiered);
  });

  test("the threshold reads the prompt side only — output does not trip it", () => {
    const t: TokenCounts = {
      inputTokens: 1_000,
      outputTokens: 300_000,
      cacheWrite5mTokens: 0,
      cacheWrite1hTokens: 0,
      cacheReadTokens: 0,
    };
    expect(promptTokens(t)).toBe(1_000);
    expect(effectivePricing(tiered, t)).toBe(tiered);
  });

  test("cache categories count toward the prompt side", () => {
    const t: TokenCounts = {
      inputTokens: 1_000,
      outputTokens: 0,
      cacheWrite5mTokens: 100_000,
      cacheWrite1hTokens: 50_000,
      cacheReadTokens: 60_000,
    };
    expect(promptTokens(t)).toBe(211_000);
    expect(effectivePricing(tiered, t).inputCostPerToken).toBe(above200k.inputCostPerToken);
  });
});
