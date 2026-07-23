import type { ModelPricing, PricingTable } from "../../src/core/pricing.ts";

/** A single model's flat per-token rates, shared across tests. */
export const flatPricing: ModelPricing = {
  inputCostPerToken: 0.00001,
  outputCostPerToken: 0.00002,
  cacheWrite5mCostPerToken: 0.0000125,
  cacheWrite1hCostPerToken: 0.00002,
  cacheReadCostPerToken: 0.000001,
  maxInputTokens: 200_000,
};

/** Pricing table covering the models used in the sample-session fixture. */
export const samplePricing: PricingTable = {
  "claude-opus-4-7": flatPricing,
  "claude-sonnet-4-5": flatPricing,
};
