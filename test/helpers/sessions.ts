import type { Database } from "bun:sqlite";

/**
 * Insert a session row with sane defaults for every commonly-asserted column;
 * a test overrides only what it cares about. JSON columns take pre-stringified
 * values (`'{"git status":1}'`), matching what the indexer stores.
 */
export function insertSession(
  db: Database,
  row: Record<string, string | number | null> & { path: string },
): void {
  const defaults: Record<string, string | number | null> = {
    project_id: "p1",
    project_path: "/p/one",
    session_id: row.path,
    title: row.path,
    cost_total: 0,
    cost_estimated: 0,
    cost_input: 0,
    cost_output: 0,
    cost_cache_write: 0,
    cost_cache_read: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_write_5m: 0,
    cache_write_1h: 0,
    cache_read: 0,
    turns: 0,
    api_calls: 0,
    tool_calls: 0,
    web_searches: 0,
    web_fetches: 0,
    active_ms: 0,
    sidechain_calls: 0,
    sidechain_cost: 0,
    prompt_chars: 0,
    retries: 0,
  };
  const full = { ...defaults, ...row };
  const cols = Object.keys(full);
  db.query(
    `INSERT INTO sessions (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`,
  ).run(...(Object.values(full) as (string | number | null)[]));
}
