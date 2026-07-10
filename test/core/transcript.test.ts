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
