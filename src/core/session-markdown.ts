/**
 * Session markdown + HTML export — the shareable per-session artifact.
 *
 * Bun-free and pure (like `digest.ts` / `stats-types.ts`) so the CLI,
 * the web SPA's "Copy as Markdown" button, and the HTML download can
 * all call the same builder and never drift. The digest's
 * `buildDigestMarkdown` proved the pattern; this is its per-session
 * sibling.
 */

import type { SessionAnalysis } from "./analyze.ts";
import {
  buildBurnSeries,
  buildCacheSeries,
  buildContextSeries,
  burstAttributionNote,
  groupSidechainBursts,
  modelMixRows,
  projectHeadroom,
  turnFlags,
} from "./chart-series.ts";
import { type CostBasis, costFramingNote, costNoun } from "./cost-framing.ts";
import { formatCount, formatDuration, formatSignedUSD, formatUSD, pct } from "./format-shared.ts";
import { buildSessionDiagnostics } from "./session-diagnostics.ts";
import type { SessionHealthReport } from "./session-health.ts";
import { OUTCOME_CAVEAT, outcomeRows, sessionOutcomes } from "./session-insights.ts";
import type { SessionCostRank, WhatIfRepricing } from "./stats-types.ts";
import { CORRECTION_CAVEAT, SKILL_COST_CAVEAT, WHATIF_CAVEAT } from "./stats-types.ts";
import type { TranscriptItem } from "./transcript.ts";

// ---------------------------------------------------------------------------
// Markdown helpers (same shape as digest.ts so paste quality matches)
// ---------------------------------------------------------------------------

const mdRow = (cells: string[]): string => `| ${cells.join(" | ")} |`;

function mdTable(headers: string[], align: ("left" | "right")[], rows: string[][]): string {
  const sep = headers.map((_, i) => (align[i] === "right" ? "---:" : "---"));
  return [mdRow(headers), mdRow(sep), ...rows.map(mdRow)].join("\n");
}

const mdCell = (s: string): string => s.replaceAll("|", "\\|");
const mdEscape = (s: string): string =>
  s.replaceAll("|", "\\|").replaceAll("\n", " ").replaceAll("\r", "");

