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
  claude_dir TEXT NOT NULL,
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
  first_prompt_tokens INTEGER,
  parse_lines INTEGER,
  parse_errors INTEGER,
  unknown_events INTEGER,
  test_fail_streak INTEGER,
  redundant_reads INTEGER,
  correction_turns INTEGER,
  interruption_turns INTEGER,
  reread_files_json TEXT,
  models_json TEXT,
  tools_json TEXT,
  tool_errors_json TEXT,
  skills_json TEXT,
  skill_errors_json TEXT,
  skill_turn_costs_json TEXT,
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
CREATE INDEX IF NOT EXISTS idx_sessions_claude_dir ON sessions(claude_dir);
CREATE INDEX IF NOT EXISTS idx_sessions_month ON sessions(month);
CREATE INDEX IF NOT EXISTS idx_sessions_day ON sessions(day);
CREATE INDEX IF NOT EXISTS idx_sessions_session_id ON sessions(session_id);

CREATE TABLE IF NOT EXISTS usage_keys (
  key TEXT PRIMARY KEY,
  path TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_usage_keys_path ON usage_keys(path);
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
// v9: adds `first_prompt_tokens` — the prompt-side tokens of a session's first
// main-chain API call, the context-tax baseline `contextTax()` takes
// percentiles over. NULL when the session made no main-chain call. Same
// rationale as v8: the incremental indexer skips unchanged files, so rows
// written by v8 would keep the column NULL forever and every established
// project would report no baseline — the bump forces the rebuild.
// v10: adds `skill_turn_costs_json` — per-skill turn-scoped cost attribution
// (the cost of the turns that invoked a skill), the primary skill-cost number
// the surfaces now show. Same rationale as v8/v9: the incremental indexer skips
// unchanged files, so rows written by v9 would carry no attribution forever and
// every skill would report $0 — the bump forces the rebuild.
// v11: adds the parse-coverage columns — `parse_lines`, `parse_errors`,
// `unknown_events` — the per-session record of how much of each JSONL file this
// build of the parser actually understood, which `parseCoverage()` rolls up and
// the `parse-coverage-drop` diagnostic watches. Same rationale as v8/v9/v10:
// the incremental indexer skips unchanged files, so rows written by v10 would
// report zero lines forever and the coverage share would read as a clean 0%
// exactly when it matters most — the bump forces the rebuild.
// v12: adds the thrash columns — `test_fail_streak` (longest run of
// consecutive failing test runs on one chain, the edit→test→fail loop signal),
// `redundant_reads` (Read invocations beyond the second of the same file on
// one chain), and `reread_files_json` (the files read ≥ 3 times, most re-read
// first) — what the thrash session diagnostics and the `test-thrash-pattern` /
// `reread-heavy` insight rules read. Same rationale as v8–v11: the incremental
// indexer skips unchanged files, so rows written by v11 would report zero
// thrash forever — the bump forces the rebuild.
// v13: adds the correction columns — `correction_turns` (real prompts opening
// with a correction marker, per `isCorrectionPrompt`) and `interruption_turns`
// (turns carrying a "[Request interrupted by user…]" marker) — what the
// corrections rollup, the `correction-loop` session diagnostic, and the
// `correction-heavy` insight rule read. Same rationale as v8–v12: the
// incremental indexer skips unchanged files, so rows written by v12 would
// report zero corrections forever — the bump forces the rebuild. Note the
// `isTestCommand`-style trade-off, made the other way here: the correction
// marker list is baked in at index time, so evolving the phrase heuristics
// requires a reindex (unlike command heads, which classify at query time).
// v14: adds `claude_dir` — which Claude Code data directory a session was
// discovered under, now that `claudeRoots()` can resolve more than one. It is
// what scopes the indexer's prune (a row whose root is no longer configured is
// dropped, so removing a root removes its data) and what `index --check`
// counts against. Project ids are made globally unique at index time instead
// (`qualifyProjectId`), so no aggregate query needs a root clause. Same
// rationale as v8–v13: the incremental indexer skips unchanged files, so rows
// written by v13 would carry no root forever and the first multi-root prune
// would treat every one of them as de-configured — the bump forces the rebuild.
// v15: project ids are now root-qualified **uniformly** (`<rootSlug>~<name>`),
// including the primary root's — previously the first root's ids were bare, so
// a project's identity depended on which root sorted first and silently changed
// meaning when the configured list was reordered. Every id in a v14 index is
// therefore the wrong shape; the bump rebuilds them.
// v16: cost accounting changed three ways at once, all baked into indexed
// rows: (1) the `usage_keys` table — each counted API call's stable identity
// (message id), claimed by the file that first counted it, so a
// continuation/copied session file no longer double-counts the parent's spend
// in portfolio rollups; (2) long-context (>200K prompt) calls price at the
// tiered rates; (3) a zero-token call (e.g. a "<synthetic>" error stub) no
// longer flips `cost_estimated` for the whole session. Rows written by v15
// carry the old numbers and no claims — the bump forces the rebuild.
// v18: `claude-sonnet-5` is now priced at the rate Claude Code bills rather
// than the introductory rate LiteLLM publishes (see `PRICE_CORRECTIONS`), a
// 1.5x change in every token category. Cost is computed at index time and
// stored, so v17 rows keep the understated numbers — and the incremental
// indexer skips unchanged files, so they would keep them forever. This is a
// pricing change rather than a shape change, but the bump is the only
// mechanism that forces the rebuild, and "rows computed under the old rule
// stay wrong" is exactly what it exists for.
export const SCHEMA_VERSION = "18";

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
    db.exec("DROP TABLE IF EXISTS usage_keys;");
    db.query("DELETE FROM meta WHERE key = 'last_scan_at'").run();
    db.query("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)").run(
      SCHEMA_VERSION,
    );
  }
  db.exec(SCHEMA);
  return db;
}
