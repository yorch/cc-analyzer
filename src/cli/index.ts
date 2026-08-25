#!/usr/bin/env bun
import { existsSync } from "node:fs";

import { analyzeSession, type SessionAnalysis } from "../core/analyze.ts";
import {
  CLAUDE_NOT_FOUND_MESSAGE,
  isValidModel,
  resolveClaudeBinary,
  runClaudeAnalysis,
} from "../core/claude-handoff.ts";
import {
  type ClaudeRootSource,
  claudeRoots,
  expandPath,
  persistentClaudeRoots,
  projectsDirOf,
  setClaudeRootsOverride,
  splitRootList,
} from "../core/claude-roots.ts";
import { openDb } from "../core/db.ts";
import { buildDigestMarkdown, isDayString } from "../core/digest.ts";
import { buildWeeklyDigest } from "../core/digest-signals.ts";
import {
  findProject,
  findSessionById,
  listProjects,
  listSessionsIn,
  type SessionSource,
  sessionSourceAt,
  sessionTree,
} from "../core/discover.ts";
import { exportBundle, parseFormats, parseScope } from "../core/export.ts";
import { inspectIndexStatus } from "../core/index-status.ts";
import { reindex } from "../core/indexer.ts";
import { scanInventories } from "../core/inventory.ts";
import { parseSessionTree } from "../core/parser.ts";
import { buildPortfolioDiagnostics } from "../core/portfolio-diagnostics.ts";
import { assemblePortfolioSignals } from "../core/portfolio-signals.ts";
import {
  getAnalysisModel,
  getClaudeDirs,
  getCostBasis,
  setClaudeDirs,
  setCostBasis,
} from "../core/prefs.ts";
import type { PricingTable } from "../core/pricing.ts";
import { loadPricing } from "../core/pricing-source.ts";
import { labelProjects, rootTag } from "../core/project-labels.ts";
import { indexedProjectForPath, isIndexEmpty } from "../core/queries.ts";
import { compareVersions, fetchLatestVersion } from "../core/release.ts";
import { inspectSessionHealth, type SessionHealthReport } from "../core/session-health.ts";
import { sessionWhatIf } from "../core/session-insights.ts";
import {
  buildSessionHtml,
  buildSessionMarkdown,
  sanitizeFilename,
} from "../core/session-markdown.ts";
import { buildSetupAudit } from "../core/setup-audit.ts";
import {
  analyticsRollup,
  buildPortfolioStats,
  cacheTtlSplit,
  concurrency,
  contextTax,
  localDayOfMs,
  parseCoverage,
  sessionCostRank,
  whatIfRepricing,
} from "../core/stats.ts";
import {
  flushTelemetry,
  maybeShowFirstRunNotice,
  POSTER_COMMAND,
  runTelemetryPoster,
  setTelemetryEnabled,
  telemetryStatus,
  trackCommand,
} from "../core/telemetry.ts";
import { buildTranscript } from "../core/transcript.ts";
import { type DownloadProgress, performUpdate } from "../core/update.ts";
import { maybeNotifyUpdate } from "../core/update-check.ts";
import { VERSION } from "../core/version.ts";
import {
  formatBytes,
  formatCount,
  formatRelativeTime,
  formatUSD,
  table,
  truncate,
} from "./format.ts";
import {
  renderParseCoverageLine,
  renderPortfolioInsights,
  renderSessionSummary,
  renderSetupAudit,
  renderStats,
  renderWeeklyDigest,
} from "./render.ts";

const HELP = `cc-analyzer ${VERSION} — analyze Claude Code sessions

Usage:
  cc-analyzer                          Launch the interactive TUI
  cc-analyzer projects                 List all projects
  cc-analyzer sessions <projectId>     List sessions in a project
  cc-analyzer analyze <id|path> [--json|--md|--html] [--out <file>]
                                       [--include-transcript] [--redact]
                                       [--with-claude] [--model <id>]
                                       Analyze a single session (--with-claude runs a
                                       Claude Code retrospective; --model overrides the default).
                                       --md/--html export full markdown/HTML; --out writes to a file
                                       (directory auto-names cc-analyzer-<id>.md/.html/.json);
                                       --include-transcript appends transcript (off by default);
                                       --redact hides prompt/transcript text for sharing
  cc-analyzer doctor <id|path> [--json]
                                       Check session health and recoverability
  cc-analyzer index [--rebuild|--check]
                                       Build, refresh, or check the session index
  cc-analyzer stats [--current] [--json]
                                       Portfolio or current-project analytics (needs an index)
  cc-analyzer audit [--json]           Cross-reference your installed setup with observed usage
  cc-analyzer insights [--json]        Ranked, actionable findings across the whole portfolio
  cc-analyzer report [--week YYYY-MM-DD] [--md|--json]
                                       Weekly digest: last complete week vs the week before
  cc-analyzer export [--project <id>] [--session <id|path>]
                                     [--format json,csv,md,html|all] [--out <dir>]
                                     [--redact|--split] [--include-transcript] [--zip]
                                       Export portfolio / project / session data.
                                       Formats are mixable (default json). Folder output;
                                       --zip writes a .zip, --split emits private/ + shareable/.
  cc-analyzer serve [--port=4317] [--host=127.0.0.1] [--refresh] [--open]
                                       Launch the local web app
  cc-analyzer pricing update           Refresh the pricing cache
  cc-analyzer update [--check]         Update to the latest release (or just check)
  cc-analyzer version                  Print the version
  cc-analyzer telemetry <on|off|status>
                                       View or change anonymous usage telemetry
  cc-analyzer cost-basis [api|subscription]
                                       View or change how dollar figures are framed
  cc-analyzer claude-dir [show|set <path>|add <path>|remove <path>|reset]
                                       View or change which Claude data dirs are read
  cc-analyzer help                     Show this help

Global options:
  --claude-dir=<path>                  Read this Claude data dir for one invocation
                                       (repeatable, or a ${
                                         process.platform === "win32" ? ";" : ":"
}-separated list).
                                       Only for the commands that read session
                                       files directly: projects, sessions,
                                       analyze, doctor. Use \`claude-dir set\` for
                                       anything index-backed.

Notes:
  <id> is a session uuid (searched across all projects) or a path to a .jsonl file.

Claude data directories:
  By default cc-analyzer reads ~/.claude, and honours CLAUDE_CONFIG_DIR when
  Claude Code has been relocated — a relocated install needs no configuration.
  To read somewhere else, or to analyze several directories together as one
  portfolio:

    cc-analyzer claude-dir set <path>     # or: add / remove / reset
    cc-analyzer index                     # the index mirrors the configured set

  Run \`cc-analyzer claude-dir\` to see which directories are in effect and why.

Telemetry:
  cc-analyzer reports anonymous, cookieless usage stats (no session content,
  paths, or personal data). Opt out with CC_ANALYZER_TELEMETRY=0, DO_NOT_TRACK,
  or \`cc-analyzer telemetry off\`.

Cost basis:
  Dollar figures are always tokens × API rates. "api" (default) reads that as
  a bill. "subscription" is for flat-plan (Pro/Max) users: the same numbers
  are framed as API-equivalent value, not money owed. Set with
  \`cc-analyzer cost-basis subscription\`.
`;

