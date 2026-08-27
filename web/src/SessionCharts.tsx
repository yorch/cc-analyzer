import { useMemo, useState } from "react";
import { EmptyNotice } from "./AsyncNotice.tsx";
import {
  type BurnGap,
  type BurnPoint,
  buildBurnSeries,
  buildCacheSeries,
  buildContextSeries,
  buildGapMarkers,
  buildTurnSeries,
  type CacheSeries,
  type Compaction,
  type ContextSeries,
  cumulativeShares,
  modelMixRows,
  pct,
  pctOfLimit,
  projectHeadroom,
  type SessionAnalysis,
  type SessionModelRow,
  type SidechainBurst,
  shareOf,
  summarizeCompactions,
  type TurnPoint,
  turnCostShape,
  turnFlags,
} from "./api.ts";
import {
  ActiveDot,
  activeAt,
  barLocate,
  ChartTip,
  Crosshair,
  type HoverController,
  type IndexHover,
  lineLocate,
  TipHead,
  TipRow,
  usePointerIndex,
} from "./chart-hover.tsx";
import { count, duration, usd } from "./format.ts";
import { useHashParam } from "./router.ts";
import { Seg } from "./Seg.tsx";
import {
  areaPath,
  CHART_PAD,
  CHART_W,
  ChartData,
  chartBox,
  fmt,
  linePath,
  MAX_LINE_DOTS,
  xScale,
  YAxis,
} from "./trend-charts.tsx";

/** Session-scoped charts: context-window fill (with compaction markers),
 * cache efficiency, cumulative burn (with idle-gap markers), per-turn bars,
 * tool activity, model mix, and subagent bursts. Series come from core
 * `chart-series.ts` so these numbers match the TUI charts exactly.
 *
 * `onGoToTurn` (when given) lets a chart hand a turn number back to the page —
 * the subagent-burst table uses it to open the Turns tab at that turn. */
export function SessionCharts({
  a,
  onGoToTurn,
}: {
  a: SessionAnalysis;
  onGoToTurn?: (turnIndex: number) => void;
}) {
  const ctx = useMemo(() => buildContextSeries(a), [a]);
  const cache = useMemo(() => buildCacheSeries(ctx), [ctx]);
  const burn = useMemo(() => buildBurnSeries(a), [a]);
  const gaps = useMemo(() => buildGapMarkers(burn, a.totals.idlePeriods), [burn, a]);
  const turns = useMemo(() => buildTurnSeries(a), [a]);
  const models = useMemo(() => modelMixRows(a), [a]);
  const hasKinds = useMemo(() => turns.some((t) => Object.keys(t.kindCounts).length > 0), [turns]);
  // Guard against a payload from an older server (same staleness assumption
  // `insights` is optional for): absent means no bursts, not a crash.
  const bursts = a.sidechainBursts ?? [];
  // Context and cache chart the same per-main-chain-call axis (cache is derived
  // point-for-point from ctx), so one shared cursor drives both: hover either
  // and the same call lights up on the other.
  const callCursor = useState<IndexHover | null>(null);

  if (a.turns.length === 0) {
    return <EmptyNotice>No turns to chart in this session.</EmptyNotice>;
  }

  return (
    <>
      <section className="trend-panel">
        <div className="trend-head">
          <h2>Context window</h2>
          <span className="muted">prompt-side tokens per main-chain API call</span>
        </div>
        <ContextChart ctx={ctx} compactions={a.compactions} cursor={callCursor} />
      </section>

      {ctx.points.length > 0 && (
        <section className="trend-panel">
          <div className="trend-head">
            <h2>Cache efficiency</h2>
            <span className="muted">share of each call's context served from cache</span>
          </div>
          <CacheChart cache={cache} cursor={callCursor} />
        </section>
      )}

      <section className="trend-panel">
        <div className="trend-head">
          <h2>Cumulative cost</h2>
          <span className="muted">running total across every API call</span>
        </div>
        <BurnChart points={burn} gaps={gaps} />
      </section>

      <section className="trend-panel">
        <TurnBars turns={turns} />
      </section>

      {hasKinds && (
        <section className="trend-panel">
          <ToolActivity turns={turns} />
        </section>
      )}

      {models.length > 1 && (
        <section className="trend-panel">
          <div className="trend-head">
            <h2>Model mix</h2>
            <span className="muted">this session's models, ranked by cost</span>
          </div>
          <ModelMixPanel rows={models} />
        </section>
      )}

      {bursts.length > 0 && (
        <section className="trend-panel">
          <div className="trend-head">
            <h2>Subagent bursts</h2>
            <span className="muted">
              {usd(a.totals.sidechainCost)} total sidechain cost across {bursts.length} burst
              {bursts.length > 1 ? "s" : ""}
            </span>
          </div>
          <SidechainBursts bursts={bursts} onGoToTurn={onGoToTurn} />
        </section>
      )}
    </>
  );
}

