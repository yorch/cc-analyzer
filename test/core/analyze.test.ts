import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { analyzeSession, analyzeSessionStream } from "../../src/core/analyze.ts";
import type { SessionEvent } from "../../src/core/events.ts";
import { parseSessionFile } from "../../src/core/parser.ts";
import { flatPricing as flat, samplePricing as pricing } from "../helpers/pricing.ts";

/** Turn an array into an async iterable, to drive analyzeSessionStream. */
async function* iterate(events: SessionEvent[]): AsyncGenerator<SessionEvent> {
  for (const e of events) yield e;
}

const fixturePath = fileURLToPath(new URL("../fixtures/sample-session.jsonl", import.meta.url));

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
    expect(a.toolErrors).toEqual({ Bash: 1 }); // the fixture's Bash result is an error
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

// ---------------------------------------------------------------------------
// Real-world log shapes the fixture doesn't cover: streamed multi-line API
// responses, sidechain (subagent) chains, and pre-first-prompt API calls.

import { parseSessionText } from "../../src/core/parser.ts";

function analyzeLines(lines: unknown[]): ReturnType<typeof analyzeSession> {
  const { events } = parseSessionText(lines.map((l) => JSON.stringify(l)).join("\n"));
  return analyzeSession(events, pricing);
}

const usage = { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 100 };

describe("analyzeSession · streamed responses", () => {
  test("counts usage once per API call across per-block continuation lines", () => {
    const a = analyzeLines([
      { type: "user", uuid: "u1", message: { role: "user", content: "hi" } },
      {
        type: "assistant",
        uuid: "a1",
        requestId: "req_1",
        message: {
          id: "msg_1",
          model: "claude-opus-4-7",
          content: [{ type: "text", text: "hello" }],
          usage,
        },
      },
      {
        type: "assistant",
        uuid: "a2",
        requestId: "req_1",
        message: {
          id: "msg_1",
          model: "claude-opus-4-7",
          content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }],
          usage,
        },
      },
    ]);
    expect(a.totals.apiCalls).toBe(1);
    expect(a.totals.tokens.inputTokens).toBe(10);
    expect(a.totals.tokens.outputTokens).toBe(20);
    expect(a.models["claude-opus-4-7"]?.apiCalls).toBe(1);
    // Continuation steps merge into the originating ApiCall; tools still count.
    expect(a.turns[0]?.apiCalls).toHaveLength(1);
    expect(a.turns[0]?.apiCalls[0]?.steps).toHaveLength(2);
    expect(a.totals.toolCalls).toBe(1);
  });

  test("merges continuation lines that are not immediately adjacent (interleaved streams)", () => {
    // A sidechain assistant line lands between the two lines of one main-chain
    // response; keyed dedup must still merge them (not fabricate a ghost call).
    const a = analyzeLines([
      { type: "user", uuid: "u1", message: { role: "user", content: "hi" } },
      {
        type: "assistant",
        uuid: "a1",
        requestId: "req_1",
        message: {
          id: "msg_1",
          model: "claude-opus-4-7",
          content: [{ type: "text", text: "x" }],
          usage,
        },
      },
      {
        type: "assistant",
        uuid: "sa1",
        isSidechain: true,
        requestId: "req_2",
        message: {
          id: "msg_2",
          model: "claude-opus-4-7",
          content: [{ type: "text", text: "sub" }],
          usage,
        },
      },
      {
        type: "assistant",
        uuid: "a2",
        requestId: "req_1",
        message: {
          id: "msg_1",
          model: "claude-opus-4-7",
          content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }],
          usage,
        },
      },
    ]);
    // Two distinct API calls (msg_1 once, msg_2 once) — no phantom third.
    expect(a.totals.apiCalls).toBe(2);
    expect(a.turns[0]?.apiCalls).toHaveLength(2);
    // Turn rows agree with the total (no zero-token ghost inflating the array).
    expect(a.turns[0]?.apiCalls.length).toBe(a.totals.apiCalls);
    // msg_1's two content blocks merged onto one call.
    const mainCall = a.turns[0]?.apiCalls.find((ca) => !ca.isSidechain);
    expect(mainCall?.steps).toHaveLength(2);
  });
});