function cmdTelemetry(action: string | undefined): number {
  switch (action) {
    case "on":
      setTelemetryEnabled(true);
      console.log("Telemetry enabled. Thank you — this helps improve cc-analyzer.");
      return 0;
    case "off":
      setTelemetryEnabled(false);
      console.log("Telemetry disabled.");
      return 0;
    case "status": {
      const { enabled, reason } = telemetryStatus();
      console.log(`Telemetry is ${enabled ? "ON" : "OFF"} — ${reason}.`);
      return 0;
    }
    default:
      console.error("usage: cc-analyzer telemetry <on|off|status>");
      return 2;
  }
}

function cmdCostBasis(action: string | undefined): number {
  switch (action) {
    case "api":
    case "subscription":
      setCostBasis(action);
      console.log(
        action === "subscription"
          ? "Cost basis set to subscription. Dollar figures will read as API-equivalent " +
              "value, not a bill."
          : "Cost basis set to api. Dollar figures read as billed cost.",
      );
      return 0;
    case undefined: {
      const basis = getCostBasis();
      console.log(
        basis === "subscription"
          ? "Cost basis is subscription (dollar figures shown as API-equivalent value)."
          : "Cost basis is api (dollar figures shown as billed cost).",
      );
      return 0;
    }
    default:
      console.error("usage: cc-analyzer cost-basis [api|subscription]");
      return 2;
  }
}

/**
 * One line per configured root, for the `claude-dir` report and empty states.
 *
 * A root with no `projects/` directory is marked: that is the same condition
 * the indexer treats as "unreadable this scan", and it is the one thing worth
 * telling the user about — the rest is working by definition.
 */
function rootLines(): string[] {
  return claudeRoots().map((r) => {
    const missing = existsSync(projectsDirOf(r.path)) ? "" : " — no projects/ directory";
    return `  ${r.path}  (${ROOT_SOURCE_LABEL[r.source]})${missing}`;
  });
}

/** True when not one configured root holds a `projects/` directory. */
const noReadableRoot = (): boolean => !claudeRoots().some((r) => existsSync(projectsDirOf(r.path)));

const ROOT_SOURCE_LABEL: Record<ClaudeRootSource, string> = {
  flag: "--claude-dir",
  env: "CC_ANALYZER_CLAUDE_DIR",
  prefs: "cc-analyzer claude-dir",
  "claude-code": "CLAUDE_CONFIG_DIR",
  default: "default",
};

async function cmdProjects(): Promise<number> {
  const projects = await listProjects();
  if (projects.length === 0) {
    // Name the directories actually searched and why: the commonest cause of an
    // empty portfolio is a relocated Claude dir, and "~/.claude" would be a lie.
    console.log(
      `No projects found under:\n${rootLines().join("\n")}\n\n` +
        "Point cc-analyzer at another directory with `cc-analyzer claude-dir add <path>` " +
        "or --claude-dir=<path>.",
    );
    return 0;
  }
  // Shared decision, table-shaped rendering: a terminal table has room for the
  // full root path in its own column, so it disambiguates there rather than
  // with the suffix the space-constrained surfaces use.
  const { multiRoot } = labelProjects(
    projects,
    (p) => p.label,
    (p) => p.root,
  );
  // The root column carries `rootTag`, not the raw path: truncating full paths
  // renders roots that share a long prefix identically — the synced-machines
  // case the docs recommend — so the column would disambiguate nothing.
  const allRoots = [...new Set(projects.map((p) => p.root))];
  console.log(
    table(
      multiRoot ? ["sessions", "project", "claude dir"] : ["sessions", "project"],
      projects.map((p) =>
        multiRoot
          ? [String(p.sessionCount), truncate(p.label, 60), truncate(rootTag(p.root, allRoots), 40)]
          : [String(p.sessionCount), truncate(p.label, 80)],
      ),
    ),
  );
  console.log(`\n${projects.length} projects`);
  return 0;
}

/**
 * Show or change the Claude data directories cc-analyzer reads.
 *
 * Writes only cc-analyzer's own prefs.json — the directories themselves are
 * never touched, in keeping with the tool's read-only contract.
 */
