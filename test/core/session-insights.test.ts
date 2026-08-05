import { describe, expect, test } from "bun:test";
import type { ModelUsage, SessionAnalysis } from "../../src/core/analyze.ts";
import type { PricingTable, TokenCounts } from "../../src/core/pricing.ts";
import {
  repriceModelMixes,
  sessionOutcomes,
  sessionWhatIf,
} from "../../src/core/session-insights.ts";
import { cheapPricing, flatPricing } from "../helpers/pricing.ts";

const MIX: TokenCounts = {
  inputTokens: 1_000_000,
  outputTokens: 200_000,
  cacheWrite5mTokens: 400_000,
  cacheWrite1hTokens: 80_000,
  cacheReadTokens: 5_000_000,
};

const SMALL: TokenCounts = {
  inputTokens: 10_000,
  outputTokens: 2_000,
  cacheWrite5mTokens: 0,
  cacheWrite1hTokens: 0,
  cacheReadTokens: 0,
};

/** Two priceable models with 10× different rates on every category. */
const pricing: PricingTable = {
  "claude-opus-9": flatPricing,
  "claude-haiku-9": cheapPricing,
};

const usage = (tokens: TokenCounts, cost: number, apiCalls = 3): ModelUsage => ({
  apiCalls,
  tokens,
  cost: { input: cost, output: 0, cacheWrite: 0, cacheRead: 0, total: cost, estimated: false },
});

describe("sessionWhatIf", () => {
  test("reprices a session's model mix against the other models it ran", () => {
    const w = sessionWhatIf(
      { "claude-opus-9": usage(MIX, 50), "claude-haiku-9": usage(SMALL, 0.02) },
      pricing,
    );
    expect(w.summary.fallbackAlternatives).toBe(false);
    expect(w.rows).toHaveLength(2);
    // Rows rank by actual cost; each row reprices against the OTHER model.
    expect(w.rows[0]?.model).toBe("claude-opus-9");
    expect(w.rows[0]?.alternatives.map((a) => a.model)).toEqual(["claude-haiku-9"]);
    // The opus mix at haiku (cheap) rates is 10× cheaper than at flat rates.
    const flatCost =
      MIX.inputTokens * flatPricing.inputCostPerToken +
      MIX.outputTokens * flatPricing.outputCostPerToken +
      MIX.cacheWrite5mTokens * flatPricing.cacheWrite5mCostPerToken +
      MIX.cacheWrite1hTokens * flatPricing.cacheWrite1hCostPerToken +
      MIX.cacheReadTokens * flatPricing.cacheReadCostPerToken;
    expect(w.rows[0]?.alternatives[0]?.cost).toBeCloseTo(flatCost / 10, 10);
  });

  test("a single-model session falls back to the family alternatives", () => {
    const w = sessionWhatIf({ "claude-opus-9": usage(MIX, 50) }, pricing);
    expect(w.summary.fallbackAlternatives).toBe(true);
    // The fallback ids resolve through the family heuristic against this
    // table (opus → claude-opus-9, haiku → claude-haiku-9, no sonnet entry).
    expect(w.rows[0]?.alternatives.length).toBeGreaterThan(0);
  });

  test("unpriceable models are dropped rather than repriced at $0", () => {
    const w = repriceModelMixes(
      [{ model: "totally-unknown-llm", calls: 5, cost: 12, tokens: MIX }],
      pricing,
    );
    expect(w.rows).toEqual([]);
    expect(w.summary.bestModel).toBeNull();
  });
});

describe("sessionOutcomes", () => {
  const analysis = {
    totals: {
      turns: 4,
      cost: { total: 10 },
      activeMs: 1_800_000, // 30 min
    },
    filesTouched: ["/a", "/b"],
    testRuns: 0,
  } as unknown as SessionAnalysis;

  test("derives ratios and leaves zero-denominator ones absent", () => {
    const o = sessionOutcomes(analysis);
    expect(o.costPerTurn).toBeCloseTo(2.5, 10);
    expect(o.costPerFileTouched).toBeCloseTo(5, 10);
    expect(o.costPerTestRun).toBeUndefined();
    expect(o.costPerActiveHour).toBeCloseTo(20, 10);
    expect(o.filesTouched).toBe(2);
    expect(o.testRuns).toBe(0);
  });
});
