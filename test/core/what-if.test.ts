import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { openDb } from "../../src/core/db.ts";
import type { PricingTable, TokenCounts } from "../../src/core/pricing.ts";
import { FALLBACK_WHATIF_MODELS, sessionCostRank, whatIfRepricing } from "../../src/core/stats.ts";
import { cheapPricing, flatPricing } from "../helpers/pricing.ts";
import { insertSession } from "../helpers/sessions.ts";

/** Every category non-zero, and the two cache-write TTLs distinct — so a
 * repricing that drops one of them cannot pass. */
const MIX: TokenCounts = {
  inputTokens: 1_000_000,
  outputTokens: 200_000,
  cacheWrite5mTokens: 400_000,
  cacheWrite1hTokens: 80_000,
  cacheReadTokens: 5_000_000,
};

/** Hand-computed cost of MIX under a rate card, independent of computeCost. */
function expectedCost(p: typeof flatPricing): number {
  return (
    MIX.inputTokens * p.inputCostPerToken +
    MIX.outputTokens * p.outputCostPerToken +
    MIX.cacheWrite5mTokens * p.cacheWrite5mCostPerToken +
    MIX.cacheWrite1hTokens * p.cacheWrite1hCostPerToken +
    MIX.cacheReadTokens * p.cacheReadCostPerToken
  );
}

function seed(
  db: Database,
  path: string,
  models: Record<string, { apiCalls: number; cost: number; tokens: TokenCounts }>,
): void {
  const cost = Object.values(models).reduce((s, m) => s + m.cost, 0);
  insertSession(db, {
    path,
    cost_total: cost,
    models_json: JSON.stringify(
      Object.fromEntries(
        Object.entries(models).map(([m, v]) => [
          m,
          { apiCalls: v.apiCalls, cost: { total: v.cost }, tokens: v.tokens },
        ]),
      ),
    ),
  });
}

const TWO_MODEL_TABLE: PricingTable = {
  "claude-opus-4-7": flatPricing,
  "claude-haiku-4-5": cheapPricing,
};

describe("whatIfRepricing", () => {
  test("reprices all four categories and both cache-write TTLs", () => {
    const db = openDb(":memory:");
    const actual = expectedCost(flatPricing);
    seed(db, "s1", {
      "claude-opus-4-7": { apiCalls: 4, cost: actual, tokens: MIX },
      "claude-haiku-4-5": { apiCalls: 1, cost: 0.5, tokens: MIX },
    });

    const { rows } = whatIfRepricing(db, TWO_MODEL_TABLE);
    const opus = rows.find((r) => r.model === "claude-opus-4-7");
    expect(opus?.calls).toBe(4);
    expect(opus?.cost).toBeCloseTo(actual, 10);

    // The only alternative is the other model the user actually ran.
    expect(opus?.alternatives.map((a) => a.model)).toEqual(["claude-haiku-4-5"]);
    const alt = opus?.alternatives[0];
    expect(alt?.cost).toBeCloseTo(expectedCost(cheapPricing), 10);
    // Every category is 10× cheaper, so the whole mix is exactly 10× cheaper —
    // which only holds if all five token buckets were repriced.
    expect(alt?.cost).toBeCloseTo(actual / 10, 10);
    expect(alt?.delta).toBeCloseTo((alt?.cost ?? 0) - actual, 10);
    expect(alt?.delta).toBeLessThan(0); // negative = saving
    db.close();
  });

  test("sums a model's mix across sessions and never reprices it against itself", () => {
    const db = openDb(":memory:");
    const one = expectedCost(flatPricing);
    seed(db, "s1", { "claude-opus-4-7": { apiCalls: 2, cost: one, tokens: MIX } });
    seed(db, "s2", { "claude-opus-4-7": { apiCalls: 3, cost: one, tokens: MIX } });
    seed(db, "s3", { "claude-haiku-4-5": { apiCalls: 1, cost: 1, tokens: MIX } });

    const { rows } = whatIfRepricing(db, TWO_MODEL_TABLE);
    const opus = rows.find((r) => r.model === "claude-opus-4-7");
    expect(opus?.calls).toBe(5);
    expect(opus?.cost).toBeCloseTo(one * 2, 10);
    // Two sessions' worth of mix repriced, and no self-comparison row.
    expect(opus?.alternatives).toHaveLength(1);
    expect(opus?.alternatives[0]?.cost).toBeCloseTo(expectedCost(cheapPricing) * 2, 10);
    db.close();
  });

  test("headline picks the cheapest single model to have run everything on", () => {
    const db = openDb(":memory:");
    const actual = expectedCost(flatPricing);
    seed(db, "s1", {
      "claude-opus-4-7": { apiCalls: 4, cost: actual, tokens: MIX },
      "claude-haiku-4-5": { apiCalls: 1, cost: expectedCost(cheapPricing), tokens: MIX },
    });
    const { summary } = whatIfRepricing(db, TWO_MODEL_TABLE);
    expect(summary.bestModel).toBe("claude-haiku-4-5");
    // All on haiku = two mixes at the cheap rate; actual = one dear + one cheap.
    expect(summary.bestCost).toBeCloseTo(expectedCost(cheapPricing) * 2, 10);
    expect(summary.actualCost).toBeCloseTo(actual + expectedCost(cheapPricing), 10);
    expect(summary.bestDelta).toBeCloseTo(summary.bestCost - summary.actualCost, 10);
    expect(summary.bestDelta).toBeLessThan(0);
    expect(summary.fallbackAlternatives).toBe(false);
    db.close();
  });

  test("excludes models the pricing table cannot resolve", () => {
    const db = openDb(":memory:");
    seed(db, "s1", {
      "claude-opus-4-7": { apiCalls: 2, cost: 5, tokens: MIX },
      // No family keyword and no exact entry → resolveModel returns undefined.
      "some-other-vendor-model": { apiCalls: 9, cost: 5, tokens: MIX },
    });
    const { rows } = whatIfRepricing(db, TWO_MODEL_TABLE);
    expect(rows.map((r) => r.model)).toEqual(["claude-opus-4-7"]);
    // …and it is never offered as an alternative either.
    expect(rows[0]?.alternatives.map((a) => a.model)).not.toContain("some-other-vendor-model");
    db.close();
  });

  test("falls back to the canonical ladder with fewer than two priceable models", () => {
    const db = openDb(":memory:");
    seed(db, "s1", { "claude-opus-4-7": { apiCalls: 2, cost: 5, tokens: MIX } });
    // The fallback ids resolve here only by the opus/sonnet/haiku family
    // heuristic, which is exactly how they resolve against a real table.
    const { rows, summary } = whatIfRepricing(db, {
      "claude-opus-4-7": flatPricing,
      "claude-haiku-4-5": cheapPricing,
      "claude-sonnet-4-5": flatPricing,
    });
    expect(summary.fallbackAlternatives).toBe(true);
    const alts = rows[0]?.alternatives.map((a) => a.model) ?? [];
    expect(alts.length).toBeGreaterThan(0);
    for (const a of alts) expect(FALLBACK_WHATIF_MODELS).toContain(a);
    expect(alts).not.toContain("claude-opus-4-7"); // still never itself
    db.close();
  });

  test("drops fallback ids the pricing table cannot resolve at all", () => {
    const db = openDb(":memory:");
    seed(db, "s1", { "claude-opus-4-7": { apiCalls: 2, cost: 5, tokens: MIX } });
    // Only an opus entry exists: the sonnet/haiku fallbacks have no family to
    // match, so they must be dropped instead of priced at $0.
    const { rows, summary } = whatIfRepricing(db, { "claude-opus-4-7": flatPricing });
    expect(summary.fallbackAlternatives).toBe(true);
    const alts = rows[0]?.alternatives.map((a) => a.model) ?? [];
    expect(alts).not.toContain("claude-sonnet-5");
    expect(alts).not.toContain("claude-haiku-4-5");
    db.close();
  });

  test("an empty index yields no rows and no headline", () => {
    const db = openDb(":memory:");
    const { rows, summary } = whatIfRepricing(db, TWO_MODEL_TABLE);
    expect(rows).toEqual([]);
    expect(summary.bestModel).toBeNull();
    expect(summary.bestDelta).toBe(0);
    db.close();
  });
});

