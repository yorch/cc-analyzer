import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { openDb } from "../../src/core/db.ts";
import {
  analyticsRollup,
  cacheTtlSplit,
  concurrency,
  costDistribution,
  durationSummary,
  errorRateByWeek,
  estimatedShareByProject,
  hotFiles,
  idleVsCache,
  modelMixByDay,
  runRate,
  sessionScatter,
  sidechainByProject,
  sidechainSummary,
  streaks,
  webToolUsage,
} from "../../src/core/stats.ts";
import { insertSession as insert } from "../helpers/sessions.ts";

const fresh = (): Database => openDb(":memory:");

describe("costDistribution", () => {
  test("percentiles, buckets and top-decile concentration", () => {
    const db = fresh();
    const costs = [0.005, 0.05, 0.5, 5, 50, 500];
    costs.forEach((c, i) => {
      insert(db, { path: `s${i}`, cost_total: c });
    });
    insert(db, { path: "zero", cost_total: 0 }); // excluded

    const d = costDistribution(db);
    expect(d.sessions).toBe(6);
    expect(d.p50).toBeCloseTo(2.75, 5); // midpoint of 0.5 and 5
    expect(d.max).toBe(500);
    expect(d.buckets.map((b) => b.count)).toEqual([1, 1, 1, 1, 1, 1]);
    // Fewer than 10 sessions: there is no "top 10%" cohort to report.
    expect(d.topDecileShare).toBeNull();
  });

  test("topDecileShare only reported with a real decile (≥10 sessions)", () => {
    const db = fresh();
    for (let i = 0; i < 9; i++) insert(db, { path: `s${i}`, cost_total: 1 });
    insert(db, { path: "big", cost_total: 91 });
    expect(costDistribution(db).topDecileShare).toBeCloseTo(0.91, 5);
  });
});

describe("streaks", () => {
  test("longest and current runs plus 30-day window", () => {
    const db = fresh();
    for (const day of ["2026-07-01", "2026-07-19", "2026-07-20", "2026-07-21"]) {
      insert(db, { path: day, day });
    }
    const s = streaks(db, "2026-07-21");
    expect(s.activeDays).toBe(4);
    expect(s.longestStreak).toBe(3);
    expect(s.currentStreak).toBe(3);
    expect(s.last30ActiveDays).toBe(4);
  });

  test("streak survives when today is not yet active", () => {
    const db = fresh();
    insert(db, { path: "a", day: "2026-07-20" });
    const s = streaks(db, "2026-07-21");
    expect(s.currentStreak).toBe(1);
  });

  test("cold streak is zero", () => {
    const db = fresh();
    insert(db, { path: "a", day: "2026-07-01" });
    expect(streaks(db, "2026-07-21").currentStreak).toBe(0);
  });
});

describe("runRate", () => {
  test("month-to-date, previous-month comparison and projection", () => {
    const db = fresh();
    insert(db, { path: "a", day: "2026-07-05", cost_total: 10 });
    insert(db, { path: "b", day: "2026-07-20", cost_total: 20 });
    insert(db, { path: "c", day: "2026-06-10", cost_total: 15 });
    insert(db, { path: "d", day: "2026-06-25", cost_total: 30 });

    const r = runRate(db, "2026-07-21");
    expect(r.month).toBe("2026-07");
    expect(r.monthToDate).toBe(30);
    expect(r.prevMonth).toBe("2026-06");
    expect(r.prevMonthSamePoint).toBe(15); // only the 06-10 session by the 21st
    expect(r.prevMonthTotal).toBe(45);
    expect(r.projected).toBeCloseTo((30 / 21) * 31, 5);
  });
});

