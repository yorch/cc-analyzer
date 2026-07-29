import { describe, expect, test } from "bun:test";
import type { SessionEvent } from "../../src/core/events.ts";
import { inspectSessionHealth } from "../../src/core/session-health.ts";

const user = (uuid: string, parentUuid: string | null, sessionId = "s"): SessionEvent => ({
  type: "user",
  uuid,
  parentUuid,
  sessionId,
  message: { role: "user", content: "hello" },
});

const assistant = (
  uuid: string,
  parentUuid: string,
  content: unknown[] = [{ type: "text", text: "done" }],
  sessionId = "s",
): SessionEvent => ({
  type: "assistant",
  uuid,
  parentUuid,
  sessionId,
  message: { role: "assistant", content },
});

describe("inspectSessionHealth", () => {
  test("reports a complete session as healthy", () => {
    const report = inspectSessionHealth([user("u1", null), assistant("a1", "u1")]);
    expect(report).toEqual({
      status: "healthy",
      events: 2,
      parseErrors: 0,
      unknownEvents: 0,
      findings: [],
    });
  });

  test("distinguishes skipped records from preserved schema drift", () => {
    const report = inspectSessionHealth(
      [user("u1", null), assistant("a1", "u1")],
      [
        { line: 2, raw: "{", error: "invalid JSON: broken" },
        { line: 3, raw: "{}", error: "schema mismatch (user): changed" },
      ],
    );
    expect(report.status).toBe("damaged");
    expect(report.findings.map((finding) => finding.code)).toEqual([
      "unparseable-lines",
      "schema-drift",
    ]);
  });

  test("uses parser coverage to report unrecognized event types", () => {
    const report = inspectSessionHealth(
      [user("u1", null), assistant("a1", "u1"), { type: "future-event" }],
      [],
      { lines: 3, parseErrors: 0, unknownEvents: 1 },
    );
    expect(report.status).toBe("warning");
    expect(report.unknownEvents).toBe(1);
    expect(report.findings.map((finding) => finding.code)).toContain("schema-drift");
  });

  test("finds broken identities, chain references, and leaf pointers", () => {
    const report = inspectSessionHealth([
      user("same", "outside", "one"),
      assistant("same", "same", [], "two"),
      { type: "last-prompt", sessionId: "one", leafUuid: "missing" },
    ]);
    expect(report.status).toBe("damaged");
    expect(report.findings.map((finding) => finding.code)).toEqual(
      expect.arrayContaining([
        "multiple-session-ids",
        "duplicate-uuid",
        "missing-parent",
        "missing-leaf",
      ]),
    );
  });

  test("reports interrupted and out-of-file tool relationships as warnings", () => {
    const report = inspectSessionHealth([
      user("u1", null),
      assistant("a1", "u1", [{ type: "tool_use", id: "call-1", name: "Read", input: {} }]),
      {
        type: "user",
        uuid: "result",
        parentUuid: "a1",
        sessionId: "s",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "outside", content: "result" }],
        },
      },
      user("u2", "a1"),
    ]);
    expect(report.status).toBe("warning");
    expect(report.findings.map((finding) => finding.code)).toEqual(
      expect.arrayContaining(["unmatched-tool-use", "orphan-tool-result", "unanswered-prompt"]),
    );
  });

  test("distinguishes a machine interruption from an unanswered human prompt", () => {
    const report = inspectSessionHealth([
      user("u1", null),
      assistant("a1", "u1"),
      {
        type: "user",
        uuid: "interrupt",
        parentUuid: "a1",
        sessionId: "s",
        message: { role: "user", content: "[Request interrupted by user]" },
      },
    ]);
    expect(report.status).toBe("warning");
    expect(report.findings.map((finding) => finding.code)).toContain("interrupted-response");
    expect(report.findings.map((finding) => finding.code)).not.toContain("unanswered-prompt");
  });

  test("an empty source is damaged without redundant prompt findings", () => {
    const report = inspectSessionHealth([]);
    expect(report.status).toBe("damaged");
    expect(report.findings.map((finding) => finding.code)).toEqual(["empty-session"]);
  });
});