/** A short stroke sample for legends whose distinction is a line style — a
 *  dashed compaction marker, the teal subagent line — not a solid fill. */
function LegendLine({ cls, label }: { cls: string; label: string }) {
  return (
    <span className="legend-item">
      <svg className="legend-mark" viewBox="0 0 18 6" aria-hidden="true">
        <line className={cls} x1={0} x2={18} y1={3} y2={3} />
      </svg>
      {label}
    </span>
  );
}

/** A filled sample for legends keyed to a bar or lane color. */
function LegendSwatch({ cls, label }: { cls: string; label: string }) {
  return (
    <span className="legend-item">
      <span className={`legend-swatch ${cls}`} />
      {label}
    </span>
  );
}

/** "2 auto + 1 manual compactions", from the own-compaction trigger split. */
function triggerLabel(triggers: Record<string, number>, total: number): string {
  if (total === 0) return "no compactions";
  const parts = Object.entries(triggers)
    .map(([t, c]) => `${c} ${t}`)
    .join(" + ");
  return `${parts} compaction${total > 1 ? "s" : ""}`;
}

/** A between-calls marker sits between the previous call and the one at `pos`. */
const betweenX = (pos: number, n: number, x: (i: number) => number): number =>
  pos <= 0 ? CHART_PAD : pos >= n ? CHART_W - CHART_PAD : (x(pos - 1) + x(pos)) / 2;

/** Shared x labels for the call-indexed charts' tabular fallbacks. */
const callLabels = (n: number): string[] => Array.from({ length: n }, (_, i) => `call ${i + 1}`);

