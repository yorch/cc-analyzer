import { describe, expect, test } from "bun:test";
import {
  ACTIVE_GAP_MS,
  analyzeSession,
  analyzeSessionStream,
  commandFamily,
  commandHead,
  isTestCommand,
  type SessionAnalysis,
} from "../../src/core/analyze.ts";
import { samplePricing as pricing } from "../helpers/pricing.ts";

type Events = Parameters<typeof analyzeSession>[0];

describe("commandFamily", () => {
  test("takes the program's basename", () => {
    expect(commandFamily("git status")).toBe("git");
    expect(commandFamily("/usr/bin/git log")).toBe("git");
    expect(commandFamily("  bun test  ")).toBe("bun");
  });

  test("skips leading env assignments", () => {
    expect(commandFamily("FOO=1 BAR='a b' npm run build")).toBe("npm");
    expect(commandFamily('CI="true" cargo build')).toBe("cargo");
  });

  test("attributes `cd … && real` to the real command", () => {
    expect(commandFamily("cd /tmp && bun test")).toBe("bun");
    expect(commandFamily("cd /tmp; git diff")).toBe("git");
    expect(commandFamily("cd /tmp")).toBe("cd");
  });

  test("returns undefined for empty commands", () => {
    expect(commandFamily("")).toBeUndefined();
    expect(commandFamily("   ")).toBeUndefined();
  });
});

describe("commandHead", () => {
  test("keeps the first three tokens with a basenamed program", () => {
    expect(commandHead("git commit -m 'msg' --amend")).toBe("git commit -m");
    expect(commandHead("/usr/bin/git status")).toBe("git status");
    expect(commandHead("bun test")).toBe("bun test");
  });

  test("skips navigation segments and empty input", () => {
    expect(commandHead("cd /tmp")).toBeUndefined();
    expect(commandHead("pushd /x")).toBeUndefined();
    expect(commandHead("")).toBeUndefined();
  });
});

describe("isTestCommand", () => {
  test("matches common test runners", () => {
    expect(isTestCommand("bun test")).toBe(true);
    expect(isTestCommand("npm run test -- --watch")).toBe(true);
    expect(isTestCommand("cargo test")).toBe(true);
    expect(isTestCommand("pytest tests/")).toBe(true);
    expect(isTestCommand("cd pkg && go test ./...")).toBe(true);
  });

  test("does not match non-test commands", () => {
    expect(isTestCommand("npm run build")).toBe(false);
    expect(isTestCommand("git commit -m 'test'")).toBe(false);
    expect(isTestCommand("ls attest")).toBe(false);
  });

  test("does not match runner names appearing in arguments", () => {
    expect(isTestCommand("cat jest.config.js")).toBe(false);
    expect(isTestCommand('grep -rn "go test" src/')).toBe(false);
    expect(isTestCommand('git commit -m "make bun test pass"')).toBe(false);
    expect(isTestCommand("echo pytest")).toBe(false);
  });

  test("matches runners after env assignments and in later segments", () => {
    expect(isTestCommand("CI=1 bun test")).toBe(true);
    expect(isTestCommand("npm run build && npm test")).toBe(true);
    expect(isTestCommand("./gradlew test")).toBe(true);
    expect(isTestCommand("make test")).toBe(true);
  });
});

/** Minutes after a fixed origin, as an ISO timestamp. */
const at = (min: number): string => new Date(Date.UTC(2026, 0, 1, 12, min)).toISOString();

const usage = { input_tokens: 10, output_tokens: 20 };

function assistant(opts: {
  id: string;
  min: number;
  sidechain?: boolean;
  parentId?: string;
  stopReason?: string | null;
  content?: unknown[];
  model?: string;
}) {
  return {
    type: "assistant",
    uuid: `a-${opts.id}`,
    parentUuid: opts.parentId ? `a-${opts.parentId}` : undefined,
    timestamp: at(opts.min),
    isSidechain: opts.sidechain,
    requestId: `req-${opts.id}`,
    message: {
      id: `msg-${opts.id}`,
      model: opts.model ?? "claude-opus-4-7",
      stop_reason: opts.stopReason ?? null,
      content: opts.content ?? [{ type: "text", text: "ok" }],
      usage,
    },
  };
}

const toolUse = (id: string, name: string, input: unknown) => ({
  type: "tool_use",
  id,
  name,
  input,
});

