import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { parseSessionFile } from "../../src/core/parser.ts";
import { buildTranscript } from "../../src/core/transcript.ts";

const fixturePath = fileURLToPath(new URL("../fixtures/sample-session.jsonl", import.meta.url));

describe("buildTranscript", () => {
  test("flattens prompts, thinking, text, tool_use and tool_result in order", async () => {
    const { events } = await parseSessionFile(fixturePath);
    const items = buildTranscript(events);
    const kinds = items.map((i) => i.kind);
    expect(kinds).toEqual([
      "prompt", // u1
      "thinking", // a1
      "text", // a1
      "tool_use", // a1 Write
      "tool_result", // u2
      "text", // a2 Done
      "prompt", // u3
      "tool_use", // a3 Bash
      "tool_result", // u4 (error)
    ]);
  });

  test("assigns turn numbers by genuine prompt", async () => {
    const { events } = await parseSessionFile(fixturePath);
    const items = buildTranscript(events);
    expect(items[0]?.turnIndex).toBe(0);
    expect(items.at(-1)?.turnIndex).toBe(1);
  });

  test("marks error tool results and captures tool names", async () => {
    const { events } = await parseSessionFile(fixturePath);
    const items = buildTranscript(events);
    const errorResult = items.find((i) => i.kind === "tool_result" && i.isError);
    expect(errorResult?.body).toBe("1 test failed");
    const bash = items.find((i) => i.kind === "tool_use" && i.label === "Bash");
    expect(bash).toBeDefined();
  });
});

describe("buildTranscript · compaction summaries", () => {
  test("renders the machine-written summary as a labeled system item, not a prompt", () => {
    const events = [
      {
        type: "user",
        uuid: "u1",
        timestamp: "t1",
        message: { role: "user", content: "real prompt" },
      },
      {
        type: "user",
        uuid: "u2",
        isCompactSummary: true,
        timestamp: "t2",
        message: { role: "user", content: "This session is being continued…" },
      },
    ] as unknown as Parameters<typeof buildTranscript>[0];
    const items = buildTranscript(events);
    expect(items.map((i) => i.label)).toEqual(["You", "Compaction summary"]);
    expect(items[1]?.role).toBe("system");
    expect(items[1]?.kind).toBe("text");
    // Turn numbering follows genuine prompts only.
    expect(items[1]?.turnIndex).toBe(0);
  });
});
