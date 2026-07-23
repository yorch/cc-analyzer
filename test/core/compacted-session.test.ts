/**
 * End-to-end pass over a realistically shaped compacted session (the field
 * layout the format research documented: compact_boundary + compactMetadata,
 * the adjacent isCompactSummary prompt, a sidechain burst, real uuids and
 * timestamps): parse → analyze → chart series → index → portfolio rollup.
 */

import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeSession, type SessionAnalysis } from "../../src/core/analyze.ts";
import { buildContextSeries, buildTurnSeries } from "../../src/core/chart-series.ts";
import { openDb } from "../../src/core/db.ts";
import { reindex } from "../../src/core/indexer.ts";
import { parseSessionFile } from "../../src/core/parser.ts";
import { compactionUsage } from "../../src/core/stats.ts";
import { samplePricing as pricing } from "../helpers/pricing.ts";

const fixture = fileURLToPath(new URL("../fixtures/compacted-session.jsonl", import.meta.url));
const tmpDir = join("/tmp", `cc-analyzer-compact-${process.pid}-${Date.now()}`);
let prevClaudeDir: string | undefined;
let analysis: SessionAnalysis;
let db: Database;

beforeAll(async () => {
  const parsed = await parseSessionFile(fixture);
  expect(parsed.errors).toHaveLength(0);
  analysis = analyzeSession(parsed.events, pricing);

  // Index the same file twice (a copied session file) to exercise the
  // uuid-based rollup dedupe.
  const content = await Bun.file(fixture).text();
  mkdirSync(join(tmpDir, "projects", "proj-c"), { recursive: true });
  writeFileSync(join(tmpDir, "projects", "proj-c", "sess-compact.jsonl"), content);
  writeFileSync(
    join(tmpDir, "projects", "proj-c", "sess-compact-copy.jsonl"),
    content.replaceAll("sess-compact", "sess-compact-copy"),
  );
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

describe("compacted session end-to-end", () => {
  test("analyzer captures one own compaction with full metadata", () => {
    expect(analysis.compactions).toHaveLength(1);
    const c = analysis.compactions[0];
    expect(c?.trigger).toBe("auto");
    expect(c?.preTokens).toBe(158_100);
    expect(c?.uuid).toBe("b1");
    expect(c?.timestamp).toBe("2026-07-10T09:05:00.000Z");
    expect(c?.isSidechain).toBeUndefined();
    expect(c?.inherited).toBeUndefined(); // two API calls preceded it
  });

  test("the compact summary does not open a turn; real prompts do", () => {
    expect(analysis.totals.turns).toBe(2);
    expect(buildTurnSeries(analysis).map((t) => t.prompt)).toEqual([
      "Refactor the auth module",
      "Now add tests",
    ]);
  });

  test("context series shows the sawtooth, the marker, and the limit", () => {
    const s = buildContextSeries(analysis);
    // Main-chain calls only: a1, a2, a3, a4 — the sidechain call is excluded.
    expect(s.points).toHaveLength(4);
    expect(s.points.map((p) => p.contextTokens)).toEqual([52_000, 158_100, 20_500, 22_800]);
    // The drop lands between a2 and a3: marker at the first post-compaction call.
    expect(s.markers).toHaveLength(1);
    expect(s.markers[0]?.pos).toBe(2);
    // Pricing knows the window, so the limit line has a value.
    expect(s.contextLimit).toBe(200_000);
    expect(s.peakTokens).toBe(158_100);
  });

  test("the index row counts the own compaction once", () => {
    const row = db
      .query("SELECT compactions FROM sessions WHERE session_id = 'sess-compact'")
      .get() as { compactions: number };
    expect(row.compactions).toBe(1);
  });

  test("the rollup dedupes the copied session file by boundary uuid", () => {
    const u = compactionUsage(db);
    // Two indexed rows carry the same boundary uuid; the portfolio counts it once.
    expect(u.summary.totalSessions).toBe(2);
    expect(u.summary.compactions).toBe(1);
    expect(u.summary.auto).toBe(1);
    // The SUM-able column (per-project convenience) still sees both rows.
    expect(u.byProject[0]?.compactions).toBe(2);
  });
});
