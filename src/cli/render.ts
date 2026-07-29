import type { SessionAnalysis } from "../core/analyze.ts";
import { type CostBasis, costFramingNote, costNoun } from "../core/cost-framing.ts";
import type { IndexStatus } from "../core/index-status-types.ts";
import {
  PARSE_COVERAGE_MAX_UNPARSED_SHARE,
  PORTFOLIO_DIAGNOSTIC_CODES,
  type PortfolioDiagnostic,
} from "../core/portfolio-diagnostics.ts";
import type { TokenCounts } from "../core/pricing.ts";
import { buildSessionDiagnostics } from "../core/session-diagnostics.ts";
import { SETUP_AUDIT_CAVEAT, type SetupAudit } from "../core/setup-audit.ts";
import type {
  BashCommandRow,
  CacheTtlSplit,
  ContextTax,
  ParseCoverageSummary,
  PortfolioStats,
  RetryStats,
  TestRunSummary,
  WhatIfRepricing,
} from "../core/stats.ts";
import {
  CORRECTION_CAVEAT,
  type CorrectionStats,
  SKILL_COST_CAVEAT,
  type SkillUsageRow,
  THRASH_REREAD_MIN,
  THRASH_STREAK_MIN,
  topEntries,
} from "../core/stats-types.ts";
import {
  formatCount,
  formatDuration,
  formatRelativeTime,
  formatTokens,
  formatUSD,
  table,
  truncate,
} from "./format.ts";

