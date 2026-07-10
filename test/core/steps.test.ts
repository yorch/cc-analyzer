import { describe, expect, test } from "bun:test";
import { makeResultHint, resultToText, summarizeToolUse } from "../../src/core/steps.ts";

describe("summarizeToolUse", () => {
  test("Bash prefers description over command", () => {
    const s = summarizeToolUse("Bash", { command: "bun test", description: "Run tests" });
    expect(s).toEqual({ kind: "run", label: "Bash", summary: "Run tests" });
  });

  test("file tools summarize by path", () => {
    expect(summarizeToolUse("Read", { file_path: "/a/b.ts" }).summary).toBe("/a/b.ts");
    expect(summarizeToolUse("Edit", { file_path: "/a/b.ts" }).kind).toBe("edit");
    expect(summarizeToolUse("Write", { file_path: "/a/b.ts" }).label).toBe("Write");
  });

  test("search tools summarize by pattern/query", () => {
    expect(summarizeToolUse("Grep", { pattern: "TODO" }).summary).toBe("TODO");
    expect(summarizeToolUse("Grep", { pattern: "TODO" }).kind).toBe("search");
  });

  test("Skill and Task/Agent", () => {
    expect(summarizeToolUse("Skill", { skill: "superpowers:brainstorming" }).summary).toBe(
      "superpowers:brainstorming",
    );
    const task = summarizeToolUse("Task", {
      subagent_type: "code-reviewer",
      description: "review",
    });
    expect(task.kind).toBe("subagent");
    expect(task.summary).toBe("code-reviewer · review");
  });

  test("web tools", () => {
    expect(summarizeToolUse("WebFetch", { url: "https://x.dev" }).summary).toBe("https://x.dev");
    expect(summarizeToolUse("WebSearch", { query: "bun sqlite" }).kind).toBe("web");
  });

  test("unknown tool falls back to first string field", () => {
    const s = summarizeToolUse("MysteryTool", { foo: 1, note: "hello there" });
    expect(s.kind).toBe("tool");
    expect(s.label).toBe("MysteryTool");
    expect(s.summary).toBe("hello there");
  });
});

describe("makeResultHint", () => {
  test("error returns the first non-empty line", () => {
    expect(makeResultHint(true, "\n\nboom: it broke\nmore")).toBe("boom: it broke");
  });
  test("multi-line success reports a line count", () => {
    expect(makeResultHint(false, "a\nb\nc")).toBe("3 lines");
  });
  test("single-line success returns the text", () => {
    expect(makeResultHint(false, "File created")).toBe("File created");
  });
  test("empty result yields no hint", () => {
    expect(makeResultHint(false, "")).toBeUndefined();
  });
});

describe("resultToText", () => {
  test("joins text blocks and marks images", () => {
    expect(resultToText([{ type: "text", text: "hi" }, { type: "image" }])).toBe("hi\n[image]");
  });
  test("passes strings through", () => {
    expect(resultToText("ok")).toBe("ok");
  });
});
