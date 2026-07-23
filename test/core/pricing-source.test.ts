import { describe, expect, test } from "bun:test";
import {
  bundledPricing,
  loadPricing,
  mapLiteLLMEntry,
  parseLiteLLMTable,
} from "../../src/core/pricing-source.ts";

describe("mapLiteLLMEntry", () => {
  test("maps litellm fields including the 1h cache rate", () => {
    const mapped = mapLiteLLMEntry({
      input_cost_per_token: 0.000015,
      output_cost_per_token: 0.000075,
      cache_creation_input_token_cost: 0.00001875,
      cache_creation_input_token_cost_above_1hr: 0.00003,
      cache_read_input_token_cost: 0.0000015,
    });
    expect(mapped?.cacheWrite5mCostPerToken).toBe(0.00001875);
    expect(mapped?.cacheWrite1hCostPerToken).toBe(0.00003);
    expect(mapped?.cacheReadCostPerToken).toBe(0.0000015);
  });

  test("derives cache rates from input cost when missing", () => {
    const mapped = mapLiteLLMEntry({
      input_cost_per_token: 0.00001,
      output_cost_per_token: 0.00002,
    });
    expect(mapped?.cacheWrite5mCostPerToken).toBeCloseTo(0.0000125, 12);
    expect(mapped?.cacheWrite1hCostPerToken).toBeCloseTo(0.00002, 12);
    expect(mapped?.cacheReadCostPerToken).toBeCloseTo(0.000001, 12);
  });

  test("returns null when input/output costs are absent", () => {
    expect(mapLiteLLMEntry({ litellm_provider: "anthropic" })).toBeNull();
  });
});

describe("parseLiteLLMTable", () => {
  test("keeps only priceable entries", () => {
    const table = parseLiteLLMTable({
      "claude-x": { input_cost_per_token: 1, output_cost_per_token: 2 },
      sample_spec: { litellm_provider: "sample" },
      bad: 5,
    });
    expect(Object.keys(table)).toEqual(["claude-x"]);
  });
});

describe("bundledPricing", () => {
  test("includes known Claude families as a fallback", () => {
    const keys = Object.keys(bundledPricing).join(" ");
    expect(keys).toContain("opus");
    expect(keys).toContain("sonnet");
    expect(keys).toContain("haiku");
  });
});

describe("loadPricing", () => {
  test("falls back to bundled when the network fails and no cache exists", async () => {
    const dir = `/tmp/cc-analyzer-test-${Bun.hash(import.meta.url)}-nocache`;
    const prev = process.env.CC_ANALYZER_STATE_DIR;
    process.env.CC_ANALYZER_STATE_DIR = dir;
    try {
      const loaded = await loadPricing({
        force: true,
        fetchImpl: () => Promise.reject(new Error("offline")),
      });
      expect(loaded.source).toBe("bundled");
      expect(Object.keys(loaded.table).length).toBeGreaterThan(0);
    } finally {
      if (prev === undefined) delete process.env.CC_ANALYZER_STATE_DIR;
      else process.env.CC_ANALYZER_STATE_DIR = prev;
    }
  });
});

describe("mapLiteLLMEntry · context window", () => {
  test("carries max_input_tokens through as maxInputTokens", () => {
    const mapped = mapLiteLLMEntry({
      input_cost_per_token: 0.00001,
      output_cost_per_token: 0.00002,
      max_input_tokens: 200_000,
    });
    expect(mapped?.maxInputTokens).toBe(200_000);
  });

  test("omits the field when missing or non-positive", () => {
    const base = { input_cost_per_token: 0.00001, output_cost_per_token: 0.00002 };
    expect(mapLiteLLMEntry(base)?.maxInputTokens).toBeUndefined();
    expect(mapLiteLLMEntry({ ...base, max_input_tokens: 0 })?.maxInputTokens).toBeUndefined();
  });
});

describe("loadPricing · cache format version", () => {
  test("rejects a pre-upgrade cache (no formatVersion) instead of serving it", async () => {
    const dir = `/tmp/cc-analyzer-test-${Bun.hash(import.meta.url)}-oldcache`;
    const prev = process.env.CC_ANALYZER_STATE_DIR;
    process.env.CC_ANALYZER_STATE_DIR = dir;
    try {
      // A fresh-looking cache written by an older binary: valid rates, no
      // formatVersion (and so no maxInputTokens anywhere).
      const { pricingCachePath } = await import("../../src/core/paths.ts");
      const { mkdirSync, writeFileSync } = await import("node:fs");
      const { dirname } = await import("node:path");
      const path = pricingCachePath();
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(
        path,
        JSON.stringify({
          fetchedAt: Date.now(),
          table: {
            "claude-old": {
              inputCostPerToken: 1,
              outputCostPerToken: 2,
              cacheWrite5mCostPerToken: 1,
              cacheWrite1hCostPerToken: 2,
              cacheReadCostPerToken: 0.1,
            },
          },
        }),
      );
      // Offline: the stale-format cache must NOT win; bundled (which carries
      // maxInputTokens) is the answer.
      const loaded = await loadPricing({ fetchImpl: () => Promise.reject(new Error("offline")) });
      expect(loaded.source).toBe("bundled");
      expect(loaded.table["claude-opus-4-7"]?.maxInputTokens).toBe(200_000);
    } finally {
      const { rmSync } = await import("node:fs");
      rmSync(dir, { recursive: true, force: true });
      if (prev === undefined) delete process.env.CC_ANALYZER_STATE_DIR;
      else process.env.CC_ANALYZER_STATE_DIR = prev;
    }
  });
});
