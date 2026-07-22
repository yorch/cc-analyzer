import { type SessionEvent, schemaByType, unknownEventSchema } from "./events.ts";

export interface ParseError {
  /** 1-based line number in the source file. */
  line: number;
  raw: string;
  error: string;
}

export interface ParseResult {
  events: SessionEvent[];
  errors: ParseError[];
}

/**
 * Parse one JSONL line into `events` / `errors` (1-based `line` number).
 *
 * Tolerant by design: a line that is not valid JSON is recorded as an error and
 * skipped; a line whose known-type schema fails validation falls back to a raw
 * "unknown" event so downstream counts stay consistent and nothing throws.
 */
function parseLine(raw: string, line: number, events: SessionEvent[], errors: ParseError[]): void {
  if (raw.trim() === "") return;

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    errors.push({ line, raw, error: `invalid JSON: ${String(err)}` });
    return;
  }

  const type =
    typeof json === "object" && json !== null && "type" in json
      ? String((json as { type: unknown }).type)
      : undefined;

  const schema = type ? schemaByType[type] : undefined;
  if (schema) {
    const result = schema.safeParse(json);
    if (result.success) {
      events.push(result.data as SessionEvent);
      return;
    }
    // Known type but shape drifted — keep it as a tolerant unknown event and
    // note the validation error rather than dropping data.
    errors.push({ line, raw, error: `schema mismatch (${type}): ${result.error.message}` });
  }

  const fallback = unknownEventSchema.safeParse(json);
  if (fallback.success) {
    events.push(fallback.data as SessionEvent);
    return;
  }
  // Valid JSON but not an object (`null`, a number, a string…): downstream
  // consumers assume property access is safe, so record it as an error.
  if (typeof json !== "object" || json === null) {
    errors.push({ line, raw, error: "not a JSON object" });
    return;
  }
  events.push(json as SessionEvent);
}

/** Parse the in-memory text of a session JSONL file into typed events. */
export function parseSessionText(text: string): ParseResult {
  const events: SessionEvent[] = [];
  const errors: ParseError[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    parseLine(lines[i] ?? "", i + 1, events, errors);
  }
  return { events, errors };
}

/**
 * Read and parse a session JSONL file from disk, streaming it line by line.
 *
 * Sessions can reach hundreds of MB; streaming avoids holding the whole file as
 * a single string *and* its `split("\n")` array in memory at once (only the
 * parsed events, which the caller needs anyway, plus one chunk are resident).
 */
export async function parseSessionFile(path: string): Promise<ParseResult> {
  const events: SessionEvent[] = [];
  const errors: ParseError[] = [];
  const decoder = new TextDecoder();
  let buf = "";
  let line = 0;

  for await (const chunk of Bun.file(path).stream()) {
    buf += decoder.decode(chunk, { stream: true });
    let start = 0;
    let nl = buf.indexOf("\n", start);
    while (nl !== -1) {
      // A trailing "\r" on CRLF files is fine — JSON.parse ignores it.
      parseLine(buf.slice(start, nl), ++line, events, errors);
      start = nl + 1;
      nl = buf.indexOf("\n", start);
    }
    // Keep only the unfinished tail; compacted once per chunk, not per line.
    buf = buf.slice(start);
  }
  buf += decoder.decode(); // flush any multi-byte remainder
  if (buf.length > 0) parseLine(buf, ++line, events, errors);

  return { events, errors };
}