describe("sessionCostRank", () => {
  test("ranks a session's cost within the portfolio and its project", () => {
    const db = openDb(":memory:");
    insertSession(db, { path: "/s/a.jsonl", session_id: "a", project_id: "p1", cost_total: 1 });
    insertSession(db, { path: "/s/b.jsonl", session_id: "b", project_id: "p1", cost_total: 5 });
    insertSession(db, { path: "/s/c.jsonl", session_id: "c", project_id: "p2", cost_total: 10 });
    insertSession(db, { path: "/s/d.jsonl", session_id: "d", project_id: "p2", cost_total: 20 });
    const rank = sessionCostRank(db, "b");
    expect(rank?.cost).toBe(5);
    // Strictly-below share: 1 of 4 sessions costs less than $5…
    expect(rank?.portfolio).toEqual({ sessions: 4, pct: 25 });
    // …and 1 of the 2 project sessions.
    expect(rank?.project).toEqual({ sessions: 2, pct: 50 });
    // Unknown session → undefined, not a fabricated rank.
    expect(sessionCostRank(db, "nope")).toBeUndefined();
    db.close();
  });

  test("ties and NULL costs cannot read as most-expensive", () => {
    const db = openDb(":memory:");
    insertSession(db, { path: "/s/a.jsonl", session_id: "a", cost_total: 0 });
    insertSession(db, { path: "/s/b.jsonl", session_id: "b", cost_total: 0 });
    insertSession(db, { path: "/s/c.jsonl", session_id: "c", cost_total: null });
    // A tied-cheapest session is p0, never p100 — and a NULL cost reads as $0.
    expect(sessionCostRank(db, "a")?.portfolio).toEqual({ sessions: 3, pct: 0 });
    const nullRank = sessionCostRank(db, "c");
    expect(nullRank?.cost).toBe(0);
    expect(nullRank?.portfolio.pct).toBe(0);
    db.close();
  });

  test("falls back to the path basename like sessionPathById", () => {
    const db = openDb(":memory:");
    insertSession(db, { path: "/s/abc123.jsonl", session_id: null, cost_total: 3 });
    expect(sessionCostRank(db, "abc123")?.cost).toBe(3);
    db.close();
  });
});
