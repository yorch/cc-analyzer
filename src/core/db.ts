import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { indexDbPath, stateDir } from "./paths.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  path TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  project_path TEXT,
  session_id TEXT,
  title TEXT,
  start_time TEXT,
  end_time TEXT,
  day TEXT,
  month TEXT,
  duration_ms INTEGER,
  turns INTEGER,
  api_calls INTEGER,
  tool_calls INTEGER,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cache_write_5m INTEGER,
  cache_write_1h INTEGER,
  cache_read INTEGER,
  cost_input REAL,
  cost_output REAL,
  cost_cache_write REAL,
  cost_cache_read REAL,
  cost_total REAL,
  cost_estimated INTEGER,
  web_searches INTEGER,
  web_fetches INTEGER,
  models_json TEXT,
  tools_json TEXT,
  tool_errors_json TEXT,
  skills_json TEXT,
  subagents_json TEXT,
  size_bytes INTEGER,
  mtime_ms REAL,
  indexed_at REAL
);

CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id);
CREATE INDEX IF NOT EXISTS idx_sessions_month ON sessions(month);
CREATE INDEX IF NOT EXISTS idx_sessions_day ON sessions(day);
`;

export const SCHEMA_VERSION = "2";

/**
 * Open (and migrate) the index database. The index is a disposable cache — it
 * can be deleted and rebuilt from the JSONL files at any time.
 */
export function openDb(path: string = indexDbPath()): Database {
  mkdirSync(stateDir(), { recursive: true });
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = NORMAL;");
  db.exec(SCHEMA);
  const row = db.query("SELECT value FROM meta WHERE key = 'schema_version'").get() as
    | { value: string }
    | undefined;
  if (row?.value !== SCHEMA_VERSION) {
    // The index is a disposable cache: on a schema change, drop and recreate the
    // sessions table (with the current columns) so a rebuild fills it accurately.
    db.exec("DROP TABLE IF EXISTS sessions;");
    db.exec(SCHEMA);
    db.query("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)").run(
      SCHEMA_VERSION,
    );
  }
  return db;
}
