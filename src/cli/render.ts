import type { SessionAnalysis } from "../core/analyze.ts";
import type { TokenCounts } from "../core/pricing.ts";
import type {
  BashCommandRow,
  CacheTtlSplit,
  PortfolioStats,
  RetryStats,
  TestRunSummary,
} from "../core/stats.ts";
import { topEntries } from "../core/stats-types.ts";
import { formatCount, formatDuration, formatTokens, formatUSD, table, truncate } from "./format.ts";

export interface RenderOptions {
  color?: boolean;
  projectPath?: string;
}

const ANSI = {
  reset: "\u001B[0m",
  bold: "\u001B[1m",
  dim: "\u001B[2m",
  amber: "\u001B[38;5;214m",
  green: "\u001B[38;5;114m",
};

function paint(enabled: boolean, codes: string, value: string): string {
  return enabled ? `${codes}${value}${ANSI.reset}` : value;
}

function reportTitle(title: string, options: RenderOptions): string {
  return paint(options.color === true, `${ANSI.bold}${ANSI.amber}`, `◆ ${title}`);
}

function section(title: string, options: RenderOptions): string {
  return paint(options.color === true, `${ANSI.bold}${ANSI.amber}`, `▸ ${title}`);
}

function muted(value: string, options: RenderOptions): string {
  return paint(options.color === true, ANSI.dim, value);
}

function healthy(value: string, options: RenderOptions): string {
  return paint(options.color === true, ANSI.green, value);
}

function totalTokens(t: TokenCounts): number {
  return (
    t.inputTokens + t.outputTokens + t.cacheWrite5mTokens + t.cacheWrite1hTokens + t.cacheReadTokens
  );
}

/** Render a full single-session analysis as a text report. */
export function renderSessionSummary(a: SessionAnalysis, options: RenderOptions = {}): string {
  const lines: string[] = [];
  const est = a.totals.cost.estimated ? " (estimated)" : "";

  lines.push(reportTitle(a.title ?? "(untitled session)", options));
  lines.push(muted(`${a.sessionId ?? "?"} · ${a.projectPath ?? "?"}`, options));
  if (a.gitBranches.length) lines.push(`  branch: ${a.gitBranches.join(", ")}`);
  if (a.versions.length) lines.push(`  cc version: ${a.versions.join(", ")}`);

  lines.push(`\n${section("Totals", options)}`);
  lines.push(
    table(
      ["metric", "value"],
      [
        ["cost", `${formatUSD(a.totals.cost.total)}${est}`],
        ["turns", String(a.totals.turns)],
        ["api calls", String(a.totals.apiCalls)],
        ["tool calls", String(a.totals.toolCalls)],
        ["tokens", formatCount(totalTokens(a.totals.tokens))],
        ["duration", formatDuration(a.durationMs)],
        ["active time", formatDuration(a.totals.activeMs)],
        ["web search / fetch", `${a.totals.webSearches} / ${a.totals.webFetches}`],
        [
          "subagent (sidechain)",
          a.totals.sidechainApiCalls > 0
            ? `${formatUSD(a.totals.sidechainCost)} over ${a.totals.sidechainApiCalls} calls`
            : "none",
        ],
        [
          "test runs",
          a.testRuns > 0 ? `${a.testRuns} (${a.testFailures} failed)` : "none detected",
        ],
        ["tool-call churn", a.retries > 0 ? `${a.retries} repeated identical calls` : "none"],
      ],
    ),
  );

  lines.push(`\n${section("Cost by token category", options)}`);
  lines.push(
    table(
      ["category", "cost"],
      [
        ["input", formatUSD(a.totals.cost.input)],
        ["output", formatUSD(a.totals.cost.output)],
        ["cache write", formatUSD(a.totals.cost.cacheWrite)],
        ["cache read", formatUSD(a.totals.cost.cacheRead)],
      ],
    ),
  );

  const modelRows = Object.entries(a.models)
    .sort((x, y) => y[1].cost.total - x[1].cost.total)
    .map(([m, u]) => [m, String(u.apiCalls), formatUSD(u.cost.total)]);
  if (modelRows.length) {
    lines.push(`\n${section("Models", options)}`);
    lines.push(table(["model", "calls", "cost"], modelRows, { align: ["left", "right", "right"] }));
  }

  const toolRows = Object.entries(a.tools)
    .sort((x, y) => y[1] - x[1])
    .map(([t, c]) => [t, String(c)]);
  if (toolRows.length) {
    lines.push(`\n${section("Tools", options)}`);
    lines.push(table(["tool", "count"], toolRows, { align: ["left", "right"] }));
  }

  if (Object.keys(a.skills).length) {
    lines.push(
      `\nSkills: ${Object.entries(a.skills)
        .map(([s, n]) => `${s}:${n}`)
        .join(", ")}`,
    );
  }
  if (a.subagents.length) lines.push(`Subagents: ${a.subagents.join(", ")}`);
  if (a.filesTouched.length) lines.push(`Files touched: ${a.filesTouched.length}`);
  if (Object.keys(a.stopReasons).length) {
    lines.push(`Stop reasons: ${topEntries(a.stopReasons)}`);
  }
  const modeCount = Object.keys(a.permissionModes).length;
  // Worth a line only when something other than plain "default" shows up.
  if (modeCount > 1 || (modeCount === 1 && !a.permissionModes.default)) {
    lines.push(`Permission modes: ${topEntries(a.permissionModes)}`);
  }
  if (Object.keys(a.bashCommands).length) {
    lines.push(`Shell commands: ${topEntries(a.bashCommands, 8)}`);
  }

  lines.push(`\n${section("Turns", options)}`);
  lines.push(
    table(
      ["#", "cost", "calls", "tools", "prompt"],
      a.turns.map((t) => [
        String(t.index + 1),
        formatUSD(t.cost.total),
        String(t.apiCalls.length),
        String(Object.values(t.toolCounts).reduce((s, n) => s + n, 0)),
        truncate(t.prompt || "(no text)", 60),
      ]),
      { align: ["right", "right", "right", "right", "left"] },
    ),
  );

  return lines.join("\n");
}

