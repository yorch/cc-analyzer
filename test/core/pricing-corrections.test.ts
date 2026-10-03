import { expect, test } from "bun:test";
import {
  correctPricing,
  type ModelPricing,
  PRICE_CORRECTIONS,
  type PriceCorrection,
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

/**
 * A synthetic version of the Sonnet 5 correction that used to ship in
 * `PRICE_CORRECTIONS`, so the mechanism keeps its coverage while the live list
 * is empty. The real entry was removed on 2026-10-03 once Claude Code's own
 * catalog and accounting settled on the same $2/$10 rate LiteLLM publishes.
 */
const SONNET_5: PriceCorrection = {
  model: "claude-sonnet-5",
  reason: "test fixture",
  when: { inputCostPerToken: 0.000002, outputCostPerToken: 0.00001 },
  use: {
    inputCostPerToken: 0.000003,
    outputCostPerToken: 0.000015,
    cacheWrite5mCostPerToken: 0.00000375,
    cacheWrite1hCostPerToken: 0.000006,
    cacheReadCostPerToken: 0.0000003,
  },
};

const ONLY = [SONNET_5] as const;

test("corrects a model to the rates the correction names", () => {
  const p = correctPricing({ "claude-sonnet-5": { ...INTRO } }, ONLY)["claude-sonnet-5"];

  expect(p?.inputCostPerToken).toBe(0.000003);
  expect(p?.outputCostPerToken).toBe(0.000015);
  expect(p?.cacheWrite5mCostPerToken).toBe(0.00000375);
  expect(p?.cacheWrite1hCostPerToken).toBe(0.000006);
  expect(p?.cacheReadCostPerToken).toBe(0.0000003);
});

test("the correction is exactly 1.5x the published rate in every category", () => {
  // The observed Sonnet 5 discrepancy was a clean 1.5x across all four token
  // categories; a correction that broke that ratio would be a different (and
  // unverified) claim about the price.
  const p = correctPricing({ "claude-sonnet-5": { ...INTRO } }, ONLY)["claude-sonnet-5"];
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

test("stops applying once the source publishes the corrected rate", () => {
  // The self-expiry that keeps a correction from becoming the next stale
  // number: when the source catches up, the entry no longer matches its own
  // `when` and the source wins.
  const standard: ModelPricing = {
    inputCostPerToken: 0.000003,
    outputCostPerToken: 0.000015,
    cacheWrite5mCostPerToken: 0.00000375,
    cacheWrite1hCostPerToken: 0.000006,
    cacheReadCostPerToken: 0.0000003,
  };
  const table: PricingTable = { "claude-sonnet-5": standard };

  expect(correctPricing(table, ONLY)["claude-sonnet-5"]).toBe(standard);
});

test("stops applying if the price moves somewhere else entirely", () => {
  const moved: ModelPricing = { ...INTRO, inputCostPerToken: 0.0000045 };

  expect(correctPricing({ "claude-sonnet-5": moved }, ONLY)["claude-sonnet-5"]).toBe(moved);
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

  const p = correctPricing({ "claude-sonnet-5": withTier }, ONLY)["claude-sonnet-5"];
  expect(p?.maxInputTokens).toBe(1_000_000);
  expect(p?.above200k).toEqual(withTier.above200k);
});

test("is idempotent — a corrected table no longer matches its own trigger", () => {
  const once = correctPricing({ "claude-sonnet-5": { ...INTRO } }, ONLY);
  expect(correctPricing(once, ONLY)).toEqual(once);
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

  const corrected = correctPricing(table, ONLY);
  expect(corrected["claude-opus-5"]).toBe(opus);
});

test("an absent model is not invented", () => {
  expect(correctPricing({}, ONLY)).toEqual({});
});

test("the live correction list is empty and leaves the table untouched", () => {
  // `PRICE_CORRECTIONS` is the list the load path applies. It is empty because
  // Claude Code and LiteLLM agree on every current rate; if an entry is added
  // back, this test is the reminder to re-verify it against `claude -p` and to
  // bump SCHEMA_VERSION (indexed costs are stored, not recomputed).
  expect(PRICE_CORRECTIONS).toEqual([]);
  expect(correctPricing(bundledPricing)).toBe(bundledPricing);
});

test("the bundled snapshot prices Sonnet 5 at the rate LiteLLM publishes", () => {
  // The exact value the removed correction used to override.
  expect(correctPricing(bundledPricing)["claude-sonnet-5"]?.inputCostPerToken).toBe(0.000002);
});