function cmdClaudeDir(action: string | undefined, operand: string | undefined): number {
  /** The one report every branch ends with, so the wording can't drift. */
  const report = (prefix = ""): number => {
    console.log(`${prefix}Reading Claude Code data from:\n${rootLines().join("\n")}`);
    return 0;
  };

  switch (action) {
    case undefined:
    case "show": {
      report();
      // Only nudge when something is actually wrong. The default `~/.claude` and
      // an inherited CLAUDE_CONFIG_DIR are both working setups that persist
      // nothing, and telling those users to configure something reads as a fault.
      if (noReadableRoot()) {
        console.log(
          "\nNo Claude sessions found in any of these. If Claude Code stores its data " +
            "elsewhere, point cc-analyzer at it:\n  cc-analyzer claude-dir set <path>",
        );
      }
      return 0;
    }
    case "set":
    case "add":
    case "remove":
    case "reset": {
      const current = getClaudeDirs();
      let next: string[];

      if (action === "reset") {
        next = [];
      } else {
        if (!operand) {
          console.error(`usage: cc-analyzer claude-dir ${action} <path>`);
          return 2;
        }
        // Normalize with the same function resolution uses, so a path stored
        // here and a path resolved later can never disagree.
        const path = expandPath(operand);
        if (action === "set") next = [path];
        else if (action === "add") {
          // `add` appends to what is *persistently* in effect. With nothing
          // stored that is `~/.claude` (or CLAUDE_CONFIG_DIR): writing a
          // one-element list would make the exclusive prefs tier win and
          // silently drop it, and the next `index` would prune all its rows.
          // Deliberately not `claudeRoots()` — that would bake a `--claude-dir=`
          // or `CC_ANALYZER_CLAUDE_DIR` root, scoped to one command, into
          // prefs.json permanently.
          const base = current.length > 0 ? current : persistentClaudeRoots().map((r) => r.path);
          next = base.includes(path) ? base : [...base, path];
        } else {
          next = current.filter((p) => p !== path);
          if (next.length === current.length) {
            console.error(`error: '${path}' is not a persisted Claude directory.`);
            return 1;
          }
        }
        if (action !== "remove" && !existsSync(path)) {
          // A warning, not an error: a synced or mounted directory can be absent
          // right now and present on the next run.
          console.error(`warning: '${path}' does not exist yet.`);
        }
      }

      setClaudeDirs(next);
      report(action === "reset" ? "Cleared. " : "");
      // A `--claude-dir=`/`CC_ANALYZER_CLAUDE_DIR` root outranks the pref, so the
      // list above is *not* what was just written. Say so rather than letting the
      // confirmation contradict the change.
      const overriding = claudeRoots()[0]?.source;
      if (overriding === "flag" || overriding === "env") {
        console.log(
          `\nNote: ${ROOT_SOURCE_LABEL[overriding]} is overriding the stored list for this ` +
            `invocation. Persisted: ${next.length > 0 ? next.join(", ") : "(none)"}`,
        );
      }
      console.log("\nReindex with `cc-analyzer index` to pick up the change.");
      return 0;
    }
    default:
      console.error(
        "usage: cc-analyzer claude-dir [show|set <path>|add <path>|remove <path>|reset]",
      );
      return 2;
  }
}

async function cmdSessions(projectId: string | undefined): Promise<number> {
  if (!projectId) {
    console.error("error: missing <projectId>. Run `cc-analyzer projects` to list ids.");
    return 2;
  }
  // Stored ids are root-qualified, but nobody should have to type a hash: a
  // bare encoded name resolves when only one root holds that project. When
  // several do, name them instead of silently picking one.
  const found = await findProject(projectId);
  if (found.status === "ambiguous") {
    console.error(
      `error: '${projectId}' matches ${found.candidates.length} projects across your Claude ` +
        `directories. Use the full id:\n` +
        found.candidates.map((p) => `  ${p.id}  (${p.root})`).join("\n"),
    );
    return 2;
  }
  if (found.status === "unknown") {
    console.error(`No project '${projectId}'. Run \`cc-analyzer projects\` to list ids.`);
    return 1;
  }
  const sessions = await listSessionsIn(found.project);
  if (sessions.length === 0) {
    console.error(`No sessions found for project '${projectId}'.`);
    return 1;
  }
  console.log(
    table(
      ["session id", "modified", "size"],
      sessions.map((s) => [s.id, formatRelativeTime(s.mtimeMs), formatBytes(s.sizeBytes)]),
    ),
  );
  console.log(`\n${sessions.length} sessions`);
  return 0;
}

/**
 * Resolve a session reference to its whole tree — the parent transcript plus
 * the subagent transcripts Claude Code keeps beside it — so `analyze` and
 * `doctor` see a session's full spend, not just its main chain.
 */
async function resolveSessionSource(ref: string): Promise<SessionSource | undefined> {
  if (ref.endsWith(".jsonl") || ref.includes("/")) {
    return (await Bun.file(ref).exists()) ? await sessionSourceAt(ref) : undefined;
  }
  const found = await findSessionById(ref);
  return (
    found && {
      path: found.path,
      subagentPaths: found.subagentPaths,
      agentMeta: found.agentMeta,
      parentExists: found.parentExists,
    }
  );
}

/** Extract a `--name value` or `--name=value` flag, returning its value (if any)
 *  and argv with the flag and its space-form value removed. Lets the positional
 *  filter run over the remainder without mistaking a flag value for a positional. */
function takeFlagValue(rest: string[], name: string): { value?: string; rest: string[] } {
  const out: string[] = [];
  let value: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === undefined) continue;
    if (arg === name) {
      value = rest[i + 1];
      i++;
      continue;
    }
    if (arg.startsWith(`${name}=`)) {
      value = arg.slice(name.length + 1);
      continue;
    }
    out.push(arg);
  }
  return { value, rest: out };
}

/** Stream a Claude Code retrospective for a session to stdout. Text streams as
 *  it arrives; the run's own cost prints to stderr at the end so stdout stays
 *  the retrospective. */
async function cmdAnalyzeWithClaude(
  analysis: SessionAnalysis,
  path: string,
  pricing: PricingTable,
  modelOverride: string | undefined,
): Promise<number> {
  if (modelOverride !== undefined && !isValidModel(modelOverride)) {
    console.error(`error: invalid --model '${modelOverride}'.`);
    return 2;
  }
  const claudeBin = resolveClaudeBinary();
  if (!claudeBin) {
    console.error(`error: ${CLAUDE_NOT_FOUND_MESSAGE}`);
    return 1;
  }
  const model = modelOverride ?? getAnalysisModel();
  process.stderr.write(`Analyzing with Claude Code (${model})…\n\n`);
  let streamedText = false;
  let cost: number | undefined;
  let errored = false;
  for await (const event of runClaudeAnalysis({
    claudeBin,
    sessionPath: path,
    analysis,
    model,
    whatIf: sessionWhatIf(analysis.models, pricing),
  })) {
    if (event.type === "text") {
      process.stdout.write(event.delta);
      streamedText = true;
    } else if (event.type === "result") {
      // Older Claude Code without partial streaming carries the text only here.
      if (!streamedText && event.text) process.stdout.write(event.text);
      cost = event.costUsd;
    } else {
      errored = true;
      process.stderr.write(`\nerror: ${event.message}\n`);
    }
  }
  process.stdout.write("\n");
  if (cost !== undefined) process.stderr.write(`\nRun cost: ${formatUSD(cost)}\n`);
  return errored ? 1 : 0;
}

