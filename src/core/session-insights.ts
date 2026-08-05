/**
 * Session-scoped cost insights — the what-if repricing fold and the
 * cost-per-outcome ratios behind the CLI `analyze` footer, the TUI session
 * summary, and the web session view. Bun-free on purpose (like
 * `chart-series.ts`): the fold is shared with the portfolio-wide
 * `whatIfRepricing()` in `stats.ts`, so a session's what-if and the
 * portfolio's cannot price the same mix differently.
 */

import type { ModelUsage, SessionAnalysis } from "./analyze.ts";
import { computeCost, type PricingTable, resolveModel, type TokenCounts } from "./pricing.ts";
import type { WhatIfRepricing, WhatIfRow } from "./stats-types.ts";

/**
 * Alternatives to compare against when the mix itself doesn't contain at
 * least two priceable models — one model per family, the newest of each
 * present in the bundled pricing snapshot. Filtered at use to ids the live
 * pricing table can actually resolve, so a snapshot that drifts ahead of (or
 * behind) LiteLLM degrades to whatever does resolve instead of inventing a
 * rate.
 */
export const FALLBACK_WHATIF_MODELS = ["claude-opus-4-8", "claude-sonnet-5", "claude-haiku-4-5"];

/** One model's actual usage, the input to the repricing fold. */
export interface ModelMix {
  model: string;
  calls: number;
  cost: number;
  tokens: TokenCounts;
}

/**
 * Replay each model's ACTUAL token mix at the other models' rates — the
 * "should I have routed this work somewhere cheaper?" signal, over any scope
 * (the portfolio index or a single session's `models`).
 *
 * Alternatives are the other models in the mix (the realistic comparison
 * set), falling back to `FALLBACK_WHATIF_MODELS` when fewer than two of them
 * can be priced. All four token categories and both cache-write TTLs are
 * repriced through `computeCost`, so cache accounting — where most of the
 * spend hides — is not silently dropped.
 *
 * Strictly a rate comparison; `WHATIF_CAVEAT` (stats-types.ts) must survive
 * to every render site.
 */
export function repriceModelMixes(mixes: ModelMix[], pricing: PricingTable): WhatIfRepricing {
  // Only models the pricing table can resolve can be repriced at all; an
  // unresolvable id would silently price at $0 and read as a huge saving.
  const actual = mixes.filter((m) => m.calls > 0 && resolveModel(pricing, m.model) !== undefined);

  const used = actual.map((m) => m.model);
  const fallbackAlternatives = used.length < 2;
  const candidates = fallbackAlternatives
    ? FALLBACK_WHATIF_MODELS.filter((m) => resolveModel(pricing, m) !== undefined)
    : used;

  const rows: WhatIfRow[] = actual
    .map((m) => ({
      model: m.model,
      calls: m.calls,
      cost: m.cost,
      alternatives: candidates
        .filter((c) => c !== m.model)
        .map((c) => {
          const cost = computeCost(m.tokens, resolveModel(pricing, c)?.pricing).total;
          return { model: c, cost, delta: cost - m.cost };
        })
        .sort((a, b) => a.cost - b.cost),
    }))
    .sort((a, b) => b.cost - a.cost);

  // Headline: if EVERY repriced model's mix had run on one model, which is
  // cheapest? A model's own rows keep their actual cost in its own total.
  const actualCost = rows.reduce((s, r) => s + r.cost, 0);
  let bestModel: string | null = null;
  let bestCost = 0;
  for (const c of candidates) {
    const total = rows.reduce(
      (s, r) =>
        s + (r.model === c ? r.cost : (r.alternatives.find((a) => a.model === c)?.cost ?? 0)),
      0,
    );
    if (bestModel === null || total < bestCost) {
      bestModel = c;
      bestCost = total;
    }
  }
  if (rows.length === 0) bestModel = null;

  return {
    summary: {
      actualCost,
      bestModel,
      bestCost: bestModel === null ? 0 : bestCost,
      bestDelta: bestModel === null ? 0 : bestCost - actualCost,
      fallbackAlternatives,
    },
    rows,
  };
}

/** What-if repricing of one session's model mix (see `repriceModelMixes`). */
export function sessionWhatIf(
  models: Record<string, ModelUsage>,
  pricing: PricingTable,
): WhatIfRepricing {
  return repriceModelMixes(
    Object.entries(models).map(([model, m]) => ({
      model,
      calls: m.apiCalls,
      cost: m.cost.total,
      tokens: m.tokens,
    })),
    pricing,
  );
}

/** Every render site of the outcome ratios prints this verbatim. */
export const OUTCOME_CAVEAT =
  "Outcome ratios pair spend with observable work products (turns, files, test runs); " +
  "they measure activity, not value delivered.";

/** Cost-per-outcome ratios: what the session's spend bought, in observable
 * units. A field is undefined when its denominator is zero — absent, not $0. */
export interface SessionOutcomes {
  /** Cost per genuine user turn. */
  costPerTurn?: number;
  /** Cost per distinct file written or edited. */
  costPerFileTouched?: number;
  /** Cost per detected test run. */
  costPerTestRun?: number;
  /** Cost per hour of ACTIVE time (gaps > 5 min are idle, not paid attention). */
  costPerActiveHour?: number;
  filesTouched: number;
  testRuns: number;
}

/** Derive the cost-per-outcome ratios from a finished analysis. */
export function sessionOutcomes(a: SessionAnalysis): SessionOutcomes {
  const cost = a.totals.cost.total;
  const ratio = (denominator: number): number | undefined =>
    denominator > 0 ? cost / denominator : undefined;
  return {
    costPerTurn: ratio(a.totals.turns),
    costPerFileTouched: ratio(a.filesTouched.length),
    costPerTestRun: ratio(a.testRuns),
    costPerActiveHour: ratio(a.totals.activeMs / 3_600_000),
    filesTouched: a.filesTouched.length,
    testRuns: a.testRuns,
  };
}
