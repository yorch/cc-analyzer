/**
 * Explainable, per-session diagnostics derived from detail-mode analysis.
 *
 * These are deliberately named heuristics, not a synthetic quality score.
 * Every result carries the observed evidence and a suggested next action.
 * Bun-free so the web SPA can build the same diagnostics as the CLI and TUI.
 */

import type { ApiCall, SessionAnalysis } from "./analyze.ts";
import { buildContextSeries } from "./chart-series.ts";

/** Prompt-cache rewrites become interesting after the five-minute TTL boundary. */
const CACHE_IDLE_GAP_MS = 5 * 60_000;

export type SessionDiagnosticCode =
  | "context-pressure"
  | "context-jump"
  | "idle-cache-rewrite"
  | "post-compaction-refill"
  | "turn-cost-concentration";

export type SessionDiagnosticSeverity = "info" | "warning";

export interface SessionDiagnostic {
  code: SessionDiagnosticCode;
  severity: SessionDiagnosticSeverity;
  title: string;
  evidence: string;
  action: string;
  /** Zero-based turn index when the signal belongs to one turn. */
  turnIndex?: number;
}

const pct = (value: number): string => `${Math.round(value * 100)}%`;

interface TimedCall {
  call: ApiCall;
  turnIndex: number;
  ms: number;
}

function mainCallsByTime(analysis: SessionAnalysis): TimedCall[] {
  return analysis.turns
    .flatMap((turn) =>
      turn.apiCalls.flatMap((call) => {
        if (call.isSidechain || !call.timestamp) return [];
        const ms = Date.parse(call.timestamp);
        return Number.isNaN(ms) ? [] : [{ call, turnIndex: turn.index, ms }];
      }),
    )
    .sort((a, b) => a.ms - b.ms);
}

/**
 * Build actionable signals from a full session analysis.
 *
 * Thresholds are intentionally conservative and documented beside each rule:
 * - 75% context pressure leaves relatively little room for another agent loop.
 * - A 25%-of-window single-call jump is large enough to merit inspecting the turn.
 * - A post-compaction first call at 75% of pre-compaction context indicates that
 *   compaction recovered little practical headroom.
 * - Cost concentration requires at least three turns, so short sessions are not
 *   called concentrated by construction.
 */
export function buildSessionDiagnostics(analysis: SessionAnalysis): SessionDiagnostic[] {
  const diagnostics: SessionDiagnostic[] = [];
  const context = buildContextSeries(analysis);

  if (context.contextLimit && context.peakTokens >= context.contextLimit * 0.75) {
    let peak = context.points[0];
    for (const point of context.points) {
      if (!peak || point.contextTokens > peak.contextTokens) peak = point;
    }
    if (peak) {
      const share = peak.contextTokens / context.contextLimit;
      diagnostics.push({
        code: "context-pressure",
        severity: share >= 0.9 ? "warning" : "info",
        title: "Context window is under pressure",
        evidence: `Turn ${peak.turnIndex + 1} peaked at ${pct(share)} of the known context window.`,
        action: "Compact before another long agent loop, or start fresh if the task has changed.",
        turnIndex: peak.turnIndex,
      });
    }
  }

  if (context.contextLimit && context.points.length >= 2) {
    let largest:
      | { delta: number; share: number; turnIndex: number; previous: number; current: number }
      | undefined;
    for (let i = 1; i < context.points.length; i++) {
      const previous = context.points[i - 1];
      const current = context.points[i];
      if (!previous || !current) continue;
      const delta = current.contextTokens - previous.contextTokens;
      const share = delta / context.contextLimit;
      if (delta > 0 && (!largest || delta > largest.delta)) {
        largest = {
          delta,
          share,
          turnIndex: current.turnIndex,
          previous: previous.contextTokens,
          current: current.contextTokens,
        };
      }
    }
    if (largest && largest.share >= 0.25) {
      diagnostics.push({
        code: "context-jump",
        severity: "warning",
        title: "One call added a large block of context",
        evidence: `Turn ${largest.turnIndex + 1} grew from ${largest.previous.toLocaleString()} to ${largest.current.toLocaleString()} prompt-side tokens (+${pct(largest.share)} of the window).`,
        action: "Inspect this turn for a large file, tool result, image, or pasted payload.",
        turnIndex: largest.turnIndex,
      });
    }
  }

  const calls = mainCallsByTime(analysis);
  let rewriteCount = 0;
  let rewriteTokens = 0;
  let firstRewriteTurn: number | undefined;
  for (let i = 1; i < calls.length; i++) {
    const previous = calls[i - 1];
    const current = calls[i];
    if (!previous || !current || current.ms - previous.ms < CACHE_IDLE_GAP_MS) continue;
    const tokens = current.call.tokens.cacheWrite5mTokens + current.call.tokens.cacheWrite1hTokens;
    if (tokens <= 0) continue;
    rewriteCount += 1;
    rewriteTokens += tokens;
    firstRewriteTurn ??= current.turnIndex;
  }
  if (rewriteCount > 0) {
    diagnostics.push({
      code: "idle-cache-rewrite",
      severity: rewriteCount >= 2 ? "warning" : "info",
      title: "Idle gaps were followed by cache rewrites",
      evidence: `${rewriteCount} call${rewriteCount === 1 ? "" : "s"} after a gap of at least 5 minutes wrote ${rewriteTokens.toLocaleString()} cache tokens.`,
      action:
        "Finish related turns together when practical, or start fresh after a long task switch.",
      turnIndex: firstRewriteTurn,
    });
  }

  const refills = context.markers.flatMap((marker) => {
    const point = context.points[marker.pos];
    const preTokens = marker.compaction.preTokens;
    if (!point || !preTokens || preTokens <= 0) return [];
    const share = point.contextTokens / preTokens;
    return share >= 0.75 ? [{ point, preTokens, share }] : [];
  });
  if (refills.length > 0) {
    const worst = refills.reduce((a, b) => (b.share > a.share ? b : a));
    diagnostics.push({
      code: "post-compaction-refill",
      severity: "warning",
      title: "Compaction recovered little headroom",
      evidence: `The first call after compaction refilled to ${pct(worst.share)} of the recorded pre-compaction context.`,
      action:
        "Check for a large reloaded file or tool result; a fresh handoff may be more effective.",
      turnIndex: worst.point.turnIndex,
    });
  }

  if (analysis.turns.length >= 3 && analysis.totals.cost.total > 0) {
    const expensive = analysis.turns.reduce((a, b) => (b.cost.total > a.cost.total ? b : a));
    const share = expensive.cost.total / analysis.totals.cost.total;
    if (share >= 0.5) {
      diagnostics.push({
        code: "turn-cost-concentration",
        severity: "info",
        title: "Most spend landed in one turn",
        evidence: `Turn ${expensive.index + 1} accounted for ${pct(share)} of session cost.`,
        action:
          "Inspect that turn before optimizing the whole workflow; its model, context, or subagents dominate spend.",
        turnIndex: expensive.index,
      });
    }
  }

  return diagnostics;
}