describe("durationSummary / sessionScatter", () => {
  test("aggregates durations and active share", () => {
    const db = fresh();
    insert(db, { path: "a", duration_ms: 100_000, active_ms: 50_000, cost_total: 1 });
    insert(db, { path: "b", duration_ms: 300_000, active_ms: 150_000, cost_total: 2 });
    insert(db, { path: "no-duration" });

    const d = durationSummary(db);
    expect(d.sessions).toBe(2);
    expect(d.totalMs).toBe(400_000);
    expect(d.medianMs).toBe(200_000);
    expect(d.activeShare).toBeCloseTo(0.5, 5);

    const scatter = sessionScatter(db);
    expect(scatter).toHaveLength(2);
    expect(scatter[0]?.cost).toBe(2); // ordered by cost desc
  });
});

describe("sidechain rollups", () => {
  test("summary share and per-project ranking", () => {
    const db = fresh();
    insert(db, {
      path: "a",
      cost_total: 10,
      sidechain_cost: 4,
      sidechain_calls: 3,
      api_calls: 10,
    });
    insert(db, { path: "b", project_id: "p2", project_path: "/p/two", cost_total: 10 });

    const s = sidechainSummary(db);
    expect(s.cost).toBe(4);
    expect(s.share).toBeCloseTo(0.2, 5);

    const rows = sidechainByProject(db);
    expect(rows).toHaveLength(1); // p2 has no sidechain spend
    expect(rows[0]?.projectId).toBe("p1");
    expect(rows[0]?.share).toBeCloseTo(0.4, 5);
  });
});

describe("cacheTtlSplit / webToolUsage / estimatedShareByProject", () => {
  test("small rollups", () => {
    const db = fresh();
    insert(db, {
      path: "a",
      cache_write_5m: 100,
      cache_write_1h: 50,
      cost_cache_write: 2,
      web_searches: 3,
      web_fetches: 1,
      cost_total: 8,
      cost_estimated: 1,
    });
    insert(db, { path: "b", cost_total: 2 });

    expect(cacheTtlSplit(db)).toEqual({ write5mTokens: 100, write1hTokens: 50, writeCost: 2 });

    const wt = webToolUsage(db);
    expect(wt.summary).toEqual({ searches: 3, fetches: 1, sessions: 1 });
    expect(wt.byProject).toHaveLength(1);

    const est = estimatedShareByProject(db);
    expect(est).toHaveLength(1);
    expect(est[0]?.estimatedCost).toBe(8);
    expect(est[0]?.share).toBeCloseTo(0.8, 5);
  });
});

