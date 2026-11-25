import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { renderWeeklyDigest } from "../../src/cli/render.ts";
import { openDb } from "../../src/core/db.ts";
import { buildDigestMarkdown, isEmptyPeriod } from "../../src/core/digest.ts";
import { buildWeeklyDigest } from "../../src/core/digest-signals.ts";
import { samplePricing as pricing } from "../helpers/pricing.ts";
import { insertSession } from "../helpers/sessions.ts";

/**
 * Two full ISO weeks, with sessions parked on both boundary days:
 *   prior week   2026-06-29 (Mon) … 2026-07-05 (Sun)
 *   digest week  2026-07-06 (Mon) … 2026-07-12 (Sun)
 *   after        2026-07-13 (Mon) — the next week, must never leak in
 * Today is Wed 2026-07-15, so the default period is the digest week.
 */
const TODAY = "2026-07-15";

function seed(db: Database): void {
  // Prior week: one session, on the closing Sunday.
  insertSession(db, {
    path: "prior-sun",
    day: "2026-07-05",
    project_id: "p1",
    project_path: "/p/one",
    cost_total: 10,
    active_ms: 60_000,
    input_tokens: 100,
    output_tokens: 100,
    models_json: JSON.stringify({ "claude-opus-4-7": { apiCalls: 3, cost: { total: 10 } } }),
    skills_json: JSON.stringify({ tidy: 9 }),
    skill_turn_costs_json: JSON.stringify({ tidy: { turns: 9, cost: 90 } }),
  });
  // Digest week: opening Monday and closing Sunday — both must be inside.
  insertSession(db, {
    path: "week-mon",
    day: "2026-07-06",
    project_id: "p1",
    project_path: "/p/one",
    cost_total: 12,
    active_ms: 120_000,
    input_tokens: 500,
    output_tokens: 500,
    cache_write_5m: 1000,
    cache_read: 4000,
    cost_cache_write: 4,
    cost_cache_read: 1,
    models_json: JSON.stringify({ "claude-opus-4-7": { apiCalls: 5, cost: { total: 12 } } }),
    tools_json: JSON.stringify({ Bash: 8, Read: 2 }),
    tool_errors_json: JSON.stringify({ Bash: 1 }),
    skills_json: JSON.stringify({ tidy: 2 }),
    skill_turn_costs_json: JSON.stringify({ tidy: { turns: 2, cost: 3 } }),
    turns: 10,
    correction_turns: 2,
    interruption_turns: 1,
  });
  insertSession(db, {
    path: "week-sun",
    day: "2026-07-12",
    project_id: "p2",
    project_path: "/p/two",
    cost_total: 3,
    active_ms: 30_000,
  });
  // Next week — outside the period on the other boundary.
  insertSession(db, {
    path: "after-mon",
    day: "2026-07-13",
    project_id: "p1",
    project_path: "/p/one",
    cost_total: 99,
    active_ms: 900_000,
    skills_json: JSON.stringify({ tidy: 50 }),
    skill_turn_costs_json: JSON.stringify({ tidy: { turns: 50, cost: 500 } }),
  });
}

let db: Database;
beforeEach(() => {
  db = openDb(":memory:");
  seed(db);
});

/** The audit scan touches the filesystem; the digest's numbers don't need it. */
const build = (opts: { week?: string } = {}) =>
  buildWeeklyDigest(db, pricing, { today: TODAY, audit: false, ...opts });

