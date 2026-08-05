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

import type { Compaction, IdlePeriod, SessionAnalysis, SidechainBurst } from "./analyze.ts";
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

/**
 * Drop compaction records whose `uuid` was already seen. Copied session files
 * (and continuation edge cases) land the same boundary event in several rows;
 * the uuid is its stable identity, so cross-row rollups filter through one
 * shared `seen` set before summarizing. Uuid-less records (older files)
 * cannot dedupe and always pass.
 */
export function dedupeCompactions(compactions: Compaction[], seen: Set<string>): Compaction[] {
  return compactions.filter((c) => {
    if (!c.uuid) return true;
    if (seen.has(c.uuid)) return false;
    seen.add(c.uuid);
    return true;
  });
}

/** Percentage of a context window used, rounded to whole percent. */
export const pctOfLimit = (tokens: number, limit: number): number =>
  Math.round((tokens / limit) * 100);

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
}

export interface ContextMarker {
  /** Index of the first call at-or-after the compaction (may equal the series
   * length when the compaction closed the session). */
  pos: number;
  compaction: Compaction;
  /** Context tokens the compaction reclaimed: `preTokens` minus the first
   * post-compaction call's context. Undefined when either side is unknown
   * (no preTokens on older files, or the compaction closed the session), and
   * clamped at 0 — a bigger post-compaction prompt is growth, not negative
   * reclamation. */
  reclaimed?: number;
}

export interface ContextSeries {
  points: ContextPoint[];
  /** Own compactions with a mappable position; sidechain/inherited ones and
   * timestamp-less ones stay in `analysis.compactions` but are not placed. */
  markers: ContextMarker[];
  peakTokens: number;
  /** Largest known context-window size across the charted models — the limit
   * line and the "% of window" denominator, single-sourced here for both
   * frontends. Undefined when pricing knew none of them, or when the peak
   * exceeds it by enough that the limit is evidently wrong for this session
   * (e.g. a 1M-context beta priced by the family heuristic's 200k entry). */
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
      });
      if (contextTokens > peakTokens) peakTokens = contextTokens;
      if (limit && (contextLimit === undefined || limit > contextLimit)) contextLimit = limit;
    }
  }
  // A peak meaningfully above the "limit" means the limit is wrong for this
  // session (a bigger-window variant priced by the family heuristic) — drop
  // it rather than render an impossible ">100% of window". Slight overshoot
  // is real: the overflowing call itself can exceed the window briefly.
  if (contextLimit !== undefined && peakTokens > contextLimit * 1.1) contextLimit = undefined;

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
    const after = points[cursor];
    const reclaimed =
      compaction.preTokens !== undefined && after !== undefined
        ? Math.max(0, compaction.preTokens - after.contextTokens)
        : undefined;
    markers.push({ pos: cursor, compaction, ...(reclaimed !== undefined ? { reclaimed } : {}) });
  }
  return { points, markers, peakTokens, contextLimit };
}

/**
 * How much runway is left in the context window, extrapolated linearly from
 * the calls since the last compaction (or the whole session when it never
 * compacted). Undefined when the window size is unknown, the open segment has
 * fewer than three calls (no trend to read), or the context is flat/shrinking.
 * A projection, not a promise — one big paste or subagent digest breaks it.
 */
export interface HeadroomProjection {
  /** Net context growth per main-chain call over the open segment. */
  perCallTokens: number;
  /** Estimated calls until the window is full at that pace. */
  callsToLimit: number;
}

export function projectHeadroom(ctx: ContextSeries): HeadroomProjection | undefined {
  const { points, markers, contextLimit } = ctx;
  if (!contextLimit) return undefined;
  // Index math, not slice — the open segment can be the whole (large) series.
  const start = markers[markers.length - 1]?.pos ?? 0;
  const len = points.length - start;
  const first = points[start];
  const last = points[points.length - 1];
  if (len < 3 || !first || !last) return undefined;
  const perCallTokens = (last.contextTokens - first.contextTokens) / (len - 1);
  if (perCallTokens <= 0) return undefined;
  return {
    perCallTokens,
    callsToLimit: Math.max(0, Math.ceil((contextLimit - last.contextTokens) / perCallTokens)),
  };
}