export function sanitizeFilename(s: string): string {
  return (
    s
      .replaceAll(/[^a-zA-Z0-9_-]/g, "-")
      .replaceAll(/-+/g, "-")
      .replaceAll(/^-|-$/g, "")
      .slice(0, 80) || "session"
  );
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface SessionMarkdownOptions {
  /** Display-only cost framing (`api` default). Never changes the numbers. */
  costBasis?: CostBasis;
  /** Session-scoped what-if (computed by caller — needs the pricing table). */
  whatIf?: WhatIfRepricing;
  /** Health report from `inspectSessionHealth` — merged into the export. */
  health?: SessionHealthReport;
  /** Rank payload from `sessionCostRank` (needs the index). */
  rank?: SessionCostRank | null;
  /** Hide prompt / transcript text for external sharing. */
  redact?: boolean;
  /** Append full transcript appendix. Off by default (size warning). */
  includeTranscript?: boolean;
  /** Transcript items when `includeTranscript` is true. */
  transcript?: TranscriptItem[];
  /** Project display name override (already resolved by caller). */
  projectLabel?: string;
}

// ---------------------------------------------------------------------------
// Markdown builder
// ---------------------------------------------------------------------------

export function buildSessionMarkdown(
  a: SessionAnalysis,
  opts: SessionMarkdownOptions = {},
): string {
  const out: string[] = [];
  const redact = opts.redact === true;
  const costBasis = opts.costBasis ?? "api";
  const framing = costFramingNote(costBasis);

  // Header
  const rawTitle = a.title ?? "(untitled session)";
  const title = redact ? "[redacted]" : rawTitle;
  out.push(`# Session: ${mdEscape(title)}`);
  out.push("");
  const idLine = a.sessionId ? `\`${mdEscape(a.sessionId)}\`` : "(no session id)";
  const rawProj = opts.projectLabel ?? a.projectPath ?? "(unknown project)";
  const proj = redact ? "[redacted]" : rawProj;
  out.push(`**Session** ${idLine} · **Project** ${mdEscape(proj)}`);
  if (a.startTime || a.endTime) {
    const s = a.startTime?.slice(0, 19).replace("T", " ") ?? "?";
    const e = a.endTime?.slice(0, 19).replace("T", " ") ?? "?";
    out.push(`**Window** ${s} → ${e}`);
  }
  if (!redact) {
    if (a.gitBranches.length) out.push(`**Branch** ${a.gitBranches.map(mdEscape).join(", ")}`);
    if (a.versions.length) out.push(`**Claude Code** ${a.versions.join(", ")}`);
  }
  if (a.durationMs !== undefined)
    out.push(
      `**Duration** ${formatDuration(a.durationMs)} wall · ${formatDuration(a.totals.activeMs)} active`,
    );
  out.push("");
  if (framing) {
    out.push(`_${framing}_`);
    out.push("");
  }
  if (redact) {
    out.push(`> _Redacted export — prompt and transcript text hidden for sharing._`);
    out.push("");
  }

  // Overview
  const c = a.totals.cost;
  const t = a.totals.tokens;
  const est = c.estimated ? " (estimated)" : "";
  out.push("## Overview");
  out.push("");
  const rank = opts.rank;
  const rankLine = (() => {
    if (!rank) return undefined;
    // pick cohort like Session.tsx does
    const p = rank.project;
    const pf = rank.portfolio;
    if (p && p.sessions >= 5)
      return `p${p.pct} of ${p.sessions} project sessions · p${pf.pct} of ${pf.sessions} overall`;
    if (pf.sessions >= 5) return `p${pf.pct} of ${pf.sessions} sessions`;
    return undefined;
  })();

  out.push(
    mdTable(
      ["Metric", "Value"],
      ["left", "right"],
      [
        [costNoun(costBasis), `${formatUSD(c.total)}${est}`],
        ["Turns", String(a.totals.turns)],
        ["API calls", String(a.totals.apiCalls)],
        ["Tool calls", String(a.totals.toolCalls)],
        [
          "Tokens (in / out / cache)",
          `${formatCount(t.inputTokens)} / ${formatCount(t.outputTokens)} / ${formatCount(t.cacheWrite5mTokens + t.cacheWrite1hTokens + t.cacheReadTokens)}`,
        ],
        ["Web search / fetch", `${a.totals.webSearches} / ${a.totals.webFetches}`],
        [
          "Subagents",
          a.totals.sidechainApiCalls > 0
            ? `${formatUSD(a.totals.sidechainCost)} over ${a.totals.sidechainApiCalls} calls`
            : "none",
        ],
        [
          "Duration",
          `${formatDuration(a.durationMs)} wall / ${formatDuration(a.totals.activeMs)} active`,
        ],
        ...(rankLine ? [["Cost rank", rankLine] as string[]] : []),
      ],
    ),
  );
  out.push("");

  // Diagnostics
  const diagnostics = buildSessionDiagnostics(a);
  out.push("## Actionable diagnostics");
  out.push("");
  if (diagnostics.length === 0) {
    out.push("No notable context or cost patterns crossed the current thresholds.");
  } else {
    for (const d of diagnostics) {
      out.push(
        `- **${d.severity === "warning" ? "!" : "·"} ${mdEscape(d.title)}** — ${mdEscape(d.evidence)}`,
      );
      out.push(`  - Next: ${mdEscape(d.action)}`);
    }
  }
  out.push("");

  // Health
  if (opts.health) {
    const h = opts.health;
    const symbol = h.status === "healthy" ? "✓" : h.status === "damaged" ? "✗" : "!";
    out.push("## Health");
    out.push("");
    out.push(
      `${symbol} **${h.status}** · ${h.events} events · ${h.parseErrors} parse errors · ${h.unknownEvents} unknown events`,
    );
    out.push("");
    if (h.findings.length === 0) {
      out.push("No structural health problems were detected.");
    } else {
      for (const f of h.findings) {
        out.push(
          `- **${f.severity === "error" ? "✗" : "!"} ${mdEscape(f.title)}** — ${mdEscape(f.evidence)}`,
        );
        out.push(`  - Next: ${mdEscape(f.action)}`);
      }
    }
    out.push("");
    out.push("_Read-only check · no Claude Code files were changed._");
    out.push("");
  }

  // Cost breakdown
  out.push("## Cost breakdown");
  out.push("");
  out.push(
    mdTable(
      ["Category", "Cost"],
      ["left", "right"],
      [
        ["Input", formatUSD(c.input)],
        ["Output", formatUSD(c.output)],
        ["Cache write", formatUSD(c.cacheWrite)],
        ["Cache read", formatUSD(c.cacheRead)],
        ["**Total**", `**${formatUSD(c.total)}**`],
      ],
    ),
  );
  out.push("");
  out.push(
    mdTable(
      ["Token kind", "Count"],
      ["left", "right"],
      [
        ["Input", formatCount(t.inputTokens)],
        ["Output", formatCount(t.outputTokens)],
        ["Cache write 5m", formatCount(t.cacheWrite5mTokens)],
        ["Cache write 1h", formatCount(t.cacheWrite1hTokens)],
        ["Cache read", formatCount(t.cacheReadTokens)],
      ],
    ),
  );
  out.push("");

  // Cost per outcome
  const outcomes = outcomeRows(sessionOutcomes(a));
  if (outcomes.length > 0) {
    out.push("## Cost per outcome");
    out.push("");
    out.push(
      mdTable(
        ["Unit", "Cost"],
        ["left", "right"],
        outcomes.map((r) => [mdCell(r.label), formatUSD(r.cost)]),
      ),
    );
    out.push("");
    out.push(`_${OUTCOME_CAVEAT}_`);
    out.push("");
  }

  // What-if repricing
  const whatIf = opts.whatIf;
  if (whatIf && whatIf.rows.length > 0 && whatIf.summary.bestModel) {
    const s = whatIf.summary;
    out.push("## What-if repricing");
    out.push("");
    out.push(
      mdTable(
        ["Model", "Cost", "Cheapest alternative", "At rate"],
        ["left", "right", "left", "right"],
        whatIf.rows.map((r) => {
          const alt = r.alternatives[0];
          return [
            mdCell(r.model),
            formatUSD(r.cost),
            alt ? mdCell(alt.model) : "—",
            alt ? formatUSD(alt.cost) : "—",
          ];
        }),
      ),
    );
    out.push("");
    out.push(
      // biome-ignore lint/style/noNonNullAssertion: guarded by whatIf.summary.bestModel check
      `Cheapest single model: **${mdEscape(s.bestModel!)}** at ${formatUSD(s.bestCost)} ` +
        `(${formatSignedUSD(s.bestDelta)} vs actual ${formatUSD(s.actualCost)}` +
        `${s.fallbackAlternatives ? ", stock alternatives" : ""}).`,
    );
    out.push("");
    out.push(`_${WHATIF_CAVEAT}_`);
    out.push("");
  }

  // Models
  const modelRows = Object.entries(a.models).sort((x, y) => y[1].cost.total - x[1].cost.total);
  if (modelRows.length > 0) {
    out.push("## Models");
    out.push("");
    out.push(
      mdTable(
        ["Model", "Calls", "Cost"],
        ["left", "right", "right"],
        modelRows.map(([m, u]) => [mdCell(m), String(u.apiCalls), formatUSD(u.cost.total)]),
      ),
    );
    out.push("");
    const mix = modelMixRows(a);
    if (mix.length > 1) {
      out.push(`Mix: ${mix.map((r) => `${mdEscape(r.model)} ${pct(r.share)}`).join(" · ")}`);
      out.push("");
    }
  }

  // Tools — per-tool counts with error rate (session-level breakdown)
  const toolRows = Object.entries(a.tools).sort((x, y) => y[1] - x[1]);
  if (toolRows.length > 0) {
    out.push("## Tools");
    out.push("");
    out.push(
      mdTable(
        ["Tool", "Count", "Errors", "Err %"],
        ["left", "right", "right", "right"],
        toolRows.map(([k, v]) => {
          const errs = a.toolErrors[k] ?? 0;
          const pct = v > 0 ? `${Math.round((errs / v) * 100)}%` : "0%";
          return [mdCell(k), String(v), String(errs), pct];
        }),
      ),
    );
    out.push("");
  }

  // Skills — per-skill uses, turn-scoped cost, and error rate (session-level breakdown)
  const skillEntries = Object.entries(a.skills).sort((x, y) => y[1] - x[1]);
  if (skillEntries.length > 0) {
    out.push("## Skills");
    out.push("");
    out.push(
      mdTable(
        ["Skill", "Uses", "Turns", "Turn $", "Errors", "Err %"],
        ["left", "right", "right", "right", "right", "right"],
        skillEntries.map(([s, n]) => {
          const attr = a.skillTurnCosts[s];
          const errs = a.skillErrors[s] ?? 0;
          const errPct = n > 0 ? `${Math.round((errs / n) * 100)}%` : "0%";
          return [
            mdCell(s),
            String(n),
            String(attr?.turns ?? 0),
            formatUSD(attr?.cost ?? 0),
            String(errs),
            errPct,
          ];
        }),
      ),
    );
    out.push("");
    out.push(`_${SKILL_COST_CAVEAT}_`);
    out.push("");
  }

  // Subagent bursts
  if (a.sidechainBursts.length > 0) {
    out.push("## Subagent bursts");
    out.push("");
    const roll = groupSidechainBursts(a.sidechainBursts);
    out.push(
      mdTable(
        ["Type", "Bursts", "Calls", "Cost"],
        ["left", "right", "right", "right"],
        roll.map((r) => [mdCell(r.type), String(r.bursts), String(r.apiCalls), formatUSD(r.cost)]),
      ),
    );
    out.push("");
    out.push(
      mdTable(
        ["#", "Type", "Turn", "Calls", "Cost"],
        ["right", "left", "right", "right", "right"],
        a.sidechainBursts.map((b, i) => [
          String(i + 1),
          mdCell(b.subagentType ?? "(unmatched)"),
          b.turnIndex !== undefined ? `#${b.turnIndex + 1}` : "—",
          String(b.apiCalls),
          formatUSD(b.cost),
        ]),
      ),
    );
    out.push("");
    const note = burstAttributionNote(a.sidechainBursts);
    if (note) {
      out.push(`_${mdEscape(note)}_`);
      out.push("");
    }
  }

  // Session facts
  const factLines: string[] = [];
  if (a.subagents.length)
    factLines.push(`**Subagent types:** ${a.subagents.map(mdEscape).join(", ")}`);
  if (!redact && a.filesTouched.length)
    factLines.push(
      `**Files touched (${a.filesTouched.length}):** ${a.filesTouched.slice(0, 20).map(mdEscape).join(", ")}${a.filesTouched.length > 20 ? " …" : ""}`,
    );
  else if (redact && a.filesTouched.length)
    factLines.push(`**Files touched:** ${a.filesTouched.length} (redacted)`);
  if (Object.keys(a.stopReasons).length)
    factLines.push(
      `**Stop reasons:** ${Object.entries(a.stopReasons)
        .sort((x, y) => y[1] - x[1])
        .map(([k, n]) => `${mdEscape(k)}:${n}`)
        .join(" · ")}`,
    );
  const modeCount = Object.keys(a.permissionModes).length;
  if (modeCount > 1 || (modeCount === 1 && !a.permissionModes.default))
    factLines.push(
      `**Permission modes:** ${Object.entries(a.permissionModes)
        .sort((x, y) => y[1] - x[1])
        .map(([k, n]) => `${mdEscape(k)}:${n}`)
        .join(" · ")}`,
    );
  if (!redact && Object.keys(a.bashCommands).length)
    factLines.push(
      `**Shell commands:** ${Object.entries(a.bashCommands)
        .sort((x, y) => y[1] - x[1])
        .slice(0, 8)
        .map(([k, n]) => `${mdEscape(k)}:${n}`)
        .join(" · ")}`,
    );
  else if (redact && Object.keys(a.bashCommands).length)
    factLines.push(`**Shell commands:** ${Object.keys(a.bashCommands).length} families (redacted)`);
  if (!redact && a.testRuns > 0)
    factLines.push(`**Test runs:** ${a.testRuns} (${a.testFailures} failed)`);
  if (a.retries > 0) factLines.push(`**Retries:** ${a.retries} repeated identical tool calls`);
  if (a.testFailStreak > 0) factLines.push(`**Test fail streak:** ${a.testFailStreak}`);
  if (a.redundantReads > 0)
    factLines.push(
      `**Redundant reads:** ${a.redundantReads}${a.rereadFiles.length ? ` (${a.rereadFiles.slice(0, 3).map(mdEscape).join(", ")})` : ""}`,
    );
  if (a.correctionTurns > 0 || a.interruptionTurns > 0) {
    const corr =
      a.correctionTurns > 0
        ? `${a.correctionTurns} correction turn${a.correctionTurns === 1 ? "" : "s"}${a.totals.turns ? ` (${Math.round((a.correctionTurns / a.totals.turns) * 100)}%)` : ""}`
        : "";
    const intr =
      a.interruptionTurns > 0
        ? `${a.interruptionTurns} interruption${a.interruptionTurns === 1 ? "" : "s"}`
        : "";
    factLines.push(`**Corrections:** ${[corr, intr].filter(Boolean).join(" · ")}`);
  }
  if (factLines.length > 0) {
    out.push("## Session facts");
    out.push("");
    for (const f of factLines) out.push(`- ${f}`);
    out.push("");
    if (a.correctionTurns > 0 || a.interruptionTurns > 0) {
      out.push(`_${CORRECTION_CAVEAT}_`);
      out.push("");
    }
  }

  // Compactions
  if (a.compactions.length > 0) {
    out.push("## Compactions");
    out.push("");
    out.push(
      mdTable(
        ["#", "Trigger", "Pre tokens", "Time", "Kind"],
        ["right", "left", "right", "left", "left"],
        a.compactions.map((c, i) => [
          String(i + 1),
          mdCell(c.trigger ?? "unknown"),
          c.preTokens !== undefined ? formatCount(c.preTokens) : "—",
          c.timestamp ? c.timestamp.slice(0, 19).replace("T", " ") : "—",
          c.isSidechain ? "sidechain" : c.inherited ? "inherited" : "main",
        ]),
      ),
    );
    out.push("");
  }

  // Turns — sampled when huge (same SAMPLE_CAP logic as charts) to avoid DOS
  out.push("## Turns");
  out.push("");
  if (a.turns.length === 0) {
    out.push("No turn timeline (aggregate mode or no real prompts).");
    out.push("");
  } else {
    const flagsNote =
      "Flags: interrupted · correction prompt · retries · failing tests · redundant reads · tool errors.";
    out.push(`_${flagsNote}_`);
    out.push("");
    const turnHeaders = ["#", "Cost", "Calls", "Tools", "Flags", "Prompt"];
    const turnAlign: ("left" | "right")[] = ["right", "right", "right", "right", "left", "left"];
    const TURNS_SAMPLE_CAP = 300;
    const tStep =
      a.turns.length > TURNS_SAMPLE_CAP ? Math.ceil(a.turns.length / TURNS_SAMPLE_CAP) : 1;
    const sampledTurns = a.turns.filter((_, i) => i % tStep === 0);
    out.push(
      mdTable(
        turnHeaders,
        turnAlign,
        sampledTurns.map((t) => {
          const toolN = String(Object.values(t.toolCounts).reduce((s, n) => s + n, 0));
          const flags = turnFlags({
            index: t.index,
            cost: t.cost.total,
            costInput: t.cost.input,
            costOutput: t.cost.output,
            costCacheWrite: t.cost.cacheWrite,
            costCacheRead: t.cost.cacheRead,
            ioTokens: t.tokens.inputTokens + t.tokens.outputTokens,
            cacheTokens:
              t.tokens.cacheReadTokens + t.tokens.cacheWrite5mTokens + t.tokens.cacheWrite1hTokens,
            apiCalls: t.apiCalls.length,
            mainApiCalls: t.mainApiCalls,
            kindCounts: t.toolCounts,
            toolErrors: t.apiCalls.flatMap((c) => c.steps).filter((s) => s.status === "error")
              .length,
            interrupted: t.interrupted === true,
            correction: t.correction === true,
            retries: t.retries,
            testFailures: t.testFailures,
            redundantReads: t.redundantReads,
            prompt: t.prompt,
          }).join(" · ");
          const prompt = redact ? "[redacted]" : mdEscape(t.prompt.slice(0, 120)) || "(no text)";
          return [
            String(t.index + 1),
            formatUSD(t.cost.total),
            String(t.apiCalls.length),
            toolN,
            mdEscape(flags),
            prompt,
          ];
        }),
      ),
    );
    if (tStep > 1)
      out.push(
        `\n_Sampled 1/${tStep} of ${a.turns.length} turns for readability — full timeline in JSON export (capped)._`,
      );
    out.push("");
  }

  // Charts as data tables (context / cache / burn)
  const ctx = buildContextSeries(a);
  if (ctx.points.length > 0) {
    out.push("## Charts (as tables)");
    out.push("");
    out.push("### Context window per main-chain call");
    out.push("");
    if (ctx.contextLimit)
      out.push(
        `Window: ${formatCount(ctx.contextLimit)} tokens · peak ${formatCount(ctx.peakTokens)} (${pct(ctx.peakTokens / ctx.contextLimit)}).`,
      );
    else out.push(`Peak context: ${formatCount(ctx.peakTokens)} (window unknown).`);
    const headroom = projectHeadroom(ctx);
    if (headroom) {
      out.push(
        `Headroom: ~${headroom.callsToLimit} calls until full at +${formatCount(Math.round(headroom.perCallTokens))} / call since last compaction.`,
      );
    }
    out.push("");
    // Sampling: huge sessions would make a 10k-row markdown table unreadable.
    const SAMPLE_CAP = 300;
    const step = ctx.points.length > SAMPLE_CAP ? Math.ceil(ctx.points.length / SAMPLE_CAP) : 1;
    const sampled = ctx.points.filter((_, i) => i % step === 0);
    const cacheSeries = buildCacheSeries(ctx);
    out.push(
      mdTable(
        ["Call", "Turn", "Context", "Cached", "Hit %", "Cost"],
        ["right", "right", "right", "right", "right", "right"],
        sampled.map((p, i) => {
          const idx = i * step + 1;
          const cp = cacheSeries.points[i * step];
          return [
            String(idx),
            `#${p.turnIndex + 1}`,
            formatCount(p.contextTokens),
            formatCount(p.cachedTokens),
            cp ? `${cp.hitPct}%` : "—",
            formatUSD(p.cost),
          ];
        }),
      ),
    );
    if (step > 1)
      out.push(
        `\n_Sampled 1/${step} of ${ctx.points.length} calls for readability — full series in JSON export._`,
      );
    out.push("");
    out.push(
      `Cache hit: ${cacheSeries.hitPct}% token-weighted · ${cacheSeries.coldCalls} cold calls.`,
    );
    out.push("");

    // Burn series tail
    const burn = buildBurnSeries(a);
    if (burn.length > 0) {
      // biome-ignore lint/style/noNonNullAssertion: guarded by burn.length > 0
      const last = burn[burn.length - 1]!;
      out.push("### Cumulative cost");
      out.push("");
      out.push(
        `Total ${formatUSD(last.cost)} · sidechain ${formatUSD(last.sidechainCost)} over ${burn.length} calls.`,
      );
      out.push("");
      // Sampled burn table
      const bStep = burn.length > SAMPLE_CAP ? Math.ceil(burn.length / SAMPLE_CAP) : 1;
      const bSampled = burn.filter((_, i) => i % bStep === 0);
      out.push(
        mdTable(
          ["Call", "Cumulative", "Sidechain cum.", "This call", "Type"],
          ["right", "right", "right", "right", "left"],
          bSampled.map((p, i) => [
            String(i * bStep + 1),
            formatUSD(p.cost),
            formatUSD(p.sidechainCost),
            formatUSD(p.callCost),
            p.isSidechain ? "sidechain" : "main",
          ]),
        ),
      );
      if (bStep > 1) out.push(`\n_Sampled 1/${bStep} of ${burn.length} calls._`);
      out.push("");
    }
  }

  // Parse coverage
  if (a.parseCoverage) {
    const c = a.parseCoverage;
    const unparsed = c.parseErrors + c.unknownEvents;
    const share = c.lines > 0 ? unparsed / c.lines : 0;
    out.push("## Parse coverage");
    out.push("");
    out.push(
      `${formatCount(c.lines)} lines · ${c.parseErrors} unparseable · ${c.unknownEvents} unknown events · ${pct(1 - share)} clean.`,
    );
    if (share >= 0.01)
      out.push(`_Parser may be behind the Claude Code format — run \`cc-analyzer update\`._`);
    out.push("");
  }

  // Transcript appendix
  if (opts.includeTranscript) {
    out.push("## Transcript");
    out.push("");
    const items = opts.transcript ?? [];
    if (items.length === 0) {
      out.push("_No transcript loaded — pass the full session file to include it._");
      out.push("");
    } else {
      out.push(`_${items.length} items_`);
      if (redact) out.push("_Text redacted._");
      out.push("");
      // Cap appendix to avoid 50MB paste
      const TRANSCRIPT_CAP = 600;
      const shown = items.slice(0, TRANSCRIPT_CAP);
      for (const item of shown) {
        const body = redact ? "[redacted]" : (item.body || "(empty)").slice(0, 2000);
        const label = mdEscape(item.label);
        out.push(`### ${label}${item.isError ? " · ✗ error" : ""}`);
        out.push("");
        out.push("```");
        // Escape ``` inside body
        out.push(body.replaceAll("```", "\\`\\`\\`"));
        out.push("```");
        out.push("");
      }
      if (items.length > TRANSCRIPT_CAP) {
        out.push(
          `_… ${items.length - TRANSCRIPT_CAP} more items truncated — see JSON export for full transcript._`,
        );
        out.push("");
      }
    }
  } else {
    out.push("## Transcript");
    out.push("");
    out.push("_Omitted for shareability — pass `--include-transcript` to append it._");
    out.push("");
  }

  // Footer
  out.push("---");
  out.push("");
  out.push(`Generated by \`cc-analyzer analyze\` — ${new Date().toISOString().slice(0, 10)}.`);
  out.push("");
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// HTML builder — standalone single-file export
// ---------------------------------------------------------------------------

const HTML_STYLE = `
:root{
  --bg:#0f1115; --bg-card:#1a1d23; --bg-hover:#232730; --bg-elevated:#232730;
  --border:#2a2d35; --border-strong:#3a3d47; --border-subtle:rgba(255,255,255,0.06);
  --text:#e8eaed; --text-muted:#9aa0a6; --text-faint:#6b7280;
  --accent:#6c7bfe; --accent-bg:rgba(108,123,254,0.12); --accent-strong:#818cf8;
  --success:#34d399; --warning:#fbbf24; --danger:#f87171;
  --radius:12px; --radius-sm:8px; --radius-xs:6px;
  --font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, ui-sans-serif, system-ui, sans-serif;
  --font-mono: ui-monospace, "JetBrains Mono", "SF Mono", Menlo, monospace;
}
[data-theme="light"]{
  --bg:#f8f9fb; --bg-card:#ffffff; --bg-hover:#f3f4f6; --bg-elevated:#ffffff;
  --border:#e5e7eb; --border-strong:#d1d5db; --border-subtle:#f3f4f6;
  --text:#111827; --text-muted:#6b7280; --text-faint:#9ca3af;
  --accent:#4f46e5; --accent-bg:rgba(79,70,229,0.08); --accent-strong:#4338ca;
}
@media (prefers-color-scheme: light){
  :root:not([data-theme="dark"]){
    --bg:#f8f9fb; --bg-card:#ffffff; --border:#e5e7eb; --text:#111827; --text-muted:#6b7280;
  }
}
*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{margin:0;font:14px/1.6 var(--font-sans);color:var(--text);background:var(--bg);-webkit-font-smoothing:antialiased}
@media (prefers-reduced-motion: reduce){*{transition:none !important; scroll-behavior:auto !important}}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
h1{font-size:22px;line-height:1.25;font-weight:700;letter-spacing:-0.02em;margin:0 0 4px}
h2{font-size:15px;line-height:1.4;font-weight:600;letter-spacing:-0.01em;margin:28px 0 6px;color:var(--text);padding-bottom:8px;border-bottom:1px solid var(--border)}
h2 .kicker{display:block;font-size:11px;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;color:var(--text-faint);margin-bottom:4px}
h3{font-size:13px;font-weight:600;color:var(--text-muted);margin:20px 0 8px}
.wrap{max-width:1024px;margin:0 auto;padding:28px 24px}
@media (max-width:640px){.wrap{padding:20px 16px}}
.masthead{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:20px;padding-bottom:16px;border-bottom:1px solid var(--border)}
.masthead h1{margin:0}
.theme-toggle{appearance:none;border:1px solid var(--border);background:var(--bg-card);color:var(--text-muted);border-radius:999px;padding:6px 12px;font:12px var(--font-sans);cursor:pointer;display:inline-flex;align-items:center;gap:6px}
.theme-toggle:hover{background:var(--bg-hover);color:var(--text)}
.theme-toggle:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.ai-summary{background:var(--accent-bg);border:1px solid var(--border);border-left:3px solid var(--accent);border-radius:var(--radius);padding:14px 16px;margin:16px 0 20px;font-size:13.5px;line-height:1.6;color:var(--text)}
.ai-summary strong{color:var(--accent-strong)}
.kpi-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:14px;margin:16px 0 24px}
.kpi-card{background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius);padding:14px 16px}
.kpi-card .label{font-size:11px;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;color:var(--text-faint);margin-bottom:6px}
.kpi-card .value{font-size:20px;font-weight:700;letter-spacing:-0.02em;line-height:1.2;font-variant-numeric:tabular-nums}
.kpi-card .sub{font-size:12px;color:var(--text-muted);margin-top:4px;line-height:1.4}
.kpi-card .trend{font-size:11px;margin-top:6px}
.card{background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius);padding:16px;margin:12px 0}
.meta{color:var(--text-muted);font-size:12.5px;line-height:1.5}
.provenance{font-size:12px;color:var(--text-faint);margin-top:4px}
table{width:100%;border-collapse:collapse;font-size:13px;margin:10px 0 16px}
thead th{font-size:11px;font-weight:600;letter-spacing:0.05em;text-transform:uppercase;color:var(--text-muted);background:transparent;border:none;border-bottom:2px solid var(--border-strong);padding:8px 10px;text-align:left;white-space:nowrap}
thead th.num{text-align:right}
tbody td{padding:8px 10px;border:none;border-bottom:1px solid var(--border-subtle);vertical-align:top}
tbody tr:last-child td{border-bottom:none}
tbody tr:hover{background:var(--bg-hover)}
td.num{font-family:var(--font-mono);text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
th.num{text-align:right}
td .bar-wrap{position:relative}
td .bar{position:absolute;inset:2px 0; background:var(--accent-bg);border-radius:3px;pointer-events:none}
td .bar-val{position:relative}
.muted{color:var(--text-muted)}.warn{color:var(--warning)}.err{color:var(--danger)}.pill{display:inline-block;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:500;border:1px solid var(--border);background:var(--bg-card)}
pre{white-space:pre-wrap;word-break:break-word;background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-sm);padding:12px 14px;overflow:auto;font:12.5px/1.6 var(--font-mono)}
code{font-family:var(--font-mono);background:var(--bg-card);border:1px solid var(--border);padding:1px 5px;border-radius:4px;font-size:12px}
.kicker{font-size:11px;letter-spacing:0.06em;text-transform:uppercase;color:var(--text-faint);font-weight:600}
.tablewrap{overflow-x:auto;-webkit-overflow-scrolling:touch}
.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
@media print{
  :root{--bg:#fff;--bg-card:#fff;--text:#111827;--text-muted:#4b5563;--border:#e5e7eb;--border-subtle:#f3f4f6}
  body{font-size:10pt;max-width:none;background:#fff;color:#111}
  .wrap{max-width:none;padding:12px}
  .masthead{border-bottom:2px solid #111}
  .theme-toggle,.no-print{display:none !important}
  table,th,td,pre,.card,.kpi-card{border-color:#ddd}
  pre,.card,.kpi-card{background:#fff;box-shadow:none}
  details{display:block !important} details > *:not(summary){display:block !important}
  thead th{position:static}
  a{color:#111;text-decoration:none} a[href]::after{content:" (" attr(href) ")";font-size:8pt;color:#6b7280;word-break:break-all}
  table{page-break-inside:auto} tr{page-break-inside:avoid;page-break-after:auto} section{break-inside:avoid}
  @page{margin:16mm 12mm; size:A4}
}
`;

function escHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function buildAiSummary(a: SessionAnalysis, opts: SessionMarkdownOptions): string {
  const c = a.totals.cost.total;
  const turns = a.totals.turns;
  const dur = formatDuration(a.durationMs);
  const cachePct = (() => {
    const t = a.totals.tokens;
    const total =
      t.cacheReadTokens +
      t.cacheWrite5mTokens +
      t.cacheWrite1hTokens +
      t.inputTokens +
      t.outputTokens;
    return total > 0 ? Math.round((t.cacheReadTokens / total) * 100) : 0;
  })();
  const topTool = Object.entries(a.tools).sort((x, y) => y[1] - x[1])[0]?.[0] ?? "—";
  const diag = buildSessionDiagnostics(a);
  const warn = diag.filter((d) => d.severity === "warning").length;
  const framing = opts.costBasis === "subscription" ? "API-equivalent value" : "cost";
  let summary = `This session ${framing} <strong>${escHtml(formatUSD(c))}</strong> over <strong>${escHtml(dur)}</strong> across <strong>${turns} turns</strong>`;
  if (a.totals.toolCalls > 0)
    summary += ` and <strong>${a.totals.toolCalls} tool calls</strong> (top: ${escHtml(topTool)})`;
  summary += ".";
  if (diag.length > 0) {
    summary += ` Detected <strong>${diag.length} diagnostic${diag.length === 1 ? "" : "s"}</strong>${warn > 0 ? ` (${warn} warning${warn === 1 ? "" : "s"})` : ""} — `;
    summary += diag
      .slice(0, 2)
      .map((d) => escHtml(d.title))
      .join(", ");
    if (diag.length > 2) summary += ` +${diag.length - 2} more`;
    summary += ".";
  } else {
    summary += " No major cost or context patterns crossed thresholds.";
  }
  if (cachePct > 0) summary += ` Cache hit <strong>${cachePct}%</strong>.`;
  return summary;
}

function buildKpiCards(a: SessionAnalysis): string {
  const c = a.totals.cost;
  const t = a.totals.tokens;
  const cacheRead = t.cacheReadTokens;
  const cacheWrite = t.cacheWrite5mTokens + t.cacheWrite1hTokens;
  const totalCache = cacheRead + cacheWrite;
  const cacheHit =
    totalCache > 0 ? Math.round((cacheRead / (cacheRead + t.inputTokens + cacheWrite)) * 100) : 0;
  const models = Object.keys(a.models).join(", ") || "—";
  return `
  <div class="kpi-grid">
    <div class="kpi-card"><div class="label">Total ${a.totals.cost.estimated ? "(est.)" : ""} cost</div><div class="value">${escHtml(formatUSD(c.total))}</div><div class="sub">${escHtml(formatUSD(c.input))} in · ${escHtml(formatUSD(c.output))} out</div></div>
    <div class="kpi-card"><div class="label">Duration</div><div class="value">${escHtml(formatDuration(a.durationMs))}</div><div class="sub">${escHtml(formatDuration(a.totals.activeMs))} active · ${a.totals.turns} turns · ${a.totals.apiCalls} calls</div></div>
    <div class="kpi-card"><div class="label">Tokens</div><div class="value">${escHtml(formatCount(t.inputTokens + t.outputTokens))}</div><div class="sub">+${escHtml(formatCount(totalCache))} cache · ${escHtml(models)}</div></div>
    <div class="kpi-card"><div class="label">Cache hit</div><div class="value">${cacheHit}%</div><div class="sub">${escHtml(formatCount(cacheRead))} read · ${escHtml(formatCount(cacheWrite))} write</div></div>
  </div>`;
}

function mdToHtml(md: string): string {
  // Minimal markdown → HTML for the export (tables, headings, code fences).
  // Not a full parser — just enough for our known builder output.
  const lines = md.split("\n");
  const html: string[] = [];
  let i = 0;
  let inCode = false;
  let codeBuf: string[] = [];
  const flushCode = () => {
    if (codeBuf.length) {
      html.push(`<pre><code>${escHtml(codeBuf.join("\n"))}</code></pre>`);
      codeBuf = [];
    }
  };
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (line.startsWith("```")) {
      if (inCode) {
        inCode = false;
        flushCode();
      } else {
        inCode = true;
      }
      i++;
      continue;
    }
    if (inCode) {
      codeBuf.push(line);
      i++;
      continue;
    }
    if (line.startsWith("# ")) {
      html.push(`<h1>${escHtml(line.slice(2))}</h1>`);
    } else if (line.startsWith("## ")) {
      html.push(`<h2>${escHtml(line.slice(3))}</h2>`);
    } else if (line.startsWith("### ")) {
      html.push(`<h3>${escHtml(line.slice(4))}</h3>`);
    } else if (line.startsWith("| ")) {
      // Collect contiguous table lines
      const tableLines: string[] = [];
      while (i < lines.length && (lines[i]?.startsWith("| ") ?? false)) {
        // biome-ignore lint/style/noNonNullAssertion: guarded by while condition
        tableLines.push(lines[i]!);
        i++;
      }
      // tableLines[0]=header, [1]=separator, rest=rows
      if (tableLines.length >= 2) {
        // biome-ignore lint/style/noNonNullAssertion: guarded by length >= 2
        const headers = tableLines[0]!
          .split("|")
          .slice(1, -1)
          .map((s) => s.trim());
        // biome-ignore lint/style/noNonNullAssertion: guarded by length >= 2
        const aligns = tableLines[1]!
          .split("|")
          .slice(1, -1)
          .map((s) => (s.trim().includes(":") && s.trim().endsWith(":") ? ' class="num"' : ""));
        html.push("<table><thead><tr>");
        for (let idx = 0; idx < headers.length; idx++)
          // biome-ignore lint/style/noNonNullAssertion: aligns same length as headers
          html.push(`<th${aligns[idx] ?? ""}>${escHtml(headers[idx]! ?? "")}</th>`);
        html.push("</tr></thead><tbody>");
        for (let r = 2; r < tableLines.length; r++) {
          // biome-ignore lint/style/noNonNullAssertion: r < length
          const cells = tableLines[r]!.split("|")
            .slice(1, -1)
            .map((s) => s.trim());
          html.push("<tr>");
          for (let idx = 0; idx < cells.length; idx++)
            // biome-ignore lint/style/noNonNullAssertion: aligns length matches headers
            html.push(`<td${aligns[idx] ?? ""}>${escHtml(cells[idx]! ?? "")}</td>`);
          html.push("</tr>");
        }
        html.push("</tbody></table>");
      }
      continue;
    } else if (line.startsWith("- ")) {
      // Collect list block
      const items: string[] = [];
      while (i < lines.length && (lines[i]?.startsWith("- ") ?? false)) {
        // biome-ignore lint/style/noNonNullAssertion: guarded by while condition
        items.push(lines[i]!.slice(2));
        i++;
        // handle indented continuation line "  - Next:"
        if (i < lines.length && lines[i]?.startsWith("  - ")) {
          // biome-ignore format lint/style/noNonNullAssertion: guarded by if
          items[items.length - 1] += `<br><span class="muted">${escHtml(lines[i]!.slice(4))}</span>`;
          i++;
        }
      }
      html.push("<ul>");
      for (const it of items) html.push(`<li>${escHtml(it)}</li>`);
      html.push("</ul>");
      continue;
    } else if (line.startsWith("> ")) {
      html.push(`<blockquote class="muted">${escHtml(line.slice(2))}</blockquote>`);
    } else if (line === "---") {
      html.push("<hr>");
    } else if (line.trim() === "") {
      // skip — structure comes from block tags
    } else {
      // Paragraph — inline _italic_ and **bold** and `code`
      const p = escHtml(line)
        .replaceAll(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
        .replaceAll(/_(.+?)_/g, "<em>$1</em>")
        .replaceAll(/`(.+?)`/g, "<code>$1</code>");
      // flush standalone emphasis wrappers for caveats
      html.push(`<p>${p}</p>`);
    }
    i++;
  }
  flushCode();
  return html.join("\n");
}

export function buildSessionHtml(a: SessionAnalysis, opts: SessionMarkdownOptions = {}): string {
  const aiSummary = buildAiSummary(a, opts);
  const kpiCards = buildKpiCards(a);
  const md = buildSessionMarkdown(a, opts);
  const body = mdToHtml(md);
  const title = escHtml(a.title ?? a.sessionId ?? "Session export");
  const provenance = `Generated ${new Date().toISOString().slice(0, 10)} · cc-analyzer · Session ${escHtml(a.sessionId ?? "—")} `;
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} — cc-analyzer</title>
<style>${HTML_STYLE}</style>
<script>try{const t=localStorage.getItem("cc-theme");const m=window.matchMedia("(prefers-color-scheme: light)").matches?"light":"dark";const r=t||m;if(r==="light")document.documentElement.setAttribute("data-theme","light");}catch{}</script>
<body>
<div class="wrap">
<header class="masthead"><h1>${title}</h1><button type="button" class="theme-toggle" onclick="try{const r=document.documentElement;const c=r.getAttribute('data-theme')==='light'?'dark':'light';r.setAttribute('data-theme',c);localStorage.setItem('cc-theme',c)}catch{}" aria-label="Toggle theme">◐ Theme</button></header>
<div class="ai-summary">${aiSummary}</div>
${kpiCards}
<div class="provenance">${provenance}</div>
${body}
</div>
<script>document.querySelectorAll("table").forEach(t=>{const max=Math.max(...[...t.querySelectorAll("tbody tr")].map(r=>parseFloat(r.cells[1]?.textContent?.replace(/[^\\d.]/g,"")||"0")||0),1);t.querySelectorAll("tbody tr").forEach(r=>{const c=r.cells[1];if(!c||!c.textContent.includes("$"))return;const v=parseFloat(c.textContent.replace(/[^\\d.]/g,"")||"0");const pct=Math.min(100,Math.round((v/max)*100));c.innerHTML='<div class="bar-wrap"><div class="bar" style="width:'+pct+'%"></div><span class="bar-val">'+c.textContent+'</span></div>';c.style.position="relative";});});</script>
</body>
</html>`;
}
