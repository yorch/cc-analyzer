import { describe, expect, test } from "bun:test";
import { analyzeSession, usageToTokens } from "../../src/core/analyze.ts";
import type { SessionEvent } from "../../src/core/events.ts";
import { parseSessionText } from "../../src/core/parser.ts";
import { inspectSessionHealth } from "../../src/core/session-health.ts";
import { buildTranscript } from "../../src/core/transcript.ts";
import {
  assistantEvent,
  clock,
  promptEvent,
  toolResultEvent,
  toolUseBlock,
} from "../helpers/events.ts";
import { samplePricing as pricing } from "../helpers/pricing.ts";

const at = clock(2026, 7, 1, 10);
const raw = (e: unknown) => e as SessionEvent;

describe("schema-drifted known-type events (C1)", () => {
  const drifted: SessionEvent[] = [
    promptEvent("u1", at(0)),
    // assistant without a message object
    raw({ type: "assistant", uuid: "d1", timestamp: at(0, 1) }),
    // assistant whose message is a string
    raw({ type: "assistant", uuid: "d2", timestamp: at(0, 2), message: "oops" }),
    // assistant with string token fields and non-array content
    raw({
      type: "assistant",
      uuid: "d3",
      timestamp: at(0, 3),
      message: {
        id: "m3",
        model: "claude-opus-4-7",
        content: "not an array",
        usage: { input_tokens: "100", output_tokens: "5", cache_read_input_tokens: { a: 1 } },
      },
    }),
    // user with object content
    raw({ type: "user", uuid: "d4", timestamp: at(0, 4), message: { content: { x: 1 } } }),
    // user without message
    raw({ type: "user", uuid: "d5", timestamp: at(0, 5) }),
    // real, healthy call afterwards
    assistantEvent({
      uuid: "a1",
      timestamp: at(0, 6),
      usage: { input_tokens: 10, output_tokens: 20 },
    }),
  ];

  test("analyzeSession does not throw and totals stay numeric", () => {
    const a = analyzeSession(drifted, pricing);
    expect(typeof a.totals.tokens.inputTokens).toBe("number");
    expect(a.totals.tokens.inputTokens).toBe(10 + 0);
    expect(a.totals.tokens.outputTokens).toBe(20);
    expect(Number.isFinite(a.totals.cost.total)).toBe(true);
    expect(a.totals.turns).toBe(1);
  });

  test("usageToTokens coerces non-numbers to 0", () => {
    const t = usageToTokens({
      input_tokens: "7",
      output_tokens: Number.NaN,
      cache_creation_input_tokens: "9",
    } as never);
    expect(t).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheWrite5mTokens: 0,
      cacheWrite1hTokens: 0,
      cacheReadTokens: 0,
    });
  });

  test("buildTranscript and inspectSessionHealth survive them", () => {
    expect(() => buildTranscript(drifted)).not.toThrow();
    expect(() => inspectSessionHealth(drifted)).not.toThrow();
  });

  test("the parser still emits the tolerant unknown event and counts it", () => {
    const { events, coverage } = parseSessionText(
      `${JSON.stringify({ type: "assistant", uuid: "x", message: "bad" })}\n`,
    );
    expect(events).toHaveLength(1);
    expect(coverage.unknownEvents).toBe(1);
  });
});

describe("replayed assistant lines (C3)", () => {
  const tool = (id: string) => [toolUseBlock(id, "Grep", { pattern: id })];

  test("a replay under a different non-empty requestId does not recount tools", () => {
    const a = analyzeSession(
      [
        promptEvent("u1", at(0)),
        assistantEvent({
          uuid: "a1",
          timestamp: at(0, 1),
          messageId: "m1",
          requestId: "r1",
          content: tool("t1"),
        }),
        assistantEvent({
          uuid: "a2",
          timestamp: at(0, 2),
          messageId: "m1",
          requestId: "r2",
          content: tool("t1"),
        }),
      ],
      pricing,
    );
    expect(a.tools.Grep).toBe(1);
    expect(a.totals.apiCalls).toBe(1);
  });

  test("streamed continuations (same or absent requestId) still count their tools", () => {
    const a = analyzeSession(
      [
        promptEvent("u1", at(0)),
        assistantEvent({
          uuid: "a1",
          timestamp: at(0, 1),
          messageId: "m1",
          requestId: "r1",
          content: tool("t1"),
        }),
        assistantEvent({
          uuid: "a2",
          timestamp: at(0, 2),
          messageId: "m1",
          requestId: "r1",
          content: tool("t2"),
        }),
        assistantEvent({ uuid: "a3", timestamp: at(0, 3), messageId: "m1", content: tool("t3") }),
      ],
      pricing,
    );
    expect(a.tools.Grep).toBe(3);
    expect(a.totals.apiCalls).toBe(1);
  });

  test("a call refused by a cross-file claim still counts its tools", () => {
    const a = analyzeSession(
      [
        promptEvent("u1", at(0)),
        assistantEvent({
          uuid: "a1",
          timestamp: at(0, 1),
          messageId: "m1",
          requestId: "r1",
          content: tool("t1"),
        }),
      ],
      pricing,
      { claimUsage: () => false },
    );
    expect(a.tools.Grep).toBe(1);
    expect(a.totals.apiCalls).toBe(0);
  });
});

describe("turn depth with refused claims (C5)", () => {
  test("a claim-refused main-chain call still deepens the turn; firstPromptTokens stays unset", () => {
    const events = [
      promptEvent("u1", at(0)),
      assistantEvent({ uuid: "a1", timestamp: at(0, 1), messageId: "m1" }),
      assistantEvent({ uuid: "a2", timestamp: at(0, 2), messageId: "m2" }),
    ];
    const a = analyzeSession(events, pricing, { claimUsage: (k) => k !== "m1" });
    expect(a.turnDepths).toEqual([2]);
    expect(a.totals.apiCalls).toBe(1);
  });
});

describe("timestamps and test streaks", () => {
  test("an unparseable timestamp never yields a NaN duration", () => {
    const a = analyzeSession(
      [
        promptEvent("u1", at(0)),
        assistantEvent({ uuid: "a1", timestamp: "not-a-date" }),
        assistantEvent({ uuid: "a2", timestamp: at(5) }),
      ],
      pricing,
    );
    expect(Number.isNaN(a.durationMs)).toBe(false);
    expect(a.durationMs).toBe(5 * 60_000);
    expect(a.startTime).toBe(at(0));
  });

  test("a late failing result cannot seed the next turn's fail streak", () => {
    const bash = (id: string, ts: string) =>
      assistantEvent({
        uuid: `b-${id}`,
        timestamp: ts,
        content: [toolUseBlock(id, "Bash", { command: "bun test" })],
      });
    const events = [
      promptEvent("u1", at(0)),
      bash("t1", at(0, 1)),
      promptEvent("u2", at(1)),
      // The result of turn 1's test lands after turn 2 opened.
      toolResultEvent({ uuid: "r1", timestamp: at(1, 5), toolUseId: "t1", isError: true }),
      bash("t2", at(1, 10)),
      toolResultEvent({ uuid: "r2", timestamp: at(1, 15), toolUseId: "t2", isError: true }),
    ];
    for (const detail of [true, false]) {
      const a = analyzeSession(events, pricing, { detail });
      expect(a.testFailStreak).toBe(1);
      expect(a.testFailures).toBe(2);
    }
  });
});
