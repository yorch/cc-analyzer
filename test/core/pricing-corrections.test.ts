import { expect, test } from "bun:test";
import {
  correctPricing,
  type ModelPricing,
  PRICE_CORRECTIONS,
  type PricingTable,
} from "../../src/core/pricing.ts";
import { bundledPricing } from "../../src/core/pricing-source.ts";

/** The introductory rates LiteLLM publishes for Sonnet 5. */
const INTRO: ModelPricing = {
  inputCostPerToken: 0.000002,
  outputCostPerToken: 0.00001,
  cacheWrite5mCostPerToken: 0.0000025,
  cacheWrite1hCostPerToken: 0.000004,
  cacheReadCostPerToken: 0.0000002,
  maxInputTokens: 1_000_000,
};

test("corrects Sonnet 5 to the rates Claude Code bills", () => {
  const table = correctPricing({ "claude-sonnet-5": { ...INTRO } });
  const p = table["claude-sonnet-5"];

  expect(p?.inputCostPerToken).toBe(0.000003);
  expect(p?.outputCostPerToken).toBe(0.000015);
  expect(p?.cacheWrite5mCostPerToken).toBe(0.00000375);
  expect(p?.cacheWrite1hCostPerToken).toBe(0.000006);
  expect(p?.cacheReadCostPerToken).toBe(0.0000003);
});

test("the correction is exactly 1.5x the published rate in every category", () => {
  // The observed discrepancy against Claude Code's own accounting was a clean
  // 1.5x across all four token categories; a correction that broke that ratio
  // would be a different (and unverified) claim about the price.
  const p = correctPricing({ "claude-sonnet-5": { ...INTRO } })["claude-sonnet-5"];
  if (!p) throw new Error("entry missing");

  for (const key of [
    "inputCostPerToken",
    "outputCostPerToken",
    "cacheWrite5mCostPerToken",
    "cacheWrite1hCostPerToken",
    "cacheReadCostPerToken",
  ] as const) {
    expect(p[key] / INTRO[key]).toBeCloseTo(1.5, 10);
  }
});

test("stops applying once the source publishes the standard rate", () => {
  // The self-expiry that keeps a correction from becoming the next stale
  // number: when LiteLLM catches up after the introductory period, the entry
  // no longer matches its own `when` and the source wins.
  const standard: ModelPricing = {
    inputCostPerToken: 0.000003,
    outputCostPerToken: 0.000015,
    cacheWrite5mCostPerToken: 0.00000375,
    cacheWrite1hCostPerToken: 0.000006,
    cacheReadCostPerToken: 0.0000003,
  };
  const table: PricingTable = { "claude-sonnet-5": standard };

  expect(correctPricing(table)["claude-sonnet-5"]).toBe(standard);
});

test("stops applying if the price moves somewhere else entirely", () => {
  const moved: ModelPricing = { ...INTRO, inputCostPerToken: 0.0000045 };

  expect(correctPricing({ "claude-sonnet-5": moved })["claude-sonnet-5"]).toBe(moved);
});

test("preserves what the source knows and the correction does not describe", () => {
  const withTier: ModelPricing = {
    ...INTRO,
    above200k: {
      inputCostPerToken: 0.000004,
      outputCostPerToken: 0.00002,
      cacheWrite5mCostPerToken: 0.000005,
      cacheWrite1hCostPerToken: 0.000008,
      cacheReadCostPerToken: 0.0000004,
    },
  };

  const p = correctPricing({ "claude-sonnet-5": withTier })["claude-sonnet-5"];
  expect(p?.maxInputTokens).toBe(1_000_000);
  expect(p?.above200k).toEqual(withTier.above200k);
});

test("is idempotent — a corrected table no longer matches its own trigger", () => {
  const once = correctPricing({ "claude-sonnet-5": { ...INTRO } });
  expect(correctPricing(once)).toEqual(once);
});

test("leaves every other model untouched", () => {
  const opus: ModelPricing = {
    inputCostPerToken: 0.000005,
    outputCostPerToken: 0.000025,
    cacheWrite5mCostPerToken: 0.00000625,
    cacheWrite1hCostPerToken: 0.00001,
    cacheReadCostPerToken: 0.0000005,
  };
  const table: PricingTable = { "claude-opus-5": opus, "claude-sonnet-5": { ...INTRO } };

  const corrected = correctPricing(table);
  expect(corrected["claude-opus-5"]).toBe(opus);
});

test("an absent model is not invented", () => {
  expect(correctPricing({})).toEqual({});
});

test("the bundled snapshot carries the stale rate the correction targets", () => {
  // If this fails, the snapshot was refreshed past the introductory period and
  // the Sonnet 5 correction is dead weight — delete it rather than keeping a
  // rule that can no longer fire.
  const sonnet = bundledPricing["claude-sonnet-5"];
  const correction = PRICE_CORRECTIONS.find((c) => c.model === "claude-sonnet-5");

  expect(correction).toBeDefined();
  expect(sonnet?.inputCostPerToken).toBe(correction?.when.inputCostPerToken);
  expect(correctPricing(bundledPricing)["claude-sonnet-5"]?.inputCostPerToken).toBe(0.000003);
});