describe("analyzeSession · sidechains", () => {
  test("a sidechain user prompt does not open a new turn", () => {
    const a = analyzeLines([
      { type: "user", uuid: "u1", message: { role: "user", content: "do stuff" } },
      {
        type: "assistant",
        uuid: "a1",
        message: {
          id: "msg_1",
          model: "claude-opus-4-7",
          content: [{ type: "tool_use", id: "t1", name: "Task", input: { prompt: "sub work" } }],
          usage,
        },
      },
      {
        type: "user",
        uuid: "su1",
        isSidechain: true,
        message: { role: "user", content: "You are an agent. Do the sub work." },
      },
      {
        type: "assistant",
        uuid: "sa1",
        isSidechain: true,
        message: {
          id: "msg_2",
          model: "claude-opus-4-7",
          content: [{ type: "text", text: "done" }],
          usage,
        },
      },
      {
        type: "user",
        uuid: "u2",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "t1", content: "sub result" }],
        },
      },
      {
        type: "assistant",
        uuid: "a2",
        message: {
          id: "msg_3",
          model: "claude-opus-4-7",
          content: [{ type: "text", text: "all done" }],
          usage,
        },
      },
    ]);
    expect(a.totals.turns).toBe(1);
    expect(a.turns[0]?.prompt).toBe("do stuff");
    // The sidechain's API call is attributed to the enclosing turn.
    expect(a.turns[0]?.apiCalls).toHaveLength(3);
    expect(a.turns[0]?.apiCalls[1]?.isSidechain).toBe(true);
    expect(a.totals.apiCalls).toBe(3);
  });
});

describe("analyzeSession · totals vs models", () => {
  test("API calls before the first prompt land in totals and models alike", () => {
    const a = analyzeLines([
      {
        type: "assistant",
        uuid: "a0",
        message: {
          id: "msg_0",
          model: "claude-opus-4-7",
          content: [{ type: "text", text: "resumed" }],
          usage: { input_tokens: 5, output_tokens: 7 },
        },
      },
      { type: "user", uuid: "u1", message: { role: "user", content: "hi" } },
      {
        type: "assistant",
        uuid: "a1",
        message: {
          id: "msg_1",
          model: "claude-opus-4-7",
          content: [{ type: "text", text: "hello" }],
          usage: { input_tokens: 1, output_tokens: 2 },
        },
      },
    ]);
    expect(a.totals.turns).toBe(1);
    expect(a.totals.apiCalls).toBe(2);
    expect(a.totals.tokens.inputTokens).toBe(6);
    expect(a.totals.tokens.outputTokens).toBe(9);
    expect(a.models["claude-opus-4-7"]?.apiCalls).toBe(2);
    // totals must always agree with the per-model rollup.
    expect(a.totals.cost.total).toBeCloseTo(a.models["claude-opus-4-7"]?.cost.total ?? -1, 12);
  });
});

describe("analyzeSessionStream", () => {
  test("detail mode is identical to analyzeSession over the same events", async () => {
    const { events } = await parseSessionFile(fixturePath);
    const fromArray = analyzeSession(events, pricing);
    const fromStream = await analyzeSessionStream(iterate(events), pricing, { detail: true });
    expect(fromStream).toEqual(fromArray);
  });

  test("aggregate mode drops the per-turn timeline but keeps every aggregate", async () => {
    const { events } = await parseSessionFile(fixturePath);
    const full = analyzeSession(events, pricing);
    const agg = await analyzeSessionStream(iterate(events), pricing, { detail: false });

    // The heavy per-turn timeline is skipped...
    expect(agg.turns).toEqual([]);
    // ...but everything else — every field the indexer reads, including the
    // turn-derived promptChars/turnDepths — is identical to the full analysis.
    expect({ ...agg, turns: [] }).toEqual({ ...full, turns: [] });
    // Sanity: the turn-derived aggregates survived (indexer depends on them).
    expect(agg.turnDepths).toEqual(full.turns.map((t) => t.mainApiCalls));
    expect(agg.promptChars).toBe(full.turns.reduce((s, t) => s + t.prompt.length, 0));
  });

  test("aggregate mode attributes tool errors without building steps", async () => {
    // The fixture's Bash result is an error; error attribution must survive the
    // single streaming pass (no per-step timeline to hang the status on).
    const { events } = await parseSessionFile(fixturePath);
    const agg = await analyzeSessionStream(iterate(events), pricing, { detail: false });
    expect(agg.toolErrors).toEqual({ Bash: 1 });
    expect(agg.tools).toEqual({ Write: 1, Bash: 1 });
    expect(agg.turns).toEqual([]);
    expect(agg.totals.turns).toBe(2); // turn count still tracked
  });
});

