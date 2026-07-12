#!/usr/bin/env bun
import { analyzeSession } from "../core/analyze.ts";
import { openDb } from "../core/db.ts";
import { findSessionById, listProjects, listSessions } from "../core/discover.ts";
import { reindex } from "../core/indexer.ts";
import { parseSessionFile } from "../core/parser.ts";
import { loadPricing } from "../core/pricing-source.ts";
import { compareVersions, fetchLatestVersion } from "../core/release.ts";
import {
  portfolioSummary,
  spendByModel,
  spendByMonth,
  spendByProject,
  topSessions,
} from "../core/stats.ts";
import { performUpdate } from "../core/update.ts";
import { maybeNotifyUpdate } from "../core/update-check.ts";
import { VERSION } from "../core/version.ts";
import { formatBytes, formatCount, formatRelativeTime, table, truncate } from "./format.ts";
import { renderSessionSummary, renderStats } from "./render.ts";

const HELP = `cc-analyzer ${VERSION} — analyze Claude Code sessions in ~/.claude

Usage:
  cc-analyzer                          Launch the interactive TUI (needs an index)
  cc-analyzer projects                 List all projects
  cc-analyzer sessions <projectId>     List sessions in a project
  cc-analyzer analyze <id|path> [--json]
                                       Analyze a single session
  cc-analyzer index [--rebuild]        Build/refresh the session index
  cc-analyzer stats [--json]           Portfolio-wide analytics (needs an index)
  cc-analyzer serve [--port=4317]      Launch the local web app (needs an index)
  cc-analyzer pricing update           Refresh the pricing cache
  cc-analyzer update [--check]         Update to the latest release (or just check)
  cc-analyzer version                  Print the version
  cc-analyzer help                     Show this help

Notes:
  <id> is a session uuid (searched across all projects) or a path to a .jsonl file.
`;

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
  const { events, errors } = await parseSessionFile(path);
  const { table: pricing } = await loadPricing();
  const analysis = analyzeSession(events, pricing);

  if (json) {
    console.log(JSON.stringify({ ...analysis, parseErrors: errors.length }, null, 2));
  } else {
    console.log(renderSessionSummary(analysis));
    if (errors.length) console.log(`\n(${errors.length} unparseable lines skipped)`);
  }
  return 0;
}

async function cmdIndex(rebuild: boolean): Promise<number> {
  const db = openDb();
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

async function cmdStats(json: boolean): Promise<number> {
  const db = openDb();
  const summary = portfolioSummary(db);
  if (summary.sessions === 0) {
    db.close();
    console.error("Index is empty. Run `cc-analyzer index` first.");
    return 1;
  }
  const view = {
    summary,
    byMonth: spendByMonth(db),
    byProject: spendByProject(db),
    byModel: spendByModel(db),
    top: topSessions(db),
  };
  db.close();
  console.log(json ? JSON.stringify(view, null, 2) : renderStats(view));
  return 0;
}

async function cmdPricingUpdate(): Promise<number> {
  const loaded = await loadPricing({ force: true });
  const count = Object.keys(loaded.table).length;
  console.log(`Pricing loaded from ${loaded.source}: ${formatCount(count)} models.`);
  return loaded.source === "remote" ? 0 : 1;
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
    const result = await performUpdate();
    console.log(result.message);
    return result.status === "unsupported" ? 1 : 0;
  } catch (err) {
    console.error(`update failed: ${(err as Error).message}`);
    return 1;
  }
}

/** Commands that emit a passive "update available" notice when appropriate. */
const NOTIFY_COMMANDS = new Set(["projects", "sessions", "analyze", "index", "stats", "pricing"]);

async function runCommand(command: string | undefined, rest: string[]): Promise<number> {
  const json = rest.includes("--json");
  const positional = rest.filter((a) => !a.startsWith("--"));

  switch (command) {
    case "projects":
      return cmdProjects();
    case "sessions":
      return cmdSessions(positional[0]);
    case "analyze":
      return cmdAnalyze(positional[0], json);
    case "index":
      return cmdIndex(rest.includes("--rebuild"));
    case "stats":
      return cmdStats(json);
    case "serve": {
      const portArg = rest.find((a) => a.startsWith("--port="));
      const port = portArg ? Number(portArg.slice("--port=".length)) : undefined;
      const { runServe } = await import("../web/server.ts");
      await runServe({ port });
      return 0;
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
    case undefined: {
      const { runTui } = await import("../tui/run.tsx");
      await runTui();
      return 0;
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
  return code;
}

process.exit(await main());
