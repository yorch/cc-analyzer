import { describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AssistantEvent, UserEvent } from "../../src/core/events.ts";
import {
  type ParseError,
  parseSessionFile,
  parseSessionText,
  streamSessionEvents,
} from "../../src/core/parser.ts";

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

describe("parseSessionFile · streaming", () => {
  const write = (name: string, content: string): string => {
    const p = join(tmpdir(), `cc-analyzer-parse-${process.pid}-${name}`);
    writeFileSync(p, content);
    return p;
  };

  test("streamed file matches the in-memory parse of the same content", async () => {
    const text = await Bun.file(fixturePath).text();
    const streamed = await parseSessionFile(fixturePath);
    const inMemory = parseSessionText(text);
    expect(streamed.events).toHaveLength(inMemory.events.length);
    expect(streamed.errors).toEqual(inMemory.errors);
  });

  test("splits lines correctly across chunk boundaries and keeps line numbers", async () => {
    // Many lines with large-ish bodies so the file spans multiple read chunks;
    // a bad line-number would then land the error on the wrong line.
    const good = (i: number) =>
      JSON.stringify({ type: "ai-title", sessionId: "s", aiTitle: "x".repeat(500), i });
    const lines: string[] = [];
    for (let i = 0; i < 5000; i++) lines.push(good(i));
    lines[2500] = "not json"; // a malformed line mid-stream
    const p = write("chunks.jsonl", `${lines.join("\n")}\n`);
    try {
      const { events, errors } = await parseSessionFile(p);
      expect(events).toHaveLength(4999);
      expect(errors).toHaveLength(1);
      expect(errors[0]?.line).toBe(2501); // 1-based
    } finally {
      rmSync(p, { force: true });
    }
  });

  test("handles CRLF line endings and a missing final newline", async () => {
    const p = write(
      "crlf.jsonl",
      '{"type":"ai-title","sessionId":"s","aiTitle":"a"}\r\n{"type":"ai-title","sessionId":"s","aiTitle":"b"}',
    );
    try {
      const { events, errors } = await parseSessionFile(p);
      expect(errors).toHaveLength(0);
      expect(events).toHaveLength(2);
    } finally {
      rmSync(p, { force: true });
    }
  });

  test("reassembles a single record that spans many read chunks", async () => {
    // One JSON line larger than a stream chunk (~64KB) forces the line to be
    // pieced back together from several chunks.
    const big = JSON.stringify({ type: "ai-title", sessionId: "s", aiTitle: "y".repeat(300_000) });
    const p = write("bigline.jsonl", `${big}\n{"type":"ai-title","sessionId":"s","aiTitle":"z"}\n`);
    try {
      const { events, errors } = await parseSessionFile(p);
      expect(errors).toHaveLength(0);
      expect(events).toHaveLength(2);
      expect((events[0] as { aiTitle: string }).aiTitle).toHaveLength(300_000);
    } finally {
      rmSync(p, { force: true });
    }
  });

  test("rejects when the file does not exist (callers rely on the throw)", async () => {
    const missing = join(tmpdir(), `cc-analyzer-parse-${process.pid}-missing.jsonl`);
    expect(parseSessionFile(missing)).rejects.toThrow();
  });

  test("a scalar line in a streamed file is recorded as an error", async () => {
    const p = write("scalar.jsonl", 'null\n{"type":"ai-title","sessionId":"s","aiTitle":"a"}\n');
    try {
      const { events, errors } = await parseSessionFile(p);
      expect(events).toHaveLength(1);
      expect(errors).toHaveLength(1);
      expect(errors[0]?.error).toBe("not a JSON object");
      expect(errors[0]?.line).toBe(1);
    } finally {
      rmSync(p, { force: true });
    }
  });
});

