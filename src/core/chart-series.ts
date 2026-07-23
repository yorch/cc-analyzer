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

/**
 * A session's *own* compaction: not a subagent's (which compacted its own
 * context window) and not an inherited boundary (copied from the parent
 * session at a continuation-file start). The single rule shared by the
 * indexer's `compactions` column, the rollups, the chart markers, and both
 * frontends' labels — so counts can never disagree across surfaces.
 */
export const isOwnCompaction = (c: Compaction): boolean => !c.isSidechain && !c.inherited;

export interface CompactionBreakdown {
  /** The session's own main-chain compactions, in session order. */
  own: Compaction[];
  /** Own compactions per trigger ("auto" / "manual" / "unknown"). */
  triggers: Record<string, number>;
  /** Compactions inside subagent transcripts. */
  sidechain: number;
  /** Boundaries inherited from the parent session (continuation files). */
  inherited: number;
}

/** Split a session's compaction records the one canonical way. */
export function summarizeCompactions(compactions: Compaction[]): CompactionBreakdown {
  const own: Compaction[] = [];
  const triggers: Record<string, number> = {};
  let sidechain = 0;
  let inherited = 0;
  for (const c of compactions) {
    if (c.isSidechain) sidechain += 1;
    else if (c.inherited) inherited += 1;
    else {
      own.push(c);
      const trigger = c.trigger ?? "unknown";
      triggers[trigger] = (triggers[trigger] ?? 0) + 1;
    }
  }
  return { own, triggers, sidechain, inherited };
}

export interface ContextPoint {
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
  /** This call's model context-window size, when pricing knew it. */
  limit?: number;
}

export interface ContextMarker {
  /** Index of the first call at-or-after the compaction (may equal the series
   * length when the compaction closed the session). */
  pos: number;
  compaction: Compaction;
}

export interface ContextSeries {
  points: ContextPoint[];
  /** Own compactions with a mappable position; sidechain/inherited ones and
   * timestamp-less ones stay in `analysis.compactions` but are not placed. */
  markers: ContextMarker[];
  peakTokens: number;
  /** Largest known context-window size across the charted models — the limit
   * line. Undefined when pricing knew none of them. */
  contextLimit?: number;
}

/**
 * Context-window fill per main-chain API call — the sawtooth. Sidechain calls
 * run in their own context windows, so mixing them in would fake collapses;
 * they're excluded here and charted via the burn series instead.
 */
export function buildContextSeries(analysis: SessionAnalysis): ContextSeries {
  const points: ContextPoint[] = [];
  let peakTokens = 0;
  let contextLimit: number | undefined;
  for (const turn of analysis.turns) {
    for (const call of turn.apiCalls) {
      if (call.isSidechain) continue;
      const t = call.tokens;
      const contextTokens =
        t.inputTokens + t.cacheReadTokens + t.cacheWrite5mTokens + t.cacheWrite1hTokens;
      const ms = call.timestamp ? Date.parse(call.timestamp) : Number.NaN;
      const limit = call.model ? analysis.models[call.model]?.contextLimit : undefined;
      points.push({
        ms: Number.isNaN(ms) ? undefined : ms,
        turnIndex: turn.index,
        model: call.model,
        contextTokens,
        cachedTokens: t.cacheReadTokens,
        outputTokens: t.outputTokens,
        cost: call.cost.total,
        ...(limit ? { limit } : {}),
      });
      if (contextTokens > peakTokens) peakTokens = contextTokens;
      if (limit && (contextLimit === undefined || limit > contextLimit)) contextLimit = limit;
    }
  }

  const markers: ContextMarker[] = [];
  if (points.length === 0) return { points, markers, peakTokens, contextLimit };
  // Own, timestamped compactions only (see isOwnCompaction), sorted by time so
  // one cursor pass over the (stream-ordered) points places every marker.
  const timed = summarizeCompactions(analysis.compactions)
    .own.map((compaction) => ({
      compaction,
      ms: compaction.timestamp ? Date.parse(compaction.timestamp) : Number.NaN,
    }))
    .filter((c) => !Number.isNaN(c.ms))
    .sort((a, b) => a.ms - b.ms);
  let cursor = 0;
  for (const { compaction, ms } of timed) {
    while (cursor < points.length) {
      const pms = points[cursor]?.ms;
      if (pms !== undefined && pms >= ms) break;
      cursor++;
    }
    markers.push({ pos: cursor, compaction });
  }
  return { points, markers, peakTokens, contextLimit };
}

export interface BurnPoint {
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
 * a timestamp-less call inherits its predecessor's timestamp, keeping it
 * anchored at its stored position instead of sorting on a bogus key.
 */
export function buildBurnSeries(analysis: SessionAnalysis): BurnPoint[] {
  const calls = analysis.turns.flatMap((turn) => turn.apiCalls);
  let lastMs = Number.NEGATIVE_INFINITY;
  const timed = calls.map((call, i) => {
    const parsed = call.timestamp ? Date.parse(call.timestamp) : Number.NaN;
    const ms = Number.isNaN(parsed) ? undefined : parsed;
    if (ms !== undefined) lastMs = ms;
    return { call, i, ms, sortMs: ms ?? lastMs };
  });
  // Explicit comparisons: two -Infinity sort keys (leading untimed calls)
  // must tie cleanly on stored order, and Infinity − Infinity is NaN.
  timed.sort((a, b) => (a.sortMs < b.sortMs ? -1 : a.sortMs > b.sortMs ? 1 : a.i - b.i));

  let cost = 0;
  let sidechainCost = 0;
  return timed.map(({ call, ms }) => {
    cost += call.cost.total;
    if (call.isSidechain) sidechainCost += call.cost.total;
    return {
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
