import { describe, expect, test } from "bun:test";
import {
  ACTIVE_GAP_MS,
  analyzeSession,
  commandFamily,
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
});

/** Minutes after a fixed origin, as an ISO timestamp. */
const at = (min: number): string => new Date(Date.UTC(2026, 0, 1, 12, min)).toISOString();

const usage = { input_tokens: 10, output_tokens: 20 };

function assistant(opts: {
  id: string;
  min: number;
  sidechain?: boolean;
  stopReason?: string | null;
  content?: unknown[];
  model?: string;
}) {
  return {
    type: "assistant",
    uuid: `a-${opts.id}`,
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
});
