import { useMemo, useState } from "react";
import {
  type BurnPoint,
  buildBurnSeries,
  buildContextSeries,
  buildTurnSeries,
  type Compaction,
  type ContextSeries,
  type SessionAnalysis,
  type TurnPoint,
} from "./api.ts";
import { count, duration, usd } from "./format.ts";
import { Seg } from "./Seg.tsx";

const W = 900;
const PAD = 6;
/** Past this many points, per-point hover dots would drown the chart. */
const MAX_DOTS = 366;

const xScale = (n: number) => (i: number) => (n <= 1 ? W / 2 : PAD + (i / (n - 1)) * (W - PAD * 2));

function linePath(values: number[], x: (i: number) => number, y: (v: number) => number): string {
  return values
    .map((v, i) => `${i === 0 ? "M" : "L"} ${x(i).toFixed(1)},${y(v).toFixed(1)}`)
    .join(" ");
}

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

function ContextChart({ ctx, compactions }: { ctx: ContextSeries; compactions: Compaction[] }) {
  const { points, markers, peakTokens } = ctx;
  const totalCompactions = compactions.length;
  const n = points.length;
  if (n === 0) return <p className="muted">No main-chain API calls in this session.</p>;
  const H = 220;
  const max = Math.max(peakTokens, 1);
  const x = xScale(n);
  const y = (v: number) => H - PAD - (v / max) * (H - PAD * 2);
  const values = points.map((p) => p.contextTokens);
  const line = linePath(values, x, y);
  const area = `M ${x(0).toFixed(1)},${H} ${line.replace(/^M/, "L")} L ${x(n - 1).toFixed(1)},${H} Z`;
  const t0 = points.find((p) => p.ms !== undefined)?.ms;
  const offset = (ms?: number) => (ms !== undefined && t0 !== undefined ? duration(ms - t0) : "?");
  // A marker sits between the last pre-compaction call and the first one after.
  const markerX = (pos: number) =>
    pos <= 0 ? PAD : pos >= n ? W - PAD : (x(pos - 1) + x(pos)) / 2;
  const triggers = compactions
    .map((c) => c.trigger ?? "unknown")
    .reduce<Record<string, number>>((acc, t) => {
      acc[t] = (acc[t] ?? 0) + 1;
      return acc;
    }, {});
  return (
    <>
      <p className="muted">
        peak {count(peakTokens)} tokens ·{" "}
        {totalCompactions === 0
          ? "no compactions"
          : Object.entries(triggers)
              .map(([t, c]) => `${c} ${t}`)
              .join(" + ")
              .concat(" compaction", totalCompactions > 1 ? "s" : "")}
        {totalCompactions > markers.length ? " (some without timestamps, not placed)" : ""}
      </p>
      <svg className="burnchart" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img">
        <title>Context-window tokens per call</title>
        <path className="burn-area" d={area} />
        <path className="burn-line" d={line} />
        {markers.map((m, mi) => (
          <line
            // biome-ignore lint/suspicious/noArrayIndexKey: markers are order-stable
            key={mi}
            className="ctx-marker"
            x1={markerX(m.pos)}
            x2={markerX(m.pos)}
            y1={PAD}
            y2={H - PAD}
          >
            <title>{`compaction (${m.compaction.trigger ?? "unknown trigger"}) · +${offset(
              m.compaction.timestamp ? Date.parse(m.compaction.timestamp) : undefined,
            )}${m.compaction.preTokens ? ` · ${count(m.compaction.preTokens)} tokens before` : ""}`}</title>
          </line>
        ))}
        {n <= MAX_DOTS &&
          points.map((p) => (
            <circle key={p.index} className="dot" cx={x(p.index)} cy={y(p.contextTokens)} r={3.5}>
              <title>{`call ${p.index + 1} · turn #${p.turnIndex + 1} · +${offset(p.ms)}\n${count(
                p.contextTokens,
              )} context (${count(p.cachedTokens)} cached) · ${count(p.outputTokens)} out · ${usd(
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
  const y = (v: number) => H - PAD - (v / max) * (H - PAD * 2);
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
      <svg className="burnchart" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img">
        <title>Cumulative session cost</title>
        <path className="burn-line" d={total} />
        {side && <path className="burn-line side" d={side} />}
        {n <= MAX_DOTS &&
          points.map((p) => (
            <circle key={p.index} className="dot" cx={x(p.index)} cy={y(p.cost)} r={3.5}>
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

const fmtTurn = (m: TurnMetric, v: number): string =>
  m === "cost" ? usd(v) : count(Math.round(v));

function TurnBars({ turns }: { turns: TurnPoint[] }) {
  const [metric, setMetric] = useState<TurnMetric>("cost");
  const n = turns.length;
  const H = 160;
  const values = turns.map((t) => turnValue(t, metric));
  const max = Math.max(...values, 1e-9);
  const peakIdx = values.reduce((best, v, i) => (v > (values[best] ?? -1) ? i : best), 0);
  const slot = (W - PAD * 2) / n;
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
        peak {fmtTurn(metric, values[peakIdx] ?? 0)} (turn #{(turns[peakIdx]?.index ?? 0) + 1} ·{" "}
        {turns[peakIdx]?.prompt.slice(0, 60) || "no text"})
      </p>
      <svg className="burnchart" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img">
        <title>Per-turn {metric}</title>
        {turns.map((t, i) => {
          const v = values[i] ?? 0;
          const h = v > 0 ? Math.max((v / max) * (H - PAD * 2), 1.5) : 0;
          return (
            <rect
              key={t.index}
              className="turnbar"
              x={PAD + i * slot + gap / 2}
              y={H - PAD - h}
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