/** One call's cache split (derived from the context series' points). */
export interface CachePoint {
  ms?: number;
  turnIndex: number;
  /** Prompt-side tokens served from cache. */
  cached: number;
  /** Prompt-side tokens NOT served from cache (input + both cache writes). */
  fresh: number;
  /** cached / (cached + fresh), whole percent; 0 for an empty prompt side. */
  hitPct: number;
}

export interface CacheSeries {
  points: CachePoint[];
  /** Token-weighted cache hit rate across the whole session, whole percent. */
  hitPct: number;
  /** Calls whose prompt side had tokens but read nothing from cache — cold
   * starts (session open, cache expiry after an idle gap). */
  coldCalls: number;
}

/**
 * Cache efficiency per main-chain API call — where "most of the money hides".
 * Derived from `buildContextSeries`' points so the two charts describe the
 * same calls in the same order.
 */
export function buildCacheSeries(ctx: ContextSeries): CacheSeries {
  let cachedSum = 0;
  let contextSum = 0;
  let coldCalls = 0;
  const points = ctx.points.map((p) => {
    const fresh = p.contextTokens - p.cachedTokens;
    cachedSum += p.cachedTokens;
    contextSum += p.contextTokens;
    if (p.contextTokens > 0 && p.cachedTokens === 0) coldCalls += 1;
    return {
      ms: p.ms,
      turnIndex: p.turnIndex,
      cached: p.cachedTokens,
      fresh,
      // The one shared rounding policy for "percent of a token total".
      hitPct: p.contextTokens > 0 ? pctOfLimit(p.cachedTokens, p.contextTokens) : 0,
    };
  });
  return {
    points,
    hitPct: contextSum > 0 ? pctOfLimit(cachedSum, contextSum) : 0,
    coldCalls,
  };
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

/** One of the analyzer's idle periods, mapped onto the burn-series call axis. */
export interface BurnGap {
  /** Index of the first call at-or-after the gap's end (may equal the series
   * length when the session went idle after its last call). */
  pos: number;
  durationMs: number;
}

/**
 * The analyzer's `idlePeriods` placed on a burn series — where "6h wall,
 * 40min active" hides. The periods come from `analyze.ts` (gaps between ALL
 * event timestamps, > `ACTIVE_GAP_MS`), so a chart's "idle" total is exactly
 * `durationMs − activeMs` and can never contradict the active-time vitals —
 * a long-running tool whose result event lands mid-gap is active, not idle.
 */
export function buildGapMarkers(points: BurnPoint[], idlePeriods: IdlePeriod[]): BurnGap[] {
  // One cursor pass: points are time-ordered (buildBurnSeries sorts) and so
  // are the idle periods.
  let cursor = 0;
  return idlePeriods.map((idle) => {
    const endMs = idle.startMs + idle.durationMs;
    while (cursor < points.length) {
      const ms = points[cursor]?.ms;
      if (ms !== undefined && ms >= endMs) break;
      cursor++;
    }
    return { pos: cursor, durationMs: idle.durationMs };
  });
}

/**
 * A turn's attention signals, as short labels — the ONE definition of "this
 * turn is worth flagging", shared by the web tooltips/marks, the TUI ▲ row,
 * and anything else that renders per-turn churn. A turn is flagged iff this
 * returns a non-empty array.
 */
export function turnFlags(t: TurnPoint): string[] {
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  const flags: string[] = [];
  if (t.interrupted) flags.push("interrupted");
  if (t.correction) flags.push("correction prompt");
  if (t.retries > 0) flags.push(plural(t.retries, "retry", "retries"));
  if (t.testFailures > 0) flags.push(plural(t.testFailures, "failing test", "failing tests"));
  if (t.redundantReads > 0)
    flags.push(plural(t.redundantReads, "redundant read", "redundant reads"));
  if (t.toolErrors > 0) flags.push(plural(t.toolErrors, "tool error", "tool errors"));
  return flags;
}

/** One subagent type's summed burst spend (see `groupSidechainBursts`). */
export interface SubagentTypeRow {
  /** Best-effort type, with unmatched bursts folded into "(unmatched)". */
  type: string;
  bursts: number;
  apiCalls: number;
  cost: number;
}

/** Fold bursts into a per-type rollup, ranked by cost — the one grouping rule
 * (label, fold, ordering) for every "what did the `finder` subagent cost this
 * session" surface. */
export function groupSidechainBursts(bursts: SidechainBurst[]): SubagentTypeRow[] {
  const byType = new Map<string, SubagentTypeRow>();
  for (const burst of bursts) {
    const type = burst.subagentType ?? "(unmatched)";
    const row = byType.get(type) ?? { type, bursts: 0, apiCalls: 0, cost: 0 };
    row.bursts += 1;
    row.apiCalls += burst.apiCalls;
    row.cost += burst.cost;
    byType.set(type, row);
  }
  return [...byType.values()].sort((a, b) => b.cost - a.cost || b.apiCalls - a.apiCalls);
}

export interface TurnPoint {
  index: number;
  cost: number;
  /** The four priced cost categories, for the stacked composition bars. */
  costInput: number;
  costOutput: number;
  costCacheWrite: number;
  costCacheRead: number;
  ioTokens: number;
  cacheTokens: number;
  apiCalls: number;
  mainApiCalls: number;
  /** Wall-clock span of the turn, when both ends are timestamped. */
  wallMs?: number;
  /** Operation steps per kind (run/read/edit/search/…) — narration and
   * thinking steps are not operations and are excluded. */
  kindCounts: Record<string, number>;
  /** Operation steps whose tool_result was an error. */
  toolErrors: number;
  /** Per-turn positions of the session-level signals (see `Turn`). */
  interrupted: boolean;
  correction: boolean;
  retries: number;
  testFailures: number;
  redundantReads: number;
  /** Short prompt preview for tooltips/labels. */
  prompt: string;
}

/** Per-turn cost/token/call series (bar-chart shaped). */
export function buildTurnSeries(analysis: SessionAnalysis): TurnPoint[] {
  return analysis.turns.map((turn) => {
    const kindCounts: Record<string, number> = {};
    let toolErrors = 0;
    for (const call of turn.apiCalls) {
      for (const step of call.steps) {
        if (step.kind === "note" || step.kind === "thinking") continue;
        kindCounts[step.kind] = (kindCounts[step.kind] ?? 0) + 1;
        if (step.status === "error") toolErrors += 1;
      }
    }
    const startMs = turn.startTime ? Date.parse(turn.startTime) : Number.NaN;
    const endMs = turn.endTime ? Date.parse(turn.endTime) : Number.NaN;
    const wallMs = Number.isNaN(startMs) || Number.isNaN(endMs) ? undefined : endMs - startMs;
    return {
      index: turn.index,
      cost: turn.cost.total,
      costInput: turn.cost.input,
      costOutput: turn.cost.output,
      costCacheWrite: turn.cost.cacheWrite,
      costCacheRead: turn.cost.cacheRead,
      ioTokens: ioTokens(turn.tokens),
      cacheTokens: cacheTokens(turn.tokens),
      apiCalls: turn.apiCalls.length,
      mainApiCalls: turn.mainApiCalls,
      ...(wallMs !== undefined ? { wallMs } : {}),
      kindCounts,
      toolErrors,
      interrupted: turn.interrupted === true,
      correction: turn.correction === true,
      retries: turn.retries,
      testFailures: turn.testFailures,
      redundantReads: turn.redundantReads,
      prompt: turn.prompt.slice(0, 120),
    };
  });
}

/** One model's share of the session (for the in-session model-mix bars). */
export interface SessionModelRow {
  model: string;
  apiCalls: number;
  cost: number;
  /** Share of the summed per-model cost (0..1; 0 when nothing cost anything). */
  share: number;
}

/** The session's models ranked by cost — interesting exactly when a session
 * mixed models (an Opus main chain with Haiku subagents). */
export function modelMixRows(analysis: SessionAnalysis): SessionModelRow[] {
  const rows = Object.entries(analysis.models).map(([model, m]) => ({
    model,
    apiCalls: m.apiCalls,
    cost: m.cost.total,
  }));
  const total = rows.reduce((s, r) => s + r.cost, 0);
  return rows
    .map((r) => ({ ...r, share: total > 0 ? r.cost / total : 0 }))
    .sort((a, b) => b.cost - a.cost || b.apiCalls - a.apiCalls);
}
