import type { SessionAnalysis } from "../core/analyze.ts";
import type { TokenCounts } from "../core/pricing.ts";
import type {
  BashCommandRow,
  CacheTtlSplit,
  CostDistribution,
  DurationSummary,
  ModelRow,
  MonthRow,
  PortfolioSummary,
  ProjectRow,
  RetryStats,
  RunRate,
  SessionRankRow,
  SidechainSummary,
  StreakSummary,
  TestRunSummary,
} from "../core/stats.ts";
import { formatCount, formatDuration, formatTokens, formatUSD, table, truncate } from "./format.ts";

function totalTokens(t: TokenCounts): number {
  return (
    t.inputTokens + t.outputTokens + t.cacheWrite5mTokens + t.cacheWrite1hTokens + t.cacheReadTokens
  );
}

/** Render a full single-session analysis as a text report. */
export function renderSessionSummary(a: SessionAnalysis): string {
  const lines: string[] = [];
  const est = a.totals.cost.estimated ? " (estimated)" : "";

  lines.push(`\n${a.title ?? "(untitled session)"}`);
  lines.push(`  ${a.sessionId ?? "?"}  ·  ${a.projectPath ?? "?"}`);
  if (a.gitBranches.length) lines.push(`  branch: ${a.gitBranches.join(", ")}`);
  if (a.versions.length) lines.push(`  cc version: ${a.versions.join(", ")}`);

  lines.push("\nTotals");
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

  lines.push("\nCost by token category");
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
    lines.push("\nModels");
    lines.push(table(["model", "calls", "cost"], modelRows));
  }

  const toolRows = Object.entries(a.tools)
    .sort((x, y) => y[1] - x[1])
    .map(([t, c]) => [t, String(c)]);
  if (toolRows.length) {
    lines.push("\nTools");
    lines.push(table(["tool", "count"], toolRows));
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
    lines.push(
      `Stop reasons: ${Object.entries(a.stopReasons)
        .sort((x, y) => y[1] - x[1])
        .map(([r, n]) => `${r}:${n}`)
        .join(", ")}`,
    );
  }
  const modeEntries = Object.entries(a.permissionModes);
  // Worth a line only when something other than plain "default" shows up.
  if (modeEntries.length > 0 && (modeEntries.length > 1 || !a.permissionModes.default)) {
    lines.push(
      `Permission modes: ${modeEntries
        .sort((x, y) => y[1] - x[1])
        .map(([m, n]) => `${m}:${n}`)
        .join(", ")}`,
    );
  }
  if (Object.keys(a.bashCommands).length) {
    lines.push(
      `Shell commands: ${Object.entries(a.bashCommands)
        .sort((x, y) => y[1] - x[1])
        .slice(0, 8)
        .map(([c, n]) => `${c}:${n}`)
        .join(", ")}`,
    );
  }

  lines.push("\nTurns");
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
    ),
  );

  return lines.join("\n");
}

export interface PortfolioView {
  summary: PortfolioSummary;
  byMonth: MonthRow[];
  byProject: ProjectRow[];
  byModel: ModelRow[];
  top: SessionRankRow[];
  duration: DurationSummary;
  distribution: CostDistribution;
  streaks: StreakSummary;
  runRate: RunRate;
  sidechain: SidechainSummary;
  ttl: CacheTtlSplit;
  bash: BashCommandRow[];
  tests: TestRunSummary;
  retries: RetryStats;
  concurrency: { peak: number; parallelDayShare: number };
}

/** Render portfolio-wide analytics as a text report. */
export function renderStats(v: PortfolioView): string {
  const lines: string[] = [];
  const s = v.summary;
  const range = s.firstDay && s.lastDay ? `${s.firstDay} → ${s.lastDay}` : "-";
  const estPct = s.estimatedShare > 0 ? ` (${(s.estimatedShare * 100).toFixed(0)}% estimated)` : "";

  const d = v.duration;
  const dist = v.distribution;
  const rr = v.runRate;
  const sc = v.sidechain;
  lines.push("\nPortfolio");
  lines.push(
    table(
      ["metric", "value"],
      [
        ["total cost", `${formatUSD(s.cost)}${estPct}`],
        ["sessions", String(s.sessions)],
        ["projects", String(s.projects)],
        ["date range", range],
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
          dist.topDecileShare > 0
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
            ? `${v.retries.total} repeated identical calls in ${v.retries.sessions} sessions`
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
    lines.push("\nSession cost distribution");
    const maxCount = Math.max(...dist.buckets.map((b) => b.count), 1);
    lines.push(
      table(
        ["bucket", "sessions", ""],
        dist.buckets.map((b) => [
          b.label,
          String(b.count),
          "#".repeat(Math.round((b.count / maxCount) * 30)),
        ]),
      ),
    );
  }

  if (v.byMonth.length) {
    lines.push("\nSpend by month");
    lines.push(
      table(
        ["month", "cost", "sessions", "tokens"],
        v.byMonth.map((m) => [
          m.month,
          formatUSD(m.cost),
          String(m.sessions),
          formatTokens(m.ioTokens, m.cacheTokens),
        ]),
      ),
    );
  }

  if (v.byProject.length) {
    lines.push("\nTop projects by cost");
    lines.push(
      table(
        ["cost", "tokens", "sessions", "project"],
        v.byProject.map((p) => [
          formatUSD(p.cost),
          formatTokens(p.ioTokens, p.cacheTokens),
          String(p.sessions),
          truncate(p.projectPath ?? p.projectId, 52),
        ]),
      ),
    );
  }

  if (v.byModel.length) {
    lines.push("\nSpend by model");
    lines.push(
      table(
        ["model", "calls", "cost", "tokens"],
        v.byModel.map((m) => [
          m.model,
          formatCount(m.calls),
          formatUSD(m.cost),
          formatTokens(m.ioTokens, m.cacheTokens),
        ]),
      ),
    );
  }

  if (v.top.length) {
    lines.push("\nMost expensive sessions");
    lines.push(
      table(
        ["cost", "tokens", "date", "title"],
        v.top.map((t) => [
          formatUSD(t.cost),
          formatTokens(t.ioTokens, t.cacheTokens),
          t.startTime?.slice(0, 10) ?? "-",
          truncate(t.title ?? t.sessionId ?? "?", 48),
        ]),
      ),
    );
  }

  if (v.bash.length) {
    lines.push("\nTop shell commands");
    lines.push(
      table(
        ["command", "uses", "err %", "sessions"],
        v.bash.map((b) => [
          b.command,
          formatCount(b.uses),
          `${(b.errorRate * 100).toFixed(1)}%`,
          String(b.sessions),
        ]),
      ),
    );
  }

  if (v.retries.byTool.length) {
    lines.push("\nMost retried tools (identical repeated calls)");
    lines.push(
      table(
        ["tool", "retries", "sessions"],
        v.retries.byTool.slice(0, 8).map((r) => [r.tool, String(r.retries), String(r.sessions)]),
      ),
    );
  }

  return lines.join("\n");
}
