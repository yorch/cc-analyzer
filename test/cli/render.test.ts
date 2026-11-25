import { describe, expect, test } from "bun:test";
import { knownLabelPairs } from "../../src/cli/known-labels.ts";
import {
  renderPortfolioInsights,
  renderSessionSummary,
  renderStats,
} from "../../src/cli/render.ts";
import { analyzeSession, type SessionAnalysis } from "../../src/core/analyze.ts";
import { openDb } from "../../src/core/db.ts";
import type { PortfolioDiagnostic } from "../../src/core/portfolio-diagnostics.ts";
import { knownProjectLabels } from "../../src/core/queries.ts";
import {
  analyticsRollup,
  buildPortfolioStats,
  cacheTtlSplit,
  contextTax,
  whatIfRepricing,
} from "../../src/core/stats.ts";
import { CONTEXT_GROWTH_CAVEAT, INDEXED_COST_CAVEAT } from "../../src/core/stats-types.ts";
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

  test("names why a turn was expensive, with the shape legend under the table", () => {
    // One turn whose cost is almost all cache writes: the prefix kept changing.
    const a = analyzeSession(
      [
        promptEvent("u0", at(0), "rewrite the config"),
        assistantEvent({
          uuid: "a0",
          timestamp: at(1),
          usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 200_000 },
        }),
        assistantEvent({
          uuid: "a1",
          timestamp: at(2),
          usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 200_000 },
        }),
      ],
      pricing,
    );
    const out = renderSessionSummary(a);
    expect(out).toContain("shape");
    expect(out).toContain("cache churn");
    expect(out).toContain("the cache was rewritten 2 times");
  });

  test("attributes context growth to the issuing call, with the caveat verbatim", () => {
    const a = analyzeSession(
      [
        promptEvent("u0", at(0), "read the file"),
        assistantEvent({
          uuid: "a0",
          timestamp: at(1),
          content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "/big.txt" } }],
          usage: { input_tokens: 100, output_tokens: 10 },
        }),
        assistantEvent({
          uuid: "a1",
          timestamp: at(2),
          usage: { input_tokens: 47_110, output_tokens: 10 },
        }),
      ],
      pricing,
    );
    const out = renderSessionSummary(a);
    expect(out).toContain("Context growth");
    expect(out).toContain("Read");
    expect(out).toContain(CONTEXT_GROWTH_CAVEAT);
    // A token delta, never a derived dollar for "carried" cost.
    expect(out).not.toContain("carried");
  });

  test("omits the context-growth section when nothing entered the context", () => {
    const a = analyzeSession(
      [
        promptEvent("u0", at(0), "hi"),
        assistantEvent({
          uuid: "a0",
          timestamp: at(1),
          usage: { input_tokens: 100, output_tokens: 10 },
        }),
      ],
      pricing,
    );
    const out = renderSessionSummary(a);
    expect(out).not.toContain("Context growth");
    expect(out).not.toContain(CONTEXT_GROWTH_CAVEAT);
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

describe("renderPortfolioInsights project labels", () => {
  const finding = (
    projectId: string,
    claudeDir: string | undefined,
    projectPath = "/work/app",
  ): PortfolioDiagnostic => ({
    code: "cache-waste-heavy",
    severity: "warning",
    title: "t",
    evidence: "e",
    action: "a",
    projectId,
    projectPath,
    claudeDir,
  });
  const plain = { color: false } as const;

  test("two roots holding the same project name read name [root]", () => {
    const out = renderPortfolioInsights(
      [
        finding("aaaaaaaa~-work-app", "/home/u/rootA"),
        finding("bbbbbbbb~-work-app", "/home/u/rootB"),
      ],
      plain,
    );
    expect(out).toContain("Project: /work/app [rootA]");
    expect(out).toContain("Project: /work/app [rootB]");
  });

  test("single root and missing claudeDir keep the bare name", () => {
    const one = renderPortfolioInsights([finding("aaaaaaaa~-work-app", "/home/u/rootA")], plain);
    expect(one).toContain("Project: /work/app");
    expect(one).not.toContain("[");
    const none = renderPortfolioInsights([finding("aaaaaaaa~-work-app", undefined)], plain);
    expect(none).toContain("Project: /work/app");
    expect(none).not.toContain("[");
  });
});

describe("renderPortfolioInsights with known (whole-index) labels", () => {
  const f: PortfolioDiagnostic = {
    code: "cache-waste-heavy",
    severity: "warning",
    title: "t",
    evidence: "e",
    action: "a",
    projectId: "aaaaaaaa~-work-app",
    projectPath: "/work/app",
    claudeDir: "/home/u/rootA",
  };
  const plain = { color: false } as const;

  test("a lone finding is tagged when its twin lives in another root of the index", () => {
    const known = knownLabelPairs([
      {
        projectId: "aaaaaaaa~-work-app",
        projectAlias: null,
        projectPath: "/work/app",
        claudeDir: "/home/u/rootA",
      },
      {
        projectId: "bbbbbbbb~-work-app",
        projectAlias: null,
        projectPath: "/work/app",
        claudeDir: "/home/u/rootB",
      },
    ]);
    expect(renderPortfolioInsights([f], plain, known)).toContain("Project: /work/app [rootA]");
    expect(renderPortfolioInsights([f], plain)).not.toContain("[");
  });

  test("an alias group spanning roots ('') never tags anyone", () => {
    const known = knownLabelPairs([
      { projectId: "cccccccc~-x", projectAlias: "/work/app", projectPath: null, claudeDir: "" },
    ]);
    expect(renderPortfolioInsights([f], plain, known)).not.toContain("[");
  });
});

describe("renderStats · root column judged over the whole index", () => {
  const view = (db: ReturnType<typeof openDb>, projectLimit?: number) => {
    const analytics = analyticsRollup(db);
    return {
      ...buildPortfolioStats(db, "2026-07-03", { projectLimit }),
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
  };
  const seed = (db: ReturnType<typeof openDb>) => {
    // 11 expensive, high-context projects in root A, one cheap/low one in B.
    for (let i = 0; i < 11; i++) {
      insertSession(db, {
        path: `a${i}`,
        day: "2026-07-03",
        month: "2026-07",
        start_time: "2026-07-03T12:00:00.000Z",
        claude_dir: "/home/u/.claude",
        project_id: `aaaaaaaa~-p-a${i}`,
        project_path: `/p/a${i}`,
        cost_total: 50 - i,
        first_prompt_tokens: 50_000 + i,
      });
    }
    insertSession(db, {
      path: "b0",
      day: "2026-07-03",
      month: "2026-07",
      start_time: "2026-07-03T12:00:00.000Z",
      claude_dir: "/mnt/work/.claude",
      project_id: "bbbbbbbb~-p-b0",
      project_path: "/p/b0",
      cost_total: 0.1,
      first_prompt_tokens: 100,
    });
  };

  test("top projects and context tax keep the column when the slice holds one root", () => {
    const db = openDb(":memory:");
    seed(db);
    const v = view(db, 3);
    const known = knownLabelPairs(knownProjectLabels(db));
    db.close();
    expect(new Set(v.byProject.map((p) => p.claudeDir)).size).toBe(1);
    expect(new Set(v.contextTax.byProject.slice(0, 10).map((p) => p.claudeDir)).size).toBe(1);

    const blind = renderStats(v);
    expect(blind).not.toContain("claude dir");

    const out = renderStats(v, { known });
    const sections = out.split("\n\n").filter((s) => /Top projects by cost|Context tax/.test(s));
    expect(sections).toHaveLength(2);
    for (const sec of sections) expect(sec).toContain("claude dir");
    expect(out).toContain("home/u/.claude".split("/").pop() as string);
  });

  test("single-root output is unchanged by `known`", () => {
    const db = openDb(":memory:");
    for (let i = 0; i < 3; i++) {
      insertSession(db, {
        path: `a${i}`,
        day: "2026-07-03",
        month: "2026-07",
        start_time: "2026-07-03T12:00:00.000Z",
        project_id: `aaaaaaaa~-p-a${i}`,
        project_path: `/p/a${i}`,
        cost_total: 5 + i,
        first_prompt_tokens: 1000,
      });
    }
    const v = view(db);
    const known = knownLabelPairs(knownProjectLabels(db));
    db.close();
    expect(renderStats(v, { known })).toBe(renderStats(v));
  });

  test("an alias group spanning roots prints 'several roots', not a blank cell", () => {
    const db = openDb(":memory:");
    seed(db);
    for (const [path, dir] of [
      ["g1", "/home/u/.claude"],
      ["g2", "/mnt/work/.claude"],
    ] as const) {
      insertSession(db, {
        path,
        day: "2026-07-03",
        month: "2026-07",
        start_time: "2026-07-03T12:00:00.000Z",
        claude_dir: dir,
        project_id: "alias~group",
        project_path: "/p/group",
        project_alias: "grp",
        cost_total: 500,
        first_prompt_tokens: 900_000,
      });
    }
    const v = view(db, 3);
    const known = knownLabelPairs(knownProjectLabels(db));
    db.close();
    const out = renderStats(v, { known });
    const row = out.split("\n").filter((l) => l.includes("grp"));
    expect(row.length).toBeGreaterThanOrEqual(2);
    for (const l of row) expect(l).toContain("several roots");
  });
});
