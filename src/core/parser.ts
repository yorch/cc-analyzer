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

/** Outcome of parsing one line: an event, a recorded error, or neither (blank). */
interface LineOutcome {
  event?: SessionEvent;
  error?: ParseError;
}

/**
 * Parse one JSONL line into an event or a recorded error (1-based `line`).
 *
 * Tolerant by design: a line that is not valid JSON becomes an error and is
 * skipped; a line whose known-type schema fails validation falls back to a raw
 * "unknown" event so downstream counts stay consistent and nothing throws.
 * Shared by every entry point (`parseSessionText`, `parseSessionFile`,
 * `streamSessionEvents`) so their per-line behavior can't drift.
 */
function parseLineOutcome(raw: string, line: number): LineOutcome {
  if (raw.trim() === "") return {};

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    return { error: { line, raw, error: `invalid JSON: ${String(err)}` } };
  }

  const type =
    typeof json === "object" && json !== null && "type" in json
      ? String((json as { type: unknown }).type)
      : undefined;

  const schema = type ? schemaByType[type] : undefined;
  if (schema) {
    const result = schema.safeParse(json);
    if (result.success) return { event: result.data as SessionEvent };
    // Known type but shape drifted — record the drift, but still surface the
    // event (as a tolerant unknown, or raw if even that fails) so counts hold.
    // `json` here is always a non-null object (it carried a known `type`).
    const err: ParseError = {
      line,
      raw,
      error: `schema mismatch (${type}): ${result.error.message}`,
    };
    const fallback = unknownEventSchema.safeParse(json);
    return { event: (fallback.success ? fallback.data : json) as SessionEvent, error: err };
  }

  const fallback = unknownEventSchema.safeParse(json);
  if (fallback.success) return { event: fallback.data as SessionEvent };
  // Valid JSON but not an object (`null`, a number, a string…): downstream
  // consumers assume property access is safe, so record it as an error.
  if (typeof json !== "object" || json === null) {
    return { error: { line, raw, error: "not a JSON object" } };
  }
  return { event: json as SessionEvent };
}

/** Parse the in-memory text of a session JSONL file into typed events. */
export function parseSessionText(text: string): ParseResult {
  const events: SessionEvent[] = [];
  const errors: ParseError[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const { event, error } = parseLineOutcome(lines[i] ?? "", i + 1);
    if (event) events.push(event);
    if (error) errors.push(error);
  }
  return { events, errors };
}

/**
 * Yield the raw lines of a file, streaming its bytes.
 *
 * Sessions can reach hundreds of MB; streaming avoids holding the whole file as
 * a single string *and* its `split("\n")` array in memory at once. Fragments of
 * a line that spans chunks are accumulated in an array and joined once (when the
 * newline arrives), so a single huge record stays O(n) rather than
 * re-concatenating a growing buffer. Only file I/O (e.g. a missing file) throws.
 */
async function* readLines(path: string): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let pending: string[] = [];

  for await (const chunk of Bun.file(path).stream()) {
    const text = decoder.decode(chunk, { stream: true });
    let start = 0;
    let nl = text.indexOf("\n", start);
    while (nl !== -1) {
      // `segment` runs up to (not including) the newline; a trailing "\r" on
      // CRLF files is fine, JSON.parse ignores it.
      const segment = text.slice(start, nl);
      if (pending.length === 0) {
        yield segment; // common case: the whole line arrived in this chunk
      } else {
        pending.push(segment);
        yield pending.join("");
        pending = [];
      }
      start = nl + 1;
      nl = text.indexOf("\n", start);
    }
    if (start < text.length) pending.push(text.slice(start));
  }
  const tail = decoder.decode(); // flush any multi-byte remainder
  if (tail.length > 0) pending.push(tail);
  if (pending.length > 0) yield pending.join("");
}

/**
 * Stream a session's events without materializing the full array — the memory
 * win for bulk consumers (the indexer) over multi-hundred-MB sessions. Parse
 * errors are dropped unless an `onError` sink is provided. Blank lines yield
 * nothing but still advance the line counter, so error line numbers match
 * `parseSessionText`/`parseSessionFile`.
 */
export async function* streamSessionEvents(
  path: string,
  onError?: (error: ParseError) => void,
): AsyncGenerator<SessionEvent> {
  let line = 0;
  for await (const raw of readLines(path)) {
    const { event, error } = parseLineOutcome(raw, ++line);
    if (error && onError) onError(error);
    if (event) yield event;
  }
}

/** Read and parse a session JSONL file from disk, streaming it line by line. */
export async function parseSessionFile(path: string): Promise<ParseResult> {
  const events: SessionEvent[] = [];
  const errors: ParseError[] = [];
  let line = 0;
  for await (const raw of readLines(path)) {
    const { event, error } = parseLineOutcome(raw, ++line);
    if (event) events.push(event);
    if (error) errors.push(error);
  }
  return { events, errors };
}
