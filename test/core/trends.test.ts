import type { Database } from "bun:sqlite";
import { beforeAll, describe, expect, test } from "bun:test";
import { openDb } from "../../src/core/db.ts";
import { activityHeatmap, spendByDay } from "../../src/core/stats.ts";
import { insertSession } from "../helpers/sessions.ts";

function insert(
  db: Database,
  o: { path: string; day?: string; startTime?: string; cost?: number; io?: number; cache?: number },
): void {
  insertSession(db, {
    path: o.path,
    day: o.day ?? null,
    start_time: o.startTime ?? null,
    cost_total: o.cost ?? 0,
    input_tokens: o.io ?? 0,
    cache_read: o.cache ?? 0,
  });
}

let db: Database;
beforeAll(() => {
  db = openDb(":memory:");
  // Daily burn rows (keyed on the `day` column; no start_time → not in the heatmap).
  insert(db, { path: "d1", day: "2026-07-01", cost: 5, io: 100, cache: 1000 });
  insert(db, { path: "d2", day: "2026-07-01", cost: 3, io: 50, cache: 500 });
  insert(db, { path: "d3", day: "2026-07-03", cost: 10, io: 200, cache: 2000 });
  // Heatmap rows (start_time only). h1 & h2 share a UTC hour → always one bucket,
  // regardless of the machine timezone; h3 is a different hour.
  insert(db, { path: "h1", startTime: "2026-07-06T14:00:00.000Z", cost: 1 });
  insert(db, { path: "h2", startTime: "2026-07-06T14:30:00.000Z", cost: 2 });
  insert(db, { path: "h3", startTime: "2026-07-07T09:00:00.000Z", cost: 4 });
});

describe("spendByDay", () => {
  test("groups by day, oldest first, summing cost/tokens/sessions", () => {
    const rows = spendByDay(db);
    expect(rows.map((r) => r.day)).toEqual(["2026-07-01", "2026-07-03"]);
    expect(rows[0]).toMatchObject({ cost: 8, sessions: 2, ioTokens: 150, cacheTokens: 1500 });
    expect(rows[1]).toMatchObject({ day: "2026-07-03", cost: 10, sessions: 1 });
  });
});

describe("activityHeatmap", () => {
  test("buckets sessions/cost by weekday×hour (timezone-independent invariants)", () => {
    const cells = activityHeatmap(db);
    // two same-hour sessions collapse into one cell; the third is its own cell
    expect(cells).toHaveLength(2);
    expect(cells.reduce((s, c) => s + c.sessions, 0)).toBe(3);
    expect(cells.reduce((s, c) => s + c.cost, 0)).toBeCloseTo(7, 5);
    expect(cells.map((c) => c.sessions).sort()).toEqual([1, 2]);
    for (const c of cells) {
      expect(c.weekday).toBeGreaterThanOrEqual(0);
      expect(c.weekday).toBeLessThanOrEqual(6);
      expect(c.hour).toBeGreaterThanOrEqual(0);
      expect(c.hour).toBeLessThanOrEqual(23);
    }
  });
});
