/**
 * Per-model pricing and cost computation.
 *
 * Claude Code session records contain token counts but no cost, so cost is
 * derived here from tokens x per-token rates. Anthropic prices the four token
 * categories differently: input, output, cache-write (5m and 1h TTL), and
 * cache-read. Getting cache accounting right is where most of the money hides.
 */

/** The five per-token rates, without the tier/window metadata. */
export interface TokenRates {
  inputCostPerToken: number;
  outputCostPerToken: number;
  /** Cache-write with 5-minute TTL (Anthropic: ~1.25x input). */
  cacheWrite5mCostPerToken: number;
  /** Cache-write with 1-hour TTL (Anthropic: ~2x input). */
  cacheWrite1hCostPerToken: number;
  cacheReadCostPerToken: number;
}

export interface ModelPricing extends TokenRates {
  /** Context-window size (LiteLLM `max_input_tokens`), when known — the
   * ceiling the context-fill charts draw as the limit line. */
  maxInputTokens?: number;
  /** Long-context rates (LiteLLM `*_above_200k_tokens`): what Anthropic
   * charges when a request's prompt exceeds 200K tokens (the 1M-context
   * beta). Absent for models without a long-context tier. */
  above200k?: TokenRates;
}

/** Prompt-side tokens above which `above200k` rates apply (when present). */
export const LONG_CONTEXT_THRESHOLD = 200_000;

export type PricingTable = Record<string, ModelPricing>;

/**
 * One model whose published rate is not the rate Claude Code bills.
 *
 * `when` is the *stale* value being corrected, not a comment: the correction
 * applies only while the source still publishes exactly that. This is what
 * keeps a correction from becoming the next stale number — when the source
 * catches up (or the price moves again) the entry simply stops matching, and
 * the source wins. A correction that fired unconditionally would pin a rate
 * that outlived its own reason and nobody would notice.
 */
interface PriceCorrection {
  model: string;
  reason: string;
  when: Pick<TokenRates, "inputCostPerToken" | "outputCostPerToken">;
  use: TokenRates;
}

/**
 * Corrections applied on top of whatever the pricing source returned.
 *
 * cc-analyzer exists to be reconciled against `claude /usage`, so where the
 * published list price and the rate Claude Code actually bills disagree, it
 * follows Claude Code — otherwise every comparison a user makes is off by the
 * spread, with nothing on screen to explain it.
 */
export const PRICE_CORRECTIONS: readonly PriceCorrection[] = [
  {
    model: "claude-sonnet-5",
    // LiteLLM (and cc-analyzer's bundled snapshot) publish Sonnet 5's
    // introductory rate, in effect through 2026-08-31. Claude Code bills the
    // standard $3/$15 — a clean 1.5x across all four token categories — so an
    // uncorrected table understates every Sonnet 5 session by a third.
    reason: "LiteLLM publishes the introductory rate; Claude Code bills standard",
    when: { inputCostPerToken: 0.000002, outputCostPerToken: 0.00001 },
    use: {
      inputCostPerToken: 0.000003,
      outputCostPerToken: 0.000015,
      cacheWrite5mCostPerToken: 0.00000375,
      cacheWrite1hCostPerToken: 0.000006,
      cacheReadCostPerToken: 0.0000003,
    },
  },
];

/** Does this entry still carry the exact rates a correction was written for? */
function matches(entry: ModelPricing, when: PriceCorrection["when"]): boolean {
  return (
    entry.inputCostPerToken === when.inputCostPerToken &&
    entry.outputCostPerToken === when.outputCostPerToken
  );
}

/**
 * Apply `PRICE_CORRECTIONS` to a freshly-loaded table.
 *
 * Pure and idempotent — a corrected entry no longer matches its own `when`, so
 * re-running is a no-op. Everything the source knows that a correction doesn't
 * describe (`maxInputTokens`, a long-context tier) is preserved.
 */
export function correctPricing(table: PricingTable): PricingTable {
  let corrected: PricingTable | undefined;
  for (const c of PRICE_CORRECTIONS) {
    const entry = table[c.model];
    if (!entry || !matches(entry, c.when)) continue;
    corrected ??= { ...table };
    corrected[c.model] = { ...entry, ...c.use };
  }
  return corrected ?? table;
}

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

/** Prompt-side tokens of a call: everything except the output. This is what
 * the long-context tier keys off, and what `firstPromptTokens` records. */
export const promptTokens = (t: TokenCounts): number =>
  t.inputTokens + t.cacheReadTokens + t.cacheWrite5mTokens + t.cacheWrite1hTokens;

/**
 * The rates one API call is billed at. Anthropic's long-context tier switches
 * the WHOLE request to the higher rates once the prompt exceeds 200K tokens —
 * it is not a marginal rate on the excess — so callers pass one call's tokens,
 * never an aggregate (an aggregated mix would trip the threshold spuriously).
 */
export function effectivePricing(pricing: ModelPricing, tokens: TokenCounts): ModelPricing {
  if (!pricing.above200k || promptTokens(tokens) <= LONG_CONTEXT_THRESHOLD) return pricing;
  return { ...pricing.above200k, maxInputTokens: pricing.maxInputTokens };
}

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

// Family lookups scan the whole table (thousands of LiteLLM entries), and the
// analyzer resolves per assistant event — memoize per table instance.
const familyCache = new WeakMap<PricingTable, Map<string, ModelPricing | undefined>>();

/**
 * Version key for ordering ids within a family: the numeric segments of the id,
 * excluding date stamps (runs of 6+ digits like `20250514`). So
 * `claude-opus-4-1` → [4, 1] beats `claude-opus-4` → [4], and a trailing release
 * date doesn't inflate the comparison. Compared element-wise, longer-wins on a
 * shared prefix.
 */
function versionKey(id: string): number[] {
  return (id.match(/\d+/g) ?? []).filter((s) => s.length < 6).map(Number);
}

function compareVersionKeys(a: number[], b: number[]): number {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = a[i] ?? -1;
    const y = b[i] ?? -1;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * Best pricing entry for a model family. Prefers bare Anthropic ids
 * (`claude-…` / `anthropic/claude-…`) over provider variants (Bedrock, Vertex)
 * and, among those, the newest by version segments (see `versionKey`) — so an
 * unknown `claude-opus-4-9` prices off the latest opus rather than a stale
 * `claude-3-opus` or whatever entry happens to come first in table order.
 */
function familyPricing(table: PricingTable, family: string): ModelPricing | undefined {
  let cache = familyCache.get(table);
  if (!cache) {
    cache = new Map();
    familyCache.set(table, cache);
  }
  if (cache.has(family)) return cache.get(family);

  let bestVer: number[] | undefined;
  let best: ModelPricing | undefined;
  let fallback: ModelPricing | undefined;
  for (const [key, pricing] of Object.entries(table)) {
    const k = key.toLowerCase();
    if (!k.includes(family)) continue;
    fallback ??= pricing;
    const bare = k.startsWith("claude-")
      ? k
      : k.startsWith("anthropic/claude-")
        ? k.slice("anthropic/".length)
        : undefined;
    if (!bare) continue;
    const ver = versionKey(bare);
    if (!bestVer || compareVersionKeys(ver, bestVer) > 0) {
      bestVer = ver;
      best = pricing;
    }
  }
  const result = best ?? fallback;
  cache.set(family, result);
  return result;
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
    const pricing = familyPricing(table, family);
    if (pricing) return { pricing, exact: false };
  }
  return undefined;
}
