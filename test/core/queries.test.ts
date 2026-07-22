import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "../../src/core/db.ts";
import { reindex } from "../../src/core/indexer.ts";
import type { ModelPricing, PricingTable } from "../../src/core/pricing.ts";
import {
  isIndexEmpty,
  listAllSessions,
  listIndexedProjects,
  listIndexedSessions,
  searchSessions,
} from "../../src/core/queries.ts";

const flat: ModelPricing = {
  inputCostPerToken: 0.00001,
  outputCostPerToken: 0.00002,
  cacheWrite5mCostPerToken: 0.0000125,
  cacheWrite1hCostPerToken: 0.00002,
  cacheReadCostPerToken: 0.000001,
};
const pricing: PricingTable = { "claude-opus-4-7": flat, "claude-sonnet-4-5": flat };

const tmpDir = join("/tmp", `cc-analyzer-q-${process.pid}-${Date.now()}`);
const fixture = fileURLToPath(new URL("../fixtures/sample-session.jsonl", import.meta.url));
let prevClaudeDir: string | undefined;
let db: Database;

beforeAll(async () => {
  const content = await Bun.file(fixture).text();
  mkdirSync(join(tmpDir, "projects", "proj-a"), { recursive: true });
  writeFileSync(join(tmpDir, "projects", "proj-a", "s1.jsonl"), content);
  writeFileSync(join(tmpDir, "projects", "proj-a", "s2.jsonl"), content);
  prevClaudeDir = process.env.CC_ANALYZER_CLAUDE_DIR;
  process.env.CC_ANALYZER_CLAUDE_DIR = tmpDir;
  db = openDb(":memory:");
  await reindex(db, { pricing });
});

afterAll(() => {
  db.close();
  if (prevClaudeDir === undefined) delete process.env.CC_ANALYZER_CLAUDE_DIR;
  else process.env.CC_ANALYZER_CLAUDE_DIR = prevClaudeDir;
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("queries", () => {
  test("isIndexEmpty reflects contents", () => {
    expect(isIndexEmpty(db)).toBe(false);
    expect(isIndexEmpty(openDb(":memory:"))).toBe(true);
  });

  test("listIndexedProjects rolls up sessions, cost and tokens", () => {
    const projects = listIndexedProjects(db);
    expect(projects).toHaveLength(1);
    expect(projects[0]?.sessions).toBe(2);
    expect(projects[0]?.projectPath).toBe("/Users/dev/proj");
    expect(projects[0]?.cost).toBeGreaterThan(0);
    // 2 sessions × (io 123, cache 10000) from the fixture
    expect(projects[0]?.ioTokens).toBe(246);
    expect(projects[0]?.cacheTokens).toBe(20000);
  });

  test("listIndexedSessions returns per-session rows with token split", () => {
    const sessions = listIndexedSessions(db, "proj-a");
    expect(sessions).toHaveLength(2);
    expect(sessions[0]?.turns).toBe(2);
    expect(typeof sessions[0]?.costEstimated).toBe("boolean");
    expect(sessions[0]?.ioTokens).toBe(123);
    expect(sessions[0]?.cacheTokens).toBe(10000);
  });

  test("listAllSessions returns every session with its project path", () => {
    const all = listAllSessions(db);
    expect(all).toHaveLength(2);
    expect(all[0]?.projectPath).toBe("/Users/dev/proj");
    expect(typeof all[0]?.costEstimated).toBe("boolean");
  });

  test("searchSessions matches on project path and returns project-tagged rows", () => {
    const hits = searchSessions(db, "dev/proj");
    expect(hits).toHaveLength(2);
    expect(hits[0]?.projectPath).toBe("/Users/dev/proj");
    expect(searchSessions(db, "no-such-session-xyz")).toHaveLength(0);
  });

  test("searchSessions honors the limit", () => {
    expect(searchSessions(db, "dev/proj", 1)).toHaveLength(1);
  });
});

describe("searchSessions · LIKE escaping", () => {
  test("wildcard characters in the query match literally", () => {
    // "%" appears in no title/id/path, so it must match nothing (not everything).
    expect(searchSessions(db, "%")).toHaveLength(0);
    expect(searchSessions(db, "_")).toHaveLength(0);
    expect(searchSessions(db, "proj").length).toBeGreaterThan(0);
  });
});
