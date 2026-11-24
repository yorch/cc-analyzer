import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { openDb } from "../../src/core/db.ts";
import { listIndexedProjects } from "../../src/core/queries.ts";
import {
  analyticsRollup,
  buildPortfolioStats,
  compactionUsage,
  costDistribution,
  modelMixByDay,
  projectTrends,
  sessionScatter,
  spendByDay,
  turnDepthStats,
} from "../../src/core/stats.ts";
import { insertSession } from "../helpers/sessions.ts";

let db: Database;

beforeAll(() => {
  db = openDb(":memory:");
  insertSession(db, {
    path: "/p1/a.jsonl",
    project_id: "p1",
    project_path: "/p/one",
    day: "2026-07-01",
    month: "2026-07",
    cost_total: 1,
    duration_ms: 60_000,
    input_tokens: 100,
    output_tokens: 100,
    models_json: JSON.stringify({ "claude-opus-4-7": { cost: { total: 1 } } }),
    tools_json: JSON.stringify({ Bash: 4, Read: 2 }),
    tool_errors_json: JSON.stringify({ Bash: 1 }),
    turn_depths_json: JSON.stringify([1, 3, 9]),
    compactions: 2,
    compactions_json: JSON.stringify([
      { timestamp: "t1", trigger: "auto" },
      { timestamp: "t2", trigger: "manual" },
      { timestamp: "t3", trigger: "auto", isSidechain: true },
      { timestamp: "t0", inherited: true },
    ]),
  });
  insertSession(db, {
    path: "/p1/b.jsonl",
    project_id: "p1",
    project_path: "/p/one",
    day: "2026-07-02",
    month: "2026-07",
    cost_total: 3,
    duration_ms: 120_000,
    tools_json: JSON.stringify({ Bash: 1 }),
    turn_depths_json: JSON.stringify([2]),
  });
  insertSession(db, {
    path: "/p2/c.jsonl",
    project_id: "p2",
    project_path: "/p/two",
    day: "2026-07-02",
    month: "2026-07",
    cost_total: 10,
    duration_ms: 30_000,
    models_json: JSON.stringify({ "claude-haiku-4-5": { cost: { total: 10 } } }),
    tools_json: JSON.stringify({ Write: 7 }),
    turn_depths_json: JSON.stringify([1]),
  });
});

afterAll(() => db.close());

describe("project-scoped rollups", () => {
  test("the shared stats report scopes every section to one project", () => {
    const stats = buildPortfolioStats(db, "2026-07-23", { projectId: "p1" });
    expect(stats.summary).toMatchObject({ sessions: 2, projects: 1, cost: 4 });
    expect(stats.byProject).toEqual([]);
    expect(stats.byMonth.map((row) => row.cost)).toEqual([4]);
    expect(stats.byModel.map((row) => row.model)).toEqual(["claude-opus-4-7"]);
    expect(stats.top.map((row) => row.cost)).toEqual([3, 1]);
    expect(stats.duration.sessions).toBe(2);
    expect(stats.distribution.sessions).toBe(2);

    const tools = analyticsRollup(db, "p1").tools;
    expect(tools.map((row) => row.tool)).toEqual(["Bash", "Read"]);
  });

  test("spendByDay filters to one project", () => {
    expect(spendByDay(db).map((d) => d.cost)).toEqual([1, 13]);
    expect(spendByDay(db, "p1").map((d) => d.cost)).toEqual([1, 3]);
    expect(spendByDay(db, "p2")).toHaveLength(1);
  });

  test("costDistribution filters to one project", () => {
    expect(costDistribution(db).sessions).toBe(3);
    const p1 = costDistribution(db, "p1");
    expect(p1.sessions).toBe(2);
    expect(p1.max).toBe(3);
  });

  test("sessionScatter filters to one project", () => {
    expect(sessionScatter(db, 10)).toHaveLength(3);
    expect(sessionScatter(db, 10, "p1")).toHaveLength(2);
  });

  test("modelMixByDay filters to one project", () => {
    const models = new Set(modelMixByDay(db, 6, "p1").map((r) => r.model));
    expect(models).toEqual(new Set(["claude-opus-4-7"]));
  });

  test("projectTrends folds tool uses, sessions and error rates per project", () => {
    const p1 = projectTrends(db, "p1").tools;
    const bash = p1.find((t) => t.tool === "Bash");
    expect(bash).toEqual({ tool: "Bash", uses: 5, errors: 1, errorRate: 0.2, sessions: 2 });
    expect(p1.some((t) => t.tool === "Write")).toBe(false);
    expect(projectTrends(db, "p2").tools.some((t) => t.tool === "Write")).toBe(true);
  });

  test("turnDepthStats buckets depths per project", () => {
    const p1 = turnDepthStats(db, "p1");
    expect(p1.turns).toBe(4);
    expect(p1.maxDepth).toBe(9);
    // depths 1,3,9,2 → buckets 1 / 2–3 ×2 / 8–15
    expect(p1.buckets.map((b) => b.turns)).toEqual([1, 2, 0, 1, 0]);
    expect(turnDepthStats(db).turns).toBe(5);
  });

  test("projectTrends bundles every series for one project", () => {
    const t = projectTrends(db, "p1");
    expect(t.daily).toHaveLength(2);
    expect(t.distribution.sessions).toBe(2);
    expect(t.turnDepth.turns).toBe(4);
    expect(t.tools.length).toBeGreaterThan(0);
    expect(t.scatter).toHaveLength(2);
  });
});

