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
import { basename, dirname, join } from "node:path";
import { analyzeSession } from "./analyze.ts";
import { sessionSourceAt, sessionTree } from "./discover.ts";
import { parseSessionTree } from "./parser.ts";
import { getCostBasis } from "./prefs.ts";
import type { PricingTable } from "./pricing.ts";
import { inspectSessionHealth } from "./session-health.ts";
import { sessionWhatIf } from "./session-insights.ts";
import { buildSessionHtml, buildSessionMarkdown, sanitizeFilename } from "./session-markdown.ts";
import { analyticsRollup, buildPortfolioStats, localDayOfMs, sessionCostRank } from "./stats.ts";
import { buildTranscript } from "./transcript.ts";
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

function csvEscape(v: unknown): string {
  const s = String(v ?? "");
  if (s.includes(",") || s.includes('"') || s.includes("\n")) return `"${s.replaceAll('"', '""')}"`;
  return s;
}

function writeCsv(path: string, headers: string[], rows: string[][]): void {
  const lines = [headers.map(csvEscape).join(","), ...rows.map((r) => r.map(csvEscape).join(","))];
  writeFileSync(path, lines.join("\n") + "\n", "utf-8");
}

// redact helper for CSV fields
const redactVal = (v: string, redact: boolean, placeholder = "[redacted]"): string =>
  redact ? placeholder : v;

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
    scope,
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

