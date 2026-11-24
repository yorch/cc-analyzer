/**
 * Bulk export — portfolio / project / session × json / csv / md / html
 *
 * Bun-free except for filesystem + DB access. Shared by CLI `export` and
 * web `GET /api/export` so the two can't drift.
 *
 * Output is a folder (CLI default). With `--zip` / web streaming the same
 * folder is zipped on the fly via the `zip` CLI (available on macOS/Linux;
 * falls back to a plain folder error when absent). Web callers always get a
 * zip stream.
 */

import type { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { analyzeSession, type SessionAnalysis } from "./analyze.ts";
import { claudeRoots } from "./claude-roots.ts";
import { sessionSourceAt, sessionTree } from "./discover.ts";
import { parseSessionTree } from "./parser.ts";
import { getCostBasis } from "./prefs.ts";
import type { PricingTable } from "./pricing.ts";
import {
  buildSessionJsonPayload,
  capTranscript,
  REDACTED,
  redactAggregate,
  redactAnalysis,
} from "./redact.ts";
import { inspectSessionHealth, type SessionHealthReport } from "./session-health.ts";
import { sessionWhatIf } from "./session-insights.ts";
import { buildSessionHtml, buildSessionMarkdown, sanitizeFilename } from "./session-markdown.ts";
import { analyticsRollup, buildPortfolioStats, localDayOfMs, sessionCostRank } from "./stats.ts";
import type { SessionCostRank, WhatIfRepricing } from "./stats-types.ts";
import { buildTranscript, type TranscriptItem } from "./transcript.ts";
import { VERSION } from "./version.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ExportFormat = "json" | "csv" | "md" | "html";

export type ExportScope =
  | { kind: "portfolio" }
  | { kind: "project"; projectId: string }
  | { kind: "session"; idOrPath: string };

export interface ExportOptions {
  scope: ExportScope;
  formats: Set<ExportFormat>;
  /** Base output directory (CLI) or temp dir (web). */
  outDir: string;
  redact: boolean;
  /** When true emit both private/ and shareable/ trees. */
  split: boolean;
  includeTranscript: boolean;
  /** Zip the output after writing (CLI --zip). */
  zip?: boolean;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

const PLAIN_NUMBER = /^-?\d+(\.\d+)?(e[+-]?\d+)?$/i;

/** RFC 4180 quoting plus spreadsheet formula-injection protection. */
export function csvEscape(v: unknown): string {
  let s = String(v ?? "");
  // Excel formula injection protection: prefix cells that start with a formula
  // trigger. Plain numbers (a negative delta) are data, not formulas.
  if (/^[=+\-@\t\r]/.test(s) && !PLAIN_NUMBER.test(s)) s = `'${s}`;
  if (/[",\r\n']/.test(s)) return `"${s.replaceAll('"', '""')}"`;
  return s;
}

export function writeCsv(path: string, headers: string[], rows: string[][]): void {
  const lines = [headers.map(csvEscape).join(","), ...rows.map((r) => r.map(csvEscape).join(","))];
  writeFileSync(path, `${lines.join("\n")}\n`, "utf-8");
}

// redact helper for CSV fields
const redactVal = (v: string, redact: boolean, placeholder = REDACTED): string =>
  redact ? placeholder : v;

// ---------------------------------------------------------------------------
// Security helpers
// ---------------------------------------------------------------------------

function isPathUnderRoots(p: string): boolean {
  const expanded = p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
  const abs = resolve(expanded);
  for (const r of claudeRoots()) {
    const rel = relative(r.path, abs);
    if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return true;
  }
  return false;
}

function validateOutDir(outDir: string): void {
  if (outDir.split("/").includes("..") || outDir.split("\\").includes("..")) {
    throw new Error("--out must not contain '..' traversal");
  }
  // Reject absolute sensitive locations like /etc, /bin, /usr, /System
  const abs = resolve(outDir);
  const sensitive = ["/etc", "/bin", "/usr", "/System", "/var/db"];
  for (const s of sensitive) {
    if (abs === s || abs.startsWith(`${s}/`)) {
      throw new Error(`--out must not be inside sensitive directory '${s}'`);
    }
  }
}

const LARGE_PORTFOLIO_GUARD = 2000;

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

interface SessionRow {
  path: string;
  project_id: string;
  project_path: string | null;
  session_id: string | null;
  title: string | null;
  start_time: string | null;
  end_time: string | null;
  day: string | null;
  duration_ms: number | null;
  turns: number | null;
  api_calls: number | null;
  tool_calls: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_write_5m: number | null;
  cache_write_1h: number | null;
  cache_read: number | null;
  cost_total: number | null;
  cost_estimated: number | null;
  active_ms: number | null;
  sidechain_calls: number | null;
  sidechain_cost: number | null;
  web_searches: number | null;
  web_fetches: number | null;
  compactions: number | null;
  test_fail_streak: number | null;
  redundant_reads: number | null;
  correction_turns: number | null;
  interruption_turns: number | null;
  models_json: string | null;
  tools_json: string | null;
}

function queryRows(db: Database, scope: ExportScope): SessionRow[] {
  if (scope.kind === "portfolio") {
    return db.query("SELECT * FROM sessions ORDER BY start_time DESC").all() as SessionRow[];
  }
  if (scope.kind === "project") {
    return db
      .query("SELECT * FROM sessions WHERE project_id = ? ORDER BY start_time DESC")
      .all(scope.projectId) as SessionRow[];
  }
  // session scope — try session_id first, then path
  const byId = db
    .query("SELECT * FROM sessions WHERE session_id = ? LIMIT 1")
    .get(scope.idOrPath) as SessionRow | undefined;
  if (byId) return [byId];
  const byPath = db.query("SELECT * FROM sessions WHERE path = ? LIMIT 1").get(scope.idOrPath) as
    | SessionRow
    | undefined;
  if (byPath) return [byPath];
  // Not indexed — attempt direct file parse (caller will handle)
  return [];
}

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

function buildManifest(
  scope: ExportScope,
  formats: Set<ExportFormat>,
  rows: SessionRow[],
  opts: { redact: boolean; split: boolean; includeTranscript: boolean },
): Record<string, unknown> {
  return {
    version: VERSION,
    generatedAt: new Date().toISOString(),
    // A session scope may be a file path: the shareable tree names only the kind.
    scope: opts.redact ? { kind: scope.kind } : scope,
    formats: [...formats],
    privacy: opts.split ? "split" : opts.redact ? "redacted" : "private",
    includeTranscript: opts.includeTranscript,
    sessions: rows.length,
    costBasis: getCostBasis(),
  };
}

// ---------------------------------------------------------------------------
// Portfolio / project JSON
// ---------------------------------------------------------------------------

function writePortfolioJson(
  db: Database,
  outPath: string,
  scope: ExportScope,
  redact: boolean,
): void {
  const today = localDayOfMs(Date.now());
  const projectId = scope.kind === "project" ? scope.projectId : undefined;
  const analytics = analyticsRollup(db, projectId);
  if (projectId !== undefined) {
    // Project scope: only project-scoped rollups. The whole-portfolio aggregates
    // (other projects' spend, months, models) do not belong in a one-project bundle.
    const scoped = {
      scope: { kind: scope.kind },
      analytics: redact
        ? {
            tests: analytics.tests,
            corrections: analytics.corrections,
            turnDepth: analytics.turnDepth,
            permissionModes: analytics.permissionModes,
            stopReasons: analytics.stopReasons,
          }
        : analytics,
    };
    const body = redact ? redactAggregate(scoped) : { ...scoped, scope };
    writeFileSync(outPath, JSON.stringify(body, null, 2), "utf-8");
    return;
  }
  const portfolio = buildPortfolioStats(db, today, { projectLimit: 100, topLimit: 50 });
  if (redact) {
    // Shareable: aggregates only. Per-project rows, top sessions (titles), shell
    // command heads, skill names and branches are dropped by selection, and the
    // allowlist walk blanks any other string that slipped into what remains.
    const payload = redactAggregate({
      scope: { kind: scope.kind },
      portfolio: {
        summary: portfolio.summary,
        byMonth: portfolio.byMonth,
        byModel: portfolio.byModel,
        duration: portfolio.duration,
        distribution: portfolio.distribution,
        streaks: portfolio.streaks,
        runRate: portfolio.runRate,
        sidechain: portfolio.sidechain,
      },
      analytics: {
        tests: analytics.tests,
        corrections: analytics.corrections,
        turnDepth: analytics.turnDepth,
        permissionModes: analytics.permissionModes,
        stopReasons: analytics.stopReasons,
      },
    });
    writeFileSync(outPath, JSON.stringify(payload, null, 2), "utf-8");
    return;
  }
  writeFileSync(outPath, JSON.stringify({ scope, portfolio, analytics }, null, 2), "utf-8");
}

// ---------------------------------------------------------------------------
// Sessions CSV
// ---------------------------------------------------------------------------

function writeSessionsCsv(rows: SessionRow[], outPath: string, redact: boolean): void {
  const headers = [
    "session_id",
    "project_id",
    "project_path",
    "title",
    "start_time",
    "end_time",
    "day",
    "duration_ms",
    "active_ms",
    "turns",
    "api_calls",
    "tool_calls",
    "input_tokens",
    "output_tokens",
    "cache_read",
    "cache_write_5m",
    "cache_write_1h",
    "cost_total",
    "cost_estimated",
    "sidechain_calls",
    "sidechain_cost",
    "web_searches",
    "web_fetches",
    "compactions",
    "test_fail_streak",
    "redundant_reads",
    "correction_turns",
    "interruption_turns",
    "models",
    "tools",
  ];
  const outRows = rows.map((r) => [
    r.session_id ?? "",
    redactVal(r.project_id, redact),
    redactVal(r.project_path ?? "", redact),
    redactVal(r.title ?? "", redact),
    r.start_time ?? "",
    r.end_time ?? "",
    r.day ?? "",
    String(r.duration_ms ?? ""),
    String(r.active_ms ?? ""),
    String(r.turns ?? ""),
    String(r.api_calls ?? ""),
    String(r.tool_calls ?? ""),
    String(r.input_tokens ?? ""),
    String(r.output_tokens ?? ""),
    String(r.cache_read ?? ""),
    String(r.cache_write_5m ?? ""),
    String(r.cache_write_1h ?? ""),
    String(r.cost_total ?? ""),
    String(r.cost_estimated ?? ""),
    String(r.sidechain_calls ?? ""),
    String(r.sidechain_cost ?? ""),
    String(r.web_searches ?? ""),
    String(r.web_fetches ?? ""),
    String(r.compactions ?? ""),
    String(r.test_fail_streak ?? ""),
    String(r.redundant_reads ?? ""),
    String(r.correction_turns ?? ""),
    String(r.interruption_turns ?? ""),
    redact ? "[redacted]" : (r.models_json ?? ""),
    redact ? "[redacted]" : (r.tools_json ?? ""),
  ]);
  writeCsv(outPath, headers, outRows);
}

// ---------------------------------------------------------------------------
// Per-session detailed generation (for json / md / html / turns.csv / models.csv)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Per-session detail (for json / md / html / turns.csv / models.csv)
// ---------------------------------------------------------------------------

interface SessionDetail {
  analysis: SessionAnalysis;
  path: string;
  /** Raw transcript (uncapped) — only loaded when `includeTranscript`. */
  transcript?: TranscriptItem[];
  health?: SessionHealthReport;
  whatIf: WhatIfRepricing;
  rank: SessionCostRank | null;
  parseErrors: number;
}

/** Parse + analyze one session once and gather everything every format needs. */
async function loadSessionDetail(
  path: string,
  pricing: PricingTable,
  db: Database,
  includeTranscript: boolean,
  idHint?: string,
): Promise<SessionDetail | null> {
  try {
    const source = await sessionSourceAt(path);
    if (!source.parentExists && source.subagentPaths.length === 0) return null;
    const parsed = await parseSessionTree(sessionTree(source));
    const analysis = analyzeSession(parsed.events, pricing, {
      coverage: parsed.coverage,
      agentMeta: source.agentMeta,
    });
    let transcript: TranscriptItem[] | undefined;
    if (includeTranscript) {
      try {
        transcript = buildTranscript(parsed.events);
      } catch {
        transcript = undefined;
      }
    }
    let health: SessionHealthReport | undefined;
    try {
      health = inspectSessionHealth(parsed.events, parsed.errors, parsed.coverage);
    } catch {
      health = undefined;
    }
    let rank: SessionCostRank | null = null;
    try {
      rank = sessionCostRank(db, analysis.sessionId ?? idHint ?? "") ?? null;
    } catch {
      rank = null;
    }
    return {
      analysis,
      path: source.path,
      transcript,
      health,
      whatIf: sessionWhatIf(analysis.models, pricing),
      rank,
      parseErrors: parsed.errors.length,
    };
  } catch {
    return null;
  }
}

async function loadDetailByPath(
  idOrPath: string,
  pricing: PricingTable,
  db: Database,
  includeTranscript: boolean,
): Promise<SessionDetail | null> {
  // Guard: only allow file paths under configured claudeRoots()
  const looksLikePath =
    idOrPath.includes("/") ||
    idOrPath.endsWith(".jsonl") ||
    isAbsolute(idOrPath) ||
    idOrPath.startsWith("~/");
  if (looksLikePath && !isPathUnderRoots(idOrPath)) {
    throw new Error(`--session path '${idOrPath}' is not under a configured Claude root`);
  }
  return loadSessionDetail(idOrPath, pricing, db, includeTranscript);
}

const TURN_CSV_HEADERS = [
  "session_id",
  "turn_index",
  "prompt",
  "cost",
  "api_calls",
  "tool_calls",
  "input_tokens",
  "output_tokens",
];
const MODEL_CSV_HEADERS = [
  "session_id",
  "model",
  "api_calls",
  "cost",
  "input_tokens",
  "output_tokens",
  "cache_read",
  "cache_write_5m",
  "cache_write_1h",
];

function turnCsvRows(a: SessionAnalysis, idHint: string, redact: boolean): string[][] {
  const view = redact ? redactAnalysis(a) : a;
  return view.turns.map((t) => [
    a.sessionId ?? idHint,
    String(t.index),
    redactVal(t.prompt.slice(0, 500), redact),
    String(t.cost.total),
    String(t.apiCalls.length),
    String(Object.values(t.toolCounts).reduce((s, n) => s + n, 0)),
    String(t.tokens.inputTokens),
    String(t.tokens.outputTokens),
  ]);
}

function modelCsvRows(a: SessionAnalysis, idHint: string): string[][] {
  return Object.entries(a.models).map(([model, usage]) => [
    a.sessionId ?? idHint,
    model,
    String(usage.apiCalls),
    String(usage.cost.total),
    String(usage.tokens.inputTokens),
    String(usage.tokens.outputTokens),
    String(usage.tokens.cacheReadTokens),
    String(usage.tokens.cacheWrite5mTokens),
    String(usage.tokens.cacheWrite1hTokens),
  ]);
}

/** Write one session's json / md / html into `baseDir`'s per-format folders. */
function writeSessionFiles(
  baseDir: string,
  formats: Set<ExportFormat>,
  detail: SessionDetail,
  idHint: string,
  opts: { redact: boolean; includeTranscript: boolean },
): void {
  const { analysis } = detail;
  const sid = sanitizeFilename(analysis.sessionId ?? idHint ?? "session");
  const costBasis = getCostBasis();
  const common = {
    costBasis,
    whatIf: detail.whatIf,
    health: detail.health,
    rank: detail.rank,
    redact: opts.redact,
    includeTranscript: opts.includeTranscript,
  };
  if (formats.has("json")) {
    const dir = join(baseDir, "sessions");
    ensureDir(dir);
    const payload = buildSessionJsonPayload(analysis, {
      ...common,
      transcript: detail.transcript,
      parseErrors: detail.parseErrors,
    });
    writeFileSync(join(dir, `${sid}.json`), JSON.stringify(payload, null, 2), "utf-8");
  }
  const transcript =
    opts.includeTranscript && detail.transcript ? capTranscript(detail.transcript) : undefined;
  if (formats.has("md")) {
    const dir = join(baseDir, "markdown");
    ensureDir(dir);
    writeFileSync(
      join(dir, `${sid}.md`),
      buildSessionMarkdown(analysis, { ...common, transcript }),
      "utf-8",
    );
  }
  if (formats.has("html")) {
    const dir = join(baseDir, "html");
    ensureDir(dir);
    writeFileSync(
      join(dir, `${sid}.html`),
      buildSessionHtml(analysis, { ...common, transcript }),
      "utf-8",
    );
  }
}

async function writeDetailedArtifacts(
  items: Array<{ row: SessionRow; detail?: SessionDetail }>,
  baseDir: string,
  formats: Set<ExportFormat>,
  pricing: PricingTable,
  db: Database,
  opts: { redact: boolean; includeTranscript: boolean },
): Promise<{ written: number; skipped: number }> {
  if (!(formats.has("json") || formats.has("md") || formats.has("html") || formats.has("csv"))) {
    return { written: 0, skipped: 0 };
  }

  // Large portfolio guard: for >2k sessions, skip per-session detailed files unless scoped
  if (items.length > LARGE_PORTFOLIO_GUARD && formats.has("json")) {
    console.error(
      `warning: large export (${items.length} sessions) — per-session json/md/html will be heavy. Use --project or --format csv for a lightweight portfolio.`,
    );
  }

  const turnRows: string[][] = [];
  const modelRows: string[][] = [];
  let written = 0;
  let skipped = 0;

  const processItem = async (item: { row: SessionRow; detail?: SessionDetail }): Promise<void> => {
    const idHint = item.row.session_id ?? "session";
    const detail =
      item.detail ??
      (await loadSessionDetail(
        item.row.path,
        pricing,
        db,
        opts.includeTranscript && (formats.has("json") || formats.has("md") || formats.has("html")),
        idHint,
      ));
    if (!detail) {
      skipped++;
      return;
    }
    writeSessionFiles(baseDir, formats, detail, idHint, opts);
    if (formats.has("csv")) {
      turnRows.push(...turnCsvRows(detail.analysis, idHint, opts.redact));
      modelRows.push(...modelCsvRows(detail.analysis, idHint));
    }
    written++;
  };

  // Concurrency pool (8)
  const CONCURRENCY = 8;
  const executing = new Set<Promise<void>>();
  for (const item of items) {
    const p = processItem(item).finally(() => executing.delete(p));
    executing.add(p);
    if (executing.size >= CONCURRENCY) await Promise.race(executing);
  }
  await Promise.all(executing);

  if (formats.has("csv")) {
    const csvDir = join(baseDir, "csv");
    ensureDir(csvDir);
    writeCsv(join(csvDir, "turns.csv"), TURN_CSV_HEADERS, turnRows);
    writeCsv(join(csvDir, "models.csv"), MODEL_CSV_HEADERS, modelRows);
  }

  return { written, skipped };
}

export interface ExportResult {
  outDir: string;
  manifestPath: string;
  sessions: number;
  skipped: number;
  formats: ExportFormat[];
}

export async function exportBundle(
  db: Database,
  pricing: PricingTable,
  opts: ExportOptions,
): Promise<ExportResult> {
  validateOutDir(opts.outDir);
  const rows = queryRows(db, opts.scope);

  // Session scope fallback: not indexed but the file exists
  let effectiveRows = rows;
  let fallback: SessionDetail | null = null;
  if (opts.scope.kind === "session" && rows.length === 0) {
    fallback = await loadDetailByPath(
      opts.scope.idOrPath,
      pricing,
      db,
      opts.includeTranscript &&
        (opts.formats.has("json") || opts.formats.has("md") || opts.formats.has("html")),
    );
    if (!fallback) {
      throw new Error(
        `session '${opts.scope.idOrPath}' not found (not indexed and no file at that path)`,
      );
    }
    const a = fallback.analysis;
    // Synthesize a row for manifest counts
    effectiveRows = [
      {
        path: fallback.path,
        project_id: a.projectPath ?? "unknown",
        project_path: a.projectPath ?? null,
        session_id: a.sessionId ?? null,
        title: a.title ?? null,
        start_time: a.startTime ?? null,
        end_time: a.endTime ?? null,
        day: null,
        duration_ms: a.durationMs ?? null,
        turns: a.totals.turns,
        api_calls: a.totals.apiCalls,
        tool_calls: a.totals.toolCalls,
        input_tokens: a.totals.tokens.inputTokens,
        output_tokens: a.totals.tokens.outputTokens,
        cache_write_5m: a.totals.tokens.cacheWrite5mTokens,
        cache_write_1h: a.totals.tokens.cacheWrite1hTokens,
        cache_read: a.totals.tokens.cacheReadTokens,
        cost_total: a.totals.cost.total,
        cost_estimated: a.totals.cost.estimated ? 1 : 0,
        active_ms: a.totals.activeMs,
        sidechain_calls: a.totals.sidechainApiCalls,
        sidechain_cost: a.totals.sidechainCost,
        web_searches: a.totals.webSearches,
        web_fetches: a.totals.webFetches,
        compactions: a.compactions.length,
        test_fail_streak: a.testFailStreak,
        redundant_reads: a.redundantReads,
        correction_turns: a.correctionTurns,
        interruption_turns: a.interruptionTurns,
        models_json: JSON.stringify(a.models),
        tools_json: JSON.stringify(a.tools),
      },
    ];
  }

  ensureDir(opts.outDir);

  // Helper to write one privacy tree
  const writeTree = async (
    base: string,
    redact: boolean,
  ): Promise<{ written: number; skipped: number }> => {
    ensureDir(base);
    const manifest = buildManifest(opts.scope, opts.formats, effectiveRows, {
      redact,
      split: opts.split,
      includeTranscript: opts.includeTranscript,
    });
    writeFileSync(join(base, "manifest.json"), JSON.stringify(manifest, null, 2), "utf-8");

    if (opts.formats.has("json") && effectiveRows.length > 0) {
      if (fallback) {
        const wrapper = {
          scope: redact ? { kind: opts.scope.kind } : opts.scope,
          analysis: redact ? redactAnalysis(fallback.analysis) : fallback.analysis,
          costBasis: getCostBasis(),
        };
        writeFileSync(join(base, "session.json"), JSON.stringify(wrapper, null, 2), "utf-8");
      } else {
        // A session-scoped export is that session only — never the whole portfolio's stats.
        if (opts.scope.kind !== "session") {
          const fileName = opts.scope.kind === "project" ? "project.json" : "portfolio.json";
          writePortfolioJson(db, join(base, fileName), opts.scope, redact);
        }
        // sessions.json — dump of indexed rows
        // `SELECT *` rows carry many text columns (paths, titles, branches, JSON
        // blobs): the shareable dump walks them through the allowlist redactor
        // instead of naming the columns to blank.
        const sessionsDump = redact ? effectiveRows.map((r) => redactAggregate(r)) : effectiveRows;
        writeFileSync(join(base, "sessions.json"), JSON.stringify(sessionsDump, null, 2), "utf-8");
      }
    }

    // sessions.csv
    if (opts.formats.has("csv")) {
      const csvDir = join(base, "csv");
      ensureDir(csvDir);
      writeSessionsCsv(effectiveRows, join(csvDir, "sessions.csv"), redact);
    }

    // detailed artifacts (per-session json/md/html + turns/models csv)
    return writeDetailedArtifacts(
      effectiveRows.map((row) => ({ row, detail: fallback ?? undefined })),
      base,
      opts.formats,
      pricing,
      db,
      { redact, includeTranscript: opts.includeTranscript },
    );
  };

  let totalSkipped = 0;

  if (opts.split) {
    const priv = await writeTree(join(opts.outDir, "private"), false);
    const shar = await writeTree(join(opts.outDir, "shareable"), true);
    totalSkipped = priv.skipped + shar.skipped;
    // top-level manifest for split
    const topManifest = buildManifest(opts.scope, opts.formats, effectiveRows, {
      redact: false,
      split: true,
      includeTranscript: opts.includeTranscript,
    });
    writeFileSync(
      join(opts.outDir, "manifest.json"),
      JSON.stringify({ ...topManifest, note: "split into private/ and shareable/" }, null, 2),
      "utf-8",
    );
  } else {
    const res = await writeTree(opts.outDir, opts.redact);
    totalSkipped = res.skipped;
  }

  // Zip if requested — zip the basename relative to its parent so the archive doesn't embed /tmp/…
  if (opts.zip) {
    const zipPath = `${opts.outDir}.zip`;
    const parent = dirname(opts.outDir);
    const base = basename(opts.outDir);
    try {
      const proc = Bun.spawn(["zip", "-r", "-q", zipPath, base], {
        stdout: "pipe",
        stderr: "pipe",
        cwd: parent || ".",
      });
      await proc.exited;
      if (proc.exitCode !== 0) {
        const err = await new Response(proc.stderr).text();
        throw new Error(`zip failed: ${err}`);
      }
    } catch (e) {
      // Fallback: no zip binary — leave folder and warn
      console.error(
        `warning: zip not available, leaving folder at ${opts.outDir}: ${(e as Error).message}`,
      );
    }
  }

  return {
    outDir: opts.outDir,
    manifestPath: join(opts.outDir, "manifest.json"),
    sessions: effectiveRows.length,
    skipped: totalSkipped,
    formats: [...opts.formats],
  };
}

/** Resolve a scope from CLI args. */
export function parseScope(args: string[]): ExportScope {
  let project: string | undefined;
  let session: string | undefined;
  const take = (flag: string, i: number): { value: string; next: number } => {
    const v = args[i + 1];
    // A bare / flag-shaped value must fail, never fall through to the whole portfolio.
    if (v === undefined || v === "" || v.startsWith("-")) throw new Error(`${flag} needs a value`);
    return { value: v, next: i + 1 };
  };
  const inline = (flag: string, a: string): string => {
    const v = a.slice(flag.length + 1);
    // `=` form is unambiguous: a leading "-" is a legitimate value (encoded project ids).
    if (v === "") throw new Error(`${flag} needs a value`);
    return v;
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (a.startsWith("--project=")) project = inline("--project", a);
    else if (a === "--project") {
      const t = take("--project", i);
      project = t.value;
      i = t.next;
    } else if (a.startsWith("--session=")) session = inline("--session", a);
    else if (a === "--session") {
      const t = take("--session", i);
      session = t.value;
      i = t.next;
    }
  }
  if (project !== undefined && session !== undefined)
    throw new Error("--project and --session are mutually exclusive");
  if (project !== undefined) return { kind: "project", projectId: project };
  if (session !== undefined) return { kind: "session", idOrPath: session };
  // Positional fallback: strip known flag values so "--format json,csv" doesn't become a session id
  const flagged = new Set(["--project", "--session", "--format", "--out"]);
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (a === "export") continue;
    if (
      a.startsWith("--project=") ||
      a.startsWith("--session=") ||
      a.startsWith("--format=") ||
      a.startsWith("--out=")
    )
      continue;
    if (flagged.has(a)) {
      i++;
      continue;
    }
    if (a.startsWith("-")) continue;
    positional.push(a);
  }
  if (positional.length > 0) {
    const v = positional[0] as string;
    if (v.includes("/") || v.endsWith(".jsonl") || v.length >= 8)
      return { kind: "session", idOrPath: v };
  }
  return { kind: "portfolio" };
}

export function parseFormats(raw?: string): Set<ExportFormat> {
  if (!raw) return new Set<ExportFormat>(["json"]);
  const parts = raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (parts.includes("all")) return new Set<ExportFormat>(["json", "csv", "md", "html"]);
  const out = new Set<ExportFormat>();
  for (const p of parts) {
    if (p === "json" || p === "csv" || p === "md" || p === "markdown" || p === "html") {
      out.add(p === "markdown" ? "md" : (p as ExportFormat));
    } else {
      throw new Error(`unknown format '${p}' (expected json, csv, md, html, or all)`);
    }
  }
  if (out.size === 0) throw new Error("--format needs a value");
  return out;
}