const toolResult = (id: string, isError: boolean) => ({
  type: "user",
  uuid: `r-${id}`,
  timestamp: at(0),
  message: { content: [{ type: "tool_result", tool_use_id: id, is_error: isError, content: "x" }] },
});

function analyze(events: unknown[]): SessionAnalysis {
  return analyzeSession(events as Events, pricing);
}

describe("analyzeSession new metrics", () => {
  test("splits sidechain calls and cost out of the totals", () => {
    const a = analyze([
      { type: "user", uuid: "u1", timestamp: at(0), message: { content: "hi" } },
      assistant({ id: "1", min: 1 }),
      assistant({ id: "2", min: 2, sidechain: true }),
    ]);
    expect(a.totals.apiCalls).toBe(2);
    expect(a.totals.sidechainApiCalls).toBe(1);
    expect(a.totals.sidechainCost).toBeCloseTo(a.totals.cost.total / 2, 10);
  });

  test("counts stop reasons, including ones arriving on continuation lines", () => {
    const first = assistant({ id: "1", min: 1, stopReason: null });
    // Same message id + requestId → merged into the first call; its stop_reason
    // must still land on that call.
    const continuation = assistant({ id: "1", min: 1, stopReason: "max_tokens" });
    const other = assistant({ id: "2", min: 2, stopReason: "end_turn" });
    const a = analyze([
      { type: "user", uuid: "u1", timestamp: at(0), message: { content: "hi" } },
      first,
      continuation,
      other,
    ]);
    expect(a.totals.apiCalls).toBe(2);
    expect(a.stopReasons).toEqual({ max_tokens: 1, end_turn: 1 });
  });

  test("counts turns per permission mode, defaulting to 'default'", () => {
    const a = analyze([
      {
        type: "user",
        uuid: "u1",
        timestamp: at(0),
        permissionMode: "plan",
        message: { content: "one" },
      },
      { type: "user", uuid: "u2", timestamp: at(1), message: { content: "two" } },
    ]);
    expect(a.permissionModes).toEqual({ plan: 1, default: 1 });
  });

  test("sums active time from short gaps and ignores idle gaps", () => {
    const a = analyze([
      { type: "user", uuid: "u1", timestamp: at(0), message: { content: "hi" } },
      assistant({ id: "1", min: 1 }), // +1m: active
      assistant({ id: "2", min: 3 }), // +2m: active
      assistant({ id: "3", min: 60 }), // +57m: idle, ignored
      assistant({ id: "4", min: 61 }), // +1m: active
    ]);
    expect(ACTIVE_GAP_MS).toBe(5 * 60_000);
    expect(a.totals.activeMs).toBe(4 * 60_000);
    expect(a.durationMs).toBe(61 * 60_000);
  });

  test("out-of-order timestamps never push activeMs past durationMs", () => {
    // Interleaved sidechain lines can arrive out of order; re-walking an
    // already-covered interval must not double-count it.
    const a = analyze([
      { type: "user", uuid: "u1", timestamp: at(0), message: { content: "hi" } },
      assistant({ id: "1", min: 4 }),
      assistant({ id: "2", min: 1 }), // behind the cursor: ignored
      assistant({ id: "3", min: 5 }),
    ]);
    expect(a.durationMs).toBe(5 * 60_000);
    expect(a.totals.activeMs).toBe(5 * 60_000);
    expect(a.totals.activeMs).toBeLessThanOrEqual(a.durationMs as number);
  });

  test("classifies bash commands, errors and test runs", () => {
    const a = analyze([
      { type: "user", uuid: "u1", timestamp: at(0), message: { content: "hi" } },
      assistant({
        id: "1",
        min: 1,
        content: [
          toolUse("t1", "Bash", { command: "git status" }),
          toolUse("t2", "Bash", { command: "bun test" }),
          toolUse("t3", "Bash", { command: "cd /x && bun test" }),
        ],
      }),
      toolResult("t2", true),
      toolResult("t3", false),
    ]);
    expect(a.bashCommands).toEqual({ git: 1, bun: 2 });
    expect(a.bashErrors).toEqual({ bun: 1 });
    expect(a.testRuns).toBe(2);
    expect(a.testFailures).toBe(1);
    // Raw heads for the index: the cd prefix is dropped, duplicates fold.
    expect(a.commandHeads).toEqual({ "git status": 1, "bun test": 2 });
    expect(a.commandHeadErrors).toEqual({ "bun test": 1 });
  });

  test("detects consecutive identical tool calls as retries", () => {
    const edit = { file_path: "/a.ts", old_string: "x", new_string: "y" };
    const a = analyze([
      { type: "user", uuid: "u1", timestamp: at(0), message: { content: "hi" } },
      assistant({
        id: "1",
        min: 1,
        content: [
          toolUse("t1", "Edit", edit),
          toolUse("t2", "Edit", edit), // identical → retry
          toolUse("t3", "Edit", { ...edit, new_string: "z" }), // different → not a retry
          toolUse("t4", "Read", { file_path: "/a.ts" }),
        ],
      }),
    ]);
    expect(a.retries).toBe(1);
    expect(a.retriesByTool).toEqual({ Edit: 1 });
  });

  test("an identical call in the next turn is not a retry", () => {
    const bash = { command: "bun test" };
    const a = analyze([
      { type: "user", uuid: "u1", timestamp: at(0), message: { content: "run tests" } },
      assistant({ id: "1", min: 1, content: [toolUse("t1", "Bash", bash)] }),
      { type: "user", uuid: "u2", timestamp: at(2), message: { content: "run them again" } },
      assistant({ id: "2", min: 3, content: [toolUse("t2", "Bash", bash)] }),
    ]);
    expect(a.retries).toBe(0);
  });

  test("interleaved sidechain calls do not break or fake main-chain retries", () => {
    const read = { file_path: "/x/CLAUDE.md" };
    const a = analyze([
      { type: "user", uuid: "u1", timestamp: at(0), message: { content: "hi" } },
      // Main chain reads a file; a subagent reads the same file next in file
      // order; then the main chain repeats its read.
      assistant({ id: "1", min: 1, content: [toolUse("t1", "Read", read)] }),
      assistant({ id: "2", min: 2, sidechain: true, content: [toolUse("t2", "Read", read)] }),
      assistant({ id: "3", min: 3, content: [toolUse("t3", "Read", read)] }),
    ]);
    // The sidechain's identical read is not a retry of the main chain's; the
    // main chain's own repeat still is.
    expect(a.retries).toBe(1);
    expect(a.retriesByTool).toEqual({ Read: 1 });
  });

  test("parallel subagents get independent retry cursors (parentUuid chains)", () => {
    const read = { file_path: "/x/CLAUDE.md" };
    const a = analyze([
      { type: "user", uuid: "u1", timestamp: at(0), message: { content: "hi" } },
      // Two subagents, A and B, interleave in file order. Each roots its own
      // chain (parent is main/unknown); children link via parentUuid.
      assistant({ id: "A1", min: 1, sidechain: true, content: [toolUse("t1", "Read", read)] }),
      assistant({ id: "B1", min: 2, sidechain: true, content: [toolUse("t2", "Read", read)] }),
      assistant({
        id: "A2",
        min: 3,
        sidechain: true,
        parentId: "A1",
        content: [toolUse("t3", "Read", read)],
      }),
      assistant({
        id: "B2",
        min: 4,
        sidechain: true,
        parentId: "B1",
        content: [toolUse("t4", "Read", { file_path: "/y/other.ts" })],
      }),
    ]);
    // B's interleaved identical read is a different chain — not a retry.
    // A repeating its own read on its own chain is exactly one retry.
    expect(a.retries).toBe(1);
    expect(a.retriesByTool).toEqual({ Read: 1 });
  });
});

