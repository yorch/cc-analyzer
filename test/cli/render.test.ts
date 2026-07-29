import { describe, expect, test } from "bun:test";
import { renderSessionSummary, renderStats } from "../../src/cli/render.ts";
import { analyzeSession, type SessionAnalysis } from "../../src/core/analyze.ts";
import { openDb } from "../../src/core/db.ts";
import {
  analyticsRollup,
  buildPortfolioStats,
  cacheTtlSplit,
  contextTax,
  whatIfRepricing,
} from "../../src/core/stats.ts";
import { samplePricing as pricing } from "../helpers/pricing.ts";
import { insertSession } from "../helpers/sessions.ts";

type Events = Parameters<typeof analyzeSession>[0];

const at = (min: number): string => new Date(Date.UTC(2026, 6, 3, 12, min)).toISOString();

function sessionWithSkill(): SessionAnalysis {
  const events = [
    { type: "user", uuid: "u1", timestamp: at(0), message: { content: "write the doc" } },
    {
      type: "assistant",
      uuid: "a1",
      timestamp: at(1),
      requestId: "r1",
      message: {
        id: "m1",
        model: "claude-opus-4-7",
        content: [{ type: "tool_use", id: "t1", name: "Skill", input: { skill: "docx" } }],
        usage: { input_tokens: 1_000_000, output_tokens: 100_000 },
      },
    },
  ];
  return analyzeSession(events as Events, pricing);
}

describe("renderSessionSummary · skills", () => {
  test("lists each skill with the cost of the turns that invoked it", () => {
    const out = renderSessionSummary(sessionWithSkill());
    expect(out).toContain("Skills");
    expect(out).toContain("turn $");
    expect(out).toContain("docx");
    // The one turn's cost is attributed, and the caveat travels with it.
    expect(out).toContain("Turn-scoped cost is the cost of the turns that invoked the skill");
  });
});

describe("renderStats · skills", () => {
  test("shows turn-scoped cost as the primary column with session-scoped beside it", () => {
    const db = openDb(":memory:");
    insertSession(db, {
      path: "s1",
      day: "2026-07-03",
      month: "2026-07",
      start_time: "2026-07-03T12:00:00.000Z",
      cost_total: 9,
      skills_json: '{"docx":2}',
      skill_turn_costs_json: '{"docx":{"turns":1,"cost":0.25}}',
    });
    const analytics = analyticsRollup(db);
    const view = {
      ...buildPortfolioStats(db, "2026-07-03"),
      index: { lastRefreshedAt: null, ageMs: null, stale: false, added: 0, changed: 0, deleted: 0 },
      ttl: cacheTtlSplit(db),
      bash: analytics.bash,
      skills: analytics.skills,
      tests: analytics.tests,
      retries: analytics.retries,
      concurrency: { peak: 1, parallelDayShare: 0 },
      contextTax: contextTax(db),
      whatIf: whatIfRepricing(db, pricing),
      costBasis: "api" as const,
    };
    const out = renderStats(view);
    db.close();

    expect(out).toContain("Skills · cost of the turns that invoked them");
    expect(out).toContain("turn $");
    expect(out).toContain("session $");
    // Both numbers on the row: attributed $0.25, session-scoped $9.00.
    const row = out.split("\n").find((l) => l.includes("docx")) ?? "";
    expect(row).toContain("$0.25");
    expect(row).toContain("$9.00");
    expect(out).toContain("session-scoped is the whole-session upper bound");
  });
});