describe("parse coverage", () => {
  const write = (name: string, content: string): string => {
    const p = join(tmpdir(), `cc-analyzer-coverage-${process.pid}-${name}`);
    writeFileSync(p, content);
    return p;
  };

  // 3 clean lines, 1 malformed, 1 scalar, 1 unknown type, 1 drifted known type
  // (an `assistant` line with no `message`), plus a blank line that must not
  // count as content.
  const MIXED = [
    '{"type":"ai-title","sessionId":"s","aiTitle":"a"}',
    '{"type":"ai-title","sessionId":"s","aiTitle":"b"}',
    '{"type":"ai-title","sessionId":"s","aiTitle":"c"}',
    "not json",
    "42",
    '{"type":"some-future-type","brandNewField":1}',
    '{"type":"assistant","uuid":"a1"}',
    "",
  ].join("\n");

  /** 7 non-empty lines: 2 lost outright, 2 kept as tolerant unknowns. */
  const expected = { lines: 7, parseErrors: 2, unknownEvents: 2 };

  test("parseSessionText counts lines, hard errors and tolerant unknowns", () => {
    const { events, errors, coverage } = parseSessionText(MIXED);
    expect(coverage).toEqual(expected);
    // The drifted line survives as an event, so it is not "skipped" — but it is
    // recorded as a ParseError too, which is why errors.length ≠ parseErrors.
    expect(events).toHaveLength(5);
    expect(errors).toHaveLength(3);
  });

  test("all three entry points agree on the same content", async () => {
    const p = write("mixed.jsonl", `${MIXED}\n`);
    try {
      const file = await parseSessionFile(p);
      const text = parseSessionText(MIXED);
      let streamed: unknown;
      const it = streamSessionEvents(p)[Symbol.asyncIterator]();
      for (;;) {
        const next = await it.next();
        if (next.done) {
          streamed = next.value;
          break;
        }
      }
      expect(file.coverage).toEqual(expected);
      expect(text.coverage).toEqual(expected);
      expect(streamed).toEqual(expected);
    } finally {
      rmSync(p, { force: true });
    }
  });

  test("an empty file has zero coverage, not a divide-by-zero", async () => {
    const p = write("empty.jsonl", "");
    try {
      const { coverage } = await parseSessionFile(p);
      expect(coverage).toEqual({ lines: 0, parseErrors: 0, unknownEvents: 0 });
      expect(parseSessionText("").coverage).toEqual(coverage);
      expect(parseSessionText("\n\n\n").coverage.lines).toBe(0);
    } finally {
      rmSync(p, { force: true });
    }
  });

  test("a fully understood file reports no unparsed lines", async () => {
    const clean = '{"type":"ai-title","sessionId":"s","aiTitle":"a"}\n';
    const p = write("clean.jsonl", clean.repeat(3));
    try {
      const { coverage } = await parseSessionFile(p);
      expect(coverage).toEqual({ lines: 3, parseErrors: 0, unknownEvents: 0 });
    } finally {
      rmSync(p, { force: true });
    }
  });
});

describe("streamSessionEvents", () => {
  const write = (name: string, content: string): string => {
    const p = join(tmpdir(), `cc-analyzer-stream-${process.pid}-${name}`);
    writeFileSync(p, content);
    return p;
  };

  async function collect(path: string, onError?: (e: ParseError) => void) {
    const events = [];
    for await (const e of streamSessionEvents(path, onError)) events.push(e);
    return events;
  }

  test("yields the same events as parseSessionFile (no array materialized)", async () => {
    const streamed = await collect(fixturePath);
    const { events } = await parseSessionFile(fixturePath);
    expect(streamed).toEqual(events);
  });

  test("reports parse errors through the onError sink and still yields valid events", async () => {
    const p = write(
      "mixed.jsonl",
      '{"type":"ai-title","sessionId":"s","aiTitle":"a"}\nnot json\nnull\n{"type":"ai-title","sessionId":"s","aiTitle":"b"}\n',
    );
    try {
      const errors: ParseError[] = [];
      const events = await collect(p, (e) => errors.push(e));
      expect(events).toHaveLength(2); // the two valid ai-title lines
      expect(errors.map((e) => e.line)).toEqual([2, 3]); // 1-based, in order
      expect(errors[1]?.error).toBe("not a JSON object");
    } finally {
      rmSync(p, { force: true });
    }
  });

  test("streams a record spanning many chunks without loading the whole file", async () => {
    const big = JSON.stringify({ type: "ai-title", sessionId: "s", aiTitle: "q".repeat(200_000) });
    const p = write("big.jsonl", `${big}\n{"type":"ai-title","sessionId":"s","aiTitle":"z"}\n`);
    try {
      const events = await collect(p);
      expect(events).toHaveLength(2);
      expect((events[0] as { aiTitle: string }).aiTitle).toHaveLength(200_000);
    } finally {
      rmSync(p, { force: true });
    }
  });
});
