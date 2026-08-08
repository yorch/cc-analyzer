import { describe, expect, test } from "bun:test";
import { analyzeSession } from "../../src/core/analyze.ts";
import {
  analysisArgv,
  buildAnalysisPrompt,
  DEFAULT_ANALYSIS_MODEL,
  isValidModel,
  resolveClaudeBinary,
  runClaudeAnalysis,
  type Spawner,
} from "../../src/core/claude-handoff.ts";
import { assistantEvent, clock, promptEvent, toolUseBlock } from "../helpers/events.ts";
import { samplePricing } from "../helpers/pricing.ts";

const t = clock(2026, 7, 1);

/** A small analyzed session with a couple of turns and some churn signals. */
function sampleAnalysis() {
  const events = [
    promptEvent("p1", t(0), "add a feature"),
    assistantEvent({
      uuid: "a1",
      timestamp: t(1),
      content: [toolUseBlock("tu1", "Read", { file_path: "/x.ts" })],
      usage: { input_tokens: 100, output_tokens: 50 },
    }),
    promptEvent("p2", t(2), "no, that's not what I meant"),
    assistantEvent({ uuid: "a2", timestamp: t(3), usage: { input_tokens: 40, output_tokens: 10 } }),
  ];
  return analyzeSession(events, samplePricing);
}

/** A Spawner that emits the given stdout chunks (as-is, so a caller can split a
 *  JSON line across chunks to exercise the line buffer) then exits. */
function fakeSpawn(chunks: string[], exitCode = 0, stderr?: string): Spawner {
  return () => ({
    stdout: new ReadableStream<Uint8Array>({
      start(controller) {
        const enc = new TextEncoder();
        for (const chunk of chunks) controller.enqueue(enc.encode(chunk));
        controller.close();
      },
    }),
    stderr:
      stderr === undefined
        ? null
        : new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(stderr));
              controller.close();
            },
          }),
    exited: Promise.resolve(exitCode),
  });
}

async function collect(gen: AsyncGenerator<unknown>): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const event of gen) out.push(event);
  return out;
}

describe("isValidModel", () => {
  test("accepts aliases and full ids", () => {
    expect(isValidModel("sonnet")).toBe(true);
    expect(isValidModel("opus")).toBe(true);
    expect(isValidModel("claude-sonnet-4-5")).toBe(true);
    expect(isValidModel("anthropic/claude-3.5")).toBe(false); // no slash allowed
  });

  test("rejects shell-metacharacter junk and overlong input", () => {
    expect(isValidModel("sonnet; rm -rf /")).toBe(false);
    expect(isValidModel("$(whoami)")).toBe(false);
    expect(isValidModel("a b")).toBe(false);
    expect(isValidModel("")).toBe(false);
    expect(isValidModel("x".repeat(200))).toBe(false);
  });
});

describe("buildAnalysisPrompt", () => {
  test("embeds the metrics and a read-only instruction", () => {
    const prompt = buildAnalysisPrompt(sampleAnalysis(), "/home/u/.claude/projects/p/s.jsonl");
    expect(prompt).toContain("/home/u/.claude/projects/p/s.jsonl");
    expect(prompt).toContain("Cost:");
    expect(prompt).toContain("Turns:");
    // The correction prompt ("no, that's not what I meant") is counted.
    expect(prompt).toContain("Corrections:");
    expect(prompt.toLowerCase()).toContain("do not modify");
  });

  test("omits signal lines that did not fire", () => {
    const clean = analyzeSession(
      [promptEvent("p1", t(0), "hello"), assistantEvent({ uuid: "a1", timestamp: t(1) })],
      samplePricing,
    );
    expect(buildAnalysisPrompt(clean, "/s.jsonl")).not.toContain("Churn:");
  });
});

