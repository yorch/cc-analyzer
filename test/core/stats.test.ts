import type { Database } from "bun:sqlite";
import { beforeAll, describe, expect, test } from "bun:test";
import { openDb } from "../../src/core/db.ts";
import {
  cacheSummary,
  cacheVerdict,
  cacheWasteByProject,
  cacheWasteBySession,
} from "../../src/core/stats.ts";
import { insertSession } from "../helpers/sessions.ts";

interface Row {
  path: string;
  project: string;
  projectPath: string;
  write: number; // cache-write tokens (5m bucket)
  read: number; // cache-read tokens
  costWrite: number;
}

function insert(db: Database, r: Row): void {
  insertSession(db, {
    path: r.path,
    project_id: r.project,
    project_path: r.projectPath,
    cache_write_5m: r.write,
    cache_read: r.read,
    cost_cache_write: r.costWrite,
    cost_cache_read: 0.1,
    cost_input: 1,
    cost_output: 1,
    cost_total: r.costWrite + 2.1,
  });
}

let db: Database;

beforeAll(() => {
  db = openDb(":memory:");
  // leaky project: wrote 1000, read back 100 (ratio 0.1) → waste ≈ 0.9 × $10 = $9
  insert(db, {
    path: "leaky-1",
    project: "p-leaky",
    projectPath: "/p/leaky",
    write: 1000,
    read: 100,
    costWrite: 10,
  });
  // efficient project: wrote 1000, read 3000 (ratio 3) → fully amortized, waste $0
  insert(db, {
    path: "eff-1",
    project: "p-eff",
    projectPath: "/p/eff",
    write: 1000,
    read: 3000,
    costWrite: 10,
  });
  // mixed project: one wasteful + one efficient session. Aggregate ratio 2.0 looks
  // "efficient", but per-session-then-sum still surfaces the $5 leak.
  insert(db, {
    path: "mix-1",
    project: "p-mix",
    projectPath: "/p/mix",
    write: 500,
    read: 0,
    costWrite: 5,
  });
  insert(db, {
    path: "mix-2",
    project: "p-mix",
    projectPath: "/p/mix",
    write: 500,
    read: 2000,
    costWrite: 5,
  });
  // no-cache project: never wrote to cache → excluded from the hit-list
  insert(db, {
    path: "none-1",
    project: "p-none",
    projectPath: "/p/none",
    write: 0,
    read: 0,
    costWrite: 0,
  });
});

describe("cacheVerdict", () => {
  test("thresholds on the read:write ratio", () => {
    expect(cacheVerdict(3)).toBe("efficient");
    expect(cacheVerdict(2)).toBe("efficient");
    expect(cacheVerdict(1.5)).toBe("ok");
    expect(cacheVerdict(1)).toBe("ok");
    expect(cacheVerdict(0.5)).toBe("leaky");
    expect(cacheVerdict(0)).toBe("leaky");
  });
});

describe("cacheWasteByProject", () => {
  test("ranks by un-amortized write $, excludes no-cache projects", () => {
    const rows = cacheWasteByProject(db);
    expect(rows.map((r) => r.projectId)).toEqual(["p-leaky", "p-mix", "p-eff"]);
    expect(rows.find((r) => r.projectId === "p-none")).toBeUndefined();
  });

  test("waste and ratio are computed correctly", () => {
    const byId = Object.fromEntries(cacheWasteByProject(db).map((r) => [r.projectId, r]));
    expect(byId["p-leaky"]?.waste).toBeCloseTo(9, 5);
    expect(byId["p-leaky"]?.ratio).toBeCloseTo(0.1, 5);
    expect(byId["p-eff"]?.waste).toBeCloseTo(0, 5);
    expect(byId["p-eff"]?.ratio).toBeCloseTo(3, 5);
    // per-session-then-sum: aggregate ratio is 2.0 but $5 still leaked
    expect(byId["p-mix"]?.ratio).toBeCloseTo(2, 5);
    expect(byId["p-mix"]?.waste).toBeCloseTo(5, 5);
  });
});

describe("cacheWasteBySession", () => {
  test("ranks a project's sessions, wasteful first", () => {
    const rows = cacheWasteBySession(db, "p-mix");
    expect(rows).toHaveLength(2);
    expect(rows[0]?.sessionId).toBe("mix-1");
    expect(rows[0]?.waste).toBeCloseTo(5, 5);
    expect(rows[1]?.waste).toBeCloseTo(0, 5);
  });
});

describe("cacheSummary", () => {
  test("sums cache write cost and total waste across the portfolio", () => {
    const s = cacheSummary(db);
    expect(s.writeCost).toBeCloseTo(30, 5); // 10 + 10 + 5 + 5
    expect(s.waste).toBeCloseTo(14, 5); // 9 + 0 + 5 + 0
    expect(s.totalCost).toBeGreaterThan(0);
  });
});
