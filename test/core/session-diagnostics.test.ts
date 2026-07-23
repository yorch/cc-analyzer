import { describe, expect, test } from "bun:test";
import { analyzeSession } from "../../src/core/analyze.ts";
import type { SessionEvent } from "../../src/core/events.ts";
import { buildSessionDiagnostics } from "../../src/core/session-diagnostics.ts";
import { samplePricing as pricing } from "../helpers/pricing.ts";

const at = (minutes: number, seconds = 0): string =>
  new Date(Date.UTC(2026, 6, 1, 10, minutes, seconds)).toISOString();

const prompt = (id: string, minutes: number, text = id): SessionEvent =>
  ({
    type: "user",
    uuid: id,
    timestamp: at(minutes),
    message: { role: "user", content: text },
  }) as unknown as SessionEvent;

function assistant(id: string, minutes: number, usage: Record<string, number>): SessionEvent {
  return {
    type: "assistant",
    uuid: id,
    timestamp: at(minutes, 10),
    message: {
      id: `msg_${id}`,
      role: "assistant",
      model: "claude-opus-4-7",
      stop_reason: "end_turn",
      content: [{ type: "text", text: "ok" }],
      usage,
    },
  } as unknown as SessionEvent;
}

describe("buildSessionDiagnostics", () => {
  test("reports context pressure and a large single-call jump with turn evidence", () => {
    const analysis = analyzeSession(
      [
        prompt("u1", 0),
        assistant("a1", 0, { input_tokens: 10_000, output_tokens: 1 }),
        assistant("a2", 1, { input_tokens: 160_000, output_tokens: 1 }),
      ],
      pricing,
    );

    const diagnostics = buildSessionDiagnostics(analysis);
    expect(diagnostics.map((d) => d.code)).toEqual(["context-pressure", "context-jump"]);
    expect(diagnostics[0]?.evidence).toContain("80%");
    expect(diagnostics[1]?.evidence).toContain("Turn 1");
  });

  test("detects cache writes after a five-minute idle gap", () => {
    const analysis = analyzeSession(
      [
        prompt("u1", 0),
        assistant("a1", 0, { input_tokens: 100, output_tokens: 1 }),
        prompt("u2", 6),
        assistant("a2", 6, {
          input_tokens: 100,
          output_tokens: 1,
          cache_creation_input_tokens: 2_000,
        }),
      ],
      pricing,
    );

    const diagnostic = buildSessionDiagnostics(analysis).find(
      (d) => d.code === "idle-cache-rewrite",
    );
    expect(diagnostic?.evidence).toContain("2,000 cache tokens");
    expect(diagnostic?.turnIndex).toBe(1);
  });

  test("flags a first post-compaction call that nearly refills prior context", () => {
    const analysis = analyzeSession(
      [
        prompt("u1", 0),
        assistant("a1", 0, { input_tokens: 100_000, output_tokens: 1 }),
        {
          type: "system",
          subtype: "compact_boundary",
          uuid: "compact-1",
          timestamp: at(1),
          compactMetadata: { trigger: "auto", preTokens: 100_000 },
        } as unknown as SessionEvent,
        prompt("u2", 2),
        assistant("a2", 2, { input_tokens: 80_000, output_tokens: 1 }),
      ],
      pricing,
    );

    const diagnostic = buildSessionDiagnostics(analysis).find(
      (d) => d.code === "post-compaction-refill",
    );
    expect(diagnostic?.evidence).toContain("80%");
    expect(diagnostic?.turnIndex).toBe(1);
  });

  test("reports when one of at least three turns dominates session cost", () => {
    const analysis = analyzeSession(
      [
        prompt("u1", 0),
        assistant("a1", 0, { input_tokens: 10, output_tokens: 1 }),
        prompt("u2", 1),
        assistant("a2", 1, { input_tokens: 10, output_tokens: 1 }),
        prompt("u3", 2),
        assistant("a3", 2, { input_tokens: 10_000, output_tokens: 1 }),
      ],
      pricing,
    );

    const diagnostic = buildSessionDiagnostics(analysis).find(
      (d) => d.code === "turn-cost-concentration",
    );
    expect(diagnostic?.turnIndex).toBe(2);
    expect(diagnostic?.evidence).toContain("Turn 3");
  });

  test("returns no diagnostics for a small uneventful session", () => {
    const analysis = analyzeSession(
      [prompt("u1", 0), assistant("a1", 0, { input_tokens: 100, output_tokens: 10 })],
      pricing,
    );
    expect(buildSessionDiagnostics(analysis)).toEqual([]);
  });
});
