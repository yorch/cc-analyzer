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

  // Tools
  const toolRows = Object.entries(a.tools).sort((x, y) => y[1] - x[1]);
  if (toolRows.length > 0) {
    out.push("## Tools");
    out.push("");
    out.push(
      mdTable(
        ["Tool", "Count"],
        ["left", "right"],
        toolRows.map(([k, v]) => [mdCell(k), String(v)]),
      ),
    );
    out.push("");
  }

  // Skills
  const skillEntries = Object.entries(a.skills).sort((x, y) => y[1] - x[1]);
  if (skillEntries.length > 0) {
    out.push("## Skills");
    out.push("");
    out.push(
      mdTable(
        ["Skill", "Uses", "Turns", "Turn $"],
        ["left", "right", "right", "right"],
        skillEntries.map(([s, n]) => {
          const attr = a.skillTurnCosts[s];
          return [mdCell(s), String(n), String(attr?.turns ?? 0), formatUSD(attr?.cost ?? 0)];
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
:root{--bg:#0f1115;--card:#171a21;--border:#242836;--text:#e6e8ef;--muted:#9aa0b8;--accent:#6ea8fe;--warn:#f5a623;--err:#ff6b6b;--ok:#51cf66}
*{box-sizing:border-box}body{margin:0;font:14px/1.6 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial;color:var(--text);background:var(--bg)}
a{color:var(--accent)}h1{font-size:22px;margin:0 0 6px}h2{font-size:16px;margin:22px 0 8px;color:var(--text);border-bottom:1px solid var(--border);padding-bottom:6px}h3{font-size:14px;margin:16px 0 6px;color:var(--muted)}
.wrap{max-width:980px;margin:0 auto;padding:28px 20px}
.meta{color:var(--muted);font-size:13px;line-height:1.5}
table{width:100%;border-collapse:collapse;font-size:13px;margin:8px 0 12px}
th,td{padding:6px 8px;border:1px solid var(--border);text-align:left;vertical-align:top}
th{background:var(--card);font-weight:600}
td.num{text-align:right;font-variant-numeric:tabular-nums}
.muted{color:var(--muted)}.warn{color:var(--warn)}.err{color:var(--err)}.pill{display:inline-block;padding:1px 7px;border-radius:999px;font-size:12px;border:1px solid var(--border);background:var(--card)}
pre{white-space:pre-wrap;word-break:break-word;background:var(--card);border:1px solid var(--border);border-radius:8px;padding:10px 12px;overflow:auto;font-size:12.5px;line-height:1.5}
code{background:var(--card);border:1px solid var(--border);padding:1px 5px;border-radius:6px;font-size:12.5px}
.card{border:1px solid var(--border);background:var(--card);border-radius:10px;padding:12px 14px;margin:8px 0}
.kicker{font-size:12px;letter-spacing:.04em;text-transform:uppercase;color:var(--muted)}
@media print{body{background:#fff;color:#111} .wrap{max-width:none;padding:12px} table,th,td,pre,.card{border-color:#ddd} pre,.card{background:#f8f9fb}}
`;

function escHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
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
        tableLines.push(lines[i]!);
        i++;
      }
      // tableLines[0]=header, [1]=separator, rest=rows
      if (tableLines.length >= 2) {
        const headers = tableLines[0]
          ?.split("|")
          .slice(1, -1)
          .map((s) => s.trim());
        const aligns = tableLines[1]
          ?.split("|")
          .slice(1, -1)
          .map((s) => (s.trim().includes(":") && s.trim().endsWith(":") ? ' class="num"' : ""));
        html.push("<table><thead><tr>");
        for (let idx = 0; idx < headers.length; idx++)
          html.push(`<th${aligns[idx] ?? ""}>${escHtml(headers[idx] ?? "")}</th>`);
        html.push("</tr></thead><tbody>");
        for (let r = 2; r < tableLines.length; r++) {
          const cells = tableLines[r]
            ?.split("|")
            .slice(1, -1)
            .map((s) => s.trim());
          html.push("<tr>");
          for (let idx = 0; idx < cells.length; idx++)
            html.push(`<td${aligns[idx] ?? ""}>${escHtml(cells[idx] ?? "")}</td>`);
          html.push("</tr>");
        }
        html.push("</tbody></table>");
      }
      continue;
    } else if (line.startsWith("- ")) {
      // Collect list block
      const items: string[] = [];
      while (i < lines.length && (lines[i]?.startsWith("- ") ?? false)) {
        items.push(lines[i]?.slice(2));
        i++;
        // handle indented continuation line "  - Next:"
        if (i < lines.length && lines[i]?.startsWith("  - ")) {
          items[items.length - 1] +=
            `<br><span class="muted">${escHtml(lines[i]?.slice(4))}</span>`;
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
  const md = buildSessionMarkdown(a, opts);
  const body = mdToHtml(md);
  const title = escHtml(a.title ?? a.sessionId ?? "Session export");
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} — cc-analyzer</title>
<style>${HTML_STYLE}</style>
<body>
<div class="wrap">
${body}
</div>
</body>
</html>`;
}