describe("JSON rollups", () => {
  test("hotFiles dedupes per session and tracks last touch", () => {
    const db = fresh();
    insert(db, { path: "a", day: "2026-01-01", files_json: '["/x/a.ts","/x/b.ts"]' });
    insert(db, { path: "b", day: "2026-02-01", files_json: '["/x/a.ts"]' });
    insert(db, { path: "other", project_id: "p2", files_json: '["/y/c.ts"]' });

    const all = hotFiles(db);
    expect(all[0]).toEqual({ file: "/x/a.ts", sessions: 2, lastDay: "2026-02-01" });
    expect(hotFiles(db, "p2").map((f) => f.file)).toEqual(["/y/c.ts"]);
  });

  test("modelMixByDay folds top models and 'other'", () => {
    const db = fresh();
    const models = (m: Record<string, number>) =>
      JSON.stringify(
        Object.fromEntries(Object.entries(m).map(([k, cost]) => [k, { cost: { total: cost } }])),
      );
    insert(db, { path: "a", day: "2026-01-01", models_json: models({ opus: 5, sonnet: 1 }) });
    insert(db, { path: "b", day: "2026-01-02", models_json: models({ opus: 2 }) });

    const rows = modelMixByDay(db, 1); // only 'opus' stays; sonnet folds into other
    expect(rows).toEqual([
      { day: "2026-01-01", model: "opus", cost: 5 },
      { day: "2026-01-01", model: "other", cost: 1 },
      { day: "2026-01-02", model: "opus", cost: 2 },
    ]);
  });

  test("permission modes, stop reasons, versions, branches", () => {
    const db = fresh();
    insert(db, {
      path: "a",
      day: "2026-01-01",
      cost_total: 10,
      permission_modes_json: '{"plan":2,"default":1}',
      stop_reasons_json: '{"end_turn":3,"max_tokens":1}',
      versions_json: '["1.2.0"]',
      branches_json: '["main","feat"]',
    });
    insert(db, {
      path: "b",
      day: "2026-01-05",
      cost_total: 2,
      permission_modes_json: '{"plan":1}',
      versions_json: '["1.3.0"]',
      branches_json: '["main"]',
    });

    const rollup = analyticsRollup(db);
    expect(rollup.permissionModes[0]).toMatchObject({
      mode: "plan",
      turns: 3,
      sessions: 2,
      totalCost: 12,
    });

    expect(rollup.stopReasons).toEqual([
      { reason: "end_turn", count: 3, sessions: 1 },
      { reason: "max_tokens", count: 1, sessions: 1 },
    ]);

    expect(rollup.versions[0]?.version).toBe("1.3.0"); // most recently seen first
    expect(rollup.versions[1]).toMatchObject({ version: "1.2.0", firstDay: "2026-01-01" });

    expect(rollup.branches[0]).toEqual({ branch: "main", sessions: 2, cost: 12 });
  });

  test("bash families, test runs and retries classify from raw command heads", () => {
    const db = fresh();
    insert(db, {
      path: "a",
      commands_json: '{"git status":3,"git commit -m":2,"bun test":2}',
      command_errors_json: '{"bun test":1}',
      retries: 3,
      retries_json: '{"Edit":2,"Bash":1}',
    });
    insert(db, { path: "b", commands_json: '{"git push":1}' });

    const rollup = analyticsRollup(db);
    // Families fold at query time from the stored heads.
    expect(rollup.bash[0]).toEqual({
      command: "git",
      uses: 6,
      errors: 0,
      errorRate: 0,
      sessions: 2,
    });
    expect(rollup.bash[1]).toEqual({
      command: "bun",
      uses: 2,
      errors: 1,
      errorRate: 0.5,
      sessions: 1,
    });

    // "bun test" heads classify as test runs — also at query time.
    expect(rollup.tests).toEqual({ runs: 2, failures: 1, sessions: 1, failureRate: 0.5 });

    expect(rollup.retries.total).toBe(3);
    expect(rollup.retries.sessions).toBe(1);
    expect(rollup.retries.byTool[0]).toEqual({ tool: "Edit", retries: 2, sessions: 1 });
  });

  test("turn depth buckets and monthly averages", () => {
    const db = fresh();
    insert(db, { path: "a", month: "2026-01", turn_depths_json: "[1,2,5]" });
    insert(db, { path: "b", month: "2026-02", turn_depths_json: "[20]" });

    const d = analyticsRollup(db).turnDepth;
    expect(d.turns).toBe(4);
    expect(d.avgDepth).toBeCloseTo(7, 5);
    expect(d.maxDepth).toBe(20);
    expect(d.buckets.map((b) => b.turns)).toEqual([1, 1, 1, 0, 1]);
    expect(d.byMonth).toEqual([
      { month: "2026-01", avgDepth: 8 / 3, turns: 3 },
      { month: "2026-02", avgDepth: 20, turns: 1 },
    ]);
  });

  test("errorRateByWeek folds tool counts into ISO weeks", () => {
    const db = fresh();
    // 2026-01-05 is a Monday; 01-07 lands in the same week, 01-12 in the next.
    insert(db, {
      path: "a",
      day: "2026-01-05",
      tools_json: '{"Bash":8}',
      tool_errors_json: '{"Bash":2}',
    });
    insert(db, { path: "b", day: "2026-01-07", tools_json: '{"Read":2}' });
    insert(db, { path: "c", day: "2026-01-12", tools_json: '{"Bash":5}' });

    const rows = errorRateByWeek(db);
    expect(rows).toEqual([
      { week: "2026-01-05", toolCalls: 10, errors: 2, errorRate: 0.2 },
      { week: "2026-01-12", toolCalls: 5, errors: 0, errorRate: 0 },
    ]);
  });
});

