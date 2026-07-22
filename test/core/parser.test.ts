import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import type { AssistantEvent, UserEvent } from "../../src/core/events.ts";
import { parseSessionFile, parseSessionText } from "../../src/core/parser.ts";

const fixturePath = fileURLToPath(new URL("../fixtures/sample-session.jsonl", import.meta.url));

describe("parseSessionText", () => {
  test("parses every non-empty line into an event", async () => {
    const text = await Bun.file(fixturePath).text();
    const { events, errors } = parseSessionText(text);
    expect(errors).toHaveLength(0);
    expect(events).toHaveLength(10);
  });

  test("preserves unknown/future event types instead of dropping them", async () => {
    const { events } = await parseSessionFile(fixturePath);
    const future = events.find((e) => (e as { type: string }).type === "some-future-type");
    expect(future).toBeDefined();
    expect((future as Record<string, unknown>).brandNewField).toBe(42);
  });

  test("extracts assistant model, usage and content blocks", async () => {
    const { events } = await parseSessionFile(fixturePath);
    const a1 = events.find((e) => (e as { uuid?: string }).uuid === "a1") as AssistantEvent;
    expect(a1.message.model).toBe("claude-opus-4-7");
    expect(a1.message.usage?.input_tokens).toBe(10);
    expect(a1.message.usage?.cache_read_input_tokens).toBe(2000);
    expect(a1.message.content.map((c) => c.type)).toEqual(["thinking", "text", "tool_use"]);
  });

  test("distinguishes string prompts from tool_result carrier user messages", async () => {
    const { events } = await parseSessionFile(fixturePath);
    const prompt = events.find((e) => (e as { uuid?: string }).uuid === "u1") as UserEvent;
    const carrier = events.find((e) => (e as { uuid?: string }).uuid === "u2") as UserEvent;
    expect(typeof prompt.message.content).toBe("string");
    expect(Array.isArray(carrier.message.content)).toBe(true);
  });

  test("records errors for malformed JSON lines", () => {
    const { events, errors } = parseSessionText(
      '{"type":"ai-title","sessionId":"s","aiTitle":"t"}\nnot json\n',
    );
    expect(events).toHaveLength(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.line).toBe(2);
  });
});

describe("parseSessionText · non-object lines", () => {
  test("valid-JSON scalar lines become errors, not events", () => {
    const { events, errors } = parseSessionText('null\n42\n"hi"');
    expect(events).toHaveLength(0);
    expect(errors).toHaveLength(3);
    expect(errors.every((e) => e.error === "not a JSON object")).toBe(true);
  });
});