function ContextChart({
  ctx,
  compactions,
  cursor,
}: {
  ctx: ContextSeries;
  compactions: Compaction[];
  cursor?: HoverController;
}) {
  const { points, markers, peakTokens, contextLimit } = ctx;
  // The one canonical split: own vs subagent vs inherited (see chart-series.ts).
  const b = summarizeCompactions(compactions);
  const headroom = projectHeadroom(ctx);
  const n = points.length;
  const H = 220;
  // When the window size is known, scale to it: the empty headroom above the
  // sawtooth IS the signal (how close this session ran to the ceiling).
  const max = Math.max(peakTokens, contextLimit ?? 0, 1);
  const x = xScale(n);
  const y = (v: number) => H - CHART_PAD - (v / max) * (H - CHART_PAD * 2);
  const line = linePath(
    points.map((p) => p.contextTokens),
    x,
    y,
  );
  const t0 = points.find((p) => p.ms !== undefined)?.ms;
  const offset = (ms?: number) => (ms !== undefined && t0 !== undefined ? duration(ms - t0) : "?");
  // A marker sits between the last pre-compaction call and the first one after.
  const markerX = (pos: number) => betweenX(pos, n, x);
  // Clamp the shared cursor to this chart's range: context and cache can differ
  // by a point at the edges, and a stale index from the sibling must not read
  // out of bounds.
  const { hover, bind } = usePointerIndex(n, lineLocate(n), CHART_W, cursor);
  const active = activeAt(hover, points, n, x);
  if (n === 0) return <EmptyNotice>No main-chain API calls in this session.</EmptyNotice>;
  return (
    <>
      <p className="muted">
        peak {count(peakTokens)} tokens
        {contextLimit
          ? ` (${pctOfLimit(peakTokens, contextLimit)}% of the ${count(contextLimit)} window)`
          : ""}{" "}
        · {triggerLabel(b.triggers, b.own.length)}
        {b.own.length > markers.length && " (some without timestamps, not placed)"}
        {b.inherited > 0 && " · started post-compaction (inherited boundary, not marked)"}
        {b.sidechain > 0 && ` · ${b.sidechain} in subagents (own context windows, not marked)`}
        {headroom &&
          ` · ~${count(headroom.callsToLimit)} calls to window at +${count(
            Math.round(headroom.perCallTokens),
          )} tokens/call`}
      </p>
      <div className="chart-wrap">
        <svg
          className="burnchart hoverable"
          viewBox={`0 0 ${CHART_W} ${H}`}
          style={chartBox(CHART_W, H)}
          role="img"
          aria-label={`Context-window token usage over ${n} API calls, peak ${count(peakTokens)} tokens`}
          {...bind}
        >
          <title>Context-window tokens per call</title>
          <path className="burn-area" d={areaPath(line, x, n, H)} />
          <path className="burn-line" d={line} />
          {contextLimit && (
            <line
              className="ctx-limit"
              x1={CHART_PAD}
              x2={CHART_W - CHART_PAD}
              y1={y(contextLimit)}
              y2={y(contextLimit)}
            >
              <title>{`context window · ${count(contextLimit)} tokens`}</title>
            </line>
          )}
          {markers.map((m, mi) => (
            <line
              // biome-ignore lint/suspicious/noArrayIndexKey: markers are order-stable
              key={mi}
              className="ctx-marker"
              x1={markerX(m.pos)}
              x2={markerX(m.pos)}
              y1={CHART_PAD}
              y2={H - CHART_PAD}
            >
              <title>{`compaction (${m.compaction.trigger ?? "unknown trigger"}) · +${offset(
                m.compaction.timestamp ? Date.parse(m.compaction.timestamp) : undefined,
              )}${m.compaction.preTokens ? ` · ${count(m.compaction.preTokens)} tokens before` : ""}${
                m.reclaimed !== undefined ? ` · reclaimed ${count(m.reclaimed)} tokens` : ""
              }`}</title>
            </line>
          ))}
          {n <= MAX_LINE_DOTS &&
            points.map((p, i) => (
              <circle
                // biome-ignore lint/suspicious/noArrayIndexKey: call order is fixed
                key={i}
                className="dot"
                cx={x(i)}
                cy={y(p.contextTokens)}
                r={3.5}
              />
            ))}
          <YAxis max={max} y={y} format={(v) => count(Math.round(v))} />
          {active && (
            <>
              <Crosshair x={active.x} bottom={H - CHART_PAD} />
              <ActiveDot cx={active.x} cy={y(active.p.contextTokens)} />
            </>
          )}
        </svg>
        {active && (
          <ChartTip x={active.x}>
            <TipHead>{`call ${active.i + 1} · turn #${active.p.turnIndex + 1} · +${offset(
              active.p.ms,
            )}`}</TipHead>
            <TipRow
              label="context"
              value={`${count(active.p.contextTokens)}${
                contextLimit ? ` (${pctOfLimit(active.p.contextTokens, contextLimit)}%)` : ""
              }`}
              color="var(--signal)"
            />
            <TipRow label="cached" value={count(active.p.cachedTokens)} />
            <TipRow label="output" value={count(active.p.outputTokens)} />
            <TipRow label="cost" value={usd(active.p.cost)} />
            {active.p.model ? <TipRow label="model" value={active.p.model} /> : null}
          </ChartTip>
        )}
      </div>
      <div className="axis">
        <span>call 1</span>
        <span>call {n}</span>
      </div>
      <div className="legend">
        <LegendLine cls="burn-line" label="context tokens" />
        {markers.length > 0 && <LegendLine cls="ctx-marker" label="compaction" />}
        {contextLimit ? <LegendLine cls="ctx-limit" label="context window limit" /> : null}
      </div>
      <ChartData
        labelHeading="Call"
        valueHeading="Context tokens"
        labels={callLabels(n)}
        values={points.map((p) => p.contextTokens)}
        format={(v) => count(Math.round(v))}
      />
    </>
  );
}

