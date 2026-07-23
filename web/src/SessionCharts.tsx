import { useMemo, useState } from "react";
import {
  type BurnPoint,
  buildBurnSeries,
  buildContextSeries,
  buildTurnSeries,
  type Compaction,
  type ContextSeries,
  type SessionAnalysis,
  summarizeCompactions,
  type TurnPoint,
} from "./api.ts";
import { count, duration, usd } from "./format.ts";
import { Seg } from "./Seg.tsx";
import {
  areaPath,
  CHART_PAD,
  CHART_W,
  fmt,
  linePath,
  MAX_LINE_DOTS,
  xScale,
} from "./trend-charts.tsx";

/** Session-scoped charts: context-window fill (with compaction markers),
 * cumulative burn, and per-turn bars. Series come from core `chart-series.ts`
 * so these numbers match the TUI charts exactly. */
export function SessionCharts({ a }: { a: SessionAnalysis }) {
  const ctx = useMemo(() => buildContextSeries(a), [a]);
  const burn = useMemo(() => buildBurnSeries(a), [a]);
  const turns = useMemo(() => buildTurnSeries(a), [a]);

  if (a.turns.length === 0) {
    return <p className="muted">No turns to chart in this session.</p>;
  }

  return (
    <>
      <section className="trend-panel">
        <div className="trend-head">
          <h2>Context window</h2>
          <span className="muted">
            prompt-side tokens per main-chain API call · dashed line = compaction
          </span>
        </div>
        <ContextChart ctx={ctx} compactions={a.compactions} />
      </section>

      <section className="trend-panel">
        <div className="trend-head">
          <h2>Cumulative cost</h2>
          <span className="muted">running total across every API call</span>
        </div>
        <BurnChart points={burn} />
      </section>

      <section className="trend-panel">
        <TurnBars turns={turns} />
      </section>
    </>
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

function ContextChart({ ctx, compactions }: { ctx: ContextSeries; compactions: Compaction[] }) {
  const { points, markers, peakTokens, contextLimit } = ctx;
  // The one canonical split: own vs subagent vs inherited (see chart-series.ts).
  const b = summarizeCompactions(compactions);
  const n = points.length;
  if (n === 0) return <p className="muted">No main-chain API calls in this session.</p>;
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
  const markerX = (pos: number) =>
    pos <= 0 ? CHART_PAD : pos >= n ? CHART_W - CHART_PAD : (x(pos - 1) + x(pos)) / 2;
  return (
    <>
      <p className="muted">
        peak {count(peakTokens)} tokens
        {contextLimit
          ? ` (${Math.round((peakTokens / contextLimit) * 100)}% of the ${count(contextLimit)} window)`
          : ""}{" "}
        · {triggerLabel(b.triggers, b.own.length)}
        {b.own.length > markers.length && " (some without timestamps, not placed)"}
        {b.inherited > 0 && " · started post-compaction (inherited boundary, not marked)"}
        {b.sidechain > 0 && ` · ${b.sidechain} in subagents (own context windows, not marked)`}
      </p>
      <svg
        className="burnchart"
        viewBox={`0 0 ${CHART_W} ${H}`}
        preserveAspectRatio="none"
        role="img"
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
            )}${m.compaction.preTokens ? ` · ${count(m.compaction.preTokens)} tokens before` : ""}`}</title>
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
            >
              <title>{`call ${i + 1} · turn #${p.turnIndex + 1} · +${offset(p.ms)}\n${count(
                p.contextTokens,
              )} context${
                p.limit ? ` (${Math.round((p.contextTokens / p.limit) * 100)}% of window)` : ""
              } (${count(p.cachedTokens)} cached) · ${count(p.outputTokens)} out · ${usd(
                p.cost,
              )}${p.model ? ` · ${p.model}` : ""}`}</title>
            </circle>
          ))}
      </svg>
      <div className="axis">
        <span>call 1</span>
        <span>call {n}</span>
      </div>
    </>
  );
}

function BurnChart({ points }: { points: BurnPoint[] }) {
  const n = points.length;
  if (n === 0) return <p className="muted">No API calls in this session.</p>;
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
  return (
    <>
      <p className="muted">
        {usd(last.cost)} total
        {last.sidechainCost > 0 ? ` · ${usd(last.sidechainCost)} on subagents (teal)` : ""}
      </p>
      <svg
        className="burnchart"
        viewBox={`0 0 ${CHART_W} ${H}`}
        preserveAspectRatio="none"
        role="img"
      >
        <title>Cumulative session cost</title>
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
    </>
  );
}

type TurnMetric = "cost" | "tokens" | "calls";

const turnValue = (t: TurnPoint, m: TurnMetric): number =>
  m === "cost" ? t.cost : m === "tokens" ? t.ioTokens + t.cacheTokens : t.apiCalls;

function TurnBars({ turns }: { turns: TurnPoint[] }) {
  const [metric, setMetric] = useState<TurnMetric>("cost");
  const n = turns.length;
  const H = 160;
  const values = turns.map((t) => turnValue(t, metric));
  const max = Math.max(...values, 1e-9);
  const peakIdx = values.reduce((best, v, i) => (v > (values[best] ?? -1) ? i : best), 0);
  const slot = (CHART_W - CHART_PAD * 2) / n;
  const gap = Math.min(2, slot * 0.2);
  return (
    <>
      <div className="trend-head">
        <h2>Per turn</h2>
        <span className="seg-group">
          metric <Seg options={["cost", "tokens", "calls"]} value={metric} onChange={setMetric} />
        </span>
      </div>
      <p className="muted">
        peak {fmt(metric, values[peakIdx] ?? 0)} (turn #{(turns[peakIdx]?.index ?? 0) + 1} ·{" "}
        {turns[peakIdx]?.prompt.slice(0, 60) || "no text"})
      </p>
      <svg
        className="burnchart"
        viewBox={`0 0 ${CHART_W} ${H}`}
        preserveAspectRatio="none"
        role="img"
      >
        <title>Per-turn {metric}</title>
        {turns.map((t, i) => {
          const v = values[i] ?? 0;
          const h = v > 0 ? Math.max((v / max) * (H - CHART_PAD * 2), 1.5) : 0;
          return (
            <rect
              key={t.index}
              className="turnbar"
              x={CHART_PAD + i * slot + gap / 2}
              y={H - CHART_PAD - h}
              width={Math.max(slot - gap, 1)}
              height={h}
            >
              <title>{`#${t.index + 1} · ${usd(t.cost)} · ${count(
                t.ioTokens + t.cacheTokens,
              )} tokens · ${t.apiCalls} calls (${t.mainApiCalls} main)\n${t.prompt || "(no text)"}`}</title>
            </rect>
          );
        })}
      </svg>
      <div className="axis">
        <span>turn 1</span>
        <span>turn {n}</span>
      </div>
    </>
  );
}