export interface RenderOptions {
  color?: boolean;
  projectPath?: string;
  /** Display-only cost framing preference (`getCostBasis()`). Defaults to
   *  "api" (dollars read as a bill) when omitted. */
  costBasis?: CostBasis;
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
        // One corrections line when either counter fired; the shared
        // CORRECTION_CAVEAT prints right under the table.
        ...(a.correctionTurns > 0 || a.interruptionTurns > 0
          ? [
              [
                "corrections",
                [
                  a.correctionTurns > 0
                    ? `${a.correctionTurns} correction turn${a.correctionTurns === 1 ? "" : "s"}` +
                      (a.totals.turns > 0
                        ? ` (${Math.round((a.correctionTurns / a.totals.turns) * 100)}%)`
                        : "")
                    : "",
                  a.interruptionTurns > 0
                    ? `${a.interruptionTurns} interruption${a.interruptionTurns === 1 ? "" : "s"}`
                    : "",
                ]
                  .filter(Boolean)
                  .join(" · "),
              ],
            ]
          : []),
        // One thrash line, only when a signal is non-trivial (the "Actionable
        // diagnostics" section below carries the evidence and next step).
        ...(a.testFailStreak >= THRASH_STREAK_MIN || a.redundantReads >= THRASH_REREAD_MIN
          ? [
              [
                "thrash",
                [
                  a.testFailStreak >= THRASH_STREAK_MIN
                    ? `${a.testFailStreak} failing test runs in a row`
                    : "",
                  a.redundantReads >= THRASH_REREAD_MIN
                    ? `${a.redundantReads} redundant file reads`
                    : "",
                ]
                  .filter(Boolean)
                  .join(" · "),
              ],
            ]
          : []),
      ],
    ),
  );
  if (a.correctionTurns > 0 || a.interruptionTurns > 0) {
    lines.push(muted(CORRECTION_CAVEAT, options));
  }

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

  const skillEntries = Object.entries(a.skills).sort((x, y) => y[1] - x[1]);
  if (skillEntries.length) {
    lines.push(`\n${section("Skills", options)}`);
    lines.push(
      table(
        ["skill", "uses", "turns", "turn $"],
        skillEntries.map(([s, n]) => {
          const attributed = a.skillTurnCosts[s];
          return [s, String(n), String(attributed?.turns ?? 0), formatUSD(attributed?.cost ?? 0)];
        }),
        { align: ["left", "right", "right", "right"] },
      ),
    );
    lines.push(muted(SKILL_COST_CAVEAT, options));
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

  const diagnostics = buildSessionDiagnostics(a);
  lines.push(`\n${section("Actionable diagnostics", options)}`);
  if (diagnostics.length === 0) {
    lines.push(
      healthy("No notable context or cost patterns crossed the current thresholds.", options),
    );
  } else {
    for (const diagnostic of diagnostics) {
      lines.push(`${diagnostic.severity === "warning" ? "!" : "·"} ${diagnostic.title}`);
      lines.push(`  ${diagnostic.evidence}`);
      lines.push(muted(`  Next: ${diagnostic.action}`, options));
    }
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

/**
 * Render the setup audit: an inventory summary block, then the findings with
 * warnings first. The audit compares live config against historical sessions,
 * so the caveat line is part of the report, not decoration.
 */
export function renderSetupAudit(audit: SetupAudit, options: RenderOptions = {}): string {
  const lines: string[] = [];
  const c = audit.counts;
  const inv = audit.inventory;

  lines.push(reportTitle("cc-analyzer · setup audit", options));
  lines.push(muted(`${inv.claudeDir}${inv.present ? "" : " (not found)"}`, options));

  lines.push(`\n${section("Inventory", options)}`);
  const mcpScope =
    c.mcpServers > 0 ? ` (${c.mcpGlobal} global, ${c.mcpProject} project-scoped)` : "";
  lines.push(
    table(
      ["item", "installed"],
      [
        ["skills", String(c.skills)],
        ["subagents", String(c.agents)],
        [
          "plugins",
          c.plugins > 0 ? `${c.plugins} (${inv.plugins.map((p) => p.name).join(", ")})` : "0",
        ],
        ["mcp servers", `${c.mcpServers}${mcpScope}`],
        [
          "hooks",
          c.hooks > 0
            ? `${c.hooks} across ${c.hookEvents} ${c.hookEvents === 1 ? "event" : "events"}`
            : "0",
        ],
        [
          "permission rules",
          `${c.permissionAllow} allow · ${c.permissionDeny} deny · ${c.permissionAsk} ask`,
        ],
        ["model", inv.model ?? "(not pinned)"],
      ],
    ),
  );

  lines.push(`\n${section("Findings", options)}`);
  if (audit.findings.length === 0) {
    lines.push(
      healthy("Everything installed is in use, and nothing crossed a threshold.", options),
    );
  } else {
    for (const finding of audit.findings) {
      lines.push(`${finding.severity === "warning" ? "!" : "·"} ${finding.title}`);
      lines.push(`  ${finding.evidence}`);
      lines.push(muted(`  Next: ${finding.action}`, options));
    }
  }

  lines.push(`\n${muted(SETUP_AUDIT_CAVEAT, options)}`);
  return lines.join("\n");
}

/**
 * Render the portfolio insights: ranked findings from the bun-free rules
 * engine, warnings first, each with its observed evidence and next action —
 * the portfolio-wide sibling of the per-session "Actionable diagnostics".
 */
export function renderPortfolioInsights(
  diagnostics: PortfolioDiagnostic[],
  options: RenderOptions = {},
): string {
  const lines: string[] = [];
  const ruleCount = PORTFOLIO_DIAGNOSTIC_CODES.length;

  lines.push(reportTitle("cc-analyzer · portfolio insights", options));
  lines.push(muted("Named heuristics over the whole indexed portfolio — not a score.", options));

  lines.push(`\n${section("Findings", options)}`);
  if (diagnostics.length === 0) {
    lines.push(
      healthy(
        `No findings — the portfolio looks healthy by every rule (${ruleCount} rules checked).`,
        options,
      ),
    );
  } else {
    for (const diagnostic of diagnostics) {
      lines.push(`${diagnostic.severity === "warning" ? "!" : "·"} ${diagnostic.title}`);
      lines.push(`  ${diagnostic.evidence}`);
      const project = diagnostic.projectPath ?? diagnostic.projectId;
      if (project) lines.push(muted(`  Project: ${project}`, options));
      lines.push(muted(`  Next: ${diagnostic.action}`, options));
    }
    lines.push(
      muted(
        `\n${diagnostics.length} of ${ruleCount} rules fired. Drill into sessions with ` +
          "`cc-analyzer analyze <id>` or the web app (`cc-analyzer serve`).",
        options,
      ),
    );
  }

  return lines.join("\n");
}

/**
 * One line of portfolio parse coverage for the freshness surfaces
 * (`cc-analyzer index --check`). Read straight off the indexed rows — no
 * session file is re-parsed to produce it.
 */
export function renderParseCoverageLine(c: ParseCoverageSummary): string {
  if (c.lines === 0) return "Parse coverage: no indexed lines yet.";
  const clean = ((1 - c.unparsedShare) * 100).toFixed(1);
  const tail =
    c.unparsedShare >= PARSE_COVERAGE_MAX_UNPARSED_SHARE
      ? " — run `cc-analyzer update`; the session format may have moved ahead of this parser."
      : "";
  return (
    `Parse coverage: ${clean}% of ${formatCount(c.lines)} indexed lines fully parsed ` +
    `(${formatCount(c.parseErrors)} unreadable, ${formatCount(c.unknownEvents)} unknown events)${tail}`
  );
}

/** The shared portfolio shape plus the CLI's terminal-only extras. */
export interface PortfolioView extends PortfolioStats {
  index: IndexStatus;
  ttl: CacheTtlSplit;
  bash: BashCommandRow[];
  skills: SkillUsageRow[];
  tests: TestRunSummary;
  retries: RetryStats;
  corrections: CorrectionStats;
  concurrency: { peak: number; parallelDayShare: number };
  contextTax: ContextTax;
  whatIf: WhatIfRepricing;
  costBasis: CostBasis;
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
  const costBasis = options.costBasis ?? "api";
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
    `${paint(options.color === true, ANSI.bold, `${formatUSD(s.cost)} total, est. cost (API rates)`)}  ` +
      muted(scopeSummary, options),
  );
  lines.push(
    muted(
      `${formatTokens(ioTokens, cacheTokens)} · ${formatDuration(d.totalActiveMs)} active ` +
        `(${(d.activeShare * 100).toFixed(0)}% of session time)`,
      options,
    ),
  );
  const refreshed = v.index.lastRefreshedAt
    ? formatRelativeTime(Date.parse(v.index.lastRefreshedAt))
    : "unknown";
  lines.push(
    v.index.stale
      ? paint(
          options.color === true,
          ANSI.amber,
          `Index behind · ${v.index.added} new · ${v.index.changed} changed · ` +
            `${v.index.deleted} deleted · run cc-analyzer index`,
        )
      : muted(`Index refreshed ${refreshed}`, options),
  );
  const framingNote = costFramingNote(costBasis);
  if (framingNote) lines.push(muted(framingNote, options));

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
          `${formatUSD(rr.monthToDate)} to date → ~${formatUSD(rr.projected)} projected ` +
            `${costNoun(costBasis)} (prev month ${formatUSD(rr.prevMonthTotal)})`,
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
          "corrections",
          v.corrections.correctionTurns > 0 || v.corrections.interruptionTurns > 0
            ? `${formatCount(v.corrections.correctionTurns)} correction turns ` +
              `(${(v.corrections.correctionShare * 100).toFixed(0)}% of ${formatCount(v.corrections.turns)} turns) · ` +
              `${formatCount(v.corrections.interruptionTurns)} interrupted`
            : "none detected",
        ],
        [
          "parallel sessions",
          `peak ${v.concurrency.peak} · ${(v.concurrency.parallelDayShare * 100).toFixed(0)}% of days overlapped`,
        ],
      ],
    ),
  );
  if (v.corrections.correctionTurns > 0 || v.corrections.interruptionTurns > 0) {
    lines.push(muted(CORRECTION_CAVEAT, options));
  }

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

  if (v.whatIf.rows.length && v.whatIf.rows.some((r) => r.alternatives.length)) {
    const w = v.whatIf;
    lines.push(`\n${section("What-if · same tokens, other model's rates", options)}`);
    lines.push(
      table(
        ["model", "alternative", "repriced", "delta"],
        w.rows.flatMap((r) =>
          r.alternatives.map((a) => [
            r.model,
            a.model,
            formatUSD(a.cost),
            `${a.delta < 0 ? "-" : "+"}${formatUSD(Math.abs(a.delta))}`,
          ]),
        ),
        { align: ["left", "left", "right", "right"] },
      ),
    );
    if (w.summary.bestModel && w.summary.bestDelta < 0) {
      lines.push(
        muted(
          `All of it on ${w.summary.bestModel}: ${formatUSD(w.summary.bestCost)} vs ` +
            `${formatUSD(w.summary.actualCost)} actual (${formatUSD(-w.summary.bestDelta)} lower).`,
          options,
        ),
      );
    }
    if (w.summary.fallbackAlternatives) {
      lines.push(
        muted(
          "Fewer than two priceable models used — compared against one model per family.",
          options,
        ),
      );
    }
    lines.push(
      muted(
        "Your actual token mix at other rates. A different model would produce different " +
          "tokens, and quality is not priced in.",
        options,
      ),
    );
  }

  if (v.contextTax.summary.sessions > 0) {
    const ct = v.contextTax;
    lines.push(`\n${section("Context tax · tokens before you type", options)}`);
    lines.push(
      table(
        ["median", "p90", "avg", "sessions", "project"],
        ct.byProject
          .slice(0, 10)
          .map((p) => [
            formatCount(Math.round(p.medianTokens)),
            formatCount(Math.round(p.p90Tokens)),
            formatCount(Math.round(p.avgTokens)),
            String(p.sessions),
            truncate(p.projectPath ?? p.projectId, 44),
          ]),
        { align: ["right", "right", "right", "right", "left"] },
      ),
    );
    lines.push(
      muted(
        `Portfolio median ${formatCount(Math.round(ct.summary.medianTokens))} · ` +
          `p90 ${formatCount(Math.round(ct.summary.p90Tokens))} over ${ct.summary.sessions} ` +
          `${ct.summary.sessions === 1 ? "session" : "sessions"}. ` +
          "First main-chain call's prompt side: system prompt + CLAUDE.md + MCP tool schemas.",
        options,
      ),
    );
    lines.push(
      muted(
        "Heuristic: continuation sessions and big opening pastes inflate it — read the median.",
        options,
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

  if (v.skills.length) {
    lines.push(`\n${section("Skills · cost of the turns that invoked them", options)}`);
    lines.push(
      table(
        ["skill", "invoc", "turns", "turn $", "session $", "err %"],
        v.skills.map((s) => [
          truncate(s.name, 28),
          formatCount(s.invocations),
          formatCount(s.attributedTurns),
          formatUSD(s.attributedCost),
          formatUSD(s.totalCost),
          `${(s.errorRate * 100).toFixed(1)}%`,
        ]),
        { align: ["left", "right", "right", "right", "right", "right"] },
      ),
    );
    lines.push(muted(SKILL_COST_CAVEAT, options));
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
