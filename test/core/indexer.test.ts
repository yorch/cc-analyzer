import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "../../src/core/db.ts";
import { reindex } from "../../src/core/indexer.ts";
import { resolveIndexedProject } from "../../src/core/queries.ts";
import {
  analyticsRollup,
  contextTax,
  parseCoverage,
  portfolioSummary,
  spendByModel,
  spendByProject,
} from "../../src/core/stats.ts";
import { tempClaudeDir } from "../helpers/claude-dir.ts";
import { samplePricing as pricing } from "../helpers/pricing.ts";

/** The stored (root-qualified) id for a fixture project's bare name. */
function indexedId(db: Database, bareName: string): string {
  const match = resolveIndexedProject(db, bareName);
  if (match.status !== "found") throw new Error(`no indexed project '${bareName}'`);
  return match.id;
}

const fixture = fileURLToPath(new URL("../fixtures/sample-session.jsonl", import.meta.url));
let claude: ReturnType<typeof tempClaudeDir>;

beforeAll(async () => {
  claude = tempClaudeDir("cc-analyzer-idx");
  const content = await Bun.file(fixture).text();
  mkdirSync(join(claude.dir, "projects", "proj-a"), { recursive: true });
  mkdirSync(join(claude.dir, "projects", "proj-b"), { recursive: true });
  // Distinct message/request ids per file: byte-identical copies would be
  // cross-file de-duplicated by the indexer and count $0 in rollups.
  const distinct = (n: number) =>
    content.replaceAll('"msg_', `"s${n}-msg_`).replaceAll('"req-', `"s${n}-req-`);
  writeFileSync(join(claude.dir, "projects", "proj-a", "sess-1.jsonl"), distinct(1));
  writeFileSync(join(claude.dir, "projects", "proj-a", "sess-2.jsonl"), distinct(2));
  writeFileSync(join(claude.dir, "projects", "proj-b", "sess-3.jsonl"), distinct(3));
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
    expect(contextTax(db, indexedId(db, "proj-b")).summary.sessions).toBeGreaterThan(0);
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
    const skill = analyticsRollup(db, indexedId(db, "proj-b")).skills.find(
      (s) => s.name === "docx",
    );
    expect(skill?.attributedTurns).toBe(1);
    expect(skill?.attributedCost).toBeCloseTo(attributed.docx?.cost as number, 12);
    db.close();
    rmSync(file, { force: true });
  });
});

describe("reindex · parse coverage (schema v11)", () => {
  test("round-trips the coverage counters and feeds parseCoverage()", async () => {
    const file = join(claude.dir, "projects", "proj-b", "sess-drift.jsonl");
    writeFileSync(
      file,
      [
        JSON.stringify({
          type: "user",
          uuid: "u1",
          sessionId: "sess-drift",
          version: "9.9.9",
          timestamp: "2026-07-04T10:00:00.000Z",
          message: { role: "user", content: "hi" },
        }),
        "not json at all",
        JSON.stringify({ type: "some-future-type", brandNewField: 1 }),
      ].join("\n"),
    );

    const db = openDb(":memory:");
    await reindex(db, { pricing });
    const row = db
      .query(
        `SELECT parse_lines, parse_errors, unknown_events FROM sessions
          WHERE session_id = 'sess-drift'`,
      )
      .get() as { parse_lines: number; parse_errors: number; unknown_events: number };
    expect(row).toEqual({ parse_lines: 3, parse_errors: 1, unknown_events: 1 });

    // …and the columns are what parseCoverage() reads: this session is the only
    // one carrying version 9.9.9, so it owns that row entirely.
    const drift = parseCoverage(db).byVersion.find((v) => v.version === "9.9.9");
    expect(drift).toEqual({
      version: "9.9.9",
      sessions: 1,
      lines: 3,
      parseErrors: 1,
      unknownEvents: 1,
      unparsedShare: 2 / 3,
    });
    db.close();
    rmSync(file, { force: true });
  });
});