function writePortfolioJson(db: Database, outPath: string, scope: ExportScope): void {
  const today = localDayOfMs(Date.now());
  const projectId = scope.kind === "project" ? scope.projectId : undefined;
  const portfolio = buildPortfolioStats(db, today, { projectLimit: 100, topLimit: 50 });
  // If project scoped, filter? buildPortfolioStats with projectId already scopes
  // For portfolio.json we reuse buildPortfolioStats; for project scope we also write project.json
  const analytics = analyticsRollup(db, projectId);
  const payload =
    scope.kind === "project" ? { scope, portfolio, analytics } : { scope, portfolio, analytics };
  writeFileSync(outPath, JSON.stringify(payload, null, 2), "utf-8");
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
    r.project_id,
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

async function analyzeOne(
  row: SessionRow,
  pricing: PricingTable,
): Promise<ReturnType<typeof analyzeSession> | null> {
  try {
    const source = await sessionSourceAt(row.path);
    if (!source.parentExists && source.subagentPaths.length === 0) return null;
    const parsed = await parseSessionTree(sessionTree(source));
    return analyzeSession(parsed.events, pricing, {
      coverage: parsed.coverage,
      agentMeta: source.agentMeta,
    });
  } catch {
    return null;
  }
}

async function analyzeOneByPath(
  idOrPath: string,
  pricing: PricingTable,
): Promise<{ analysis: ReturnType<typeof analyzeSession>; path: string } | null> {
  try {
    // Try as file path first
    let source: Awaited<ReturnType<typeof sessionSourceAt>>;
    try {
      source = await sessionSourceAt(idOrPath);
      if (!source.parentExists && source.subagentPaths.length === 0) throw new Error("missing");
    } catch {
      return null;
    }
    const parsed = await parseSessionTree(sessionTree(source));
    const analysis = analyzeSession(parsed.events, pricing, {
      coverage: parsed.coverage,
      agentMeta: source.agentMeta,
    });
    return { analysis, path: source.path };
  } catch {
    return null;
  }
}

function redactAnalysisJson(raw: Record<string, unknown>): Record<string, unknown> {
  const turns = (raw.turns as Array<Record<string, unknown>> | undefined)?.map((t) => ({
    ...t,
    prompt: "[redacted]",
  }));
  return {
    ...raw,
    title: "[redacted]",
    projectPath: "[redacted]",
    filesTouched: [],
    bashCommands: {},
    bashErrors: {},
    commandHeads: {},
    commandHeadErrors: {},
    turns,
  };
}

async function writeDetailedArtifacts(
  rows: SessionRow[],
  baseDir: string,
  formats: Set<ExportFormat>,
  pricing: PricingTable,
  db: Database,
  opts: { redact: boolean; includeTranscript: boolean },
): Promise<{ written: number; skipped: number }> {
  const needDetail =
    formats.has("json") || formats.has("md") || formats.has("html") || formats.has("csv");
  if (!needDetail) return { written: 0, skipped: 0 };

  const jsonDir = join(baseDir, "sessions");
  const mdDir = join(baseDir, "markdown");
  const htmlDir = join(baseDir, "html");
  if (formats.has("json")) ensureDir(jsonDir);
  if (formats.has("md")) ensureDir(mdDir);
  if (formats.has("html")) ensureDir(htmlDir);

  // For turns/models CSV we will accumulate
  const turnRows: string[][] = [];
  const modelRows: string[][] = [];
  const turnHeaders = [
    "session_id",
    "turn_index",
    "prompt",
    "cost",
    "api_calls",
    "tool_calls",
    "input_tokens",
    "output_tokens",
  ];
  const modelHeaders = [
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

  let written = 0;
  let skipped = 0;

  // CSV accumulators only if csv requested
  const needTurns = formats.has("csv");
  const needModels = formats.has("csv");

  for (const row of rows) {
    const analysis = await analyzeOne(row, pricing);
    if (!analysis) {
      skipped++;
      continue;
    }
    const sid = sanitizeFilename(analysis.sessionId ?? row.session_id ?? "session");

    // transcript handling
    let transcript: ReturnType<typeof buildTranscript> | undefined;
    if (
      opts.includeTranscript &&
      (formats.has("json") || formats.has("md") || formats.has("html"))
    ) {
      try {
        const source = await sessionSourceAt(row.path);
        const parsed = await parseSessionTree(sessionTree(source));
        const raw = buildTranscript(parsed.events)
          .slice(0, 600)
          .map((t) => ({ ...t, body: t.body.slice(0, 2000) }));
        transcript = raw as typeof transcript;
      } catch {
        transcript = undefined;
      }
    }

    const whatIf = sessionWhatIf(analysis.models, pricing);
    let health: ReturnType<typeof inspectSessionHealth> | undefined;
    try {
      const source = await sessionSourceAt(row.path);
      const parsed = await parseSessionTree(sessionTree(source));
      health = inspectSessionHealth(parsed.events, parsed.errors, parsed.coverage);
    } catch {
      health = undefined;
    }
    const rank = (() => {
      try {
        return sessionCostRank(db, analysis.sessionId ?? row.session_id ?? "") ?? null;
      } catch {
        return null;
      }
    })();

    if (formats.has("json")) {
      // SAFETY: SessionAnalysis shape is JSON-serializable and redactAnalysisJson expects Record<string,unknown>
      const redacted = opts.redact
        ? redactAnalysisJson(analysis as unknown as Record<string, unknown>)
        : {};
      const payload: Record<string, unknown> = {
        ...analysis,
        health,
        whatIf,
        rank,
        costBasis: getCostBasis(),
        ...(opts.includeTranscript && transcript
          ? {
              transcript: opts.redact
                ? transcript.map((t) => ({ ...t, body: "[redacted]" }))
                : transcript,
            }
          : {}),
        ...redacted,
      };
      // If split mode we are called twice with redact true/false, so this is correct
      writeFileSync(join(jsonDir, `${sid}.json`), JSON.stringify(payload, null, 2), "utf-8");
    }
    if (formats.has("md")) {
      const md = buildSessionMarkdown(analysis, {
        costBasis: getCostBasis(),
        whatIf,
        health,
        rank,
        redact: opts.redact,
        includeTranscript: opts.includeTranscript,
        transcript,
      });
      writeFileSync(join(mdDir, `${sid}.md`), md, "utf-8");
    }
    if (formats.has("html")) {
      const html = buildSessionHtml(analysis, {
        costBasis: getCostBasis(),
        whatIf,
        health,
        rank,
        redact: opts.redact,
        includeTranscript: opts.includeTranscript,
        transcript,
      });
      writeFileSync(join(htmlDir, `${sid}.html`), html, "utf-8");
    }
    if (needTurns) {
      for (const t of analysis.turns) {
        turnRows.push([
          analysis.sessionId ?? row.session_id ?? "",
          String(t.index),
          redactVal(t.prompt.slice(0, 500), opts.redact),
          String(t.cost.total),
          String(t.apiCalls.length),
          String(Object.values(t.toolCounts).reduce((s, n) => s + n, 0)),
          String(t.tokens.inputTokens),
          String(t.tokens.outputTokens),
        ]);
      }
    }
    if (needModels) {
      for (const [model, usage] of Object.entries(analysis.models)) {
        modelRows.push([
          analysis.sessionId ?? row.session_id ?? "",
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
    }
    written++;
  }

  if (formats.has("csv")) {
    const csvDir = join(baseDir, "csv");
    ensureDir(csvDir);
    // turns.csv & models.csv are written here; sessions.csv is written separately from DB rows
    if (turnRows.length > 0 || needTurns)
      writeCsv(join(csvDir, "turns.csv"), turnHeaders, turnRows);
    if (modelRows.length > 0 || needModels)
      writeCsv(join(csvDir, "models.csv"), modelHeaders, modelRows);
  }

  return { written, skipped };
}

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

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
  const rows = (() => {
    if (opts.scope.kind === "session") {
      // Session scope: try DB first, else we'll handle single-file path separately
      const found = queryRows(db, opts.scope);
      if (found.length > 0) return found;
      return [];
    }
    return queryRows(db, opts.scope);
  })();

  // Session scope fallback: not indexed but file exists
  let effectiveRows = rows;
  let singleFileFallback: { analysis: ReturnType<typeof analyzeSession>; path: string } | null =
    null;
  if (opts.scope.kind === "session" && rows.length === 0) {
    const pricingTable = pricing;
    singleFileFallback = await analyzeOneByPath(opts.scope.idOrPath, pricingTable);
    if (!singleFileFallback) {
      throw new Error(
        `session '${opts.scope.idOrPath}' not found (not indexed and no file at that path)`,
      );
    }
    // Synthesize a row for manifest counts
    effectiveRows = [
      {
        path: singleFileFallback.path,
        project_id: singleFileFallback.analysis.projectPath ?? "unknown",
        project_path: singleFileFallback.analysis.projectPath ?? null,
        session_id: singleFileFallback.analysis.sessionId ?? null,
        title: singleFileFallback.analysis.title ?? null,
        start_time: singleFileFallback.analysis.startTime ?? null,
        end_time: singleFileFallback.analysis.endTime ?? null,
        day: null,
        duration_ms: singleFileFallback.analysis.durationMs ?? null,
        turns: singleFileFallback.analysis.totals.turns,
        api_calls: singleFileFallback.analysis.totals.apiCalls,
        tool_calls: singleFileFallback.analysis.totals.toolCalls,
        input_tokens: singleFileFallback.analysis.totals.tokens.inputTokens,
        output_tokens: singleFileFallback.analysis.totals.tokens.outputTokens,
        cache_write_5m: singleFileFallback.analysis.totals.tokens.cacheWrite5mTokens,
        cache_write_1h: singleFileFallback.analysis.totals.tokens.cacheWrite1hTokens,
        cache_read: singleFileFallback.analysis.totals.tokens.cacheReadTokens,
        cost_total: singleFileFallback.analysis.totals.cost.total,
        cost_estimated: singleFileFallback.analysis.totals.cost.estimated ? 1 : 0,
        active_ms: singleFileFallback.analysis.totals.activeMs,
        sidechain_calls: singleFileFallback.analysis.totals.sidechainApiCalls,
        sidechain_cost: singleFileFallback.analysis.totals.sidechainCost,
        web_searches: singleFileFallback.analysis.totals.webSearches,
        web_fetches: singleFileFallback.analysis.totals.webFetches,
        compactions: singleFileFallback.analysis.compactions.length,
        test_fail_streak: singleFileFallback.analysis.testFailStreak,
        redundant_reads: singleFileFallback.analysis.redundantReads,
        correction_turns: singleFileFallback.analysis.correctionTurns,
        interruption_turns: singleFileFallback.analysis.interruptionTurns,
        models_json: JSON.stringify(singleFileFallback.analysis.models),
        tools_json: JSON.stringify(singleFileFallback.analysis.tools),
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

    // portfolio / project json
    if (opts.formats.has("json")) {
      if (effectiveRows.length === 0) {
        // no-op
      } else if (opts.scope.kind === "session" && singleFileFallback) {
        // For single session we already produce per-session json in writeDetailedArtifacts
        // Still write a portfolio wrapper
        // SAFETY: SessionAnalysis is JSON-serializable Record<string,unknown> for redact
        const wrapperAnalysis = redact
          ? redactAnalysisJson(singleFileFallback.analysis as unknown as Record<string, unknown>)
          : singleFileFallback.analysis;
        const wrapper = {
          scope: opts.scope,
          analysis: wrapperAnalysis,
          costBasis: getCostBasis(),
        };
        writeFileSync(join(base, "session.json"), JSON.stringify(wrapper, null, 2), "utf-8");
      } else {
        const fileName = opts.scope.kind === "project" ? "project.json" : "portfolio.json";
        writePortfolioJson(db, join(base, fileName), opts.scope);
        // sessions.json — dump of indexed rows (always private unless redact)
        const sessionsDump = effectiveRows.map((r) => ({
          ...r,
          title: redact ? "[redacted]" : r.title,
          project_path: redact ? "[redacted]" : r.project_path,
          models_json: redact ? "[redacted]" : r.models_json,
          tools_json: redact ? "[redacted]" : r.tools_json,
        }));
        writeFileSync(join(base, "sessions.json"), JSON.stringify(sessionsDump, null, 2), "utf-8");
      }
    }

    // sessions.csv
    if (opts.formats.has("csv")) {
      const csvDir = join(base, "csv");
      ensureDir(csvDir);
      if (effectiveRows.length > 0)
        writeSessionsCsv(effectiveRows, join(csvDir, "sessions.csv"), redact);
      else writeSessionsCsv([], join(csvDir, "sessions.csv"), redact);
    }

    // detailed artifacts (per-session json/md/html + turns/models csv)
    let detailRes = { written: 0, skipped: 0 };
    if (singleFileFallback) {
      // Single session fallback: write directly without DB loop
      const a = singleFileFallback.analysis;
      const sid = sanitizeFilename(a.sessionId ?? "session");
      if (opts.formats.has("json")) {
        const jsonDir = join(base, "sessions");
        ensureDir(jsonDir);
        // Already wrote session.json above; also write sessions/<id>.json for consistency
        const whatIf = sessionWhatIf(a.models, pricing);
        let health: ReturnType<typeof inspectSessionHealth> | undefined;
        try {
          const src = await sessionSourceAt(singleFileFallback.path);
          const parsed = await parseSessionTree(sessionTree(src));
          health = inspectSessionHealth(parsed.events, parsed.errors, parsed.coverage);
        } catch (_e) {
          health = undefined;
        }
        const rank = (() => {
          try {
            return sessionCostRank(db, a.sessionId ?? "") ?? null;
          } catch {
            return null;
          }
        })();
        let transcript: ReturnType<typeof buildTranscript> | undefined;
        if (opts.includeTranscript) {
          try {
            const src = await sessionSourceAt(singleFileFallback.path);
            const parsed = await parseSessionTree(sessionTree(src));
            transcript = buildTranscript(parsed.events)
              .slice(0, 600)
              .map((t) => ({ ...t, body: t.body.slice(0, 2000) })) as typeof transcript;
          } catch (_e) {
            transcript = undefined;
          }
        }
        // SAFETY: SessionAnalysis is JSON-serializable for redactAnalysisJson
        const redacted = redact ? redactAnalysisJson(a as unknown as Record<string, unknown>) : {};
        const payload: Record<string, unknown> = {
          ...a,
          health,
          whatIf,
          rank,
          costBasis: getCostBasis(),
          ...(opts.includeTranscript && transcript
            ? {
                transcript: redact
                  ? transcript.map((t) => ({ ...t, body: "[redacted]" }))
                  : transcript,
              }
            : {}),
          ...redacted,
        };
        writeFileSync(join(jsonDir, `${sid}.json`), JSON.stringify(payload, null, 2), "utf-8");
      }
      if (opts.formats.has("md")) {
        const mdDir = join(base, "markdown");
        ensureDir(mdDir);
        const whatIf = sessionWhatIf(a.models, pricing);
        let health2: ReturnType<typeof inspectSessionHealth> | undefined;
        try {
          const src = await sessionSourceAt(singleFileFallback.path);
          const parsed = await parseSessionTree(sessionTree(src));
          health2 = inspectSessionHealth(parsed.events, parsed.errors, parsed.coverage);
        } catch (_e) {
          health2 = undefined;
        }
        const rank2 = (() => {
          try {
            return sessionCostRank(db, a.sessionId ?? "") ?? null;
          } catch {
            return null;
          }
        })();
        let transcript2: ReturnType<typeof buildTranscript> | undefined;
        if (opts.includeTranscript) {
          try {
            const src = await sessionSourceAt(singleFileFallback.path);
            const parsed = await parseSessionTree(sessionTree(src));
            transcript2 = buildTranscript(parsed.events)
              .slice(0, 600)
              .map((t) => ({ ...t, body: t.body.slice(0, 2000) })) as typeof transcript2;
          } catch (_e) {
            transcript2 = undefined;
          }
        }
        const md = buildSessionMarkdown(a, {
          costBasis: getCostBasis(),
          whatIf,
          health: health2,
          rank: rank2,
          redact,
          includeTranscript: opts.includeTranscript,
          transcript: transcript2,
        });
        writeFileSync(join(mdDir, `${sid}.md`), md, "utf-8");
      }
      if (opts.formats.has("html")) {
        const htmlDir = join(base, "html");
        ensureDir(htmlDir);
        const whatIf = sessionWhatIf(a.models, pricing);
        let health3: ReturnType<typeof inspectSessionHealth> | undefined;
        try {
          const src = await sessionSourceAt(singleFileFallback.path);
          const parsed = await parseSessionTree(sessionTree(src));
          health3 = inspectSessionHealth(parsed.events, parsed.errors, parsed.coverage);
        } catch (_e) {
          health3 = undefined;
        }
        const rank3 = (() => {
          try {
            return sessionCostRank(db, a.sessionId ?? "") ?? null;
          } catch {
            return null;
          }
        })();
        let transcript3: ReturnType<typeof buildTranscript> | undefined;
        if (opts.includeTranscript) {
          try {
            const src = await sessionSourceAt(singleFileFallback.path);
            const parsed = await parseSessionTree(sessionTree(src));
            transcript3 = buildTranscript(parsed.events)
              .slice(0, 600)
              .map((t) => ({ ...t, body: t.body.slice(0, 2000) })) as typeof transcript3;
          } catch (_e) {
            transcript3 = undefined;
          }
        }
        const html = buildSessionHtml(a, {
          costBasis: getCostBasis(),
          whatIf,
          health: health3,
          rank: rank3,
          redact,
          includeTranscript: opts.includeTranscript,
          transcript: transcript3,
        });
        writeFileSync(join(htmlDir, `${sid}.html`), html, "utf-8");
      }
      if (opts.formats.has("csv")) {
        const csvDir = join(base, "csv");
        ensureDir(csvDir);
        // turns.csv single
        const turnHeaders = [
          "session_id",
          "turn_index",
          "prompt",
          "cost",
          "api_calls",
          "tool_calls",
          "input_tokens",
          "output_tokens",
        ];
        const turnRows = a.turns.map((t) => [
          a.sessionId ?? "",
          String(t.index),
          redactVal(t.prompt.slice(0, 500), redact),
          String(t.cost.total),
          String(t.apiCalls.length),
          String(Object.values(t.toolCounts).reduce((s, n) => s + n, 0)),
          String(t.tokens.inputTokens),
          String(t.tokens.outputTokens),
        ]);
        writeCsv(join(csvDir, "turns.csv"), turnHeaders, turnRows);
        const modelHeaders = [
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
        const modelRows = Object.entries(a.models).map(([model, u]) => [
          a.sessionId ?? "",
          model,
          String(u.apiCalls),
          String(u.cost.total),
          String(u.tokens.inputTokens),
          String(u.tokens.outputTokens),
          String(u.tokens.cacheReadTokens),
          String(u.tokens.cacheWrite5mTokens),
          String(u.tokens.cacheWrite1hTokens),
        ]);
        writeCsv(join(csvDir, "models.csv"), modelHeaders, modelRows);
      }
      detailRes = { written: 1, skipped: 0 };
    } else {
      detailRes = await writeDetailedArtifacts(effectiveRows, base, opts.formats, pricing, db, {
        redact,
        includeTranscript: opts.includeTranscript,
      });
    }

    return detailRes;
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
  // Handle inline --project=<id> / --session=<id> and space form
  for (const a of args) {
    if (a.startsWith("--project="))
      return { kind: "project", projectId: a.slice("--project=".length) };
    if (a.startsWith("--session="))
      return { kind: "session", idOrPath: a.slice("--session=".length) };
  }
  const projIdx = args.indexOf("--project");
  const sessIdx = args.indexOf("--session");
  if (projIdx !== -1 && sessIdx !== -1)
    throw new Error("--project and --session are mutually exclusive");
  if (projIdx !== -1) {
    const v = args[projIdx + 1];
    if (!v || v.startsWith("-")) throw new Error("--project needs a value");
    return { kind: "project", projectId: v };
  }
  if (sessIdx !== -1) {
    const v = args[sessIdx + 1];
    if (!v || v.startsWith("-")) throw new Error("--session needs a value");
    return { kind: "session", idOrPath: v };
  }
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