describe("compaction capture", () => {
  const boundary = (second: number, trigger = "auto", preTokens = 150_000) => ({
    type: "system",
    subtype: "compact_boundary",
    timestamp: `2026-07-01T10:00:${String(second).padStart(2, "0")}.000Z`,
    compactMetadata: { trigger, preTokens },
  });
  const summary = (second: number) => ({
    type: "user",
    uuid: `cs-${second}`,
    isCompactSummary: true,
    timestamp: `2026-07-01T10:00:${String(second).padStart(2, "0")}.000Z`,
    message: { role: "user", content: "This session is being continued…" },
  });
  const assistantLine = (second: number) => ({
    type: "assistant",
    uuid: `a-${second}`,
    timestamp: `2026-07-01T10:00:${String(second).padStart(2, "0")}.000Z`,
    message: {
      id: `msg-${second}`,
      role: "assistant",
      model: "claude-opus-4-7",
      content: [{ type: "text", text: "ok" }],
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  });
  const analyze = (events: unknown[]) =>
    analyzeSession(events as Parameters<typeof analyzeSession>[0], pricing);

  test("records a compact_boundary with trigger and preTokens", () => {
    const a = analyze([assistantLine(1), boundary(5, "manual", 42)]);
    expect(a.compactions).toEqual([
      { timestamp: "2026-07-01T10:00:05.000Z", trigger: "manual", preTokens: 42 },
    ]);
  });

  test("flags a boundary before any API call as inherited (continuation file)", () => {
    // Continuation files copy the parent session's final boundary at their
    // start — it describes the parent's compaction, not one of this session's.
    const a = analyze([boundary(5), assistantLine(7)]);
    expect(a.compactions[0]?.inherited).toBe(true);
    const b = analyze([assistantLine(1), boundary(5), assistantLine(7)]);
    expect(b.compactions[0]?.inherited).toBeUndefined();
  });

  test("a boundary followed by its summary prompt records one compaction", () => {
    const a = analyze([boundary(5), summary(6), assistantLine(7)]);
    expect(a.compactions).toHaveLength(1);
    expect(a.compactions[0]?.trigger).toBe("auto");
  });

  test("a summary alone (older Claude Code) records a timestamp-only compaction", () => {
    const a = analyze([assistantLine(1), summary(6), assistantLine(7)]);
    expect(a.compactions).toEqual([{ timestamp: "2026-07-01T10:00:06.000Z", uuid: "cs-6" }]);
  });

  test("an assistant line closes the boundary→summary pair", () => {
    // A later summary with no adjacent boundary is its own compaction.
    const a = analyze([boundary(5), summary(6), assistantLine(7), summary(9)]);
    expect(a.compactions).toHaveLength(2);
    expect(a.compactions[1]).toEqual({ timestamp: "2026-07-01T10:00:09.000Z", uuid: "cs-9" });
  });

  test("a subagent (sidechain) compaction is flagged and pairs on its own chain kind", () => {
    const sideBoundary = { ...boundary(5), isSidechain: true, agentId: "a1" };
    const sideSummary = { ...summary(6), isSidechain: true };
    const a = analyze([sideBoundary, sideSummary, assistantLine(7)]);
    expect(a.compactions).toHaveLength(1);
    expect(a.compactions[0]?.isSidechain).toBe(true);
    // A main-chain summary does not consume a pending *sidechain* boundary.
    const b = analyze([sideBoundary, summary(6), assistantLine(7)]);
    expect(b.compactions).toHaveLength(2);
    expect(b.compactions[0]?.isSidechain).toBe(true);
    expect(b.compactions[1]?.isSidechain).toBeUndefined();
  });

  test("an interleaved subagent line does not break the boundary→summary pair", () => {
    // A subagent streaming while the main chain compacts: boundary (main) →
    // assistant (sidechain) → summary (main) is still ONE compaction.
    const sideLine = { ...assistantLine(6), isSidechain: true, uuid: "side-1" };
    const a = analyze([assistantLine(1), boundary(5), sideLine, summary(7), assistantLine(8)]);
    expect(a.compactions).toHaveLength(1);
    expect(a.compactions[0]?.trigger).toBe("auto");
  });

  test("a compact summary does not open a turn (isRealPrompt excludes it)", () => {
    const a = analyze([
      {
        type: "user",
        uuid: "u1",
        timestamp: "2026-07-01T10:00:00.000Z",
        message: { role: "user", content: "real prompt" },
      },
      assistantLine(1),
      boundary(5),
      summary(6),
      assistantLine(7),
    ]);
    // The synthetic summary is machine-written; the interrupted turn continues.
    expect(a.totals.turns).toBe(1);
    expect(a.turns).toHaveLength(1);
    expect(a.compactions).toHaveLength(1);
  });

  test("survives aggregate mode (the indexer path)", async () => {
    const events = [boundary(5), summary(6)] as Parameters<typeof analyzeSession>[0];
    const agg = await analyzeSessionStream(iterate(events), pricing, { detail: false });
    expect(agg.compactions).toHaveLength(1);
    expect(agg.compactions[0]?.preTokens).toBe(150_000);
  });
});
