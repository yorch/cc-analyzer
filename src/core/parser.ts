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
 * Parse the text of a session JSONL file into typed events.
 *
 * Tolerant by design: a line that is not valid JSON is recorded as an error and
 * skipped; a line whose known-type schema fails validation falls back to a raw
 * "unknown" event so downstream counts stay consistent and nothing throws.
 */
export function parseSessionText(text: string): ParseResult {
  const events: SessionEvent[] = [];
  const errors: ParseError[] = [];

  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    if (raw.trim() === "") continue;

    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch (err) {
      errors.push({ line: i + 1, raw, error: `invalid JSON: ${String(err)}` });
      continue;
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
        continue;
      }
      // Known type but shape drifted — keep it as a tolerant unknown event and
      // note the validation error rather than dropping data.
      errors.push({
        line: i + 1,
        raw,
        error: `schema mismatch (${type}): ${result.error.message}`,
      });
    }

    const fallback = unknownEventSchema.safeParse(json);
    events.push(fallback.success ? (fallback.data as SessionEvent) : (json as SessionEvent));
  }

  return { events, errors };
}

/** Read and parse a session JSONL file from disk. */
export async function parseSessionFile(path: string): Promise<ParseResult> {
  const text = await Bun.file(path).text();
  return parseSessionText(text);
}