describe("analysisArgv", () => {
  test("points Claude at the session dir read-only and never resumes", () => {
    const argv = analysisArgv({
      claudeBin: "/usr/bin/claude",
      sessionPath: "/home/u/.claude/projects/p/s.jsonl",
      analysis: sampleAnalysis(),
      model: "sonnet",
    });
    expect(argv[0]).toBe("/usr/bin/claude");
    expect(argv).toContain("-p");
    expect(argv).toContain("--allowedTools");
    expect(argv).toContain("Read");
    expect(argv).toContain("--add-dir");
    expect(argv).toContain("/home/u/.claude/projects/p");
    expect(argv).toContain("--model");
    expect(argv).toContain("sonnet");
    expect(argv).not.toContain("--resume");
    expect(argv).not.toContain("--bare");
  });
});

describe("runClaudeAnalysis stream parsing", () => {
  const opts = {
    claudeBin: "/usr/bin/claude",
    sessionPath: "/tmp/s.jsonl",
    analysis: sampleAnalysis(),
    model: "sonnet",
  };

  test("maps text deltas and the final result (with cost), across split chunks", async () => {
    const chunks = [
      `${JSON.stringify({ type: "stream_event", event: { delta: { type: "text_delta", text: "Hel" } } })}\n`,
      // A line split across two reads must still parse once completed.
      `${JSON.stringify({ type: "stream_event", event: { delta: { type: "text_delta", text: "lo" } } }).slice(0, 20)}`,
      `${JSON.stringify({ type: "stream_event", event: { delta: { type: "text_delta", text: "lo" } } }).slice(20)}\n`,
      `${JSON.stringify({ type: "result", result: "Hello", total_cost_usd: 0.0123 })}\n`,
    ];
    const events = (await collect(runClaudeAnalysis(opts, { spawn: fakeSpawn(chunks) }))) as Array<
      Record<string, unknown>
    >;
    const text = events
      .filter((e) => e.type === "text")
      .map((e) => e.delta)
      .join("");
    expect(text).toBe("Hello");
    const result = events.find((e) => e.type === "result");
    expect(result).toBeDefined();
    expect(result?.costUsd).toBe(0.0123);
    expect(result?.text).toBe("Hello");
  });

  test("surfaces an is_error result as an error event", async () => {
    const chunk = `${JSON.stringify({ type: "result", is_error: true, result: "boom" })}\n`;
    const events = (await collect(runClaudeAnalysis(opts, { spawn: fakeSpawn([chunk]) }))) as Array<
      Record<string, unknown>
    >;
    expect(events).toEqual([{ type: "error", message: "boom" }]);
  });

  test("reports a non-zero exit with no result as an error, using stderr", async () => {
    const events = (await collect(
      runClaudeAnalysis(opts, { spawn: fakeSpawn([], 1, "not logged in") }),
    )) as Array<Record<string, unknown>>;
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("error");
    expect(events[0]?.message).toContain("not logged in");
  });

  test("ignores non-JSON noise and unknown event types", async () => {
    const chunks = [
      "not json\n",
      `${JSON.stringify({ type: "system", subtype: "init" })}\n`,
      `${JSON.stringify({ type: "result", result: "ok", total_cost_usd: 0 })}\n`,
    ];
    const events = (await collect(runClaudeAnalysis(opts, { spawn: fakeSpawn(chunks) }))) as Array<
      Record<string, unknown>
    >;
    expect(events).toEqual([{ type: "result", text: "ok", costUsd: 0, model: "sonnet" }]);
  });
});

describe("resolveClaudeBinary", () => {
  test("returns the resolved PATH binary", () => {
    expect(resolveClaudeBinary(() => "/opt/claude")).toBe("/opt/claude");
  });

  test("falls back to the local install probe when PATH misses", () => {
    // `which` finds nothing: the result is either undefined (no local install)
    // or the local-install path — never a PATH hit. Not asserting a hard
    // undefined keeps the test hermetic on machines that do have a local claude.
    const r = resolveClaudeBinary(() => null);
    expect(r === undefined || r.endsWith("claude")).toBe(true);
  });
});

describe("DEFAULT_ANALYSIS_MODEL", () => {
  test("is a valid model", () => {
    expect(isValidModel(DEFAULT_ANALYSIS_MODEL)).toBe(true);
  });
});
