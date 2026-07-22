import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "../../src/core/db.ts";
import { reindex } from "../../src/core/indexer.ts";
import type { ModelPricing, PricingTable } from "../../src/core/pricing.ts";
import { portfolioSummary, spendByModel, spendByProject } from "../../src/core/stats.ts";

const flat: ModelPricing = {
  inputCostPerToken: 0.00001,
  outputCostPerToken: 0.00002,
  cacheWrite5mCostPerToken: 0.0000125,
  cacheWrite1hCostPerToken: 0.00002,
  cacheReadCostPerToken: 0.000001,
};
const pricing: PricingTable = { "claude-opus-4-7": flat, "claude-sonnet-4-5": flat };

const tmpDir = join("/tmp", `cc-analyzer-idx-${process.pid}-${Date.now()}`);
const fixture = fileURLToPath(new URL("../fixtures/sample-session.jsonl", import.meta.url));
let prevClaudeDir: string | undefined;

beforeAll(async () => {
  const content = await Bun.file(fixture).text();
  mkdirSync(join(tmpDir, "projects", "proj-a"), { recursive: true });
  mkdirSync(join(tmpDir, "projects", "proj-b"), { recursive: true });
  writeFileSync(join(tmpDir, "projects", "proj-a", "sess-1.jsonl"), content);
  writeFileSync(join(tmpDir, "projects", "proj-a", "sess-2.jsonl"), content);
  writeFileSync(join(tmpDir, "projects", "proj-b", "sess-3.jsonl"), content);
  prevClaudeDir = process.env.CC_ANALYZER_CLAUDE_DIR;
  process.env.CC_ANALYZER_CLAUDE_DIR = tmpDir;
});

afterAll(() => {
  if (prevClaudeDir === undefined) delete process.env.CC_ANALYZER_CLAUDE_DIR;
  else process.env.CC_ANALYZER_CLAUDE_DIR = prevClaudeDir;
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("reindex + stats", () => {
  test("indexes all sessions on first run", async () => {
    const db = openDb(":memory:");
    const result = await reindex(db, { pricing });
    expect(result.total).toBe(3);
    expect(result.indexed).toBe(3);
    expect(result.skipped).toBe(0);

    const summary = portfolioSummary(db);
    expect(summary.sessions).toBe(3);
    expect(summary.projects).toBe(2);
    expect(summary.cost).toBeGreaterThan(0);
    db.close();
  });

  test("skips unchanged files on a second run (incremental)", async () => {
    const db = openDb(":memory:");
    await reindex(db, { pricing });
    const second = await reindex(db, { pricing });
    expect(second.indexed).toBe(0);
    expect(second.skipped).toBe(3);
    db.close();
  });

  test("aggregates spend by project and by model", async () => {
    const db = openDb(":memory:");
    await reindex(db, { pricing });

    const byProject = spendByProject(db);
    expect(byProject).toHaveLength(2);
    expect(byProject[0]?.sessions).toBeGreaterThan(0);

    const byModel = spendByModel(db);
    const models = byModel.map((m) => m.model).sort();
    expect(models).toEqual(["claude-opus-4-7", "claude-sonnet-4-5"]);
    expect(byModel.every((m) => m.cost > 0)).toBe(true);
    db.close();
  });
});

describe("reindex · rebuild", () => {
  test("rebuild re-parses everything and still prunes deleted files", async () => {
    const content = await Bun.file(fixture).text();
    const extra = join(tmpDir, "projects", "proj-b", "sess-extra.jsonl");
    writeFileSync(extra, content);
    const db = openDb(":memory:");
    await reindex(db, { pricing });
    expect(portfolioSummary(db).sessions).toBe(4);

    rmSync(extra, { force: true });
    const result = await reindex(db, { pricing, rebuild: true });
    expect(result.indexed).toBe(3);
    expect(result.skipped).toBe(0);
    expect(result.deleted).toBe(1);
    expect(portfolioSummary(db).sessions).toBe(3);
    db.close();
  });
});
