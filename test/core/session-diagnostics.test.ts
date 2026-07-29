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

/* ——— Thrash diagnostics ————————————————————————————————————————————— */

let seq = 0;
const toolUse = (id: string, name: string, input: unknown): SessionEvent =>
  ({
    type: "assistant",
    uuid: `tu-${++seq}`,
    timestamp: at(0, Math.min(59, seq)),
    message: {
      id: `msg-tu-${seq}`,
      role: "assistant",
      model: "claude-opus-4-7",
      content: [{ type: "tool_use", id, name, input }],
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  }) as unknown as SessionEvent;
const toolResult = (id: string, isError: boolean): SessionEvent =>
  ({
    type: "user",
    uuid: `tr-${++seq}`,
    timestamp: at(0, Math.min(59, seq)),
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: id, is_error: isError, content: "out" }],
    },
  }) as unknown as SessionEvent;

/** N failing test runs in a row (edit-test loop without the edits). */
function failingRuns(n: number): SessionEvent[] {
  const events: SessionEvent[] = [prompt("u1", 0)];
  for (let i = 0; i < n; i++) {
    events.push(toolUse(`t-${i}`, "Bash", { command: "bun test" }), toolResult(`t-${i}`, true));
  }
  return events;
}

/** Read each file the given number of times. */
function reads(files: Record<string, number>): SessionEvent[] {
  const events: SessionEvent[] = [prompt("u1", 0)];
  for (const [file, n] of Object.entries(files)) {
    for (let i = 0; i < n; i++) events.push(toolUse(`r-${file}-${i}`, "Read", { file_path: file }));
  }
  return events;
}

describe("buildSessionDiagnostics · edit-test-thrash", () => {
  const find = (n: number) =>
    buildSessionDiagnostics(analyzeSession(failingRuns(n), pricing)).find(
      (d) => d.code === "edit-test-thrash",
    );

  test("fires as info at a streak of 3 and escalates to warning at 4", () => {
    const info = find(3);
    expect(info?.severity).toBe("info");
    expect(info?.evidence).toBe("3 consecutive failing test runs without a pass.");
    expect(find(4)?.severity).toBe("warning");
  });

  test("stays quiet at a streak of 2", () => {
    expect(find(2)).toBeUndefined();
  });
});

describe("buildSessionDiagnostics · repeated-file-reads", () => {
  const diag = (files: Record<string, number>) =>
    buildSessionDiagnostics(analyzeSession(reads(files), pricing)).find(
      (d) => d.code === "repeated-file-reads",
    );

  test("fires as info at 4 redundant reads and names the top file", () => {
    // 6 reads of one file = 4 redundant on one chain.
    const f = diag({ "/p/hot.md": 6, "/p/other.md": 1 });
    expect(f?.severity).toBe("info");
    expect(f?.evidence).toContain("4 redundant reads");
    expect(f?.evidence).toContain("/p/hot.md (6 reads)");
  });

  test("fires as info when any single file is read 4 times", () => {
    // Only 2 redundant reads — but one file read 4 times is worth naming.
    const f = diag({ "/p/hot.md": 4 });
    expect(f?.severity).toBe("info");
    expect(f?.evidence).toContain("2 redundant reads");
  });

  test("escalates to warning at 8 redundant reads", () => {
    expect(diag({ "/p/hot.md": 10 })?.severity).toBe("warning");
  });

  test("stays quiet when files are read at most 3 times and redundancy is low", () => {
    expect(diag({ "/p/a.md": 3, "/p/b.md": 3, "/p/c.md": 3 })).toBeUndefined();
    expect(diag({ "/p/a.md": 2, "/p/b.md": 2 })).toBeUndefined();
  });
});
