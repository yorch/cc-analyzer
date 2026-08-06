import { useMemo } from "react";
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
  modelMixRows,
  pct,
  pctOfLimit,
  projectHeadroom,
  type SessionAnalysis,
  type SessionModelRow,
  type SidechainBurst,
  summarizeCompactions,
  type TurnPoint,
  turnFlags,
} from "./api.ts";
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
        <ContextChart ctx={ctx} compactions={a.compactions} />
      </section>

      {ctx.points.length > 0 && (
        <section className="trend-panel">
          <div className="trend-head">
            <h2>Cache efficiency</h2>
            <span className="muted">share of each call's context served from cache</span>
          </div>
          <CacheChart cache={cache} />
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

function ContextChart({ ctx, compactions }: { ctx: ContextSeries; compactions: Compaction[] }) {
  const { points, markers, peakTokens, contextLimit } = ctx;
  // The one canonical split: own vs subagent vs inherited (see chart-series.ts).
  const b = summarizeCompactions(compactions);
  const headroom = projectHeadroom(ctx);
  const n = points.length;
  if (n === 0) return <EmptyNotice>No main-chain API calls in this session.</EmptyNotice>;
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
      <svg
        className="burnchart"
        viewBox={`0 0 ${CHART_W} ${H}`}
        style={chartBox(CHART_W, H)}
        role="img"
        aria-label={`Context-window token usage over ${n} API calls, peak ${count(peakTokens)} tokens`}
      >
        <title>Context-window tokens per call</title>
        <YAxis max={max} y={y} format={(v) => count(Math.round(v))} />
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
          points.map((p, i) => {
            const windowPct = contextLimit
              ? ` (${pctOfLimit(p.contextTokens, contextLimit)}% of window)`
              : "";
            return (
              <circle
                // biome-ignore lint/suspicious/noArrayIndexKey: call order is fixed
                key={i}
                className="dot"
                cx={x(i)}
                cy={y(p.contextTokens)}
                r={3.5}
              >
                <title>{`call ${i + 1} · turn #${p.turnIndex + 1} · +${offset(p.ms)}\n${count(
                  p.contextTokens,
                )} context${windowPct} (${count(p.cachedTokens)} cached) · ${count(
                  p.outputTokens,
                )} out · ${usd(p.cost)}${p.model ? ` · ${p.model}` : ""}`}</title>
              </circle>
            );
          })}
      </svg>
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
function CacheChart({ cache }: { cache: CacheSeries }) {
  const { points, hitPct, coldCalls } = cache;
  const n = points.length;
  if (n === 0) return <EmptyNotice>No main-chain API calls in this session.</EmptyNotice>;
  const H = 160;
  const x = xScale(n);
  const y = (pct: number) => H - CHART_PAD - (pct / 100) * (H - CHART_PAD * 2);
  const line = linePath(
    points.map((p) => p.hitPct),
    x,
    y,
  );
  return (
    <>
      <p className="muted">
        hit rate {hitPct}% (token-weighted) · {coldCalls} cold call{coldCalls === 1 ? "" : "s"}
      </p>
      <svg
        className="burnchart"
        viewBox={`0 0 ${CHART_W} ${H}`}
        style={chartBox(CHART_W, H)}
        role="img"
        aria-label={`Cache hit rate per API call, ${hitPct}% overall`}
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
            >
              <title>{`call ${i + 1} · turn #${p.turnIndex + 1}\n${count(p.cached)} cached / ${count(
                p.fresh,
              )} fresh · ${p.hitPct}% hit`}</title>
            </circle>
          ))}
      </svg>
      <div className="axis">
        <span>call 1 (y: 0–100%)</span>
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
  if (n === 0) return <EmptyNotice>No API calls in this session.</EmptyNotice>;
  const H = 160;
  const last = points[n - 1] as BurnPoint;
  const max = Math.max(last.cost, 1e-9);
  const x = xScale(n);
  const y = (v: number) => H - CHART_PAD - (v / max) * (H - CHART_PAD * 2);
  const total = linePath(
    points.map((p) => p.cost),
    x,
    y,
  );
  const side =
    last.sidechainCost > 0
      ? linePath(
          points.map((p) => p.sidechainCost),
          x,
          y,
        )
      : null;
  const t0 = points.find((p) => p.ms !== undefined)?.ms;
  const offset = (ms?: number) => (ms !== undefined && t0 !== undefined ? duration(ms - t0) : "?");
  const idleMs = gaps.reduce((s, g) => s + g.durationMs, 0);
  return (
    <>
      <p className="muted">
        {usd(last.cost)} total
        {last.sidechainCost > 0 ? ` · ${usd(last.sidechainCost)} on subagents` : ""}
        {gaps.length > 0 &&
          ` · ${gaps.length} idle gap${gaps.length > 1 ? "s" : ""} (${duration(idleMs)} idle)`}
      </p>
      <svg
        className="burnchart"
        viewBox={`0 0 ${CHART_W} ${H}`}
        style={chartBox(CHART_W, H)}
        role="img"
        aria-label={`Cumulative session cost over ${n} API calls, ${usd(last.cost)} total`}
      >
        <title>Cumulative session cost</title>
        <YAxis max={max} y={y} format={usd} />
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
            >
              <title>{`+${offset(p.ms)} · ${usd(p.cost)} so far (${usd(p.callCost)} this call${
                p.isSidechain ? ", sidechain" : ""
              })`}</title>
            </circle>
          ))}
      </svg>
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

