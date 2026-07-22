/**
 * Chart series derived from a detail-mode `SessionAnalysis` — the shared
 * numbers behind the session charts in both the TUI and the web SPA, so the
 * two renderers cannot drift. Bun-free on purpose (like `stats-types.ts`):
 * the web client imports these builders directly.
 *
 * All builders walk `analysis.turns`, so they return empty series for an
 * aggregate-mode analysis (the indexer path). API calls logged before the
 * first genuine prompt belong to no turn and are not charted — matching the
 * per-turn views, though session totals do include them.
 */

import type { Compaction, SessionAnalysis } from "./analyze.ts";
import { cacheTokens, ioTokens } from "./pricing.ts";

export interface ContextPoint {
  /** Position in the main-chain call sequence (the x axis). */
  index: number;
  /** Epoch ms of the call, when timestamped. */
  ms?: number;
  turnIndex: number;
  model?: string;
  /** Prompt-side context of this call: input + cache read + cache write. */
  contextTokens: number;
  /** How much of that context was served from cache. */
  cachedTokens: number;
  outputTokens: number;
  cost: number;
}

export interface ContextMarker {
  /** Index of the first call at-or-after the compaction (may equal the series
   * length when the compaction closed the session). */
  pos: number;
  compaction: Compaction;
}

export interface ContextSeries {
  points: ContextPoint[];
  /** Main-chain compactions with a mappable position; sidechain compactions
   * and timestamp-less ones stay in `analysis.compactions` but are not
   * placed on the axis. */
  markers: ContextMarker[];
  peakTokens: number;
}

/**
 * Context-window fill per main-chain API call — the sawtooth. Sidechain calls
 * run in their own context windows, so mixing them in would fake collapses;
 * they're excluded here and charted via the burn series instead.
 */
export function buildContextSeries(analysis: SessionAnalysis): ContextSeries {
  const points: ContextPoint[] = [];
  let peakTokens = 0;
  for (const turn of analysis.turns) {
    for (const call of turn.apiCalls) {
      if (call.isSidechain) continue;
      const t = call.tokens;
      const contextTokens =
        t.inputTokens + t.cacheReadTokens + t.cacheWrite5mTokens + t.cacheWrite1hTokens;
      const ms = call.timestamp ? Date.parse(call.timestamp) : Number.NaN;
      points.push({
        index: points.length,
        ms: Number.isNaN(ms) ? undefined : ms,
        turnIndex: turn.index,
        model: call.model,
        contextTokens,
        cachedTokens: t.cacheReadTokens,
        outputTokens: t.outputTokens,
        cost: call.cost.total,
      });
      if (contextTokens > peakTokens) peakTokens = contextTokens;
    }
  }

  const markers: ContextMarker[] = [];
  if (points.length === 0) return { points, markers, peakTokens };
  for (const compaction of analysis.compactions) {
    // A subagent's compaction compacts its own context window, and an
    // inherited boundary (continuation-file start) happened before this
    // session's first call — neither produces a drop in this chart.
    if (compaction.isSidechain || compaction.inherited) continue;
    const cms = compaction.timestamp ? Date.parse(compaction.timestamp) : Number.NaN;
    if (Number.isNaN(cms)) continue;
    const at = points.findIndex((p) => p.ms !== undefined && p.ms >= cms);
    markers.push({ pos: at === -1 ? points.length : at, compaction });
  }
  markers.sort((a, b) => a.pos - b.pos);
  return { points, markers, peakTokens };
}

export interface BurnPoint {
  index: number;
  ms?: number;
  /** Cumulative cost across all calls up to and including this one. */
  cost: number;
  /** Cumulative sidechain (subagent) cost. */
  sidechainCost: number;
  /** This call's own cost (the delta). */
  callCost: number;
  isSidechain: boolean;
}

/**
 * Cumulative cost over every API call (main + sidechain), ordered by
 * timestamp so interleaved subagent bursts land where they happened;
 * timestamp-less calls keep their stored position.
 */
export function buildBurnSeries(analysis: SessionAnalysis): BurnPoint[] {
  const calls = analysis.turns.flatMap((turn) => turn.apiCalls);
  const timed = calls.map((call, i) => {
    const ms = call.timestamp ? Date.parse(call.timestamp) : Number.NaN;
    return { call, i, ms: Number.isNaN(ms) ? undefined : ms };
  });
  timed.sort((a, b) => (a.ms ?? a.i) - (b.ms ?? b.i) || a.i - b.i);

  let cost = 0;
  let sidechainCost = 0;
  return timed.map(({ call, ms }, index) => {
    cost += call.cost.total;
    if (call.isSidechain) sidechainCost += call.cost.total;
    return {
      index,
      ms,
      cost,
      sidechainCost,
      callCost: call.cost.total,
      isSidechain: call.isSidechain,
    };
  });
}

export interface TurnPoint {
  index: number;
  cost: number;
  ioTokens: number;
  cacheTokens: number;
  apiCalls: number;
  mainApiCalls: number;
  /** Short prompt preview for tooltips/labels. */
  prompt: string;
}

/** Per-turn cost/token/call series (bar-chart shaped). */
export function buildTurnSeries(analysis: SessionAnalysis): TurnPoint[] {
  return analysis.turns.map((turn) => ({
    index: turn.index,
    cost: turn.cost.total,
    ioTokens: ioTokens(turn.tokens),
    cacheTokens: cacheTokens(turn.tokens),
    apiCalls: turn.apiCalls.length,
    mainApiCalls: turn.mainApiCalls,
    prompt: turn.prompt.slice(0, 120),
  }));
}