describe("concurrency", () => {
  test("sweep counts overlapping sessions per day", () => {
    const db = fresh();
    // Two overlapping sessions on Jan 5, one solo on Jan 6 (UTC noon → same local day
    // in any timezone within ±11h).
    insert(db, { path: "a", start_time: "2026-01-05T12:00:00Z", end_time: "2026-01-05T13:00:00Z" });
    insert(db, { path: "b", start_time: "2026-01-05T12:30:00Z", end_time: "2026-01-05T14:00:00Z" });
    insert(db, { path: "c", start_time: "2026-01-06T12:00:00Z", end_time: "2026-01-06T12:30:00Z" });

    const c = concurrency(db);
    expect(c.peak).toBe(2);
    expect(c.days).toHaveLength(2);
    expect(c.days[0]?.maxConcurrent).toBe(2);
    expect(c.days[1]?.maxConcurrent).toBe(1);
    expect(c.parallelDayShare).toBeCloseTo(0.5, 5);
  });

  test("touching sessions do not overlap", () => {
    const db = fresh();
    insert(db, { path: "a", start_time: "2026-01-05T12:00:00Z", end_time: "2026-01-05T13:00:00Z" });
    insert(db, { path: "b", start_time: "2026-01-05T13:00:00Z", end_time: "2026-01-05T14:00:00Z" });
    expect(concurrency(db).peak).toBe(1);
  });

  test("overlap persisting past midnight is credited to the morning side", () => {
    const db = fresh();
    // The two sessions overlap for 25 hours, so the overlap crosses at least
    // one local midnight in every timezone — the day after the crossing must
    // report maxConcurrent 2 even though no session *starts* on it.
    insert(db, { path: "a", start_time: "2026-01-05T20:00:00Z", end_time: "2026-01-06T23:00:00Z" });
    insert(db, { path: "b", start_time: "2026-01-05T21:00:00Z", end_time: "2026-01-06T22:00:00Z" });
    const c = concurrency(db);
    expect(c.peak).toBe(2);
    expect(c.days.filter((d) => d.maxConcurrent === 2).length).toBeGreaterThanOrEqual(2);
  });

  test("zero-duration sessions still count toward their day", () => {
    const db = fresh();
    insert(db, { path: "a", start_time: "2026-01-05T12:00:00Z", end_time: "2026-01-05T12:00:00Z" });
    const c = concurrency(db);
    expect(c.peak).toBe(1);
    expect(c.days).toHaveLength(1);
  });
});

describe("idleVsCache", () => {
  test("buckets sessions by idle share with per-bucket cache outcomes", () => {
    const db = fresh();
    // Busy session: 10% idle, cache fully amortized.
    insert(db, {
      path: "busy",
      duration_ms: 100_000,
      active_ms: 90_000,
      cache_write_5m: 1000,
      cache_read: 5000,
      cost_cache_write: 10,
    });
    // Idle session: 90% idle, nothing read back.
    insert(db, {
      path: "idle",
      duration_ms: 100_000,
      active_ms: 10_000,
      cache_write_5m: 1000,
      cache_read: 0,
      cost_cache_write: 10,
    });

    const buckets = idleVsCache(db);
    expect(buckets).toHaveLength(4);
    expect(buckets[0]).toMatchObject({ bucket: "<25% idle", sessions: 1 });
    expect(buckets[0]?.ratio).toBeCloseTo(5, 5);
    expect(buckets[0]?.wasteShare).toBeCloseTo(0, 5);
    expect(buckets[3]).toMatchObject({ bucket: "75%+ idle", sessions: 1 });
    expect(buckets[3]?.wasteShare).toBeCloseTo(1, 5);
  });
});