async function cmdAnalyze(
  ref: string | undefined,
  json: boolean,
  opts: {
    withClaude?: boolean;
    model?: string;
    md?: boolean;
    html?: boolean;
    out?: string;
    redact?: boolean;
    includeTranscript?: boolean;
  } = {},
): Promise<number> {
  if (!ref) {
    console.error("error: missing <id|path>.");
    return 2;
  }
  const source = await resolveSessionSource(ref);
  if (!source) {
    console.error(`error: session '${ref}' not found.`);
    return 1;
  }
  const path = source.path;
  const { events, errors, coverage } = await parseSessionTree(sessionTree(source));
  const { table: pricing } = await loadPricing();
  const analysis = analyzeSession(events, pricing, { coverage, agentMeta: source.agentMeta });

  if (opts.withClaude) {
    return cmdAnalyzeWithClaude(analysis, path, pricing, opts.model);
  }

  // --- export path: --md / --html / --json with --out / --redact / --include-transcript ---
  const wantsExport = json || opts.md || opts.html;
  // P1-2: redact/transcript without a format would be silently ignored on the TTY render
  if (!wantsExport && (opts.redact || opts.includeTranscript)) {
    console.error("error: --redact and --include-transcript require --md, --html, or --json.");
    return 2;
  }
  if (wantsExport) {
    const whatIf = sessionWhatIf(analysis.models, pricing);
    const health = inspectSessionHealth(events, errors, coverage);
    const costBasis = getCostBasis();
    let rank: ReturnType<typeof sessionCostRank> | null = null;
    try {
      const db = openDb();
      // sessionCostRank resolves via the indexed row; may be null for unindexed sessions
      const idForRank = analysis.sessionId ?? ref;
      rank = sessionCostRank(db, idForRank) ?? null;
      db.close();
    } catch {
      // index unavailable — export without rank
    }
    const includeTranscript = opts.includeTranscript === true;
    // Cap transcript to avoid OOM on huge sessions (same caps as markdown builder)
    const rawTranscript = includeTranscript ? buildTranscript(events) : undefined;
    const transcript = rawTranscript
      ? rawTranscript.slice(0, 600).map((t) => ({ ...t, body: t.body.slice(0, 2000) }))
      : undefined;
    // Note if truncation happened for CLI feedback (markdown builder also truncates)
    if (rawTranscript && rawTranscript.length > 600) {
      console.error(
        `note: transcript truncated to 600 of ${rawTranscript.length} items for export.`,
      );
    }
    const redact = opts.redact === true;

    const extFor = (format: string): string => {
      if (format === "md") return ".md";
      if (format === "html") return ".html";
      return ".json";
    };
    const format = opts.html ? "html" : opts.md ? "md" : "json";

    let content: string;
    if (format === "md") {
      content = buildSessionMarkdown(analysis, {
        costBasis,
        whatIf,
        health,
        rank,
        redact,
        includeTranscript,
        transcript,
      });
    } else if (format === "html") {
      content = buildSessionHtml(analysis, {
        costBasis,
        whatIf,
        health,
        rank,
        redact,
        includeTranscript,
        transcript,
      });
    } else {
      // SAFETY: redact swaps PII only — capped transcript, stripped paths/commands/title.
      const redactedTranscript =
        includeTranscript && transcript
          ? transcript.map((t) => ({ ...t, body: redact ? "[redacted]" : t.body }))
          : undefined;
      const basePayload: Record<string, unknown> = {
        ...analysis,
        parseErrors: errors.length,
        health,
        whatIf,
        rank,
        costBasis,
        ...(redact
          ? {
              title: "[redacted]",
              projectPath: "[redacted]",
              filesTouched: [],
              bashCommands: {},
              bashErrors: {},
              commandHeads: {},
              commandHeadErrors: {},
              turns: analysis.turns.map((t) => ({ ...t, prompt: "[redacted]" })),
            }
          : {}),
      };
      if (includeTranscript && redactedTranscript) basePayload.transcript = redactedTranscript;
      content = JSON.stringify(basePayload, null, 2);
    }

    if (opts.out) {
      const safeId = sanitizeFilename(analysis.sessionId ?? "session");
      const outPath = await resolveOutPath(opts.out, safeId, extFor(format));
      try {
        await Bun.write(outPath, content);
      } catch (e) {
        console.error(`error: cannot write ${outPath}: ${(e as Error).message}`);
        return 1;
      }
      console.log(`Wrote ${format} export to ${outPath}`);
    } else {
      console.log(content);
    }
    return 0;
  }

  // Default: terminal rendering (unchanged)
  console.log(
    renderSessionSummary(analysis, {
      color: process.stdout.isTTY && !process.env.NO_COLOR,
      // Session-scoped what-if: computed here because the renderer never
      // sees the pricing table.
      whatIf: sessionWhatIf(analysis.models, pricing),
    }),
  );
  // Parse coverage, not just the error count: a line kept as a tolerant
  // "unknown" event is not skipped, but it is also not understood.
  if (coverage.parseErrors > 0 || coverage.unknownEvents > 0) {
    console.log(
      `\n(${coverage.parseErrors} unparseable lines skipped, ` +
        `${coverage.unknownEvents} kept as unknown events, of ${coverage.lines} lines)`,
    );
  }
  return 0;
}

/** Resolve --out to a concrete file path. Directory → auto-named file. */
async function resolveOutPath(out: string, sessionId: string, ext: string): Promise<string> {
  const { stat } = await import("node:fs/promises");
  const { extname, join, dirname } = await import("node:path");
  try {
    const s = await stat(out);
    if (s.isDirectory()) {
      const base = `cc-analyzer-${sanitizeFilename(sessionId)}${ext}`;
      return join(out, base);
    }
  } catch {
    // not existing — check if parent is dir-like (trailing slash)
    if (out.endsWith("/")) {
      const { mkdir } = await import("node:fs/promises");
      await mkdir(out, { recursive: true });
      return join(out, `cc-analyzer-${sanitizeFilename(sessionId)}${ext}`);
    }
  }
  // Add inferred extension when none present (use path.extname, not String.includes)
  if (extname(out) === "" && !out.endsWith("/")) return `${out}${ext}`;
  // Ensure parent directory exists for nested paths like a/b/c.md
  try {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(dirname(out), { recursive: true });
  } catch {
    // ignore — Bun.write will surface EACCES/ENOENT
  }
  return out;
}

