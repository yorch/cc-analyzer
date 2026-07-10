/**
 * Per-model pricing and cost computation.
 *
 * Claude Code session records contain token counts but no cost, so cost is
 * derived here from tokens x per-token rates. Anthropic prices the four token
 * categories differently: input, output, cache-write (5m and 1h TTL), and
 * cache-read. Getting cache accounting right is where most of the money hides.
 */

export interface ModelPricing {
  inputCostPerToken: number;
  outputCostPerToken: number;
  /** Cache-write with 5-minute TTL (Anthropic: ~1.25x input). */
  cacheWrite5mCostPerToken: number;
  /** Cache-write with 1-hour TTL (Anthropic: ~2x input). */
  cacheWrite1hCostPerToken: number;
  cacheReadCostPerToken: number;
}

export type PricingTable = Record<string, ModelPricing>;

export interface TokenCounts {
  inputTokens: number;
  outputTokens: number;
  cacheWrite5mTokens: number;
  cacheWrite1hTokens: number;
  cacheReadTokens: number;
}

export interface CostBreakdown {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
  total: number;
  /** True when the model could not be priced from an exact table entry. */
  estimated: boolean;
}

export const zeroTokens = (): TokenCounts => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheWrite5mTokens: 0,
  cacheWrite1hTokens: 0,
  cacheReadTokens: 0,
});

/** Input + output tokens (the "real work" excluding cache). */
export const ioTokens = (t: TokenCounts): number => t.inputTokens + t.outputTokens;

/** Cache tokens (write 5m + 1h + read). */
export const cacheTokens = (t: TokenCounts): number =>
  t.cacheWrite5mTokens + t.cacheWrite1hTokens + t.cacheReadTokens;

export const addTokens = (a: TokenCounts, b: TokenCounts): TokenCounts => ({
  inputTokens: a.inputTokens + b.inputTokens,
  outputTokens: a.outputTokens + b.outputTokens,
  cacheWrite5mTokens: a.cacheWrite5mTokens + b.cacheWrite5mTokens,
  cacheWrite1hTokens: a.cacheWrite1hTokens + b.cacheWrite1hTokens,
  cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
});

/** Compute a cost breakdown for token counts under a given model's pricing. */
export function computeCost(tokens: TokenCounts, pricing: ModelPricing | undefined): CostBreakdown {
  if (!pricing) {
    return { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, total: 0, estimated: true };
  }
  const input = tokens.inputTokens * pricing.inputCostPerToken;
  const output = tokens.outputTokens * pricing.outputCostPerToken;
  const cacheWrite =
    tokens.cacheWrite5mTokens * pricing.cacheWrite5mCostPerToken +
    tokens.cacheWrite1hTokens * pricing.cacheWrite1hCostPerToken;
  const cacheRead = tokens.cacheReadTokens * pricing.cacheReadCostPerToken;
  return {
    input,
    output,
    cacheWrite,
    cacheRead,
    total: input + output + cacheWrite + cacheRead,
    estimated: false,
  };
}

export const zeroCost = (): CostBreakdown => ({
  input: 0,
  output: 0,
  cacheWrite: 0,
  cacheRead: 0,
  total: 0,
  estimated: false,
});

export const addCost = (a: CostBreakdown, b: CostBreakdown): CostBreakdown => ({
  input: a.input + b.input,
  output: a.output + b.output,
  cacheWrite: a.cacheWrite + b.cacheWrite,
  cacheRead: a.cacheRead + b.cacheRead,
  total: a.total + b.total,
  estimated: a.estimated || b.estimated,
});

export interface ResolvedPricing {
  pricing: ModelPricing;
  /** True when matched by exact model id; false when matched by family heuristic. */
  exact: boolean;
}

/**
 * Resolve a session model id (e.g. `claude-opus-4-7`) to pricing.
 * Tries exact match, then an `anthropic/`-prefixed match, then a family
 * heuristic (opus/sonnet/haiku) so newer versioned models still get a price.
 */
export function resolveModel(table: PricingTable, modelId: string): ResolvedPricing | undefined {
  const exact = table[modelId] ?? table[`anthropic/${modelId}`];
  if (exact) return { pricing: exact, exact: true };

  const family = /opus/i.test(modelId)
    ? "opus"
    : /sonnet/i.test(modelId)
      ? "sonnet"
      : /haiku/i.test(modelId)
        ? "haiku"
        : undefined;
  if (family) {
    for (const [key, pricing] of Object.entries(table)) {
      if (key.toLowerCase().includes(family)) return { pricing, exact: false };
    }
  }
  return undefined;
}
