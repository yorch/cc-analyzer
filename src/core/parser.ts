import {
  type ParseCoverage,
  type SessionEvent,
  schemaByType,
  unknownEventSchema,
} from "./events.ts";

export type { ParseCoverage } from "./events.ts";

export interface ParseError {
  /** 1-based line number in the source file. */
  line: number;
  raw: string;
  error: string;
}

export interface ParseResult {
  events: SessionEvent[];
  errors: ParseError[];
  /** What this parser understood of the file (see `ParseCoverage`). */
  coverage: ParseCoverage;
}

/** Outcome of parsing one line: an event, a recorded error, or neither (blank). */
interface LineOutcome {
  event?: SessionEvent;
  error?: ParseError;
  /** True when the line was kept only as a tolerant "unknown" event — either a
   * known type whose schema drifted, or a type this parser doesn't know. */
  unknown?: boolean;
  /** False only for blank lines, which are not content. */
  counted?: boolean;
}

/** A zeroed coverage accumulator; `countLine` folds each outcome into it. */
function newCoverage(): ParseCoverage {
  return { lines: 0, parseErrors: 0, unknownEvents: 0 };
}

/**
 * Fold one line's outcome into the coverage counters. Every entry point calls
 * exactly this, so the three paths can't disagree about what "covered" means.
 * A drifted known type is counted once, as an unknown event, not also as a
 * parse error: the event survived, so no content was dropped.
 */
function countLine(coverage: ParseCoverage, outcome: LineOutcome): void {
  if (!outcome.counted) return;
  coverage.lines += 1;
  if (outcome.unknown) coverage.unknownEvents += 1;
  else if (outcome.error) coverage.parseErrors += 1;
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
    return { counted: true, error: { line, raw, error: `invalid JSON: ${String(err)}` } };
  }

  const type =
    typeof json === "object" && json !== null && "type" in json
      ? String((json as { type: unknown }).type)
      : undefined;

  const schema = type ? schemaByType[type] : undefined;
  if (schema) {
    const result = schema.safeParse(json);
    if (result.success) return { counted: true, event: result.data as SessionEvent };
    // Known type but shape drifted — record the drift, but still surface the
    // event (as a tolerant unknown, or raw if even that fails) so counts hold.
    // `json` here is always a non-null object (it carried a known `type`).
    const err: ParseError = {
      line,
      raw,
      error: `schema mismatch (${type}): ${result.error.message}`,
    };
    const fallback = unknownEventSchema.safeParse(json);
    return {
      counted: true,
      unknown: true,
      event: (fallback.success ? fallback.data : json) as SessionEvent,
      error: err,
    };
  }

  const fallback = unknownEventSchema.safeParse(json);
  if (fallback.success) {
    return { counted: true, unknown: true, event: fallback.data as SessionEvent };
  }
  // Valid JSON but not an object (`null`, a number, a string…): downstream
  // consumers assume property access is safe, so record it as an error.
  if (typeof json !== "object" || json === null) {
    return { counted: true, error: { line, raw, error: "not a JSON object" } };
  }
  return { counted: true, unknown: true, event: json as SessionEvent };
}

/** Parse the in-memory text of a session JSONL file into typed events. */
export function parseSessionText(text: string): ParseResult {
  const events: SessionEvent[] = [];
  const errors: ParseError[] = [];
  const coverage = newCoverage();
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const outcome = parseLineOutcome(lines[i] ?? "", i + 1);
    countLine(coverage, outcome);
    if (outcome.event) events.push(outcome.event);
    if (outcome.error) errors.push(outcome.error);
  }
  return { events, errors, coverage };
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
 *
 * Coverage is the generator's **return value**, not an out-parameter: it is the
 * only carrier that is impossible to forget to wire up and stays O(1) in
 * memory, so the streaming path keeps its constant-memory property.
 * `analyzeSessionStream` drives the iterator by hand precisely to capture it
 * (a `for await` loop discards a generator's return value).
 */
export async function* streamSessionEvents(
  path: string,
  onError?: (error: ParseError) => void,
): AsyncGenerator<SessionEvent, ParseCoverage> {
  const coverage = newCoverage();
  let line = 0;
  for await (const raw of readLines(path)) {
    const outcome = parseLineOutcome(raw, ++line);
    countLine(coverage, outcome);
    if (outcome.error && onError) onError(outcome.error);
    if (outcome.event) yield outcome.event;
  }
  return coverage;
}

/** Read and parse a session JSONL file from disk, streaming it line by line. */
export async function parseSessionFile(path: string): Promise<ParseResult> {
  const events: SessionEvent[] = [];
  const errors: ParseError[] = [];
  const coverage = newCoverage();
  let line = 0;
  for await (const raw of readLines(path)) {
    const outcome = parseLineOutcome(raw, ++line);
    countLine(coverage, outcome);
    if (outcome.event) events.push(outcome.event);
    if (outcome.error) errors.push(outcome.error);
  }
  return { events, errors, coverage };
}