/** Per-call cache hit rate on a fixed 0–100% scale — dips are cold starts. */
function CacheChart({ cache, cursor }: { cache: CacheSeries; cursor?: HoverController }) {
  const { points, hitPct, coldCalls } = cache;
  const n = points.length;
  const H = 160;
  const x = xScale(n);
  const y = (pct: number) => H - CHART_PAD - (pct / 100) * (H - CHART_PAD * 2);
  const line = linePath(
    points.map((p) => p.hitPct),
    x,
    y,
  );
  const { hover, bind } = usePointerIndex(n, lineLocate(n), CHART_W, cursor);
  const active = activeAt(hover, points, n, x);
  if (n === 0) return <EmptyNotice>No main-chain API calls in this session.</EmptyNotice>;
  return (
    <>
      <p className="muted">
        hit rate {hitPct}% (token-weighted) · {coldCalls} cold call{coldCalls === 1 ? "" : "s"}
      </p>
      <div className="chart-wrap">
        <svg
          className="burnchart hoverable"
          viewBox={`0 0 ${CHART_W} ${H}`}
          style={chartBox(CHART_W, H)}
          role="img"
          aria-label={`Cache hit rate per API call, ${hitPct}% overall`}
          {...bind}
        >
          <title>Cache hit rate per call</title>
          <path className="burn-line" d={line} />
          {n <= MAX_LINE_DOTS &&
            points.map((p, i) => (
              <circle
                // biome-ignore lint/suspicious/noArrayIndexKey: call order is fixed
                key={i}
                className="dot"
                cx={x(i)}
                cy={y(p.hitPct)}
                r={3.5}
              />
            ))}
          <YAxis max={100} y={y} format={(v) => `${Math.round(v)}%`} />
          {active && (
            <>
              <Crosshair x={active.x} bottom={H - CHART_PAD} />
              <ActiveDot cx={active.x} cy={y(active.p.hitPct)} />
            </>
          )}
        </svg>
        {active && (
          <ChartTip x={active.x}>
            <TipHead>{`call ${active.i + 1} · turn #${active.p.turnIndex + 1}`}</TipHead>
            <TipRow label="hit rate" value={`${active.p.hitPct}%`} color="var(--signal)" />
            <TipRow label="cached" value={count(active.p.cached)} />
            <TipRow label="fresh" value={count(active.p.fresh)} />
          </ChartTip>
        )}
      </div>
      <div className="axis">
        <span>call 1</span>
        <span>call {n}</span>
      </div>
      <ChartData
        labelHeading="Call"
        valueHeading="Hit rate"
        labels={callLabels(n)}
        values={points.map((p) => p.hitPct)}
        format={(v) => `${v}%`}
      />
    </>
  );
}

function BurnChart({ points, gaps }: { points: BurnPoint[]; gaps: BurnGap[] }) {
  const n = points.length;
  const H = 160;
  const last = points[n - 1];
  const max = Math.max(last?.cost ?? 0, 1e-9);
  const x = xScale(n);
  const y = (v: number) => H - CHART_PAD - (v / max) * (H - CHART_PAD * 2);
  const total = linePath(
    points.map((p) => p.cost),
    x,
    y,
  );
  const side =
    last && last.sidechainCost > 0
      ? linePath(
          points.map((p) => p.sidechainCost),
          x,
          y,
        )
      : null;
  const t0 = points.find((p) => p.ms !== undefined)?.ms;
  const offset = (ms?: number) => (ms !== undefined && t0 !== undefined ? duration(ms - t0) : "?");
  const idleMs = gaps.reduce((s, g) => s + g.durationMs, 0);
  const { hover, pinned, bind } = usePointerIndex(n, lineLocate(n));
  const active = activeAt(hover, points, n, x);
  if (n === 0 || !last) return <EmptyNotice>No API calls in this session.</EmptyNotice>;
  return (
    <>
      <p className="muted">
        {usd(last.cost)} total
        {last.sidechainCost > 0 ? ` · ${usd(last.sidechainCost)} on subagents` : ""}
        {gaps.length > 0 &&
          ` · ${gaps.length} idle gap${gaps.length > 1 ? "s" : ""} (${duration(idleMs)} idle)`}
      </p>
      <div className="chart-wrap">
        <svg
          className="burnchart hoverable"
          viewBox={`0 0 ${CHART_W} ${H}`}
          style={chartBox(CHART_W, H)}
          role="img"
          aria-label={`Cumulative session cost over ${n} API calls, ${usd(last.cost)} total`}
          {...bind}
        >
          <title>Cumulative session cost</title>
          {gaps.map((g) => (
            <line
              key={g.pos}
              className="gap-marker"
              x1={betweenX(g.pos, n, x)}
              x2={betweenX(g.pos, n, x)}
              y1={CHART_PAD}
              y2={H - CHART_PAD}
            >
              <title>{`idle ${duration(g.durationMs)}`}</title>
            </line>
          ))}
          <path className="burn-line" d={total} />
          {side && <path className="burn-line side" d={side} />}
          {n <= MAX_LINE_DOTS &&
            points.map((p, i) => (
              <circle
                // biome-ignore lint/suspicious/noArrayIndexKey: call order is fixed
                key={i}
                className="dot"
                cx={x(i)}
                cy={y(p.cost)}
                r={3.5}
              />
            ))}
          <YAxis max={max} y={y} format={usd} />
          {active && (
            <>
              <Crosshair x={active.x} bottom={H - CHART_PAD} pinned={pinned} />
              {side && <ActiveDot cx={active.x} cy={y(active.p.sidechainCost)} cls="side" />}
              <ActiveDot cx={active.x} cy={y(active.p.cost)} />
            </>
          )}
        </svg>
        {active && (
          <ChartTip x={active.x} pinned={pinned}>
            <TipHead>{`+${offset(active.p.ms)}${
              active.p.isSidechain ? " · sidechain call" : ""
            }`}</TipHead>
            <TipRow label="cumulative" value={usd(active.p.cost)} color="var(--signal)" />
            <TipRow label="this call" value={usd(active.p.callCost)} />
            {side ? (
              <TipRow label="subagent" value={usd(active.p.sidechainCost)} color="var(--teal)" />
            ) : null}
          </ChartTip>
        )}
      </div>
      <div className="axis">
        <span>start</span>
        <span>{offset(points.reduce((m, p) => Math.max(m, p.ms ?? 0), 0) || undefined)}</span>
      </div>
      <div className="legend">
        <LegendLine cls="burn-line" label="total spend" />
        {side && <LegendLine cls="burn-line side" label="subagent (sidechain) spend" />}
        {gaps.length > 0 && <LegendLine cls="gap-marker" label="idle gap" />}
      </div>
      <ChartData
        labelHeading="Call"
        valueHeading="Cumulative cost"
        labels={callLabels(n)}
        values={points.map((p) => p.cost)}
        format={usd}
      />
    </>
  );
}

