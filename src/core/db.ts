import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { indexDbPath, stateDir } from "./paths.ts";

// The meta table holds the schema version; it must exist before the version
// check, so it's created ahead of the rest of the schema (see openDb).
const META_SCHEMA = `CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);`;

const SCHEMA = `
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
  active_ms INTEGER,
  sidechain_calls INTEGER,
  sidechain_cost REAL,
  prompt_chars INTEGER,
  retries INTEGER,
  compactions INTEGER,
  models_json TEXT,
  tools_json TEXT,
  tool_errors_json TEXT,
  skills_json TEXT,
  skill_errors_json TEXT,
  subagents_json TEXT,
  turn_depths_json TEXT,
  permission_modes_json TEXT,
  stop_reasons_json TEXT,
  files_json TEXT,
  branches_json TEXT,
  versions_json TEXT,
  commands_json TEXT,
  command_errors_json TEXT,
  retries_json TEXT,
  compactions_json TEXT,
  size_bytes INTEGER,
  mtime_ms REAL,
  indexed_at REAL
);

CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id);
CREATE INDEX IF NOT EXISTS idx_sessions_month ON sessions(month);
CREATE INDEX IF NOT EXISTS idx_sessions_day ON sessions(day);
CREATE INDEX IF NOT EXISTS idx_sessions_session_id ON sessions(session_id);
`;

// v6: replaces the classified bash/test columns (bash_json, bash_errors_json,
// test_runs, test_failures) with raw normalized command heads
// (commands_json/command_errors_json), so command-family and test-runner
// heuristics classify at query time and can evolve without reindexing. Stale
// indexes must be dropped and rebuilt.
// v7: adds compaction columns — `compactions` (count of the session's OWN
// main-chain compactions: subagent compactions and inherited continuation-file
// boundaries excluded, so one compaction never counts in two rows) plus the
// full `compactions_json` detail for query-time splits.
// v8: compactions_json records now carry the boundary event's `uuid`, which
// `compactionUsage()` dedupes on portfolio-wide. The incremental indexer skips
// unchanged files, so rows written by v7 would keep uuid-less records forever
// and the dedupe would silently no-op — the bump forces the rebuild.
export const SCHEMA_VERSION = "8";

/**
 * Open (and migrate) the index database. The index is a disposable cache — it
 * can be deleted and rebuilt from the JSONL files at any time.
 */
export function openDb(path: string = indexDbPath()): Database {
  mkdirSync(stateDir(), { recursive: true });
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = NORMAL;");
  // Check the version before applying SCHEMA: creating a new index against a
  // stale sessions table (missing the indexed column) would fail.
  db.exec(META_SCHEMA);
  const row = db.query("SELECT value FROM meta WHERE key = 'schema_version'").get() as
    | { value: string }
    | undefined;
  if (row?.value !== SCHEMA_VERSION) {
    // The index is a disposable cache: on a schema change, drop and recreate the
    // sessions table (with the current columns) so a rebuild fills it accurately.
    db.exec("DROP TABLE IF EXISTS sessions;");
    db.query("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)").run(
      SCHEMA_VERSION,
    );
  }
  db.exec(SCHEMA);
  return db;
}