/** The shared portfolio shape plus the CLI's terminal-only extras. */
export interface PortfolioView extends PortfolioStats {
  ttl: CacheTtlSplit;
  bash: BashCommandRow[];
  tests: TestRunSummary;
  retries: RetryStats;
  concurrency: { peak: number; parallelDayShare: number };
}

/** Render portfolio-wide or project-scoped analytics as a text report. */
export function renderStats(v: PortfolioView, options: RenderOptions = {}): string {
  const lines: string[] = [];
  const s = v.summary;
  const range = s.firstDay && s.lastDay ? `${s.firstDay} → ${s.lastDay}` : "-";
  const estPct = s.estimatedShare > 0 ? ` (${(s.estimatedShare * 100).toFixed(0)}% estimated)` : "";

  const d = v.duration;
  const dist = v.distribution;
  const rr = v.runRate;
  const sc = v.sidechain;
  const ioTokens = s.inputTokens + s.outputTokens;
  const cacheTokens = s.cacheWriteTokens + s.cacheReadTokens;
  lines.push(
    reportTitle(
      options.projectPath ? `cc-analyzer · ${options.projectPath}` : "cc-analyzer · portfolio",
      options,
    ),
  );
  const sessionCount = `${s.sessions} ${s.sessions === 1 ? "session" : "sessions"}`;
  const projectCount = `${s.projects} ${s.projects === 1 ? "project" : "projects"}`;
  const scopeSummary = options.projectPath
    ? `· ${sessionCount} · ${range}`
    : `· ${sessionCount} · ${projectCount} · ${range}`;
  lines.push(
    `${paint(options.color === true, ANSI.bold, `${formatUSD(s.cost)} total spend`)}  ` +
      muted(scopeSummary, options),
  );
  lines.push(
    muted(
      `${formatTokens(ioTokens, cacheTokens)} · ${formatDuration(d.totalActiveMs)} active ` +
        `(${(d.activeShare * 100).toFixed(0)}% of session time)`,
      options,
    ),
  );

  lines.push(`\n${section("Activity", options)}`);
  lines.push(
    table(
      ["metric", "value"],
      [
        ["pricing", estPct ? `${(s.estimatedShare * 100).toFixed(0)}% estimated` : "exact"],
        ["tokens (in/out)", `${formatCount(s.inputTokens)} / ${formatCount(s.outputTokens)}`],
        [
          "cache tokens (w/r)",
          `${formatCount(s.cacheWriteTokens)} / ${formatCount(s.cacheReadTokens)}`,
        ],
        [
          "time with claude",
          `${formatDuration(d.totalMs)} (${formatDuration(d.totalActiveMs)} active, ${(d.activeShare * 100).toFixed(0)}%)`,
        ],
        [
          "session duration",
          `median ${formatDuration(d.medianMs)} · p90 ${formatDuration(d.p90Ms)}`,
        ],
        [
          "session cost",
          `median ${formatUSD(dist.p50)} · p90 ${formatUSD(dist.p90)} · p99 ${formatUSD(dist.p99)}`,
        ],
        [
          "spend concentration",
          dist.topDecileShare !== null
            ? `top 10% of sessions carry ${(dist.topDecileShare * 100).toFixed(0)}% of spend`
            : "n/a (fewer than 10 sessions)",
        ],
        [
          "streaks",
          `${v.streaks.currentStreak}d current · ${v.streaks.longestStreak}d longest · ${v.streaks.last30ActiveDays}/30 days active`,
        ],
        [
          `run rate (${rr.month})`,
          `${formatUSD(rr.monthToDate)} to date → ~${formatUSD(rr.projected)} projected (prev month ${formatUSD(rr.prevMonthTotal)})`,
        ],
      ],
    ),
  );

  lines.push(`\n${section("Efficiency & reliability", options)}`);
  lines.push(
    table(
      ["signal", "value"],
      [
        [
          "subagent spend",
          sc.cost > 0
            ? `${formatUSD(sc.cost)} (${(sc.share * 100).toFixed(0)}% of total, ${formatCount(sc.calls)} calls)`
            : "none",
        ],
        [
          "cache write TTL",
          `${formatCount(v.ttl.write5mTokens)} @5m / ${formatCount(v.ttl.write1hTokens)} @1h`,
        ],
        [
          "test runs",
          v.tests.runs > 0
            ? `${v.tests.runs} (${(v.tests.failureRate * 100).toFixed(0)}% failed, ${v.tests.sessions} sessions)`
            : "none detected",
        ],
        [
          "tool-call churn",
          v.retries.total > 0
            ? `${v.retries.total} repeated identical calls in ${v.retries.sessions} ${
                v.retries.sessions === 1 ? "session" : "sessions"
              }`
            : "none",
        ],
        [
          "parallel sessions",
          `peak ${v.concurrency.peak} · ${(v.concurrency.parallelDayShare * 100).toFixed(0)}% of days overlapped`,
        ],
      ],
    ),
  );

  if (dist.buckets.some((b) => b.count > 0)) {
    lines.push(`\n${section("Session cost distribution", options)}`);
    const maxCount = Math.max(...dist.buckets.map((b) => b.count), 1);
    lines.push(
      table(
        ["bucket", "sessions", ""],
        dist.buckets.map((b) => [
          b.label,
          String(b.count),
          "█".repeat(Math.round((b.count / maxCount) * 24)),
        ]),
        { align: ["left", "right", "left"] },
      ),
    );
  }

  if (v.byMonth.length) {
    lines.push(`\n${section("Spend by month", options)}`);
    lines.push(
      table(
        ["month", "cost", "sessions", "tokens"],
        v.byMonth.map((m) => [
          m.month,
          formatUSD(m.cost),
          String(m.sessions),
          formatTokens(m.ioTokens, m.cacheTokens),
        ]),
        { align: ["left", "right", "right", "right"] },
      ),
    );
  }

  if (v.byProject.length) {
    lines.push(`\n${section("Top projects by cost", options)}`);
    lines.push(
      table(
        ["cost", "tokens", "sessions", "project"],
        v.byProject.map((p) => [
          formatUSD(p.cost),
          formatTokens(p.ioTokens, p.cacheTokens),
          String(p.sessions),
          truncate(p.projectPath ?? p.projectId, 52),
        ]),
        { align: ["right", "right", "right", "left"] },
      ),
    );
  }

  if (v.byModel.length) {
    lines.push(`\n${section("Spend by model", options)}`);
    lines.push(
      table(
        ["model", "calls", "cost", "tokens"],
        v.byModel.map((m) => [
          m.model,
          formatCount(m.calls),
          formatUSD(m.cost),
          formatTokens(m.ioTokens, m.cacheTokens),
        ]),
        { align: ["left", "right", "right", "right"] },
      ),
    );
  }

  if (v.top.length) {
    lines.push(`\n${section("Most expensive sessions", options)}`);
    lines.push(
      table(
        ["cost", "tokens", "date", "title"],
        v.top.map((t) => [
          formatUSD(t.cost),
          formatTokens(t.ioTokens, t.cacheTokens),
          t.startTime?.slice(0, 10) ?? "-",
          truncate(t.title ?? t.sessionId ?? "?", 48),
        ]),
        { align: ["right", "right", "left", "left"] },
      ),
    );
  }

  if (v.bash.length) {
    lines.push(`\n${section("Top shell commands", options)}`);
    lines.push(
      table(
        ["command", "uses", "err %", "sessions"],
        v.bash.map((b) => [
          b.command,
          formatCount(b.uses),
          `${(b.errorRate * 100).toFixed(1)}%`,
          String(b.sessions),
        ]),
        { align: ["left", "right", "right", "right"] },
      ),
    );
  }

  if (v.retries.byTool.length) {
    lines.push(`\n${section("Most retried tools", options)}`);
    lines.push(
      table(
        ["tool", "retries", "sessions"],
        v.retries.byTool.slice(0, 8).map((r) => [r.tool, String(r.retries), String(r.sessions)]),
        { align: ["left", "right", "right"] },
      ),
    );
    lines.push(muted("Identical consecutive calls on the same chain.", options));
  }

  lines.push(`\n${healthy("✓ Read-only · session data stayed local", options)}`);
  lines.push(muted("Explore interactively: cc-analyzer", options));

  return lines.join("\n");
}
