import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "../../src/core/db.ts";
import { reindex } from "../../src/core/indexer.ts";
import {
  analyticsRollup,
  contextTax,
  portfolioSummary,
  spendByModel,
  spendByProject,
} from "../../src/core/stats.ts";
import { tempClaudeDir } from "../helpers/claude-dir.ts";
import { samplePricing as pricing } from "../helpers/pricing.ts";

const fixture = fileURLToPath(new URL("../fixtures/sample-session.jsonl", import.meta.url));
let claude: ReturnType<typeof tempClaudeDir>;

beforeAll(async () => {
  claude = tempClaudeDir("cc-analyzer-idx");
  const content = await Bun.file(fixture).text();
  mkdirSync(join(claude.dir, "projects", "proj-a"), { recursive: true });
  mkdirSync(join(claude.dir, "projects", "proj-b"), { recursive: true });
  writeFileSync(join(claude.dir, "projects", "proj-a", "sess-1.jsonl"), content);
  writeFileSync(join(claude.dir, "projects", "proj-a", "sess-2.jsonl"), content);
  writeFileSync(join(claude.dir, "projects", "proj-b", "sess-3.jsonl"), content);
});

afterAll(() => {
  claude.cleanup();
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

describe("reindex · compactions (schema v7)", () => {
  test("a compacted session lands its own count and full JSON in the row", async () => {
    // A session with one own boundary+summary pair, one subagent boundary,
    // and one inherited-looking boundary would be ideal — but own vs
    // inherited depends on call order, so: assistant call, then boundary.
    const lines = [
      JSON.stringify({
        type: "user",
        uuid: "u1",
        sessionId: "sess-compact",
        timestamp: "2026-07-01T10:00:00.000Z",
        message: { role: "user", content: "hi" },
      }),
      JSON.stringify({
        type: "assistant",
        uuid: "a1",
        sessionId: "sess-compact",
        timestamp: "2026-07-01T10:00:05.000Z",
        message: {
          id: "m1",
          role: "assistant",
          model: "claude-opus-4-7",
          content: [{ type: "text", text: "ok" }],
          usage: { input_tokens: 5, output_tokens: 5 },
        },
      }),
      JSON.stringify({
        type: "system",
        subtype: "compact_boundary",
        sessionId: "sess-compact",
        timestamp: "2026-07-01T10:00:10.000Z",
        compactMetadata: { trigger: "auto", preTokens: 1234 },
      }),
      JSON.stringify({
        type: "system",
        subtype: "compact_boundary",
        isSidechain: true,
        sessionId: "sess-compact",
        timestamp: "2026-07-01T10:00:11.000Z",
        compactMetadata: { trigger: "auto", preTokens: 99 },
      }),
    ].join("\n");
    const file = join(claude.dir, "projects", "proj-b", "sess-compact.jsonl");
    writeFileSync(file, lines);
    const db = openDb(":memory:");
    await reindex(db, { pricing });
    const row = db
      .query("SELECT compactions, compactions_json FROM sessions WHERE session_id = 'sess-compact'")
      .get() as { compactions: number; compactions_json: string };
    // Only the main-chain boundary counts; the sidechain one is JSON-only.
    expect(row.compactions).toBe(1);
    const detail = JSON.parse(row.compactions_json) as { isSidechain?: boolean }[];
    expect(detail).toHaveLength(2);
    expect(detail.filter((c) => c.isSidechain)).toHaveLength(1);
    db.close();
    rmSync(file, { force: true });
  });
});

describe("reindex · context tax (schema v9)", () => {
  test("round-trips the first main-chain call's prompt tokens, NULL without one", async () => {
    const call = (uuid: string, sidechain: boolean, input: number, cacheRead: number) =>
      JSON.stringify({
        type: "assistant",
        uuid,
        isSidechain: sidechain,
        sessionId: "sess-tax",
        timestamp: "2026-07-02T10:00:00.000Z",
        requestId: `req-${uuid}`,
        message: {
          id: `m-${uuid}`,
          role: "assistant",
          model: "claude-opus-4-7",
          content: [{ type: "text", text: "ok" }],
          usage: {
            input_tokens: input,
            output_tokens: 10,
            cache_read_input_tokens: cacheRead,
            cache_creation: { ephemeral_5m_input_tokens: 500, ephemeral_1h_input_tokens: 0 },
          },
        },
      });
    const withCall = join(claude.dir, "projects", "proj-b", "sess-tax.jsonl");
    // Subagent call first: it must not become the baseline.
    writeFileSync(
      withCall,
      [call("s1", true, 999_999, 0), call("a1", false, 100, 8400)].join("\n"),
    );
    // A session that never reached the model at all.
    const noCall = join(claude.dir, "projects", "proj-b", "sess-notax.jsonl");
    writeFileSync(
      noCall,
      JSON.stringify({
        type: "user",
        uuid: "u1",
        sessionId: "sess-notax",
        timestamp: "2026-07-02T10:00:00.000Z",
        message: { role: "user", content: "hi" },
      }),
    );

    const db = openDb(":memory:");
    await reindex(db, { pricing });
    const rows = db
      .query(
        `SELECT session_id, first_prompt_tokens FROM sessions
          WHERE session_id IN ('sess-tax', 'sess-notax')`,
      )
      .all() as { session_id: string; first_prompt_tokens: number | null }[];
    const byId = new Map(rows.map((r) => [r.session_id, r.first_prompt_tokens]));
    // 100 input + 8400 cache-read + 500 cache-write 5m; the sidechain is skipped.
    expect(byId.get("sess-tax")).toBe(9000);
    expect(byId.get("sess-notax")).toBeNull();

    // …and the column is what contextTax reads.
    expect(contextTax(db, "proj-b").summary.sessions).toBeGreaterThan(0);
    db.close();
    rmSync(withCall, { force: true });
    rmSync(noCall, { force: true });
  });
});

describe("reindex · turn-scoped skill cost (schema v10)", () => {
  test("round-trips per-skill turn attribution into skill_turn_costs_json", async () => {
    const line = (o: unknown) => JSON.stringify(o);
    const call = (uuid: string, minute: number, content: unknown[], sidechain = false) =>
      line({
        type: "assistant",
        uuid,
        isSidechain: sidechain,
        sessionId: "sess-skill",
        timestamp: `2026-07-03T10:0${minute}:00.000Z`,
        requestId: `req-${uuid}`,
        message: {
          id: `m-${uuid}`,
          role: "assistant",
          model: "claude-opus-4-7",
          content,
          usage: { input_tokens: 100, output_tokens: 50 },
        },
      });
    const file = join(claude.dir, "projects", "proj-b", "sess-skill.jsonl");
    writeFileSync(
      file,
      [
        line({
          type: "user",
          uuid: "u1",
          sessionId: "sess-skill",
          timestamp: "2026-07-03T10:00:00.000Z",
          message: { role: "user", content: "write the doc" },
        }),
        call("a1", 1, [{ type: "tool_use", id: "t1", name: "Skill", input: { skill: "docx" } }]),
        // The subagent this turn spawned bills to the same turn.
        call("s1", 2, [{ type: "text", text: "sub" }], true),
        line({
          type: "user",
          uuid: "u2",
          sessionId: "sess-skill",
          timestamp: "2026-07-03T10:03:00.000Z",
          message: { role: "user", content: "now something else" },
        }),
        call("a2", 4, [{ type: "text", text: "done" }]),
      ].join("\n"),
    );

    const db = openDb(":memory:");
    await reindex(db, { pricing });
    const row = db
      .query(
        `SELECT cost_total, skills_json, skill_turn_costs_json FROM sessions
          WHERE session_id = 'sess-skill'`,
      )
      .get() as { cost_total: number; skills_json: string; skill_turn_costs_json: string };
    expect(JSON.parse(row.skills_json)).toEqual({ docx: 1 });
    const attributed = JSON.parse(row.skill_turn_costs_json) as Record<
      string,
      { turns: number; cost: number }
    >;
    expect(attributed.docx?.turns).toBe(1);
    // Turn 1 (main call + subagent call) — strictly less than the session, which
    // also paid for turn 2.
    expect(attributed.docx?.cost).toBeGreaterThan(0);
    expect(attributed.docx?.cost).toBeLessThan(row.cost_total);

    // …and the column is what analyticsRollup reads.
    const skill = analyticsRollup(db, "proj-b").skills.find((s) => s.name === "docx");
    expect(skill?.attributedTurns).toBe(1);
    expect(skill?.attributedCost).toBeCloseTo(attributed.docx?.cost as number, 12);
    db.close();
    rmSync(file, { force: true });
  });
});

describe("reindex · rebuild", () => {
  test("rebuild re-parses everything and still prunes deleted files", async () => {
    const content = await Bun.file(fixture).text();
    const extra = join(claude.dir, "projects", "proj-b", "sess-extra.jsonl");
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