function renderHealthReport(ref: string, report: SessionHealthReport): string {
  const symbol = report.status === "healthy" ? "✓" : report.status === "damaged" ? "✗" : "!";
  const lines = [
    `${symbol} Session health: ${report.status}`,
    `${ref} · ${report.events} events · ${report.parseErrors} parse errors · ` +
      `${report.unknownEvents} unknown events`,
  ];
  if (report.findings.length === 0) {
    lines.push("", "No structural health problems were detected.");
  } else {
    lines.push("");
    for (const finding of report.findings) {
      lines.push(`${finding.severity === "error" ? "✗" : "!"} ${finding.title}`);
      lines.push(`  ${finding.evidence}`);
      lines.push(`  Next: ${finding.action}`);
    }
  }
  lines.push("", "Read-only check · no Claude Code files were changed.");
  return lines.join("\n");
}

async function cmdDoctor(ref: string | undefined, json: boolean): Promise<number> {
  if (!ref) {
    console.error("error: missing <id|path>.");
    return 2;
  }
  const source = await resolveSessionSource(ref);
  if (!source) {
    console.error(`error: session '${ref}' not found.`);
    return 1;
  }
  const path = source.path;
  const { events, errors, coverage } = await parseSessionTree(sessionTree(source));
  const report = inspectSessionHealth(events, errors, coverage);
  if (json) console.log(JSON.stringify({ path, ...report }, null, 2));
  else console.log(renderHealthReport(path, report));
  return report.status === "healthy" ? 0 : 1;
}

function indexChangeSummary(status: { added: number; changed: number; deleted: number }): string {
  return `${status.added} new, ${status.changed} changed, ${status.deleted} deleted`;
}

async function cmdIndex(rebuild: boolean, check: boolean): Promise<number> {
  const db = openDb();
  if (check) {
    const status = await inspectIndexStatus(db);
    // Coverage comes from the indexed rows (schema v11), so `--check` keeps its
    // no-parse guarantee: this is one SQL scan, no session file is reopened.
    const coverage = parseCoverage(db).summary;
    db.close();
    if (status.stale) {
      console.log(`Index is stale: ${indexChangeSummary(status)} sessions.`);
      console.log("Run `cc-analyzer index` to refresh.");
      console.log(renderParseCoverageLine(coverage));
      return 1;
    }
    const refreshed = status.lastRefreshedAt
      ? formatRelativeTime(Date.parse(status.lastRefreshedAt))
      : "unknown";
    console.log(`Index is current (${status.added + status.changed + status.deleted} changes).`);
    console.log(`Last refreshed: ${refreshed}.`);
    console.log(renderParseCoverageLine(coverage));
    return 0;
  }
  const start = Date.now();
  let lastLogged = 0;
  const result = await reindex(db, {
    rebuild,
    onProgress: (done, total) => {
      if (done === total || done - lastLogged >= 200) {
        lastLogged = done;
        process.stderr.write(`\rindexing ${done}/${total}...`);
      }
    },
  });
  db.close();
  if (result.total > result.skipped) process.stderr.write("\n");
  const secs = ((Date.now() - start) / 1000).toFixed(1);
  console.log(
    `Indexed ${result.indexed}, skipped ${result.skipped}, deleted ${result.deleted} ` +
      `(${result.total} sessions) in ${secs}s.`,
  );
  return 0;
}

async function cmdStats(json: boolean, current: boolean): Promise<number> {
  const db = openDb();
  const project = current ? indexedProjectForPath(db, process.cwd()) : undefined;
  if (current && !project) {
    db.close();
    console.error(
      `No indexed Claude Code project contains '${process.cwd()}'. ` +
        "Run `cc-analyzer index` and try again.",
    );
    return 1;
  }
  const projectId = project?.projectId;
  // The shared portfolio shape comes from the same builder as /api/stats;
  // the CLI adds its terminal-only extras on top.
  const portfolio = buildPortfolioStats(db, localDayOfMs(Date.now()), { projectId });
  if (portfolio.summary.sessions === 0) {
    db.close();
    console.error("Index is empty. Run `cc-analyzer index` first.");
    return 1;
  }
  const analytics = analyticsRollup(db, projectId);
  // The CLI reports only the concurrency headline, not the per-day series.
  const { peak, parallelDayShare } = concurrency(db, projectId);
  // What-if repricing needs live rates; `loadPricing` serves the cached table
  // (bundled snapshot offline), the same one the index was priced with.
  const { table: pricing } = await loadPricing();
  const scope = project
    ? {
        type: "project" as const,
        projectId: project.projectId,
        projectPath: project.projectPath,
      }
    : { type: "portfolio" as const };
  const costBasis = getCostBasis();
  const view = {
    scope,
    index: await inspectIndexStatus(db),
    ...portfolio,
    ttl: cacheTtlSplit(db, projectId),
    bash: analytics.bash.slice(0, 10),
    // Ranked by turn-scoped cost — the primary skill-cost number.
    skills: [...analytics.skills].sort((a, b) => b.attributedCost - a.attributedCost).slice(0, 10),
    tests: analytics.tests,
    retries: analytics.retries,
    corrections: analytics.corrections,
    concurrency: { peak, parallelDayShare },
    contextTax: contextTax(db, projectId),
    whatIf: whatIfRepricing(db, pricing, projectId),
    costBasis,
  };
  db.close();
  console.log(
    json
      ? JSON.stringify(view, null, 2)
      : renderStats(view, {
          color: process.stdout.isTTY && !process.env.NO_COLOR,
          projectPath: project?.projectPath,
          costBasis,
        }),
  );
  return 0;
}

/**
 * Cross-reference the installed setup (skills, subagents, plugins, MCP servers,
 * hooks, permission rules) with what the indexed sessions actually used.
 *
 * The inventory is read live off the Claude dir; usage comes from the index, so
 * an empty index would report the whole setup as unused — refuse instead.
 */