/** The four cost categories, bottom-up in stacking order. */
const COST_SEGS = [
  { cls: "tb-input", key: "costInput", label: "input" },
  { cls: "tb-output", key: "costOutput", label: "output" },
  { cls: "tb-write", key: "costCacheWrite", label: "cache write" },
  { cls: "tb-read", key: "costCacheRead", label: "cache read" },
] as const;

function TurnBars({ turns }: { turns: TurnPoint[] }) {
  const metrics = ["cost", "tokens", "calls", "depth", "time"] as const;
  const [metric, setMetric] = useHashParam<TurnMetric>("turnMetric", "cost", metrics);
  const n = turns.length;
  const H = 160;
  const values = turns.map((t) => turnValue(t, metric));
  const max = Math.max(...values, 1e-9);
  const peakIdx = values.reduce((best, v, i) => (v > (values[best] ?? -1) ? i : best), 0);
  const slot = (CHART_W - CHART_PAD * 2) / n;
  const gap = Math.min(2, slot * 0.2);
  const y = (v: number) => H - CHART_PAD - (v / max) * (H - CHART_PAD * 2);
  const flagged = turns.filter((t) => turnFlags(t).length > 0).length;
  return (
    <>
      <div className="trend-head">
        <h2>Per turn</h2>
        <span className="seg-group">
          metric{" "}
          <Seg label="Turn bar metric" options={metrics} value={metric} onChange={setMetric} />
        </span>
      </div>
      <p className="muted">
        peak {fmtTurn(metric, values[peakIdx] ?? 0)} (turn #{(turns[peakIdx]?.index ?? 0) + 1} ·{" "}
        {turns[peakIdx]?.prompt.slice(0, 60) || "no text"})
      </p>
      <svg
        className="burnchart"
        viewBox={`0 0 ${CHART_W} ${H}`}
        style={chartBox(CHART_W, H)}
        role="img"
        aria-label={`Per-turn ${metric} bar chart across ${n} turns, peak ${fmtTurn(
          metric,
          values[peakIdx] ?? 0,
        )}`}
      >
        <title>Per-turn {metric}</title>
        <YAxis max={max} y={y} format={(v) => fmtTurn(metric, v)} />
        {turns.map((t, i) => {
          const v = values[i] ?? 0;
          const h = v > 0 ? Math.max((v / max) * (H - CHART_PAD * 2), 1.5) : 0;
          const bx = CHART_PAD + i * slot + gap / 2;
          const bw = Math.max(slot - gap, 1);
          const flags = turnFlags(t);
          const costSplit =
            metric === "cost"
              ? `\n${COST_SEGS.map((s) => `${s.label} ${usd(t[s.key])}`).join(" · ")}`
              : "";
          const title = `#${t.index + 1} · ${usd(t.cost)} · ${count(
            t.ioTokens + t.cacheTokens,
          )} tokens · ${t.apiCalls} calls (${t.mainApiCalls} main)${
            t.wallMs !== undefined ? ` · ${duration(t.wallMs)}` : ""
          }${costSplit}${flags.length > 0 ? `\n⚠ ${flags.join(" · ")}` : ""}\n${t.prompt || "(no text)"}`;
          let yCursor = H - CHART_PAD;
          return (
            <g key={t.index}>
              <title>{title}</title>
              {metric === "cost" && t.cost > 0 ? (
                COST_SEGS.map((s) => {
                  const segH = (t[s.key] / t.cost) * h;
                  yCursor -= segH;
                  return (
                    <rect
                      key={s.cls}
                      className={`turnbar ${s.cls}`}
                      x={bx}
                      y={yCursor}
                      width={bw}
                      height={segH}
                    />
                  );
                })
              ) : (
                <rect className="turnbar" x={bx} y={H - CHART_PAD - h} width={bw} height={h} />
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
      </svg>
      <div className="axis">
        <span>turn 1</span>
        <span>turn {n}</span>
      </div>
      <div className="legend">
        {metric === "cost" &&
          COST_SEGS.map((s) => <LegendSwatch key={s.cls} cls={s.cls} label={s.label} />)}
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
        labels={turns.map((t) => `#${t.index + 1}`)}
        values={values}
        format={(v) => fmtTurn(metric, v)}
      />
    </>
  );
}

/** Step-kind groups for the tool-activity bars; the rest fold into "other". */
const KIND_GROUPS = [
  { key: "run", cls: "tk-run" },
  { key: "read", cls: "tk-read" },
  { key: "edit", cls: "tk-edit" },
  { key: "search", cls: "tk-search" },
] as const;

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
  const legend = [
    ...KIND_GROUPS.map((g) => ({ key: g.key, cls: g.cls })),
    { key: "other", cls: "tk-other" },
  ];
  return (
    <>
      <div className="trend-head">
        <h2>Tool activity</h2>
        <span className="muted">operation steps per turn, by kind</span>
      </div>
      <svg
        className="burnchart"
        viewBox={`0 0 ${CHART_W} ${H}`}
        style={chartBox(CHART_W, H)}
        role="img"
        aria-label={`Per-turn tool activity stacked bar chart across ${n} turns, busiest ${max} steps`}
      >
        <title>Per-turn tool activity</title>
        <YAxis max={max} y={y} format={(v) => count(Math.round(v))} />
        {turns.map((t, i) => {
          const groups = perTurn[i] ?? [];
          const total = totals[i] ?? 0;
          if (total === 0) return null;
          const h = Math.max((total / max) * (H - CHART_PAD * 2), 1.5);
          const bx = CHART_PAD + i * slot + gap / 2;
          const bw = Math.max(slot - gap, 1);
          const breakdown = Object.entries(t.kindCounts)
            .sort((a, b) => b[1] - a[1])
            .map(([k, c]) => `${k} ${c}`)
            .join(" · ");
          let yCursor = H - CHART_PAD;
          return (
            <g key={t.index}>
              <title>{`#${t.index + 1} · ${total} steps\n${breakdown}${
                t.toolErrors > 0
                  ? ` · ${t.toolErrors} tool error${t.toolErrors === 1 ? "" : "s"}`
                  : ""
              }`}</title>
              {legend.map((g, gi) => {
                const v = groups[gi] ?? 0;
                if (v === 0) return null;
                const segH = (v / total) * h;
                yCursor -= segH;
                return (
                  <rect
                    key={g.key}
                    className={`turnbar ${g.cls}`}
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
      </svg>
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
