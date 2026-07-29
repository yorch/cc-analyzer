/**
 * Explainable, per-session diagnostics derived from detail-mode analysis.
 *
 * These are deliberately named heuristics, not a synthetic quality score.
 * Every result carries the observed evidence and a suggested next action.
 * Bun-free so the web SPA can build the same diagnostics as the CLI and TUI.
 */

import type { ApiCall, SessionAnalysis } from "./analyze.ts";
import { buildContextSeries } from "./chart-series.ts";
import { THRASH_REREAD_MIN, THRASH_STREAK_MIN } from "./stats-types.ts";

/** Prompt-cache rewrites become interesting after the five-minute TTL boundary. */
const CACHE_IDLE_GAP_MS = 5 * 60_000;

/** Edit-test thrash escalates to a warning here: four consecutive failing test
 * runs without a pass is the loop clearly repeating, not a debugging step. */
const THRASH_STREAK_WARN = 4;

/** Redundant reads escalate to a warning at eight — at that point whole files
 * are being re-paid into context every couple of turns. */
const THRASH_REREAD_WARN = 8;

/** A single file read this many times is worth naming even when total
 * redundancy stays low (4 reads of one file = 2 redundant on one chain). */
const SINGLE_FILE_READS = 4;

/** Correction loops need at least three correction turns AND a quarter of the
 * session's turns to fire — one or two "no, …" prompts are normal iteration,
 * and the share floor keeps a long session's occasional corrections quiet.
 * At 40% of turns the session is mostly redoing itself: warning. The counters
 * come from the same `isCorrectionPrompt`/`isInterruptionMarker` heuristics
 * the index stores, so this diagnostic and the indexed columns always agree. */
const CORRECTION_LOOP_MIN = 3;
const CORRECTION_LOOP_SHARE = 0.25;
const CORRECTION_LOOP_WARN_SHARE = 0.4;

export type SessionDiagnosticCode =
  | "context-pressure"
  | "context-jump"
  | "idle-cache-rewrite"
  | "post-compaction-refill"
  | "turn-cost-concentration"
  | "edit-test-thrash"
  | "repeated-file-reads"
  | "correction-loop";

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

/**
 * Session-wide `Read` counts per file, off the detail-mode step timeline —
 * richer evidence for `repeated-file-reads` (counts span chains, unlike the
 * per-chain analyzer counters, so they are display evidence, not the trigger).
 */
function readCountsByFile(analysis: SessionAnalysis): Map<string, number> {
  const counts = new Map<string, number>();
  for (const turn of analysis.turns) {
    for (const call of turn.apiCalls) {
      for (const step of call.steps) {
        // The Read step's summary is its file_path (see `summarizeToolUse`).
        if (step.tool !== "Read" || !step.summary) continue;
        counts.set(step.summary, (counts.get(step.summary) ?? 0) + 1);
      }
    }
  }
  return counts;
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
 * - Edit-test thrash starts at three consecutive failing test runs (warning at
 *   four) — two fails in a row is a normal debugging step.
 * - Repeated reads start at four redundant reads, or one file read four times
 *   (warning at eight redundant) — a re-read or two happens in any session.
 * - Correction loops start at three correction turns that are also a quarter
 *   of the session's turns (warning at 40%) — a "no, …" or two is iteration.
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

  if (analysis.testFailStreak >= THRASH_STREAK_MIN) {
    const streak = analysis.testFailStreak;
    diagnostics.push({
      code: "edit-test-thrash",
      severity: streak >= THRASH_STREAK_WARN ? "warning" : "info",
      title: "Edit-test loop repeated without progress",
      evidence: `${streak} consecutive failing test runs without a pass.`,
      action:
        "Step back and read the failure output carefully, or bisect — repeated blind " +
        "edit-test cycles burn tokens; consider asking for a different approach.",
    });
  }

  {
    const reads = readCountsByFile(analysis);
    let topFile: string | undefined = analysis.rereadFiles[0];
    let topReads = topFile !== undefined ? (reads.get(topFile) ?? 0) : 0;
    for (const [file, n] of reads) {
      if (n > topReads) {
        topFile = file;
        topReads = n;
      }
    }
    if (
      analysis.redundantReads >= THRASH_REREAD_MIN ||
      (topFile !== undefined && topReads >= SINGLE_FILE_READS)
    ) {
      const total = analysis.redundantReads;
      diagnostics.push({
        code: "repeated-file-reads",
        severity: total >= THRASH_REREAD_WARN ? "warning" : "info",
        title: "The same files are being re-read repeatedly",
        evidence:
          `${total} redundant read${total === 1 ? "" : "s"} (3rd+ read of a file)` +
          (topFile !== undefined
            ? `; the most re-read file is ${topFile}${topReads > 0 ? ` (${topReads} reads)` : ""}.`
            : "."),
        action:
          "Large files re-read every turn belong in a summary or a subagent; check whether " +
          "context was compacted away, forcing the re-reads.",
      });
    }
  }

  {
    // The analyzer computed both counters with the shared `isCorrectionPrompt`
    // / `isInterruptionMarker` heuristics (the same numbers the index stores),
    // so the diagnostic cannot disagree with the indexed columns.
    const corrections = analysis.correctionTurns;
    const turns = analysis.totals.turns;
    const share = turns > 0 ? corrections / turns : 0;
    if (corrections >= CORRECTION_LOOP_MIN && share >= CORRECTION_LOOP_SHARE) {
      const interruptions = analysis.interruptionTurns;
      diagnostics.push({
        code: "correction-loop",
        severity: share >= CORRECTION_LOOP_WARN_SHARE ? "warning" : "info",
        title: "Many prompts corrected the previous turn",
        evidence:
          `${corrections} of ${turns} turns (${pct(share)}) opened by correcting the previous ` +
          `one${interruptions > 0 ? `; ${interruptions} turn${interruptions === 1 ? "" : "s"} interrupted mid-flight` : ""}. ` +
          "English-only keyword heuristic — it undercounts.",
        action:
          "Invest in the first prompt: more context, constraints, and acceptance criteria up " +
          "front. When a turn misfires, consider /clear plus a fresh, fuller prompt instead of " +
          "iterating on the misfire.",
      });
    }
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
