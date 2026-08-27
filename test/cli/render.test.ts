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
import { INDEXED_COST_CAVEAT } from "../../src/core/stats-types.ts";
import { assistantEvent, clock, promptEvent } from "../helpers/events.ts";
import { samplePricing as pricing } from "../helpers/pricing.ts";
import { insertSession } from "../helpers/sessions.ts";

type Events = Parameters<typeof analyzeSession>[0];

const at = clock(2026, 7, 3, 12);

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

describe("renderSessionSummary · outcomes, what-if, and subagent bursts", () => {
  test("prints cost-per-outcome rows with the caveat", () => {
    const out = renderSessionSummary(sessionWithSkill());
    expect(out).toContain("Cost per outcome");
    expect(out).toContain("per turn");
    expect(out).toContain("they measure activity, not value delivered");
  });

  test("prints the what-if section only when the caller computed one", () => {
    const a = sessionWithSkill();
    const bare = renderSessionSummary(a);
    expect(bare).not.toContain("What-if repricing");
    const withWhatIf = renderSessionSummary(a, {
      whatIf: {
        summary: {
          actualCost: 12,
          bestModel: "claude-haiku-4-5",
          bestCost: 3,
          bestDelta: -9,
          fallbackAlternatives: true,
        },
        rows: [
          {
            model: "claude-opus-4-7",
            calls: 1,
            cost: 12,
            alternatives: [{ model: "claude-haiku-4-5", cost: 3, delta: -9 }],
          },
        ],
      },
    });
    expect(withWhatIf).toContain("What-if repricing");
    expect(withWhatIf).toContain("cheapest single model: claude-haiku-4-5");
    expect(withWhatIf).toContain("read it as a rate comparison, not a bill");
  });

  test("renders a burst table when subagents ran", () => {
    const a: SessionAnalysis = {
      ...sessionWithSkill(),
      subagents: ["explorer"],
      sidechainBursts: [
        {
          subagentType: "explorer",
          turnIndex: 0,
          apiCalls: 3,
          cost: 0.5,
          tokens: {
            inputTokens: 1,
            outputTokens: 1,
            cacheWrite5mTokens: 0,
            cacheWrite1hTokens: 0,
            cacheReadTokens: 0,
          },
        },
      ],
    };
    const out = renderSessionSummary(a);
    expect(out).toContain("Subagent bursts");
    expect(out).toContain("explorer");
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
      corrections: analytics.corrections,
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

  test("prints the indexed-cost caveat unconditionally in the footer", () => {
    const db = openDb(":memory:");
    insertSession(db, {
      path: "s1",
      day: "2026-07-03",
      month: "2026-07",
      start_time: "2026-07-03T12:00:00.000Z",
      cost_total: 9,
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
      corrections: analytics.corrections,
      concurrency: { peak: 1, parallelDayShare: 0 },
      contextTax: contextTax(db),
      whatIf: whatIfRepricing(db, pricing),
      costBasis: "api" as const,
    };
    const out = renderStats(view);
    db.close();

    expect(out).toContain(INDEXED_COST_CAVEAT);
  });
});

/**
 * A session of `turns` prompts, one assistant call each. Turn `costliest`
 * (0-based) is given a far larger prompt so it dominates the session's spend
 * from deep inside the timeline — the case a chronological truncation hides.
 */
function sessionWithTurns(turns: number, costliest: number): SessionAnalysis {
  const events: Events = [];
  for (let i = 0; i < turns; i++) {
    events.push(promptEvent(`u${i}`, at(i * 2), `prompt number ${i}`));
    events.push(
      assistantEvent({
        uuid: `a${i}`,
        timestamp: at(i * 2 + 1),
        usage: { input_tokens: i === costliest ? 100_000 : 10, output_tokens: 5 },
      }),
    );
  }
  return analyzeSession(events, pricing);
}

describe("renderSessionSummary · turns table", () => {
  test("ranks by cost and says so once the row cap bites", () => {
    // 60 turns > the 40-row cap, with the expensive one at #48 — well past
    // where a first-40 slice would have stopped.
    const out = renderSessionSummary(sessionWithTurns(60, 47));
    expect(out).toContain("Turns · top 40 by cost");
    expect(out).toContain("Ranked by cost, not session order");
    expect(out).toContain("20 cheaper turns not shown");
    // The costliest turn is present and leads the table.
    expect(out).toContain("prompt number 47");
    const table = out.slice(out.indexOf("Turns · top 40 by cost"));
    expect(table.indexOf("prompt number 47")).toBeLessThan(table.indexOf("prompt number 0"));
  });

  test("carries a per-turn share, and a cumulative share only when ranked", () => {
    const ranked = renderSessionSummary(sessionWithTurns(60, 47));
    expect(ranked).toContain("share");
    expect(ranked).toContain("cum");
    const plain = renderSessionSummary(sessionWithTurns(5, 3));
    expect(plain).toContain("share");
    // A running total down a chronological list is a burn curve, not a share.
    expect(plain).not.toContain("cum");
  });

  test("a $0 session prints 0% shares rather than NaN%", () => {
    // No pricing table entry for the fixture model => every turn costs $0.
    const a = analyzeSession(
      [
        promptEvent("u0", at(0), "hello"),
        assistantEvent({
          uuid: "a0",
          timestamp: at(1),
          model: "some-unpriceable-model",
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
      ],
      {},
    );
    const out = renderSessionSummary(a);
    expect(out).not.toContain("NaN");
    expect(out).toContain("0%");
  });

  test("keeps session order (and the plain heading) when everything fits", () => {
    const out = renderSessionSummary(sessionWithTurns(5, 3));
    expect(out).toContain("▸ Turns");
    expect(out).not.toContain("top 40 by cost");
    expect(out).not.toContain("Ranked by cost");
    const table = out.slice(out.indexOf("▸ Turns"));
    expect(table.indexOf("prompt number 0")).toBeLessThan(table.indexOf("prompt number 3"));
  });
});