type TurnMetric = "cost" | "tokens" | "calls" | "depth" | "time";

const turnValue = (t: TurnPoint, m: TurnMetric): number =>
  m === "cost"
    ? t.cost
    : m === "tokens"
      ? t.ioTokens + t.cacheTokens
      : m === "calls"
        ? t.apiCalls
        : m === "depth"
          ? t.mainApiCalls
          : (t.wallMs ?? 0);

/** Metric label: dollars for cost, durations for time, counts otherwise. */
const fmtTurn = (m: TurnMetric, v: number): string => (m === "time" ? duration(v) : fmt(m, v));

/** The four cost categories, bottom-up in stacking order. `color` mirrors each
 *  segment's fill in styles.css, so the tooltip key matches the bar. */
const COST_SEGS = [
  { cls: "tb-input", key: "costInput", label: "input", color: "var(--signal)" },
  { cls: "tb-output", key: "costOutput", label: "output", color: "var(--teal)" },
  { cls: "tb-write", key: "costCacheWrite", label: "cache write", color: "var(--data-violet)" },
  { cls: "tb-read", key: "costCacheRead", label: "cache read", color: "var(--data-blue)" },
] as const;

/**
 * Bar order. `turn` is the session's own narrative; `rank` sorts descending by
 * the active metric, which is what makes the cumulative-share overlay a real
 * **Pareto** curve rather than a cumulative burn line wearing a share's label.
 * A running share is only a "the top few turns are most of the spend" reading
 * when the bars are already ranked, so the curve rides on the order rather
 * than being drawn unconditionally over chronological bars.
 */
type TurnOrder = "turn" | "rank";

/** Turns summed into the ranked chart's "top N = X%" headline. Five is small
 *  enough that the claim is still surprising when it is true, and it matches
 *  the Summary tab's "Costliest turns" block so the two agree on screen. */
const PARETO_HEAD = 5;