describe("reindex · thrash (schema v12)", () => {
  test("round-trips the streak, redundant reads, and re-read files; rollup folds them", async () => {
    const line = (o: unknown) => JSON.stringify(o);
    const toolUse = (uuid: string, name: string, input: unknown) =>
      line({
        type: "assistant",
        uuid,
        sessionId: "sess-thrash",
        timestamp: "2026-07-05T10:00:00.000Z",
        requestId: `req-${uuid}`,
        message: {
          id: `m-${uuid}`,
          role: "assistant",
          model: "claude-opus-4-7",
          content: [{ type: "tool_use", id: `t-${uuid}`, name, input }],
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      });
    const result = (uuid: string, forUuid: string, isError: boolean) =>
      line({
        type: "user",
        uuid,
        sessionId: "sess-thrash",
        timestamp: "2026-07-05T10:00:01.000Z",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: `t-${forUuid}`, is_error: isError }],
        },
      });
    const file = join(claude.dir, "projects", "proj-b", "sess-thrash.jsonl");
    writeFileSync(
      file,
      [
        line({
          type: "user",
          uuid: "u1",
          sessionId: "sess-thrash",
          timestamp: "2026-07-05T10:00:00.000Z",
          message: { role: "user", content: "fix the tests" },
        }),
        // Three failing test runs in a row, edits in between.
        toolUse("b1", "Bash", { command: "bun test" }),
        result("x1", "b1", true),
        toolUse("e1", "Edit", { file_path: "/p/x.ts" }),
        result("x2", "e1", false),
        toolUse("b2", "Bash", { command: "bun test" }),
        result("x3", "b2", true),
        toolUse("b3", "Bash", { command: "bun test" }),
        result("x4", "b3", true),
        // Four reads of the same file: 2 redundant.
        toolUse("r1", "Read", { file_path: "/p/hot.md" }),
        toolUse("r2", "Read", { file_path: "/p/hot.md" }),
        toolUse("r3", "Read", { file_path: "/p/hot.md", offset: 10 }),
        toolUse("r4", "Read", { file_path: "/p/hot.md" }),
      ].join("\n"),
    );

    const db = openDb(":memory:");
    await reindex(db, { pricing });
    const row = db
      .query(
        `SELECT test_fail_streak, redundant_reads, reread_files_json FROM sessions
          WHERE session_id = 'sess-thrash'`,
      )
      .get() as { test_fail_streak: number; redundant_reads: number; reread_files_json: string };
    expect(row.test_fail_streak).toBe(3);
    expect(row.redundant_reads).toBe(2);
    expect(JSON.parse(row.reread_files_json)).toEqual(["/p/hot.md"]);

    // …and the columns are what the rollup folds.
    const thrash = analyticsRollup(db).thrash;
    expect(thrash.testThrashSessions).toBe(1);
    expect(thrash.worstTestFailStreak).toBe(3);
    expect(thrash.redundantReads).toBe(2);
    expect(thrash.rereadSessions).toBe(0); // 2 < the 4-redundant-read session floor
    expect(thrash.topRereadFiles).toEqual([{ file: "/p/hot.md", sessions: 1 }]);
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

describe("reindex · corrections (schema v13)", () => {
  test("round-trips both counters; the rollup folds shares and the weekly trend", async () => {
    const line = (o: unknown) => JSON.stringify(o);
    const prompt = (uuid: string, sec: number, content: unknown) =>
      line({
        type: "user",
        uuid,
        sessionId: "sess-correct",
        timestamp: `2026-07-05T10:00:0${sec}.000Z`,
        message: { role: "user", content },
      });
    const file = join(claude.dir, "projects", "proj-b", "sess-correct.jsonl");
    writeFileSync(
      file,
      [
        prompt("u1", 0, "add a feature"),
        line({
          type: "assistant",
          uuid: "a1",
          sessionId: "sess-correct",
          timestamp: "2026-07-05T10:00:01.000Z",
          requestId: "req-a1",
          message: {
            id: "m-a1",
            role: "assistant",
            model: "claude-opus-4-7",
            content: [{ type: "text", text: "done" }],
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        }),
        // The user hits Esc (turn 2, machine-written marker), then corrects
        // (turn 3, keyword heuristic).
        prompt("u2", 2, [{ type: "text", text: "[Request interrupted by user]" }]),
        prompt("u3", 3, "no, the other file"),
      ].join("\n"),
    );

    const db = openDb(":memory:");
    await reindex(db, { pricing });
    const row = db
      .query(
        `SELECT turns, correction_turns, interruption_turns FROM sessions
          WHERE session_id = 'sess-correct'`,
      )
      .get() as { turns: number; correction_turns: number; interruption_turns: number };
    expect(row).toEqual({ turns: 3, correction_turns: 1, interruption_turns: 1 });

    // …and the columns are what the rollup folds. The three base fixture
    // sessions carry 2 turns each (and no corrections), so the portfolio
    // denominator is 6 + 3 turns, all in the same ISO week.
    const corrections = analyticsRollup(db).corrections;
    expect(corrections.sessions).toBe(1);
    expect(corrections.correctionTurns).toBe(1);
    expect(corrections.interruptionTurns).toBe(1);
    expect(corrections.turns).toBe(9);
    expect(corrections.correctionShare).toBeCloseTo(1 / 9, 12);
    expect(corrections.interruptionShare).toBeCloseTo(1 / 9, 12);
    expect(corrections.weekly).toEqual([{ week: "2026-06-29", correctionTurns: 1, turns: 9 }]);
    db.close();
    rmSync(file, { force: true });
  });

  test("an empty index yields zero shares, not NaN", () => {
    const db = openDb(":memory:");
    const corrections = analyticsRollup(db).corrections;
    expect(corrections).toEqual({
      sessions: 0,
      correctionTurns: 0,
      interruptionTurns: 0,
      turns: 0,
      correctionShare: 0,
      interruptionShare: 0,
      weekly: [],
    });
    db.close();
  });
});

describe("reindex · cross-file usage de-dup (schema v16)", () => {
  const call = (mid: string, req: string, uuid: string) =>
    JSON.stringify({
      type: "assistant",
      uuid,
      sessionId: "sess-parent",
      requestId: req,
      timestamp: "2026-07-01T10:00:05.000Z",
      cwd: "/Users/dev/dedup",
      message: {
        id: mid,
        role: "assistant",
        model: "claude-opus-4-7",
        content: [{ type: "text", text: "ok" }],
        usage: { input_tokens: 10, output_tokens: 20 },
      },
    });
  const prompt = (uuid: string, text: string) =>
    JSON.stringify({
      type: "user",
      uuid,
      sessionId: "sess-parent",
      timestamp: "2026-07-01T10:00:00.000Z",
      cwd: "/Users/dev/dedup",
      message: { role: "user", content: text },
    });
  const parentLines = [
    prompt("du1", "hi"),
    call("dmsg_1", "dreq_1", "da1"),
    call("dmsg_2", "dreq_2", "da2"),
  ];
  // The continuation copies the parent's entries verbatim, then adds one novel call.
  const contLines = [...parentLines, prompt("du2", "continue"), call("dmsg_3", "dreq_3", "da3")];

  const dir = () => join(claude.dir, "projects", "proj-dedup");
  const parentPath = () => join(dir(), "parent.jsonl");
  const contPath = () => join(dir(), "continuation.jsonl");

  function tokensByPath(db: Database): Map<string, { input: number; output: number }> {
    const rows = db
      .query(
        "SELECT path, input_tokens AS input, output_tokens AS output FROM sessions WHERE path LIKE ?",
      )
      .all(`${dir()}%`) as { path: string; input: number; output: number }[];
    return new Map(rows.map((r) => [r.path, { input: r.input, output: r.output }]));
  }

  test("a continuation file's copied calls count once portfolio-wide", async () => {
    const db = openDb(":memory:");
    mkdirSync(dir(), { recursive: true });
    writeFileSync(parentPath(), parentLines.join("\n"));
    await reindex(db, { pricing });

    writeFileSync(contPath(), contLines.join("\n"));
    await reindex(db, { pricing });

    const rows = tokensByPath(db);
    // Parent keeps its 2 calls; the continuation counts only its novel one.
    expect(rows.get(parentPath())).toEqual({ input: 20, output: 40 });
    expect(rows.get(contPath())).toEqual({ input: 10, output: 20 });

    // Claims live in usage_keys, scoped by path.
    const keys = db
      .query("SELECT key, path FROM usage_keys WHERE path LIKE ? ORDER BY key")
      .all(`${dir()}%`) as { key: string; path: string }[];
    expect(keys.map((k) => k.key)).toEqual(["dmsg_1", "dmsg_2", "dmsg_3"]);
    expect(keys[0]?.path).toBe(parentPath());
    expect(keys[2]?.path).toBe(contPath());
    db.close();
  });

  test("totals stay single-counted through a full rebuild", async () => {
    const db = openDb(":memory:");
    await reindex(db, { pricing });
    await reindex(db, { pricing, rebuild: true });
    const rows = tokensByPath(db);
    const total = [...rows.values()].reduce((s, r) => s + r.input, 0);
    // 3 distinct calls x 10 input tokens, however attribution fell.
    expect(total).toBe(30);
    db.close();
  });

  test("pruning a deleted parent frees its claims; a rebuild reclaims them", async () => {
    const db = openDb(":memory:");
    await reindex(db, { pricing });
    rmSync(parentPath());
    await reindex(db, { pricing });
    expect(tokensByPath(db).has(parentPath())).toBe(false);
    const owners = db
      .query("SELECT DISTINCT path FROM usage_keys WHERE path = ?")
      .all(parentPath());
    expect(owners).toHaveLength(0);

    // The surviving continuation row still carries deduped numbers until a
    // rebuild re-analyzes it with the claims freed.
    await reindex(db, { pricing, rebuild: true });
    expect(tokensByPath(db).get(contPath())).toEqual({ input: 30, output: 60 });
    db.close();
  });
});