describe("turn-scoped skill cost attribution", () => {
  const skill = (id: string, name: string) => toolUse(id, "Skill", { skill: name });
  const prompt = (uuid: string, min: number) => ({
    type: "user",
    uuid,
    timestamp: at(min),
    message: { content: `prompt ${uuid}` },
  });

  test("charges a skill the whole turn it ran in, subagent burst included", () => {
    const a = analyze([
      prompt("u1", 0),
      assistant({ id: "1", min: 1, content: [skill("t1", "docx")] }),
      // The subagent the turn spawned bills to that turn too.
      assistant({ id: "2", min: 2, sidechain: true }),
    ]);
    const turnCost = a.turns[0]?.cost.total as number;
    expect(turnCost).toBeGreaterThan(0);
    expect(a.skillTurnCosts).toEqual({ docx: { turns: 1, cost: turnCost } });
    // The single turn holds every call, so it equals the session total here.
    expect(turnCost).toBeCloseTo(a.totals.cost.total, 12);
    expect(a.totals.sidechainCost).toBeGreaterThan(0);
  });

  test("two skills in one turn each get the full turn cost", () => {
    const a = analyze([
      prompt("u1", 0),
      assistant({ id: "1", min: 1, content: [skill("t1", "docx"), skill("t2", "pdf")] }),
      assistant({ id: "2", min: 2 }),
    ]);
    const turnCost = a.turns[0]?.cost.total as number;
    expect(a.skillTurnCosts).toEqual({
      docx: { turns: 1, cost: turnCost },
      pdf: { turns: 1, cost: turnCost },
    });
    // Correlational at the margin: the two attributions sum past the session.
    const attributed = Object.values(a.skillTurnCosts).reduce((s, v) => s + v.cost, 0);
    expect(attributed).toBeCloseTo(2 * a.totals.cost.total, 12);
  });

  test("repeat invocations inside one turn count that turn once", () => {
    const a = analyze([
      prompt("u1", 0),
      assistant({ id: "1", min: 1, content: [skill("t1", "docx")] }),
      assistant({ id: "2", min: 2, content: [skill("t2", "docx")] }),
    ]);
    expect(a.skills).toEqual({ docx: 2 });
    expect(a.skillTurnCosts.docx?.turns).toBe(1);
    expect(a.skillTurnCosts.docx?.cost).toBeCloseTo(a.turns[0]?.cost.total as number, 12);
  });

  test("a skill used in turn 2 of 3 carries only turn 2's cost", () => {
    const a = analyze([
      prompt("u1", 0),
      assistant({ id: "1", min: 1 }),
      prompt("u2", 2),
      assistant({ id: "2", min: 3, content: [skill("t1", "docx")] }),
      assistant({ id: "3", min: 4 }),
      prompt("u3", 5),
      assistant({ id: "4", min: 6 }),
    ]);
    const turn2 = a.turns[1]?.cost.total as number;
    expect(a.turns).toHaveLength(3);
    expect(a.skillTurnCosts).toEqual({ docx: { turns: 1, cost: turn2 } });
    expect(turn2).toBeLessThan(a.totals.cost.total);
  });

  test("a skill invoked in several turns accumulates their costs", () => {
    const a = analyze([
      prompt("u1", 0),
      assistant({ id: "1", min: 1, content: [skill("t1", "docx")] }),
      prompt("u2", 2),
      assistant({ id: "2", min: 3, content: [skill("t2", "docx")] }),
    ]);
    const expected = (a.turns[0]?.cost.total as number) + (a.turns[1]?.cost.total as number);
    expect(a.skillTurnCosts.docx?.turns).toBe(2);
    expect(a.skillTurnCosts.docx?.cost).toBeCloseTo(expected, 12);
  });

  test("a session with no skills attributes nothing", () => {
    const a = analyze([prompt("u1", 0), assistant({ id: "1", min: 1 })]);
    expect(a.skillTurnCosts).toEqual({});
  });

  test("aggregate mode attributes exactly like detail mode", async () => {
    const events = [
      prompt("u1", 0),
      assistant({ id: "1", min: 1, content: [skill("t1", "docx")] }),
      assistant({ id: "2", min: 2, sidechain: true }),
      prompt("u2", 3),
      assistant({ id: "3", min: 4, content: [skill("t2", "pdf"), skill("t3", "docx")] }),
    ];
    const full = analyze(events);
    async function* stream() {
      for (const e of events) yield e as Events[number];
    }
    const agg = await analyzeSessionStream(stream(), pricing, { detail: false });
    expect(agg.turns).toEqual([]);
    expect(agg.skillTurnCosts).toEqual(full.skillTurnCosts);
    expect(agg.skillTurnCosts.docx?.turns).toBe(2);
  });
});