function TurnBars({ turns }: { turns: TurnPoint[] }) {
  const metrics = ["cost", "tokens", "calls", "depth", "time"] as const;
  const orders = ["turn", "rank"] as const;
  const [metric, setMetric] = useHashParam<TurnMetric>("turnMetric", "cost", metrics);
  const [order, setOrder] = useHashParam<TurnOrder>("turnOrder", "turn", orders);
  const n = turns.length;
  const H = 160;
  const ordered = useMemo(
    () =>
      order === "rank"
        ? [...turns].sort((a, b) => turnValue(b, metric) - turnValue(a, metric))
        : turns,
    [turns, order, metric],
  );
  const values = ordered.map((t) => turnValue(t, metric));
  const max = Math.max(...values, 1e-9);
  const peakIdx = values.reduce((best, v, i) => (v > (values[best] ?? -1) ? i : best), 0);
  const slot = (CHART_W - CHART_PAD * 2) / n;
  const gap = Math.min(2, slot * 0.2);
  const y = (v: number) => H - CHART_PAD - (v / max) * (H - CHART_PAD * 2);
  const flagged = turns.filter((t) => turnFlags(t).length > 0).length;
  // The Pareto overlay runs on its own 0–100% scale, independent of the bars'
  // value axis; `shareOf` keeps a $0 (or 0-call) session at 0% instead of NaN%.
  const metricTotal = values.reduce((sum, v) => sum + v, 0);
  const cum = cumulativeShares(values, metricTotal);
  const yShare = (share: number) => H - CHART_PAD - share * (H - CHART_PAD * 2);
  // The mark is the hit target on a bar chart: snap to the slot under the
  // pointer and anchor the tooltip at that bar's center (no crosshair).
  const xCenter = (i: number) => CHART_PAD + i * slot + slot / 2;
  const { hover, pinned, bind } = usePointerIndex(n, barLocate(n, slot));
  const active = activeAt(hover, ordered, n, xCenter);
  return (
    <>
      <div className="trend-head">
        <h2>Per turn</h2>
        <span className="seg-group">
          metric{" "}
          <Seg label="Turn bar metric" options={metrics} value={metric} onChange={setMetric} />{" "}
          order <Seg label="Turn bar order" options={orders} value={order} onChange={setOrder} />
        </span>
      </div>
      <p className="muted">
        peak {fmtTurn(metric, values[peakIdx] ?? 0)} (turn #{(ordered[peakIdx]?.index ?? 0) + 1} ·{" "}
        {ordered[peakIdx]?.prompt.slice(0, 60) || "no text"})
        {order === "rank" && n > 0
          ? ` · top ${Math.min(PARETO_HEAD, n)} = ${pct(cum[Math.min(PARETO_HEAD, n) - 1] ?? 0)} of ${metric}`
          : ""}
      </p>
      <div className="chart-wrap">
        <svg
          className="burnchart"
          viewBox={`0 0 ${CHART_W} ${H}`}
          style={chartBox(CHART_W, H)}
          role="img"
          aria-label={`Per-turn ${metric} bar chart across ${n} turns, peak ${fmtTurn(
            metric,
            values[peakIdx] ?? 0,
          )}`}
          {...bind}
        >
          <title>Per-turn {metric}</title>
          {ordered.map((t, i) => {
            const v = values[i] ?? 0;
            const h = v > 0 ? Math.max((v / max) * (H - CHART_PAD * 2), 1.5) : 0;
            const bx = CHART_PAD + i * slot + gap / 2;
            const bw = Math.max(slot - gap, 1);
            const flags = turnFlags(t);
            const hot = i === hover?.i ? " hot" : "";
            let yCursor = H - CHART_PAD;
            return (
              <g key={t.index}>
                {metric === "cost" && t.cost > 0 ? (
                  COST_SEGS.map((s) => {
                    const segH = (t[s.key] / t.cost) * h;
                    yCursor -= segH;
                    return (
                      <rect
                        key={s.cls}
                        className={`turnbar ${s.cls}${hot}`}
                        x={bx}
                        y={yCursor}
                        width={bw}
                        height={segH}
                      />
                    );
                  })
                ) : (
                  <rect
                    className={`turnbar${hot}`}
                    x={bx}
                    y={H - CHART_PAD - h}
                    width={bw}
                    height={h}
                  />
                )}
                {flags.length > 0 && (
                  <rect
                    className="turn-signal"
                    x={bx}
                    y={H - CHART_PAD + 1.5}
                    width={bw}
                    height={3}
                  />
                )}
              </g>
            );
          })}
          {order === "rank" && n > 1 && (
            <path className="pareto-line" d={linePath(cum, xCenter, yShare)} />
          )}
          <YAxis max={max} y={y} format={(v) => fmtTurn(metric, v)} />
        </svg>
        {active && (
          <ChartTip x={active.x} pinned={pinned}>
            <TipHead>
              {order === "rank"
                ? `turn #${active.p.index + 1} · rank ${(hover?.i ?? 0) + 1}`
                : `turn #${active.p.index + 1}`}
            </TipHead>
            {order === "rank" ? (
              <TipRow
                label="cumulative"
                value={pct(cum[hover?.i ?? 0] ?? 0)}
                color="var(--data-clay)"
              />
            ) : null}
            <TipRow label="share" value={pct(shareOf(values[hover?.i ?? 0] ?? 0, metricTotal))} />
            <TipRow label="cost" value={usd(active.p.cost)} color="var(--signal)" />
            <TipRow label="tokens" value={count(active.p.ioTokens + active.p.cacheTokens)} />
            <TipRow label="calls" value={`${active.p.apiCalls} (${active.p.mainApiCalls} main)`} />
            {active.p.wallMs !== undefined ? (
              <TipRow label="time" value={duration(active.p.wallMs)} />
            ) : null}
            {metric === "cost" && active.p.cost > 0
              ? COST_SEGS.map((s) => (
                  <TipRow
                    key={s.cls}
                    label={s.label}
                    value={usd(active.p[s.key])}
                    color={s.color}
                  />
                ))
              : null}
            {turnCostShape(active.p) ? (
              <div className="tip-note">{turnCostShape(active.p)?.detail}</div>
            ) : null}
            {turnFlags(active.p).length > 0 ? (
              <div className="tip-note">⚠ {turnFlags(active.p).join(" · ")}</div>
            ) : null}
            {active.p.prompt ? (
              <div className="tip-note">{active.p.prompt.slice(0, 140)}</div>
            ) : null}
          </ChartTip>
        )}
      </div>
      <div className="axis">
        <span>turn 1</span>
        <span>turn {n}</span>
      </div>
      <div className="legend">
        {metric === "cost" &&
          COST_SEGS.map((s) => <LegendSwatch key={s.cls} cls={s.cls} label={s.label} />)}
        {order === "rank" && n > 1 && (
          <LegendLine cls="pareto-line" label="cumulative share (Pareto, 0–100%)" />
        )}
        {flagged > 0 && (
          <LegendSwatch
            cls="turn-signal"
            label={`flagged turn (${flagged}) — interruption, correction, retry, test failure, re-read, or tool error`}
          />
        )}
      </div>
      <ChartData
        labelHeading="Turn"
        valueHeading={metric}
        labels={ordered.map((t) => `#${t.index + 1}`)}
        values={values}
        format={(v) => fmtTurn(metric, v)}
      />
    </>
  );
}