function cmdAudit(json: boolean): number {
  const db = openDb();
  if (isIndexEmpty(db)) {
    db.close();
    console.error(
      "Index is empty, so every installed skill and server would look unused. " +
        "Run `cc-analyzer index` first.",
    );
    return 1;
  }
  const usage = analyticsRollup(db);
  db.close();
  const audit = buildSetupAudit(scanInventories(), usage, localDayOfMs(Date.now()));
  console.log(
    json
      ? JSON.stringify(audit, null, 2)
      : renderSetupAudit(audit, {
          color: process.stdout.isTTY && !process.env.NO_COLOR,
        }),
  );
  return 0;
}

/**
 * Portfolio insights: every portfolio signal folded through the bun-free rules
 * engine into ranked, explainable findings. Usage comes from the index; an
 * empty index has no signals to diagnose — refuse, like `stats` and `audit`.
 */
async function cmdInsights(json: boolean): Promise<number> {
  const db = openDb();
  if (isIndexEmpty(db)) {
    db.close();
    console.error("Index is empty. Run `cc-analyzer index` first.");
    return 1;
  }
  // The what-if signal needs live rates; `loadPricing` serves the cached table
  // (bundled snapshot offline), the same one the index was priced with.
  const { table: pricing } = await loadPricing();
  const diagnostics = buildPortfolioDiagnostics(assemblePortfolioSignals(db, pricing));
  db.close();
  console.log(
    json
      ? JSON.stringify(diagnostics, null, 2)
      : renderPortfolioInsights(diagnostics, {
          color: process.stdout.isTTY && !process.env.NO_COLOR,
        }),
  );
  return 0;
}

/**
 * Weekly digest: one week of usage, what changed against the week before, and
 * the current-state insight snapshot. `--md` prints paste-ready markdown to
 * stdout (never a file — users redirect); `--json` prints the plain digest.
 *
 * An empty index has nothing to report, so it exits 1 like `stats`/`insights`.
 * A period with zero sessions is NOT an error: "you didn't use Claude Code last
 * week" is a legitimate answer, and the prior week still renders.
 */
async function cmdReport(
  json: boolean,
  md: boolean,
  week: string | null | undefined,
): Promise<number> {
  if (week === null) {
    console.error("error: missing value for --week (expected a YYYY-MM-DD day inside the week).");
    return 2;
  }
  if (week !== undefined && !isDayString(week)) {
    console.error(`error: invalid --week '${week}' (expected a YYYY-MM-DD day inside the week).`);
    return 2;
  }
  const db = openDb();
  if (isIndexEmpty(db)) {
    db.close();
    console.error("Index is empty. Run `cc-analyzer index` first.");
    return 1;
  }
  // The insight snapshot needs live rates for what-if repricing; `loadPricing`
  // serves the cached table (bundled snapshot offline).
  const { table: pricing } = await loadPricing();
  // Cost framing is read here, at the CLI's presentation boundary — the digest
  // builder never touches the prefs file.
  const digest = buildWeeklyDigest(db, pricing, { week, costBasis: getCostBasis() });
  db.close();
  if (json) console.log(JSON.stringify(digest, null, 2));
  else if (md) console.log(buildDigestMarkdown(digest));
  else
    console.log(
      renderWeeklyDigest(digest, {
        color: process.stdout.isTTY && !process.env.NO_COLOR,
      }),
    );
  return 0;
}

/**
 * `--week=YYYY-MM-DD` or `--week YYYY-MM-DD`. `undefined` when the flag is
 * absent, `null` when it is present without a value — nothing follows it, or
 * the next token is another flag, since `report --week --md` must report a
 * missing week rather than swallow `--md` as its value.
 */
function weekArg(rest: string[]): string | null | undefined {
  const inline = rest.find((a) => a.startsWith("--week="));
  if (inline) {
    const value = inline.slice("--week=".length);
    return value.length > 0 ? value : null;
  }
  const i = rest.indexOf("--week");
  if (i === -1) return undefined;
  const next = rest[i + 1];
  return next !== undefined && !next.startsWith("-") ? next : null;
}

async function cmdPricingUpdate(): Promise<number> {
  const loaded = await loadPricing({ force: true });
  const count = Object.keys(loaded.table).length;
  if (loaded.source !== "remote") {
    console.error(
      `error: could not refresh pricing from the remote source; ` +
        `still using ${loaded.source} (${formatCount(count)} models).`,
    );
    return 1;
  }
  console.log(`Pricing loaded from ${loaded.source}: ${formatCount(count)} models.`);
  return 0;
}

/** Live download progress on stderr (TTY only, so piped output stays clean). */
function renderDownloadProgress(p: DownloadProgress): void {
  if (!process.stderr.isTTY) return;
  const mb = (n: number) => (n / 1_000_000).toFixed(1);
  const status = p.total
    ? `${Math.floor((p.received / p.total) * 100)}% (${mb(p.received)}/${mb(p.total)} MB)`
    : `${mb(p.received)} MB`;
  process.stderr.write(`\rDownloading update… ${status}   `);
}

async function cmdUpdate(checkOnly: boolean): Promise<number> {
  try {
    if (checkOnly) {
      const latest = await fetchLatestVersion();
      if (compareVersions(latest, VERSION) <= 0) {
        console.log(`You're on the latest version (v${VERSION}).`);
      } else {
        console.log(
          `v${latest} is available (you have v${VERSION}).\n` +
            `Run 'cc-analyzer update' to install it.`,
        );
      }
      return 0;
    }
    const result = await performUpdate(renderDownloadProgress);
    if (result.status === "updated" && process.stderr.isTTY) process.stderr.write("\n");
    console.log(result.message);
    return result.status === "unsupported" ? 1 : 0;
  } catch (err) {
    console.error(`update failed: ${(err as Error).message}`);
    return 1;
  }
}

