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
}

/** Map a raw LiteLLM model entry to our pricing shape, or null if unpriceable. */
export function mapLiteLLMEntry(entry: LiteLLMEntry): ModelPricing | null {
  const input = entry.input_cost_per_token;
  const output = entry.output_cost_per_token;
  if (typeof input !== "number" || typeof output !== "number") return null;
  return {
    inputCostPerToken: input,
    outputCostPerToken: output,
    cacheWrite5mCostPerToken: entry.cache_creation_input_token_cost ?? input * 1.25,
    cacheWrite1hCostPerToken: entry.cache_creation_input_token_cost_above_1hr ?? input * 2,
    cacheReadCostPerToken: entry.cache_read_input_token_cost ?? input * 0.1,
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

interface CacheFile {
  fetchedAt: number;
  table: PricingTable;
}

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Load the pricing table: fresh cache -> remote fetch -> stale cache -> bundled.
 * Never throws for network reasons; always returns a usable table.
 */
export async function loadPricing(opts: LoadPricingOptions = {}): Promise<LoadedPricing> {
  const maxAgeMs = opts.maxAgeMs ?? SEVEN_DAYS_MS;
  const fetchImpl = opts.fetchImpl ?? fetch;
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
    await writeCache(cachePath, { fetchedAt: Date.now(), table });
    return { table, source: "remote" };
  } catch {
    if (cached) return { table: cached.table, source: "cache" };
    return { table: bundledPricing, source: "bundled" };
  }
}

async function readCache(path: string): Promise<CacheFile | null> {
  try {
    const file = Bun.file(path);
    if (!(await file.exists())) return null;
    const data = (await file.json()) as CacheFile;
    if (typeof data.fetchedAt !== "number" || typeof data.table !== "object") return null;
    return data;
  } catch {
    return null;
  }
}

async function writeCache(path: string, data: CacheFile): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, JSON.stringify(data));
}
