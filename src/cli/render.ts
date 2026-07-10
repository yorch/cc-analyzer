import type { SessionAnalysis } from "../core/analyze.ts";
import type { TokenCounts } from "../core/pricing.ts";
import type {
  ModelRow,
  MonthRow,
  PortfolioSummary,
  ProjectRow,
  SessionRankRow,
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
        ["web search / fetch", `${a.totals.webSearches} / ${a.totals.webFetches}`],
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

  if (a.skills.length) lines.push(`\nSkills: ${a.skills.join(", ")}`);
  if (a.subagents.length) lines.push(`Subagents: ${a.subagents.join(", ")}`);
  if (a.filesTouched.length) lines.push(`Files touched: ${a.filesTouched.length}`);

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
}

/** Render portfolio-wide analytics as a text report. */
export function renderStats(v: PortfolioView): string {
  const lines: string[] = [];
  const s = v.summary;
  const range = s.firstDay && s.lastDay ? `${s.firstDay} → ${s.lastDay}` : "-";
  const estPct = s.estimatedShare > 0 ? ` (${(s.estimatedShare * 100).toFixed(0)}% estimated)` : "";

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
      ],
    ),
  );

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

  return lines.join("\n");
}