describe("correction and interruption turns", () => {
  const prompt = (
    uuid: string,
    min: number,
    text: string,
    extra: Record<string, unknown> = {},
  ) => ({
    type: "user",
    uuid,
    timestamp: at(min),
    ...extra,
    message: { content: text },
  });
  const marker = (uuid: string, min: number, blocks = 1, extra: Record<string, unknown> = {}) => ({
    type: "user",
    uuid,
    timestamp: at(min),
    ...extra,
    message: {
      content: Array.from({ length: blocks }, () => ({
        type: "text",
        text: "[Request interrupted by user]",
      })),
    },
  });

  test("counts an interrupted turn once, however many markers it carries", () => {
    const a = analyze([
      prompt("u1", 0, "build the thing"),
      assistant({ id: "1", min: 1 }),
      // One user message with two marker blocks: one turn, one interruption.
      marker("u2", 2, 2),
    ]);
    expect(a.interruptionTurns).toBe(1);
    // Turn segmentation is unchanged: the marker is still a real prompt.
    expect(a.totals.turns).toBe(2);
  });

  test("a tool_result carrying the marker interrupts the open turn", () => {
    // Esc during a pending tool call: the marker is the tool_result's content,
    // as a plain string.
    const a = analyze([
      prompt("u1", 0, "run the migration"),
      assistant({ id: "1", min: 1 }),
      {
        type: "user",
        uuid: "u2",
        timestamp: at(2),
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "t1",
              content: "[Request interrupted by user for tool use]",
            },
          ],
        },
      },
    ]);
    expect(a.interruptionTurns).toBe(1);
    // A tool_result carrier is not a real prompt: no new turn, no split.
    expect(a.totals.turns).toBe(1);
  });

  test("a tool_result marker nested in content blocks counts too", () => {
    const a = analyze([
      prompt("u1", 0, "run the migration"),
      assistant({ id: "1", min: 1 }),
      {
        type: "user",
        uuid: "u2",
        timestamp: at(2),
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "t1",
              content: [{ type: "text", text: "[Request interrupted by user for tool use]" }],
            },
          ],
        },
      },
    ]);
    expect(a.interruptionTurns).toBe(1);
    expect(a.totals.turns).toBe(1);
  });

  test("an ordinary tool_result is not an interruption", () => {
    const a = analyze([
      prompt("u1", 0, "run the migration"),
      assistant({ id: "1", min: 1 }),
      {
        type: "user",
        uuid: "u2",
        timestamp: at(2),
        message: {
          content: [{ type: "tool_result", tool_use_id: "t1", content: "migration applied" }],
        },
      },
    ]);
    expect(a.interruptionTurns).toBe(0);
  });

  test("counts corrections only on real prompts, and shares a turn denominator", () => {
    const a = analyze([
      prompt("u1", 0, "build the thing"),
      assistant({ id: "1", min: 1 }),
      prompt("u2", 2, "no, the other module"),
      // Meta and sidechain copies of the same text are not real prompts.
      prompt("u3", 3, "no, the other module", { isMeta: true }),
      prompt("u4", 4, "no, the other module", { isSidechain: true }),
    ]);
    expect(a.correctionTurns).toBe(1);
    expect(a.totals.turns).toBe(2);
    expect(a.interruptionTurns).toBe(0);
  });

  test("sidechain interruption markers belong to the subagent, not the dialogue", () => {
    const a = analyze([
      prompt("u1", 0, "delegate it"),
      assistant({ id: "1", min: 1, sidechain: true }),
      marker("u2", 2, 1, { isSidechain: true }),
    ]);
    expect(a.interruptionTurns).toBe(0);
    expect(a.totals.turns).toBe(1);
  });

  test("an interrupted turn and a correction prompt are independent counters", () => {
    const a = analyze([
      prompt("u1", 0, "build the thing"),
      assistant({ id: "1", min: 1 }),
      marker("u2", 2),
      prompt("u3", 3, "that's not what i meant — smaller"),
      assistant({ id: "2", min: 4 }),
    ]);
    expect(a.interruptionTurns).toBe(1);
    expect(a.correctionTurns).toBe(1);
    expect(a.totals.turns).toBe(3);
  });

  test("the interruption marker prompt itself is never a correction", () => {
    const a = analyze([prompt("u1", 0, "go"), marker("u2", 1)]);
    expect(a.correctionTurns).toBe(0);
    expect(a.interruptionTurns).toBe(1);
  });

  test("aggregate mode counts exactly like detail mode", async () => {
    const events = [
      prompt("u1", 0, "build the thing"),
      assistant({ id: "1", min: 1 }),
      marker("u2", 2),
      prompt("u3", 3, "undo that and use the flag"),
      assistant({ id: "2", min: 4 }),
    ];
    const full = analyze(events);
    async function* stream() {
      for (const e of events) yield e as Events[number];
    }
    const agg = await analyzeSessionStream(stream(), pricing, { detail: false });
    expect(agg.turns).toEqual([]);
    expect(agg.correctionTurns).toBe(full.correctionTurns);
    expect(agg.interruptionTurns).toBe(full.interruptionTurns);
    expect(full.correctionTurns).toBe(1);
    expect(full.interruptionTurns).toBe(1);
  });
});