/** Step-kind groups for the tool-activity bars; the rest fold into "other".
 *  `color` mirrors each group's fill in styles.css. */
const KIND_GROUPS = [
  { key: "run", cls: "tk-run", color: "var(--signal)" },
  { key: "read", cls: "tk-read", color: "var(--teal)" },
  { key: "edit", cls: "tk-edit", color: "var(--data-violet)" },
  { key: "search", cls: "tk-search", color: "var(--data-blue)" },
] as const;
/** The "other" fold that closes the group list (its own colour). */
const KIND_OTHER = { key: "other", cls: "tk-other", color: "var(--data-neutral)" } as const;

/** Fold a turn's kindCounts into the chart's five groups (order preserved). */
function groupCounts(kindCounts: Record<string, number>): number[] {
  const grouped = KIND_GROUPS.map((g) => kindCounts[g.key] ?? 0);
  const named = grouped.reduce((s, v) => s + v, 0);
  const total = Object.values(kindCounts).reduce((s, v) => s + v, 0);
  return [...grouped, total - named];
}

function ToolActivity({ turns }: { turns: TurnPoint[] }) {
  const n = turns.length;
  const H = 160;
  // Identical on every render while `turns` is stable (it's memoized
  // upstream) — don't re-fold thousands of kind maps per re-render.
  const { perTurn, totals, max } = useMemo(() => {
    const perTurn = turns.map((t) => groupCounts(t.kindCounts));
    const totals = perTurn.map((g) => g.reduce((s, v) => s + v, 0));
    return { perTurn, totals, max: Math.max(...totals, 1) };
  }, [turns]);
  const slot = (CHART_W - CHART_PAD * 2) / n;
  const gap = Math.min(2, slot * 0.2);
  const y = (v: number) => H - CHART_PAD - (v / max) * (H - CHART_PAD * 2);
  const legend = [...KIND_GROUPS, KIND_OTHER];
  const xCenter = (i: number) => CHART_PAD + i * slot + slot / 2;
  const { hover, pinned, bind } = usePointerIndex(n, barLocate(n, slot));
  const active = activeAt(hover, turns, n, xCenter);
  const hgroups = active ? (perTurn[active.i] ?? []) : [];
  const htotal = active ? (totals[active.i] ?? 0) : 0;
  return (
    <>
      <div className="trend-head">
        <h2>Tool activity</h2>
        <span className="muted">operation steps per turn, by kind</span>
      </div>
      <div className="chart-wrap">
        <svg
          className="burnchart"
          viewBox={`0 0 ${CHART_W} ${H}`}
          style={chartBox(CHART_W, H)}
          role="img"
          aria-label={`Per-turn tool activity stacked bar chart across ${n} turns, busiest ${max} steps`}
          {...bind}
        >
          <title>Per-turn tool activity</title>
          {turns.map((t, i) => {
            const groups = perTurn[i] ?? [];
            const total = totals[i] ?? 0;
            if (total === 0) return null;
            const h = Math.max((total / max) * (H - CHART_PAD * 2), 1.5);
            const bx = CHART_PAD + i * slot + gap / 2;
            const bw = Math.max(slot - gap, 1);
            const hot = i === hover?.i ? " hot" : "";
            let yCursor = H - CHART_PAD;
            return (
              <g key={t.index}>
                {legend.map((g, gi) => {
                  const v = groups[gi] ?? 0;
                  if (v === 0) return null;
                  const segH = (v / total) * h;
                  yCursor -= segH;
                  return (
                    <rect
                      key={g.key}
                      className={`turnbar ${g.cls}${hot}`}
                      x={bx}
                      y={yCursor}
                      width={bw}
                      height={segH}
                    />
                  );
                })}
              </g>
            );
          })}
          <YAxis max={max} y={y} format={(v) => count(Math.round(v))} />
        </svg>
        {active && htotal > 0 && (
          <ChartTip x={active.x} pinned={pinned}>
            <TipHead>{`turn #${active.p.index + 1} · ${htotal} steps`}</TipHead>
            {legend.map((g, gi) =>
              (hgroups[gi] ?? 0) > 0 ? (
                <TipRow
                  key={g.key}
                  label={g.key}
                  value={count(hgroups[gi] ?? 0)}
                  color={g.color}
                  keyKind="swatch"
                />
              ) : null,
            )}
            {active.p.toolErrors > 0 ? (
              <TipRow
                label="tool errors"
                value={count(active.p.toolErrors)}
                color="var(--red)"
                keyKind="swatch"
              />
            ) : null}
          </ChartTip>
        )}
      </div>
      <div className="axis">
        <span>turn 1</span>
        <span>turn {n}</span>
      </div>
      <div className="legend">
        {legend.map((g) => (
          <LegendSwatch key={g.key} cls={g.cls} label={g.key} />
        ))}
      </div>
      <ChartData
        labelHeading="Turn"
        valueHeading="Steps"
        labels={turns.map((t) => `#${t.index + 1}`)}
        values={totals}
        format={(v) => count(Math.round(v))}
      />
    </>
  );
}

