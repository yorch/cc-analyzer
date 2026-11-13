import type { Database } from "bun:sqlite";
import type { SessionAnalysis } from "./analyze.ts";
import { analyzeSessionStream } from "./analyze.ts";
import { ArchiveIdentityError, archiveSessions, listArchiveRoots } from "./archive.ts";
import { type ClaudeRoot, claudeRoots } from "./claude-roots.ts";
import {
  planSessions,
  retainsMissingRows,
  type SessionInfo,
  scanRoots,
  sessionRowKey,
  sessionTree,
} from "./discover.ts";
import { LAST_SCAN_KEY, readReanalyzeKeys } from "./index-status.ts";
import { streamSessionTree } from "./parser.ts";
import { getArchiveDuringIndex } from "./prefs.ts";
import type { PricingTable } from "./pricing.ts";
import { loadPricing } from "./pricing-source.ts";
import {
  aliasesForProjectPath,
  aliasNeedsReindex,
  projectAliasId,
  readProjectAliases,
} from "./project-aliases.ts";

export interface SessionRow {
  path: string;
  claude_dir: string;
  project_id: string;
  project_alias: string | null;
  project_path: string | null;
  session_id: string | null;
  title: string | null;
  start_time: string | null;
  end_time: string | null;
  day: string | null;
  month: string | null;
  duration_ms: number | null;
  turns: number;
  api_calls: number;
  tool_calls: number;
  input_tokens: number;
  output_tokens: number;
  cache_write_5m: number;
  cache_write_1h: number;
  cache_read: number;
  cost_input: number;
  cost_output: number;
  cost_cache_write: number;
  cost_cache_read: number;
  cost_total: number;
  cost_estimated: number;
  web_searches: number;
  web_fetches: number;
  active_ms: number;
  sidechain_calls: number;
  sidechain_cost: number;
  prompt_chars: number;
  retries: number;
  compactions: number;
  first_prompt_tokens: number | null;
  parse_lines: number;
  parse_errors: number;
  unknown_events: number;
  test_fail_streak: number;
  redundant_reads: number;
  correction_turns: number;
  interruption_turns: number;
  reread_files_json: string;
  models_json: string;
  tools_json: string;
  tool_errors_json: string;
  skills_json: string;
  skill_errors_json: string;
  skill_turn_costs_json: string;
  subagents_json: string;
  turn_depths_json: string;
  permission_modes_json: string;
  stop_reasons_json: string;
  files_json: string;
  branches_json: string;
  versions_json: string;
  commands_json: string;
  command_errors_json: string;
  retries_json: string;
  compactions_json: string;
  size_bytes: number;
  mtime_ms: number;
  indexed_at: number;
}

/**
 * Local-time YYYY-MM-DD for an ISO timestamp. `day`/`month` must agree with
 * the activity heatmap, which buckets by `strftime(..., 'localtime')`.
 */