async function cmdExport(rest: string[]): Promise<number> {
  let scope: ReturnType<typeof parseScope>;
  try {
    scope = parseScope(rest);
  } catch (e) {
    console.error(`error: ${(e as Error).message}`);
    return 2;
  }
  const { value: formatRaw, rest: rest1 } = takeFlagValue(rest, "--format");
  let formats: ReturnType<typeof parseFormats>;
  try {
    formats = parseFormats(formatRaw);
  } catch (e) {
    console.error(`error: ${(e as Error).message}`);
    return 2;
  }
  const { value: outRaw, rest: rest2 } = takeFlagValue(rest1, "--out");
  const redact = rest2.includes("--redact");
  const split = rest2.includes("--split");
  const includeTranscript = rest2.includes("--include-transcript");
  const zip = rest2.includes("--zip");
  if (redact && split) {
    console.error(
      "error: --redact and --split are mutually exclusive (split already includes both).",
    );
    return 2;
  }
  // Unknown flag guard: allow exact and --flag=value forms for --format/--out/--project/--session
  const knownBase = new Set([
    "--format",
    "--out",
    "--redact",
    "--split",
    "--include-transcript",
    "--zip",
    "--project",
    "--session",
  ]);
  for (const a of rest2) {
    if (a.startsWith("--")) {
      const base = a.split("=")[0] as string;
      if (!knownBase.has(base)) {
        console.error(`error: unknown flag '${a}' for export. See \`cc-analyzer help\`.`);
        return 2;
      }
    }
  }
  // Resolve out dir: folder is default; file not allowed for bulk scopes
  const defaultName = `cc-analyzer-export-${new Date().toISOString().slice(0, 10)}`;
  const outRawTrimmed = outRaw?.trim() ?? "";
  const outDir = outRawTrimmed.length > 0 ? outRawTrimmed : defaultName;
  if (outDir.trim() === "") {
    console.error("error: --out needs a directory.");
    return 2;
  }
  // Basic outDir sandbox: reject path traversal trying to escape cwd via .. and absolute sensitive roots
  // We still allow absolute /tmp/* and cwd-relative paths; just block obvious ../../etc style.
  {
    const { resolve, isAbsolute } = await import("node:path");
    const resolved = resolve(outDir);
    // Block if resolved path is exactly / or /etc or sensitive, or contains .. traversal that was not normalized
    // Minimal: if user gave "../../" style that escapes cwd's parent by more than 2 levels, warn.
    // We allow absolute paths inside /tmp and $HOME and cwd.
    if (isAbsolute(outDir) && (outDir === "/" || outDir === "/etc" || outDir.startsWith("/etc/"))) {
      console.error(`error: --out path '${outDir}' is not allowed.`);
      return 2;
    }
    // If outDir still contains ".." after resolve, it escaped; we already resolved so just check original had .. and resolved is outside cwd/tmp/home
    void resolved; // kept for future stricter sandbox (cwd/tmp/home check)
  }
  // For session scope via indexed id, we need to validate projectId if --project was given as qualified id
  // Validate project exists when scope is project
  if (scope.kind === "project") {
    const dbCheck = openDb();
    const rows = dbCheck
      .query("SELECT 1 FROM sessions WHERE project_id = ? LIMIT 1")
      .get(scope.projectId) as unknown;
    dbCheck.close();
    if (!rows) {
      console.error(
        `error: project '${scope.projectId}' not found in index. Run \`cc-analyzer projects\` to list ids. Re-index if the project is new.`,
      );
      return 1;
    }
  }
  // Session scope with --project value already handled via scope; positional session via file will be validated in exportBundle
  const db = openDb();
  // For portfolio/project scope the index must not be empty (otherwise empty zip).
  if ((scope.kind === "portfolio" || scope.kind === "project") && isIndexEmpty(db)) {
    db.close();
    console.error("Index is empty. Run `cc-analyzer index` first.");
    return 1;
  }
  const { table: pricing } = await loadPricing();
  try {
    const result = await exportBundle(db, pricing, {
      scope,
      formats,
      outDir,
      redact,
      split,
      includeTranscript,
      zip,
    });
    db.close();
    const privacy = split ? "split (private/ + shareable/)" : redact ? "redacted" : "private";
    console.log(
      `Exported ${result.sessions} sessions (${privacy}, ${[...formats].join(",")}) to ${result.outDir}${zip ? ".zip" : ""}${result.skipped > 0 ? ` (${result.skipped} skipped)` : ""}`,
    );
    if (split) console.log(`  private/ and shareable/ subfolders present.`);
    return 0;
  } catch (e) {
    db.close();
    console.error(`export failed: ${(e as Error).message}`);
    return 1;
  }
}

/** Commands that emit a passive "update available" notice when appropriate. */
const NOTIFY_COMMANDS = new Set([
  "projects",
  "sessions",
  "analyze",
  "doctor",
  "index",
  "stats",
  "audit",
  "insights",
  "report",
  "export",
  "pricing",
]);

/**
 * Commands that read or write the SQLite index, and therefore cannot honour a
 * one-invocation `--claude-dir` scope. `undefined` (the TUI) is checked
 * alongside them.
 *
 * The index always covers *every* configured Claude directory — that is what
 * lets the query layer aggregate with no root clause anywhere. So a one-off
 * scope is either silently ignored (a read command would still report the whole
 * portfolio) or quietly destructive (`index` would prune the directories it was
 * not pointed at). Refusing is the honest option; `claude-dir set` is the way to
 * scope these for real.
 */
const INDEX_BACKED = new Set(["index", "stats", "audit", "insights", "report", "export", "serve"]);

/** Whether the roots in effect came from `--claude-dir=` rather than config. */
const flagScoped = (): boolean => claudeRoots()[0]?.source === "flag";