describe("compaction rollups (schema v7)", () => {
  test("summary counts own compactions from the INT column, splits from JSON", () => {
    const u = compactionUsage(db);
    expect(u.summary.totalSessions).toBe(3);
    expect(u.summary.sessions).toBe(1); // only p1/a has own compactions
    expect(u.summary.compactions).toBe(2);
    expect(u.summary.auto).toBe(1);
    expect(u.summary.manual).toBe(1);
    expect(u.summary.unknown).toBe(0);
    expect(u.summary.sidechain).toBe(1);
    expect(u.summary.inherited).toBe(1);
  });

  test("byProject ranks projects with compactions and computes the share", () => {
    const u = compactionUsage(db);
    expect(u.byProject).toHaveLength(1);
    const p1 = u.byProject[0];
    expect(p1?.projectId).toBe("p1");
    expect(p1?.compactions).toBe(2);
    expect(p1?.sessionsWithCompaction).toBe(1);
    expect(p1?.share).toBeCloseTo(0.5, 10);
  });

  test("byProject keeps a small high-share project beyond the top-N by count, with claudeDir", () => {
    const db2 = openDb(":memory:");
    // Three big projects (many compactions, low share) crowd a limit of 3.
    for (const id of ["big1", "big2", "big3"]) {
      for (let i = 0; i < 10; i++) {
        insertSession(db2, {
          path: `/${id}/${i}.jsonl`,
          project_id: id,
          claude_dir: "/root-a",
          compactions: i === 0 ? 20 : 0,
        });
      }
    }
    // One tiny project where every session compacts once.
    for (let i = 0; i < 5; i++) {
      insertSession(db2, {
        path: `/small/${i}.jsonl`,
        project_id: "small",
        claude_dir: "/root-b",
        compactions: 1,
      });
    }
    const u = compactionUsage(db2, 3);
    const small = u.byProject.find((p) => p.projectId === "small");
    expect(small?.share).toBe(1);
    expect(small?.claudeDir).toBe("/root-b");
    expect(u.byProject.find((p) => p.projectId === "big1")?.claudeDir).toBe("/root-a");
  });

  test("byShare ranks only rule-qualifying projects and the result stays within limit", () => {
    const db2 = openDb(":memory:");
    // 30 large, low-share projects: 10 sessions, 1 compacting with many compactions.
    for (let p = 0; p < 30; p++) {
      for (let i = 0; i < 10; i++) {
        insertSession(db2, {
          path: `/big${p}/${i}.jsonl`,
          project_id: `big${String(p).padStart(2, "0")}`,
          compactions: i === 0 ? 50 : 0,
        });
      }
    }
    // 30 one-session projects at share 1.0.
    for (let p = 0; p < 30; p++) {
      insertSession(db2, {
        path: `/tiny${p}/0.jsonl`,
        project_id: `tiny${String(p).padStart(2, "0")}`,
        compactions: 1,
      });
    }
    // Target: 10 sessions, 8 compacting once (share 0.8).
    for (let i = 0; i < 10; i++) {
      insertSession(db2, {
        path: `/target/${i}.jsonl`,
        project_id: "target",
        compactions: i < 8 ? 1 : 0,
      });
    }
    const u = compactionUsage(db2, 30);
    expect(u.byProject.find((p) => p.projectId === "target")?.share).toBeCloseTo(0.8, 10);
    expect(u.byProject.length).toBeLessThanOrEqual(30);
  });

  test("copied rows dedupe every category by boundary uuid", () => {
    const db2 = openDb(":memory:");
    const blob = JSON.stringify([
      { timestamp: "t1", uuid: "o1", trigger: "auto" },
      { timestamp: "t2", uuid: "s1", isSidechain: true },
      { timestamp: "t0", uuid: "i1", inherited: true },
    ]);
    insertSession(db2, { path: "/x/a.jsonl", compactions: 1, compactions_json: blob });
    insertSession(db2, { path: "/x/b.jsonl", compactions: 1, compactions_json: blob });
    const u = compactionUsage(db2);
    expect(u.summary.compactions).toBe(1);
    expect(u.summary.auto).toBe(1);
    expect(u.summary.sidechain).toBe(1); // not doubled by the copy
    expect(u.summary.inherited).toBe(1);
    expect(u.summary.sessions).toBe(1);
    db2.close();
  });

  test("listIndexedProjects carries the summed compaction count", () => {
    const projects = listIndexedProjects(db);
    expect(projects.find((p) => p.projectId === "p1")?.compactions).toBe(2);
    expect(projects.find((p) => p.projectId === "p2")?.compactions).toBe(0);
  });
});