function localDay(iso: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Flatten a session analysis + file metadata into a database row. */
export function toSessionRow(
  analysis: SessionAnalysis,
  info: SessionInfo,
  now: number,
  aliases: ReadonlyMap<string, string> = new Map(),
): SessionRow {
  const t = analysis.totals.tokens;
  const c = analysis.totals.cost;
  const alias = aliasesForProjectPath(analysis.projectPath, aliases) ?? null;
  const day = analysis.startTime ? localDay(analysis.startTime) : null;
  return {
    path: info.path,
    claude_dir: info.root,
    project_id: alias ? projectAliasId(alias) : info.projectId,
    project_alias: alias,
    project_path: analysis.projectPath ?? null,
    session_id: analysis.sessionId ?? info.id,
    title: analysis.title ?? null,
    start_time: analysis.startTime ?? null,
    end_time: analysis.endTime ?? null,
    day,
    month: day ? day.slice(0, 7) : null,
    duration_ms: analysis.durationMs ?? null,
    turns: analysis.totals.turns,
    api_calls: analysis.totals.apiCalls,
    tool_calls: analysis.totals.toolCalls,
    input_tokens: t.inputTokens,
    output_tokens: t.outputTokens,
    cache_write_5m: t.cacheWrite5mTokens,
    cache_write_1h: t.cacheWrite1hTokens,
    cache_read: t.cacheReadTokens,
    cost_input: c.input,
    cost_output: c.output,
    cost_cache_write: c.cacheWrite,
    cost_cache_read: c.cacheRead,
    cost_total: c.total,
    cost_estimated: c.estimated ? 1 : 0,
    web_searches: analysis.totals.webSearches,
    web_fetches: analysis.totals.webFetches,
    active_ms: analysis.totals.activeMs,
    sidechain_calls: analysis.totals.sidechainApiCalls,
    sidechain_cost: analysis.totals.sidechainCost,
    prompt_chars: analysis.promptChars,
    retries: analysis.retries,
    // Own main-chain compactions only — the countable rollup signal.
    compactions: analysis.compactions.filter((c) => !c.isSidechain && !c.inherited).length,
    // Null (not 0) when the session made no main-chain API call — there is no
    // baseline to report, and 0 would drag every percentile down.
    first_prompt_tokens: analysis.firstPromptTokens ?? null,
    // Coverage is always known on this path (the streaming parser returns it),
    // and a session with no lines genuinely has zero — 0, not NULL.
    parse_lines: analysis.parseCoverage?.lines ?? 0,
    parse_errors: analysis.parseCoverage?.parseErrors ?? 0,
    unknown_events: analysis.parseCoverage?.unknownEvents ?? 0,
    test_fail_streak: analysis.testFailStreak,
    redundant_reads: analysis.redundantReads,
    correction_turns: analysis.correctionTurns,
    interruption_turns: analysis.interruptionTurns,
    reread_files_json: JSON.stringify(analysis.rereadFiles),
    models_json: JSON.stringify(analysis.models),
    tools_json: JSON.stringify(analysis.tools),
    tool_errors_json: JSON.stringify(analysis.toolErrors),
    skills_json: JSON.stringify(analysis.skills),
    skill_errors_json: JSON.stringify(analysis.skillErrors),
    skill_turn_costs_json: JSON.stringify(analysis.skillTurnCosts),
    subagents_json: JSON.stringify(analysis.subagents),
    turn_depths_json: JSON.stringify(analysis.turnDepths),
    permission_modes_json: JSON.stringify(analysis.permissionModes),
    stop_reasons_json: JSON.stringify(analysis.stopReasons),
    files_json: JSON.stringify(analysis.filesTouched),
    branches_json: JSON.stringify(analysis.gitBranches),
    versions_json: JSON.stringify(analysis.versions),
    commands_json: JSON.stringify(analysis.commandHeads),
    command_errors_json: JSON.stringify(analysis.commandHeadErrors),
    retries_json: JSON.stringify(analysis.retriesByTool),
    compactions_json: JSON.stringify(analysis.compactions),
    size_bytes: info.sizeBytes,
    mtime_ms: info.mtimeMs,
    indexed_at: now,
  };
}

const COLUMNS: (keyof SessionRow)[] = [
  "path",
  "claude_dir",
  "project_id",
  "project_alias",
  "project_path",
  "session_id",
  "title",
  "start_time",
  "end_time",
  "day",
  "month",
  "duration_ms",
  "turns",
  "api_calls",
  "tool_calls",
  "input_tokens",
  "output_tokens",
  "cache_write_5m",
  "cache_write_1h",
  "cache_read",
  "cost_input",
  "cost_output",
  "cost_cache_write",
  "cost_cache_read",
  "cost_total",
  "cost_estimated",
  "web_searches",
  "web_fetches",
  "active_ms",
  "sidechain_calls",
  "sidechain_cost",
  "prompt_chars",
  "retries",
  "compactions",
  "first_prompt_tokens",
  "parse_lines",
  "parse_errors",
  "unknown_events",
  "test_fail_streak",
  "redundant_reads",
  "correction_turns",
  "interruption_turns",
  "reread_files_json",
  "models_json",
  "tools_json",
  "tool_errors_json",
  "skills_json",
  "skill_errors_json",
  "skill_turn_costs_json",
  "subagents_json",
  "turn_depths_json",
  "permission_modes_json",
  "stop_reasons_json",
  "files_json",
  "branches_json",
  "versions_json",
  "commands_json",
  "command_errors_json",
  "retries_json",
  "compactions_json",
  "size_bytes",
  "mtime_ms",
  "indexed_at",
];

function upsertStatement(db: Database) {
  const cols = COLUMNS.join(", ");
  const placeholders = COLUMNS.map(() => "?").join(", ");
  return db.query(`INSERT OR REPLACE INTO sessions (${cols}) VALUES (${placeholders})`);
}

function rowValues(row: SessionRow): (string | number | null)[] {
  return COLUMNS.map((c) => row[c]);
}

/** Run an async mapper over items with a bounded concurrency. */
async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) break;
      results[i] = await fn(items[i] as T);
    }
  });
  await Promise.all(workers);
  return results;
}