async function runCommand(command: string | undefined, rest: string[]): Promise<number> {
  const json = rest.includes("--json");
  const positional = rest.filter((a) => !a.startsWith("--"));

  if (flagScoped() && (command === undefined || INDEX_BACKED.has(command))) {
    const name = command ?? "the interactive TUI";
    console.error(
      `error: --claude-dir cannot be used with \`${name}\`, which ${
        command === "index" ? "writes" : "reads"
      } the session index.\n` +
        "The index covers every configured Claude directory, so a one-off scope would be " +
        (command === "index"
          ? "destructive here: it would drop the rows of every directory it was not pointed at."
          : "ignored — you would still see the whole portfolio.") +
        "\nConfigure the directories instead, then reindex:\n" +
        "  cc-analyzer claude-dir set <path>\n" +
        "  cc-analyzer index",
    );
    return 2;
  }

  // Fire at dispatch time (before serve/tui block forever). `telemetry`, `version`,
  // and help are never tracked; undefined command means the TUI is launching.
  const TRACKED = new Set([
    "projects",
    "sessions",
    "analyze",
    "doctor",
    "index",
    "stats",
    "audit",
    "insights",
    "report",
    "export",
    "serve",
    "pricing",
    "update",
  ]);
  if (command === undefined || TRACKED.has(command)) {
    maybeShowFirstRunNotice();
    trackCommand(command ?? "tui");
  }

  switch (command) {
    case "projects":
      return cmdProjects();
    case "sessions":
      return cmdSessions(positional[0]);
    case "analyze": {
      const withClaude = rest.includes("--with-claude");
      const md = rest.includes("--md");
      const html = rest.includes("--html");
      const redact = rest.includes("--redact");
      const includeTranscript = rest.includes("--include-transcript");
      const { value: out, rest: restOut } = takeFlagValue(rest, "--out");
      // `--model x` puts its value where the positional filter can't see it's a
      // flag argument, so strip the flag+value before resolving the id.
      const { value: model, rest: rest2 } = takeFlagValue(restOut, "--model");
      if (json && withClaude) {
        console.error("error: --json cannot be combined with --with-claude.");
        return 2;
      }
      if (md && withClaude) {
        console.error("error: --md cannot be combined with --with-claude.");
        return 2;
      }
      if (html && withClaude) {
        console.error("error: --html cannot be combined with --with-claude.");
        return 2;
      }
      if (json && md) {
        console.error("error: --json and --md cannot be used together.");
        return 2;
      }
      if (json && html) {
        console.error("error: --json and --html cannot be used together.");
        return 2;
      }
      if (md && html) {
        console.error("error: --md and --html cannot be used together.");
        return 2;
      }
      if (out !== undefined && !json && !md && !html) {
        console.error("error: --out requires --json, --md, or --html.");
        return 2;
      }
      if (out !== undefined && out.trim() === "") {
        console.error("error: --out needs a file path.");
        return 2;
      }
      const args = rest2.filter((a) => !a.startsWith("--"));
      return cmdAnalyze(args[0], json, {
        withClaude,
        model,
        md,
        html,
        out,
        redact,
        includeTranscript,
      });
    }
    case "doctor":
      return cmdDoctor(positional[0], json);
    case "index":
      if (rest.includes("--rebuild") && rest.includes("--check")) {
        console.error("error: --rebuild and --check cannot be used together.");
        return 2;
      }
      return cmdIndex(rest.includes("--rebuild"), rest.includes("--check"));
    case "stats":
      return cmdStats(json, rest.includes("--current"));
    case "audit":
      return cmdAudit(json);
    case "insights":
      return cmdInsights(json);
    case "report": {
      const md = rest.includes("--md");
      // Two different renderings of the same digest — asking for both hides one.
      if (md && json) {
        console.error("error: --md and --json cannot be used together.");
        return 2;
      }
      return cmdReport(json, md, weekArg(rest));
    }
    case "export":
      return cmdExport(rest);
    case "serve": {
      const portArg = rest.find((a) => a.startsWith("--port="));
      let port: number | undefined;
      if (portArg) {
        const raw = portArg.slice("--port=".length);
        const parsed = Number(raw);
        if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
          console.error(`error: invalid --port '${raw}' (expected an integer 1-65535).`);
          return 2;
        }
        port = parsed;
      }
      const hostArg = rest.find((a) => a.startsWith("--host="));
      const host = hostArg ? hostArg.slice("--host=".length) : undefined;
      const { runServe } = await import("../web/server.ts");
      return await runServe({
        port,
        host,
        refresh: rest.includes("--refresh"),
        open: rest.includes("--open"),
      });
    }
    case "pricing":
      if (positional[0] === "update") return cmdPricingUpdate();
      console.error("usage: cc-analyzer pricing update");
      return 2;
    case "update":
      return cmdUpdate(rest.includes("--check"));
    case "version":
    case "--version":
    case "-v":
      console.log(VERSION);
      return 0;
    case "telemetry":
      return cmdTelemetry(positional[0]);
    case "cost-basis":
      return cmdCostBasis(positional[0]);
    case "claude-dir":
      return cmdClaudeDir(positional[0], positional[1]);
    // Hidden re-entry point: the detached child that delivers one telemetry
    // event after its parent has exited. Reads argv directly (the payload is
    // JSON, not a flag) and prints nothing. Never itself tracked.
    case POSTER_COMMAND:
      return await runTelemetryPoster(rest[0], rest[1]);
    case undefined: {
      const { runTui } = await import("../tui/run.tsx");
      return await runTui();
    }
    case "help":
    case "--help":
    case "-h":
      console.log(HELP);
      return 0;
    default:
      console.error(`unknown command: ${command}\n`);
      console.log(HELP);
      return 2;
  }
}

/**
 * Pull `--claude-dir=<path>` (repeatable, or one `PATH`-style list) out of argv
 * and apply it before anything resolves a directory.
 *
 * Only the `--flag=value` form is accepted, matching `--port=`/`--host=`: the
 * space-separated form would leave the path in argv as a positional and quietly
 * break `sessions <projectId>`.
 */
function applyClaudeDirFlag(argv: string[]): string[] | null {
  const PREFIX = "--claude-dir=";
  if (argv.includes("--claude-dir")) {
    console.error("error: --claude-dir takes its value inline, as --claude-dir=<path>.");
    return null;
  }
  const flags = argv.filter((a) => a.startsWith(PREFIX));
  const paths = flags.flatMap((a) => splitRootList(a.slice(PREFIX.length)));
  if (flags.length > 0 && paths.length === 0) {
    console.error("error: --claude-dir=<path> needs a path.");
    return null;
  }
  if (paths.length > 0) setClaudeRootsOverride(paths);
  return argv.filter((a) => !a.startsWith(PREFIX));
}

async function main(): Promise<number> {
  // Strip the global flag before the command is read, so it may appear anywhere.
  const argv = applyClaudeDirFlag(process.argv.slice(2));
  if (argv === null) return 2;
  const [command, ...rest] = argv;
  const code = await runCommand(command, rest);

  // Best-effort, non-blocking "update available" notice for quick commands.
  if (command && NOTIFY_COMMANDS.has(command) && !rest.includes("--json")) {
    await maybeNotifyUpdate();
  }
  await flushTelemetry();
  return code;
}

process.exit(await main());
