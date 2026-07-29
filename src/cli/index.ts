#!/usr/bin/env bun
import { analyzeSession } from "../core/analyze.ts";
import { openDb } from "../core/db.ts";
import { buildDigestMarkdown, isDayString } from "../core/digest.ts";
import { buildWeeklyDigest } from "../core/digest-signals.ts";
import { findSessionById, listProjects, listSessions } from "../core/discover.ts";
import { inspectIndexStatus } from "../core/index-status.ts";
import { reindex } from "../core/indexer.ts";
import { scanInventory } from "../core/inventory.ts";
import { parseSessionFile } from "../core/parser.ts";
import { buildPortfolioDiagnostics } from "../core/portfolio-diagnostics.ts";
import { assemblePortfolioSignals } from "../core/portfolio-signals.ts";
import { getCostBasis, setCostBasis } from "../core/prefs.ts";
import { loadPricing } from "../core/pricing-source.ts";
import { indexedProjectForPath, isIndexEmpty } from "../core/queries.ts";
import { compareVersions, fetchLatestVersion } from "../core/release.ts";
import { buildSetupAudit } from "../core/setup-audit.ts";
import {
  analyticsRollup,
  buildPortfolioStats,
  cacheTtlSplit,
  concurrency,
  contextTax,
  localDayOfMs,
  parseCoverage,
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
import { type DownloadProgress, performUpdate } from "../core/update.ts";
import { maybeNotifyUpdate } from "../core/update-check.ts";
import { VERSION } from "../core/version.ts";
import { formatBytes, formatCount, formatRelativeTime, table, truncate } from "./format.ts";
import {
  renderParseCoverageLine,
  renderPortfolioInsights,
  renderSessionSummary,
  renderSetupAudit,
  renderStats,
  renderWeeklyDigest,
} from "./render.ts";

const HELP = `cc-analyzer ${VERSION} — analyze Claude Code sessions in ~/.claude

Usage:
  cc-analyzer                          Launch the interactive TUI
  cc-analyzer projects                 List all projects
  cc-analyzer sessions <projectId>     List sessions in a project
  cc-analyzer analyze <id|path> [--json]
                                       Analyze a single session
  cc-analyzer index [--rebuild|--check]
                                       Build, refresh, or check the session index
  cc-analyzer stats [--current] [--json]
                                       Portfolio or current-project analytics (needs an index)
  cc-analyzer audit [--json]           Cross-reference your installed setup with observed usage
  cc-analyzer insights [--json]        Ranked, actionable findings across the whole portfolio
  cc-analyzer report [--week YYYY-MM-DD] [--md|--json]
                                       Weekly digest: last complete week vs the week before
  cc-analyzer serve [--port=4317] [--host=127.0.0.1] [--refresh] [--open]
                                       Launch the local web app
  cc-analyzer pricing update           Refresh the pricing cache
  cc-analyzer update [--check]         Update to the latest release (or just check)
  cc-analyzer version                  Print the version
  cc-analyzer telemetry <on|off|status>
                                       View or change anonymous usage telemetry
  cc-analyzer cost-basis [api|subscription]
                                       View or change how dollar figures are framed
  cc-analyzer help                     Show this help

Notes:
  <id> is a session uuid (searched across all projects) or a path to a .jsonl file.

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

async function cmdProjects(): Promise<number> {
  const projects = await listProjects();
  if (projects.length === 0) {
    console.log("No projects found under ~/.claude/projects.");
    return 0;
  }
  console.log(
    table(
      ["sessions", "project"],
      projects.map((p) => [String(p.sessionCount), truncate(p.label, 80)]),
    ),
  );
  console.log(`\n${projects.length} projects`);
  return 0;
}

async function cmdSessions(projectId: string | undefined): Promise<number> {
  if (!projectId) {
    console.error("error: missing <projectId>. Run `cc-analyzer projects` to list ids.");
    return 2;
  }
  const sessions = await listSessions(projectId);
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

async function resolveSessionPath(ref: string): Promise<string | undefined> {
  if (ref.endsWith(".jsonl") || ref.includes("/")) {
    return (await Bun.file(ref).exists()) ? ref : undefined;
  }
  return (await findSessionById(ref))?.path;
}

async function cmdAnalyze(ref: string | undefined, json: boolean): Promise<number> {
  if (!ref) {
    console.error("error: missing <id|path>.");
    return 2;
  }
  const path = await resolveSessionPath(ref);
  if (!path) {
    console.error(`error: session '${ref}' not found.`);
    return 1;
  }
  const { events, errors, coverage } = await parseSessionFile(path);
  const { table: pricing } = await loadPricing();
  const analysis = analyzeSession(events, pricing, { coverage });

  if (json) {
    console.log(JSON.stringify({ ...analysis, parseErrors: errors.length }, null, 2));
  } else {
    console.log(
      renderSessionSummary(analysis, {
        color: process.stdout.isTTY && !process.env.NO_COLOR,
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
  }
  return 0;
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
  const audit = buildSetupAudit(scanInventory(), usage, localDayOfMs(Date.now()));
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
  const digest = buildWeeklyDigest(db, pricing, { week });
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

/** Commands that emit a passive "update available" notice when appropriate. */
const NOTIFY_COMMANDS = new Set([
  "projects",
  "sessions",
  "analyze",
  "index",
  "stats",
  "audit",
  "insights",
  "report",
  "pricing",
]);

async function runCommand(command: string | undefined, rest: string[]): Promise<number> {
  const json = rest.includes("--json");
  const positional = rest.filter((a) => !a.startsWith("--"));

  // Fire at dispatch time (before serve/tui block forever). `telemetry`, `version`,
  // and help are never tracked; undefined command means the TUI is launching.
  const TRACKED = new Set([
    "projects",
    "sessions",
    "analyze",
    "index",
    "stats",
    "audit",
    "insights",
    "report",
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
    case "analyze":
      return cmdAnalyze(positional[0], json);
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

async function main(): Promise<number> {
  const [, , command, ...rest] = process.argv;
  const code = await runCommand(command, rest);

  // Best-effort, non-blocking "update available" notice for quick commands.
  if (command && NOTIFY_COMMANDS.has(command) && !rest.includes("--json")) {
    await maybeNotifyUpdate();
  }
  await flushTelemetry();
  return code;
}

process.exit(await main());