function ModelMixPanel({ rows }: { rows: SessionModelRow[] }) {
  const max = Math.max(...rows.map((r) => r.cost), 1e-9);
  return (
    <div className="tablewrap">
      <table>
        <thead>
          <tr>
            <th>Model</th>
            <th className="num">Calls</th>
            <th className="num">Cost</th>
            <th className="num">Share</th>
            <th aria-label="Cost bar" />
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.model}>
              <td>{r.model}</td>
              <td className="num">{count(r.apiCalls)}</td>
              <td className="num">{usd(r.cost)}</td>
              <td className="num">{pct(r.share)}</td>
              <td>
                <div className="bar">
                  <span style={{ width: `${(r.cost / max) * 100}%` }} />
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SidechainBursts({
  bursts,
  onGoToTurn,
}: {
  bursts: SidechainBurst[];
  onGoToTurn?: (turnIndex: number) => void;
}) {
  return (
    <>
      <div className="tablewrap">
        <table>
          <thead>
            <tr>
              <th className="num">#</th>
              <th>Type</th>
              <th className="num">Turn</th>
              <th className="num">Calls</th>
              <th className="num">Cost</th>
            </tr>
          </thead>
          <tbody>
            {bursts.map((b, i) => {
              const turn = b.turnIndex;
              return (
                // biome-ignore lint/suspicious/noArrayIndexKey: bursts are order-stable
                <tr key={i}>
                  <td className="num">{i + 1}</td>
                  <td>{b.subagentType ?? "(unmatched)"}</td>
                  <td className="num">
                    {turn === undefined ? (
                      "-"
                    ) : onGoToTurn ? (
                      <button
                        type="button"
                        className="row-button"
                        title={`Open turn #${turn + 1} in the Turns tab`}
                        onClick={() => onGoToTurn(turn)}
                      >
                        #{turn + 1}
                      </button>
                    ) : (
                      `#${turn + 1}`
                    )}
                  </td>
                  <td className="num">{count(b.apiCalls)}</td>
                  <td className="num">{usd(b.cost)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="muted">subagent types are matched best-effort from spawn prompts</p>
    </>
  );
}
