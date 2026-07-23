import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import bundled from "./bundled-pricing.json" with { type: "json" };
import { pricingCachePath } from "./paths.ts";
import type { ModelPricing, PricingTable } from "./pricing.ts";

export const LITELLM_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

/** Pricing snapshot compiled into the binary; used when network is unavailable. */
export const bundledPricing: PricingTable = bundled as PricingTable;

interface LiteLLMEntry {
  litellm_provider?: string;
  input_cost_per_token?: number;
  output_cost_per_token?: number;
  cache_creation_input_token_cost?: number;
  cache_creation_input_token_cost_above_1hr?: number;
  cache_read_input_token_cost?: number;
  max_input_tokens?: number;
}

/** Map a raw LiteLLM model entry to our pricing shape, or null if unpriceable. */
export function mapLiteLLMEntry(entry: LiteLLMEntry): ModelPricing | null {
  const input = entry.input_cost_per_token;
  const output = entry.output_cost_per_token;
  if (typeof input !== "number" || typeof output !== "number") return null;
  const maxInput = entry.max_input_tokens;
  return {
    inputCostPerToken: input,
    outputCostPerToken: output,
    cacheWrite5mCostPerToken: entry.cache_creation_input_token_cost ?? input * 1.25,
    cacheWrite1hCostPerToken: entry.cache_creation_input_token_cost_above_1hr ?? input * 2,
    cacheReadCostPerToken: entry.cache_read_input_token_cost ?? input * 0.1,
    ...(Number.isFinite(maxInput) && (maxInput as number) > 0 ? { maxInputTokens: maxInput } : {}),
  };
}

/** Convert the full LiteLLM JSON document into a pricing table. */
export function parseLiteLLMTable(raw: unknown): PricingTable {
  const table: PricingTable = {};
  if (typeof raw !== "object" || raw === null) return table;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== "object" || value === null) continue;
    const mapped = mapLiteLLMEntry(value as LiteLLMEntry);
    if (mapped) table[key] = mapped;
  }
  return table;
}

export interface LoadPricingOptions {
  /** Refetch when the cache is older than this (ms). Default 7 days. */
  maxAgeMs?: number;
  /** Force a network refresh regardless of cache age. */
  force?: boolean;
  /** Injectable fetch for testing (minimal signature). */
  fetchImpl?: (url: string) => Promise<Response>;
}

export interface LoadedPricing {
  table: PricingTable;
  source: "cache" | "remote" | "bundled";
}

/** Bump when the cached table's shape gains load-bearing fields: a cache
 * written by an older binary is then refreshed (or bundled pricing used)
 * instead of silently serving entries that lack the new data. v2 added
 * `maxInputTokens` (the context-window limit the charts draw). */
export const CACHE_FORMAT_VERSION = 2;

interface CacheFile {
  fetchedAt: number;
  formatVersion?: number;
  table: PricingTable;
}

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Load the pricing table: fresh cache -> remote fetch -> stale cache -> bundled.
 * Never throws for network reasons; always returns a usable table.
 */
export async function loadPricing(opts: LoadPricingOptions = {}): Promise<LoadedPricing> {
  const maxAgeMs = opts.maxAgeMs ?? SEVEN_DAYS_MS;
  // Bound the refresh: without a timeout, a hung network would stall every
  // command that loads pricing (analyze, index, serve, the TUI) indefinitely.
  const fetchImpl =
    opts.fetchImpl ?? ((url: string) => fetch(url, { signal: AbortSignal.timeout(10_000) }));
  const cachePath = pricingCachePath();

  const cached = await readCache(cachePath);
  if (!opts.force && cached && Date.now() - cached.fetchedAt < maxAgeMs) {
    return { table: cached.table, source: "cache" };
  }

  try {
    const res = await fetchImpl(LITELLM_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const table = parseLiteLLMTable(await res.json());
    if (Object.keys(table).length === 0) throw new Error("empty pricing table");
    await writeCache(cachePath, {
      fetchedAt: Date.now(),
      formatVersion: CACHE_FORMAT_VERSION,
      table,
    });
    return { table, source: "remote" };
  } catch {
    if (cached) return { table: cached.table, source: "cache" };
    return { table: bundledPricing, source: "bundled" };
  }
}

/** A pricing entry is usable only if every rate is a finite number. */
function isValidEntry(e: unknown): e is ModelPricing {
  if (typeof e !== "object" || e === null) return false;
  const p = e as Record<string, unknown>;
  return (
    Number.isFinite(p.inputCostPerToken) &&
    Number.isFinite(p.outputCostPerToken) &&
    Number.isFinite(p.cacheWrite5mCostPerToken) &&
    Number.isFinite(p.cacheWrite1hCostPerToken) &&
    Number.isFinite(p.cacheReadCostPerToken)
  );
}

async function readCache(path: string): Promise<CacheFile | null> {
  try {
    const file = Bun.file(path);
    if (!(await file.exists())) return null;
    const data = (await file.json()) as CacheFile;
    if (typeof data.fetchedAt !== "number" || typeof data.table !== "object" || data.table === null)
      return null;
    // A pre-upgrade cache lacks fields newer code depends on; rejecting it
    // falls through to a refetch, and offline to the bundled snapshot.
    if (data.formatVersion !== CACHE_FORMAT_VERSION) return null;
    // A corrupted cache (string rates, nulls) would silently yield NaN costs
    // for every session — drop invalid entries, and reject an unusable cache.
    for (const [key, entry] of Object.entries(data.table)) {
      if (!isValidEntry(entry)) delete data.table[key];
    }
    if (Object.keys(data.table).length === 0) return null;
    return data;
  } catch {
    return null;
  }
}

async function writeCache(path: string, data: CacheFile): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, JSON.stringify(data));
}
