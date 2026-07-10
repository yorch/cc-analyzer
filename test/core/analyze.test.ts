import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { analyzeSession } from "../../src/core/analyze.ts";
import { parseSessionFile } from "../../src/core/parser.ts";
import type { ModelPricing, PricingTable } from "../../src/core/pricing.ts";

const fixturePath = fileURLToPath(new URL("../fixtures/sample-session.jsonl", import.meta.url));

const flat: ModelPricing = {
  inputCostPerToken: 0.00001,
  outputCostPerToken: 0.00002,
  cacheWrite5mCostPerToken: 0.0000125,
  cacheWrite1hCostPerToken: 0.00002,
  cacheReadCostPerToken: 0.000001,
};
const pricing: PricingTable = {
  "claude-opus-4-7": flat,
  "claude-sonnet-4-5": flat,
};

async function analyzeFixture() {
  const { events } = await parseSessionFile(fixturePath);
  return analyzeSession(events, pricing);
}

describe("analyzeSession", () => {
  test("segments into turns on genuine prompts only", async () => {
    const a = await analyzeFixture();
    expect(a.turns).toHaveLength(2);
    expect(a.turns[0]?.prompt).toBe("Add a hello function");
    expect(a.turns[1]?.prompt).toBe("Now run the tests");
  });

  test("groups the tool-result continuation into its prompt's turn", async () => {
    const a = await analyzeFixture();
    // turn 0 has two API calls (a1 with the tool, a2 the follow-up), not a new turn.
    expect(a.turns[0]?.apiCalls).toHaveLength(2);
    expect(a.turns[1]?.apiCalls).toHaveLength(1);
  });

  test("aggregates token categories per turn", async () => {
    const a = await analyzeFixture();
    const t0 = a.turns[0]?.tokens;
    expect(t0?.inputTokens).toBe(15);
    expect(t0?.outputTokens).toBe(58);
    expect(t0?.cacheWrite5mTokens).toBe(1000);
    expect(t0?.cacheReadTokens).toBe(5000);
  });

  test("computes session totals", async () => {
    const a = await analyzeFixture();
    expect(a.totals.turns).toBe(2);
    expect(a.totals.apiCalls).toBe(3);
    expect(a.totals.toolCalls).toBe(2);
    expect(a.totals.cost.total).toBeGreaterThan(0);
    expect(a.totals.cost.estimated).toBe(false);
  });

  test("extracts tools, files, models and metadata", async () => {
    const a = await analyzeFixture();
    expect(a.tools).toEqual({ Write: 1, Bash: 1 });
    expect(a.filesTouched).toEqual(["/Users/dev/proj/hello.ts"]);
    expect(Object.keys(a.models).sort()).toEqual(["claude-opus-4-7", "claude-sonnet-4-5"]);
    expect(a.models["claude-opus-4-7"]?.apiCalls).toBe(2);
    expect(a.title).toBe("Add hello function and run tests");
    expect(a.projectPath).toBe("/Users/dev/proj");
    expect(a.gitBranches).toEqual(["main"]);
    expect(a.versions).toEqual(["1.3.0"]);
  });

  test("builds a per-call step timeline with narration, thinking and operations", async () => {
    const a = await analyzeFixture();
    // Turn 0, call 0 (a1): thinking → text → Write tool_use
    const steps0 = a.turns[0]?.apiCalls[0]?.steps ?? [];
    expect(steps0.map((s) => s.kind)).toEqual(["thinking", "note", "edit"]);
    const write = steps0[2];
    expect(write?.label).toBe("Write");
    expect(write?.summary).toBe("/Users/dev/proj/hello.ts");
    expect(write?.status).toBe("ok");
  });

  test("marks a failed tool_result on the matching operation step", async () => {
    const a = await analyzeFixture();
    const bash = a.turns[1]?.apiCalls[0]?.steps.find((s) => s.tool === "Bash");
    expect(bash?.label).toBe("Bash");
    expect(bash?.summary).toBe("Run tests");
    expect(bash?.status).toBe("error");
    expect(bash?.resultHint).toBe("1 test failed");
  });

  test("carries prompt permission mode", async () => {
    const a = await analyzeFixture();
    expect(a.turns[1]?.permissionMode).toBe("acceptEdits");
  });

  test("does not start a turn for a tool_result carrier that has a promptId", () => {
    // Mirrors real data: every user event carries a promptId, so segmentation
    // must rely on content shape and isMeta, not promptId.
    const events = [
      {
        type: "user",
        uuid: "u1",
        promptId: "p1",
        timestamp: "t1",
        message: { content: "real prompt" },
      },
      {
        type: "user",
        uuid: "u2",
        promptId: "p1",
        timestamp: "t2",
        message: {
          content: [{ type: "tool_result", tool_use_id: "x", is_error: false, content: "ok" }],
        },
      },
      {
        type: "user",
        uuid: "u3",
        promptId: "p2",
        isMeta: true,
        timestamp: "t3",
        message: { content: "injected meta" },
      },
    ] as unknown as Parameters<typeof analyzeSession>[0];
    const a = analyzeSession(events, pricing);
    expect(a.turns).toHaveLength(1);
    expect(a.turns[0]?.prompt).toBe("real prompt");
  });

  test("flags cost as estimated when the model is priced only by family heuristic", async () => {
    const { events } = await parseSessionFile(fixturePath);
    const a = analyzeSession(events, { "claude-opus-4-1": flat });
    // opus-4-7 resolves via family heuristic; sonnet has no match at all.
    expect(a.totals.cost.estimated).toBe(true);
  });
});