describe("buildWeeklyDigest period scoping", () => {
  test("defaults to the last complete week and compares against the one before", () => {
    const d = build();
    expect(d.period).toEqual({ start: "2026-07-06", end: "2026-07-12" });
    expect(d.prior).toEqual({ start: "2026-06-29", end: "2026-07-05" });
    expect(d.today).toBe(TODAY);
  });

  test("counts sessions on both boundary days and excludes the next week", () => {
    const h = build().headline;
    // 12 (Mon) + 3 (Sun); the $99 session on the following Monday is excluded.
    expect(h.cost.current).toBe(15);
    expect(h.sessions.current).toBe(2);
    expect(h.cost.prior).toBe(10);
    expect(h.sessions.prior).toBe(1);
    expect(h.cost.absolute).toBe(5);
    expect(h.cost.share).toBeCloseTo(0.5, 10);
    expect(h.activeMs.current).toBe(150_000);
  });

  test("--week selects the week containing any given day", () => {
    // Any day inside the prior week yields that week, with its own predecessor.
    for (const day of ["2026-06-29", "2026-07-02", "2026-07-05"]) {
      const d = build({ week: day });
      expect(d.period).toEqual({ start: "2026-06-29", end: "2026-07-05" });
      expect(d.headline.cost.current).toBe(10);
      // Nothing indexed two weeks back: no baseline, so no percentage.
      expect(d.headline.cost.share).toBeNull();
    }
  });

  test("ranks the period's projects and deltas each against its own prior cost", () => {
    const d = build();
    expect(d.projects.map((p) => [p.projectId, p.cost, p.sessions])).toEqual([
      ["p1", 12, 1],
      ["p2", 3, 1],
    ]);
    // p1 ran in both weeks; p2 is new this week.
    expect(d.projects[0]?.delta).toEqual({ current: 12, prior: 10, absolute: 2, share: 0.2 });
    expect(d.projects[1]?.delta.share).toBeNull();
  });

  test("folds the model mix per period, carrying the prior period's cost", () => {
    const models = build().models;
    expect(models).toEqual([{ model: "claude-opus-4-7", calls: 5, cost: 12, priorCost: 10 }]);
  });

  test("keeps a model that ran only in the prior period", () => {
    insertSession(db, {
      path: "prior-haiku",
      day: "2026-07-01",
      cost_total: 40,
      models_json: JSON.stringify({ "claude-haiku-4-5": { apiCalls: 7, cost: { total: 40 } } }),
    });
    // Dropping a model is exactly the change a digest exists to show, so it
    // still gets a row — no calls this week, its prior cost intact — and ranks
    // by whichever side is larger.
    expect(build().models).toEqual([
      { model: "claude-haiku-4-5", calls: 0, cost: 0, priorCost: 40 },
      { model: "claude-opus-4-7", calls: 5, cost: 12, priorCost: 10 },
    ]);
  });

  test("folds skills period-filtered, not portfolio-wide", () => {
    const d = build();
    // The week's own attribution only: 2 turns / $3 — not the $90 prior week
    // or the $500 session in the following week.
    expect(d.skills).toEqual([
      { name: "tidy", invocations: 2, attributedTurns: 2, attributedCost: 3 },
    ]);
    expect(build({ week: "2026-07-05" }).skills[0]?.attributedCost).toBe(90);
  });

  test("reports period cache economics and reliability signals", () => {
    const d = build();
    expect(d.cache.writeCost).toBe(4);
    expect(d.cache.readCost).toBe(1);
    // 4000 read against 1000 written amortizes fully — nothing wasted.
    expect(d.cache.waste).toBe(0);
    const r = d.reliability;
    expect(r.toolCalls).toBe(10);
    expect(r.toolErrors).toBe(1);
    expect(r.toolErrorRate).toBeCloseTo(0.1, 10);
    expect(r.correctionTurns).toBe(2);
    expect(r.interruptionTurns).toBe(1);
    expect(r.turns).toBe(10);
    expect(r.correctionShare).toBeCloseTo(0.2, 10);
  });

  test("a zero-session period is a valid digest, with the prior week intact", () => {
    // 2026-07-20 → 07-26 has nothing; its prior week holds the $99 session.
    const d = build({ week: "2026-07-22" });
    expect(isEmptyPeriod(d)).toBe(true);
    expect(d.headline.cost.current).toBe(0);
    expect(d.headline.sessions.prior).toBe(1);
    expect(d.headline.cost.prior).toBe(99);
    expect(d.projects).toEqual([]);
    expect(d.models).toEqual([]);
    expect(d.skills).toEqual([]);
    // Insights are current-state, so they still run over the whole portfolio.
    expect(Array.isArray(d.insights)).toBe(true);
  });

  test("the insight snapshot is portfolio-wide, identical for any period", () => {
    expect(build({ week: "2026-07-22" }).insights).toEqual(build().insights);
  });
});

describe("buildWeeklyDigest · root column over the whole index", () => {
  // Six projects in root A outrank the lone root-B project, so the digest's
  // top-5 slice holds only root A — yet the index has two roots.
  const seedRoots = (database: Database) => {
    for (let i = 0; i < 6; i++) {
      insertSession(database, {
        path: `a${i}`,
        day: "2026-07-08",
        claude_dir: "/home/u/.claude",
        project_id: `aaaaaaaa~-p-a${i}`,
        project_path: `/p/a${i}`,
        cost_total: 20 - i,
      });
    }
    insertSession(database, {
      path: "b0",
      day: "2026-07-08",
      claude_dir: "/mnt/work/.claude",
      project_id: "bbbbbbbb~-p-b0",
      project_path: "/p/b0",
      cost_total: 0.5,
    });
  };

  test("a top-5 holding one root still gets the root column, in markdown and terminal", () => {
    const d2 = openDb(":memory:");
    seedRoots(d2);
    const d = buildWeeklyDigest(d2, pricing, { today: TODAY, audit: false });
    d2.close();
    expect(new Set(d.projects.map((p) => p.claudeDir)).size).toBe(1);
    expect(d.knownLabels?.map((k) => k.root)).toContain("/mnt/work/.claude");
    expect(buildDigestMarkdown(d)).toContain("| Project | Cost | Sessions | Change | Claude dir |");
    expect(renderWeeklyDigest(d)).toContain("claude dir");
  });

  test("single-root digests keep their column-free table", () => {
    const d = build();
    expect(buildDigestMarkdown(d)).not.toContain("Claude dir");
    expect(renderWeeklyDigest(d)).not.toContain("claude dir");
  });

  test("an alias group spanning roots renders 'several roots', not a blank cell", () => {
    const d2 = openDb(":memory:");
    seedRoots(d2);
    for (const [path, dir] of [
      ["g1", "/home/u/.claude"],
      ["g2", "/mnt/work/.claude"],
    ] as const) {
      insertSession(d2, {
        path,
        day: "2026-07-08",
        claude_dir: dir,
        project_id: "alias~group",
        project_path: "/p/group",
        project_alias: "grp",
        cost_total: 100,
      });
    }
    const d = buildWeeklyDigest(d2, pricing, { today: TODAY, audit: false });
    d2.close();
    expect(d.projects[0]?.claudeDir).toBe("");
    expect(buildDigestMarkdown(d)).toContain("several roots");
    expect(renderWeeklyDigest(d)).toContain("several roots");
  });
});