export interface ReindexResult {
  total: number;
  indexed: number;
  skipped: number;
  deleted: number;
  /**
   * Why archive-during-index did not copy sessions this run (an unresolved
   * archive identity); absent when it ran or was not requested. Indexing is
   * unaffected: it only reads the archive.
   */
  archiveSkipped?: string;
}

export interface ReindexOptions {
  /** Ignore existing state and re-parse everything. */
  rebuild?: boolean;
  concurrency?: number;
  pricing?: PricingTable;
  /** Progress callback: (done, toDo). */
  onProgress?: (done: number, total: number) => void;
  /** Claude roots to scan. Defaults to the configured ones; injectable for tests. */
  roots?: ClaudeRoot[];
  /** Archive current source sessions before indexing when enabled. */
  archive?: boolean;
}

/**
 * Incrementally (re)build the session index. Files whose size and mtime are
 * unchanged since the last index are skipped; deleted files are pruned.
 */
export async function reindex(db: Database, opts: ReindexOptions = {}): Promise<ReindexResult> {
  const concurrency = opts.concurrency ?? 16;
  const pricing = opts.pricing ?? (await loadPricing()).table;
  const now = Date.now();
  const aliases = await readProjectAliases();

  // Resolve the configured roots once and pass them down: resolution reads the
  // filesystem, and the discovery helpers would otherwise repeat it per project.
  const sourceRoots = opts.roots ?? claudeRoots();
  let archiveSkipped: string | undefined;
  if (opts.archive ?? getArchiveDuringIndex()) {
    try {
      await archiveSessions(sourceRoots);
    } catch (error) {
      // Unresolved identity: indexing only reads the archive, so proceed, but
      // report that the backup did not run (`archive run` is the refusal).
      if (!(error instanceof ArchiveIdentityError)) throw error;
      archiveSkipped = error.message;
    }
  }
  const roots = [...sourceRoots, ...(await listArchiveRoots())];
  // A configured-but-unreadable root (unmounted volume, a synced folder
  // mid-setup) must not have its rows pruned — only a root the user actually
  // de-configured should lose its data.
  const retained = retainsMissingRows(await scanRoots(roots));

  const existing = new Map<
    string,
    {
      mtime_ms: number;
      size_bytes: number;
      claude_dir: string;
      project_path: string | null;
      project_alias: string | null;
    }
  >();
  {
    const rows = db
      .query(
        "SELECT path, mtime_ms, size_bytes, claude_dir, project_path, project_alias FROM sessions",
      )
      .all() as {
      path: string;
      mtime_ms: number;
      size_bytes: number;
      claude_dir: string;
      project_path: string | null;
      project_alias: string | null;
    }[];
    for (const r of rows) {
      existing.set(r.path, {
        mtime_ms: r.mtime_ms,
        size_bytes: r.size_bytes,
        claude_dir: r.claude_dir,
        project_path: r.project_path,
        project_alias: r.project_alias,
      });
    }
  }

  // One plan shared with `inspectIndexStatus`: the deduped files, the rows this
  // run deletes (`pruned` — their usage claims must not block this run's
  // analyses, or a session taking over from a pruned copy indexes at $0), and
  // the survivors that must be re-analyzed because a pruned row shares their key.
  const {
    sessions: files,
    reingest,
    pruned,
  } = await planSessions(roots, existing, retained, readReanalyzeKeys(db));
  const currentPaths = new Set(files.map((f) => f.path));

  // On rebuild, ignore existing state for skipping — but still prune below.
  // Beyond size/mtime, a row is stale when the alias it was indexed under (its
  // own `project_alias` column) disagrees with the current map. Using the row
  // as ground truth means a run that failed partway, or a root that was
  // unreadable, can never leave a stale alias that a later run cannot see.
  const toIngest = opts.rebuild
    ? files
    : files.filter((f) => {
        const prev = existing.get(f.path);
        if (!prev || prev.mtime_ms !== f.mtimeMs || prev.size_bytes !== f.sizeBytes) return true;
        if (reingest.has(f.path)) return true;
        return aliasNeedsReindex(prev.project_path, prev.project_alias, aliases.byPath);
      });
  // Oldest first: when a continuation file and its parent land in the same
  // scan, the parent (older mtime) claims the shared calls, so the copied
  // spend attributes to the session that actually ran it. Attribution — not
  // correctness — depends on this order; totals count each call once either way.
  toIngest.sort((a, b) => a.mtimeMs - b.mtimeMs);

  // Cross-file usage de-dup: a continuation/copied session file repeats its
  // parent's assistant entries (same message ids), which used to double-count
  // their cost in every portfolio rollup. Each de-duplicated call's identity is
  // claimed by the first file to count it — prior runs' claims live in
  // `usage_keys`, this run's in `runClaims` (checked synchronously, so files
  // analyzed concurrently can't both count one call). A file re-analyzed after
  // changing may re-claim its own keys. `runClaims` holds only this run's keys:
  // small on incremental scans, the whole portfolio once on a full rebuild.
  const runClaims = new Map<string, string>();
  const priorClaim = db.query("SELECT path FROM usage_keys WHERE key = ?");
  if (opts.rebuild) {
    // Re-derive every claim from scratch — except those of rows this run will
    // not re-analyze (a root unreadable right now keeps its rows): they keep
    // counting their calls, so their claims must keep blocking the other copies
    // of the session, exactly as on an incremental run. The re-analysis debt is
    // not wiped either: the settling loop below clears a key once every row with
    // it was re-analyzed, so only keys a row could not pay stay owed.
    const retainedRows = new Set<string>();
    for (const path of existing.keys()) {
      if (!pruned.has(path) && !currentPaths.has(path)) retainedRows.add(path);
    }
    const kept = (
      db.query("SELECT key, path FROM usage_keys").all() as {
        key: string;
        path: string;
      }[]
    ).filter((c) => retainedRows.has(c.path));
    db.query("DELETE FROM usage_keys").run();
    const reclaim = db.query("INSERT INTO usage_keys (key, path) VALUES (?, ?)");
    for (const c of kept) reclaim.run(c.key, c.path);
  }
  const claimFor =
    (path: string) =>
    (key: string): boolean => {
      const mine = runClaims.get(key);
      if (mine !== undefined) return mine === path;
      const prior = priorClaim.get(key) as { path: string } | undefined;
      // A prior claim held by a different file blocks, unless that file's row
      // is being deleted this run. The holder keeps the claim even when it is
      // itself being re-analyzed: its re-analysis may FAIL (unreadable file),
      // in which case its old row keeps counting the call, and handing the call
      // to a second row would count it twice. A call the holder later sheds is
      // healed by re-analysis on the next run instead (`reanalyze_keys`).
      if (prior && prior.path !== path && !pruned.has(prior.path)) return false;
      runClaims.set(key, path);
      return true;
    };

  let done = 0;
  const rows = await mapPool(toIngest, concurrency, async (info) => {
    try {
      // Stream events and skip the per-turn timeline: the index stores only
      // aggregates, so a huge session never materializes as a full array.
      // The whole session tree, not just the parent file: Claude Code writes
      // subagent work to <sessionId>/subagents/, and those calls belong to this
      // row. Aggregate mode never builds bursts, so `agentMeta` is not needed
      // here — only the events are.
      const analysis = await analyzeSessionStream(streamSessionTree(sessionTree(info)), pricing, {
        detail: false,
        claimUsage: claimFor(info.path),
      });
      return toSessionRow(analysis, info, now, aliases.byPath);
    } catch {
      return null;
    } finally {
      done++;
      opts.onProgress?.(done, toIngest.length);
    }
  });

  // No separate re-stamp pass: root qualification makes the ordinary project
  // identity stable, while a stale alias sends just the affected files (rows whose
  // recorded project_alias disagrees with the current map) through this same
  // analysis/upsert path, so alias changes update row keys too.
  const upsert = upsertStatement(db);
  const deleteStmt = db.query("DELETE FROM sessions WHERE path = ?");
  const deleteKeysStmt = db.query("DELETE FROM usage_keys WHERE path = ?");
  const insertKeyStmt = db.query("INSERT OR REPLACE INTO usage_keys (key, path) VALUES (?, ?)");

  const oldKeysStmt = db.query("SELECT key FROM usage_keys WHERE path = ?");
  const debtDelete = db.query("DELETE FROM reanalyze_keys WHERE key = ?");
  const debtInsert = db.query("INSERT OR REPLACE INTO reanalyze_keys (key) VALUES (?)");

  let deleted = 0;
  const writeAll = db.transaction(() => {
    // A re-analyzed file's stored claims are replaced wholesale by this run's;
    // a file whose analysis failed keeps its old row AND its old claims.
    const okPaths = new Set<string>();
    // Rows (after this run) per session key, to decide who owes re-analysis.
    const members = new Map<string, Set<string>>();
    const addMember = (path: string) => {
      const key = sessionRowKey(path);
      const set = members.get(key);
      if (set) set.add(path);
      else members.set(key, new Set([path]));
    };
    for (const path of existing.keys()) if (!pruned.has(path)) addMember(path);
    for (const row of rows) if (row) addMember(row.path);

    // This run's claims grouped by the file that took them, built once: a
    // per-row scan of `runClaims` is quadratic when many sessions keep both
    // copies (every sibling row would walk the whole portfolio's claims).
    const claimedBy = new Map<string, Set<string>>();
    if (!opts.rebuild) {
      for (const [key, path] of runClaims) {
        const set = claimedBy.get(path);
        if (set) set.add(key);
        else claimedBy.set(path, new Set([key]));
      }
    }

    const released = new Set<string>(); // session keys whose copies must be re-analyzed
    for (const row of rows) {
      if (!row) continue;
      // A rebuild cleared the ledger first, so there are no old claims to
      // compare against.
      const sibling = !opts.rebuild && (members.get(sessionRowKey(row.path))?.size ?? 0) > 1;
      // Claims this row held before and no longer claims. Only matters when
      // another row of the same session exists, so single-copy sessions (the
      // overwhelming majority) skip the key comparison entirely.
      if (sibling) {
        const now = claimedBy.get(row.path) ?? new Set<string>();
        for (const { key } of oldKeysStmt.all(row.path) as { key: string }[]) {
          if (now.has(key)) continue;
          // No other file can have taken it this run: the row's own prior claim
          // blocked every other file from it.
          released.add(sessionRowKey(row.path));
          break;
        }
      }
      upsert.run(...rowValues(row));
      okPaths.add(row.path);
      deleteKeysStmt.run(row.path);
    }
    for (const [key, path] of runClaims) {
      if (okPaths.has(path)) insertKeyStmt.run(key, path);
    }
    const prunedKeys = new Set<string>();
    for (const [path, prev] of existing) {
      if (currentPaths.has(path)) continue;
      if (retained(prev.claude_dir)) continue;
      // The deleted file's claims are freed here. Survivors of the same session
      // were re-analyzed this run with those claims available (`pruned` bypasses
      // the ledger); any that were not (a failed analysis, an unreadable
      // retained root) are recorded as debt below.
      deleteStmt.run(path);
      deleteKeysStmt.run(path);
      prunedKeys.add(sessionRowKey(path));
      deleted++;
    }
    // Maintain the re-analysis debt (`reanalyze_keys`, session keys). A key is
    // OWED when (a) a pruned row shared it and some surviving row of the
    // session was not successfully re-analyzed this run, or (b) a re-analyzed
    // file released claims no analyzed file took, while another row of the
    // session exists: that row's unchanged (size, mtime) means no scan would
    // ever revisit it. It is SETTLED once every row with the key was
    // re-analyzed successfully (or none remain). A key whose rows cannot be
    // re-analyzed (unreadable file, retained root) stays owed, so a permanently
    // failing file keeps `--check` honest instead of silently dropping the debt.
    for (const key of readReanalyzeKeys(db)) {
      const rest = members.get(key);
      if (!rest || [...rest].every((p) => okPaths.has(p))) debtDelete.run(key);
    }
    for (const key of prunedKeys) {
      const rest = members.get(key);
      if (rest && [...rest].some((p) => !okPaths.has(p))) debtInsert.run(key);
    }
    for (const key of released) debtInsert.run(key);
    // A rebuild wiped the ledger up front, so a file whose analysis FAILED keeps
    // its old row (and its old call count) with no claims behind it: any other
    // copy would re-claim those calls and count them twice. Owe the session a
    // re-analysis; the failed row is not in `okPaths`, so the debt stands until
    // the file reads again, and then re-claims only what no one else holds.
    if (opts.rebuild) {
      toIngest.forEach((f, i) => {
        if (!rows[i] && existing.has(f.path)) debtInsert.run(sessionRowKey(f.path));
      });
    }
    db.query("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(
      LAST_SCAN_KEY,
      String(Date.now()),
    );
  });
  writeAll();

  const indexed = rows.filter((r) => r !== null).length;
  return {
    total: files.length,
    indexed,
    skipped: files.length - toIngest.length,
    deleted,
    archiveSkipped,
  };
}
