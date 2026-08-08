/**
 * Shared pointer-interaction layer for the SVG charts.
 *
 * Every chart in the SPA is hand-rolled inline SVG (no charting library — the
 * app ships as one self-contained file). This module is the one place the
 * "hover to read a value" behaviour lives, so all charts respond to the pointer
 * the same way: a crosshair that snaps to the nearest data position on line and
 * area charts, a per-mark hit test on bars/cells/dots, an emphasized active
 * marker, and a themed tooltip that tracks the pointer and flips at the edges —
 * replacing the browser's native `<title>` tooltip (slow, unstyled, and dead on
 * dense charts whose dots are suppressed past `MAX_LINE_DOTS`).
 *
 * The tabular `<details>` fallback (`ChartData` in trend-charts.tsx) remains the
 * keyboard/no-JS path; this layer is a pointer-and-touch enhancement on top.
 *
 * Nothing here touches the core series math (`chart-series.ts`/`stats-types.ts`)
 * — it is presentation only, so the TUI/web number parity is unaffected.
 */

import { type ReactNode, useEffect, useRef, useState } from "react";
import { CHART_PAD, CHART_W } from "./trend-charts.tsx";

/** A resolved hover over an index-based chart: which point. The anchor x is
 *  intentionally *not* stored — a shared cursor drives two charts whose scales
 *  differ, so each render site recomputes x on its own scale via `activeAt`. */
export interface IndexHover {
  i: number;
}

/** Controlled-state seam: pass a lifted `useState` tuple to share one hover
 *  across charts (the context/cache session charts sync this way). */
export type HoverController = [IndexHover | null, (h: IndexHover | null) => void];

/** Clamp `v` into [lo, hi]. */
export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/** Convert a pointer event's clientX into the chart's viewBox x-coordinate.
 *  The SVG is `width:100%` with a viewBox whose aspect ratio matches the
 *  element (see `chartBox`), so there is no horizontal letterboxing and the
 *  fraction across the element maps straight onto the viewBox width. Shared so
 *  the line charts and the brush handler map coordinates the one same way. */
export function viewBoxX(
  e: { clientX: number; currentTarget: Element },
  width: number,
): number | null {
  const r = e.currentTarget.getBoundingClientRect();
  if (r.width === 0) return null;
  return ((e.clientX - r.left) / r.width) * width;
}

/** Nearest data index for a value chart whose points sit on `xScale` — the
 *  inverse of that scale, rounded to the closest point. */
export const lineLocate =
  (n: number, width = CHART_W, pad = CHART_PAD) =>
  (px: number): number =>
    n <= 1 ? 0 : clamp(Math.round(((px - pad) / (width - pad * 2)) * (n - 1)), 0, n - 1);

/** Nearest bar index for a slot-packed bar chart: which slot the pointer is
 *  over (the mark is the hit target, per the interaction spec). */
export const barLocate =
  (n: number, slot: number, pad = CHART_PAD) =>
  (px: number): number =>
    clamp(Math.floor((px - pad) / slot), 0, Math.max(n - 1, 0));

/**
 * Pointer tracking for an index-based chart (line, area, or bars).
 *
 * `locate(px)` maps a viewBox x onto a data index; render sites turn that index
 * back into an anchor x on their own scale via `activeAt`. Pass `controller` to
 * drive a lifted state instead of the hook's own — that is how two charts
 * sharing an axis show one synchronized cursor. `unpin()` releases a pin (and
 * clears the hover), for callers that must drop it on a state change such as a
 * brush-zoom or a series switch.
 */
export function usePointerIndex(
  n: number,
  locate: (px: number) => number,
  width = CHART_W,
  controller?: HoverController,
): {
  hover: IndexHover | null;
  pinned: boolean;
  unpin: () => void;
  bind: {
    onPointerMove: (e: React.PointerEvent<SVGSVGElement>) => void;
    onPointerLeave: () => void;
    onPointerDown: (e: React.PointerEvent<SVGSVGElement>) => void;
    onClick: (e: React.PointerEvent<SVGSVGElement>) => void;
  };
} {
  const own = useState<IndexHover | null>(null);
  const [hover, setHover] = controller ?? own;
  // Pinning freezes the tooltip so it can be read (or two compared) without
  // holding the pointer still. Disabled under a shared controller, where the
  // synced sibling's pointer-leave would clear a pin the other chart set.
  const [pinned, setPinned] = useState(false);
  const pinnable = !controller;
  const update = (e: React.PointerEvent<SVGSVGElement>) => {
    if (n === 0) return;
    // A pinned tooltip is frozen at its point: pointer moves don't shift it.
    if (pinnable && pinned) return;
    const px = viewBoxX(e, width);
    if (px === null) return;
    const i = locate(px);
    // Skip the state write when the snapped index hasn't changed, so a slow
    // drag across one point's span doesn't rerender on every pixel.
    if (hover && hover.i === i) return;
    setHover({ i });
  };
  const unpin = () => {
    if (pinnable && pinned) setPinned(false);
    setHover(null);
  };
  return {
    hover,
    pinned: pinnable && pinned,
    unpin,
    bind: {
      onPointerMove: update,
      // A tap/drag on touch reads the value too — pointerdown seeds it.
      onPointerDown: update,
      onPointerLeave: () => {
        if (!(pinnable && pinned)) setHover(null);
      },
      onClick: (e) => {
        if (!pinnable) return;
        // Toggle: a click pins the point under the pointer; clicking again (or
        // on the pinned point) releases and clears.
        update(e);
        setPinned((p) => {
          if (p) setHover(null);
          return !p;
        });
      },
    },
  };
}

/**
 * Pointer tracking for a 2-D scatter: the nearest point by straight-line
 * distance, so the reader only has to be closest, not dead-center on an 8px
 * dot (the interaction spec's nearest-point layer).
 */
export function usePointerNearest<T>(
  points: readonly T[],
  xOf: (p: T) => number,
  yOf: (p: T) => number,
  width: number,
  height: number,
): {
  hover: number | null;
  bind: {
    onPointerMove: (e: React.PointerEvent<SVGSVGElement>) => void;
    onPointerLeave: () => void;
    onPointerDown: (e: React.PointerEvent<SVGSVGElement>) => void;
  };
} {
  const [hover, setHover] = useState<number | null>(null);
  // The nearest-point search is O(points); coalesce moves to one scan per
  // animation frame so a fast drag over a large scatter can't run the loop
  // dozens of times between paints.
  const frame = useRef(0);
  const pending = useRef<{ px: number; py: number } | null>(null);
  useEffect(
    () => () => {
      if (frame.current) cancelAnimationFrame(frame.current);
    },
    [],
  );
  const scan = () => {
    frame.current = 0;
    const at = pending.current;
    if (!at || points.length === 0) return;
    let best = -1;
    let bestD = Number.POSITIVE_INFINITY;
    for (let i = 0; i < points.length; i++) {
      const p = points[i] as T;
      const dx = xOf(p) - at.px;
      const dy = yOf(p) - at.py;
      const d = dx * dx + dy * dy;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    setHover((prev) => (prev === best ? prev : best));
  };
  const update = (e: React.PointerEvent<SVGSVGElement>) => {
    if (points.length === 0) return;
    const r = e.currentTarget.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return;
    pending.current = {
      px: ((e.clientX - r.left) / r.width) * width,
      py: ((e.clientY - r.top) / r.height) * height,
    };
    if (!frame.current) frame.current = requestAnimationFrame(scan);
  };
  const leave = () => {
    if (frame.current) {
      cancelAnimationFrame(frame.current);
      frame.current = 0;
    }
    pending.current = null;
    setHover(null);
  };
  return {
    hover,
    bind: {
      onPointerMove: update,
      onPointerDown: update,
      onPointerLeave: leave,
    },
  };
}

/** Resolve a hover into the active datum, its index, and its anchor x — one
 *  object so the render narrows cleanly (a value derived from `hover` alone does
 *  not narrow `hover` back to non-null). Guards a stale shared-cursor index and
 *  an out-of-range access. */
export function activeAt<T>(
  hover: IndexHover | null,
  arr: readonly T[],
  n: number,
  xOf: (i: number) => number,
): { i: number; x: number; p: T } | null {
  if (!hover || hover.i < 0 || hover.i >= n) return null;
  const p = arr[hover.i];
  return p === undefined ? null : { i: hover.i, x: xOf(hover.i), p };
}

/** A vertical hairline at `x`, drawn from `top` to `bottom` in viewBox units. */
export function Crosshair({
  x,
  top = CHART_PAD,
  bottom,
  pinned = false,
}: {
  x: number;
  top?: number;
  bottom: number;
  pinned?: boolean;
}) {
  return (
    <line className={`chart-cross${pinned ? " pinned" : ""}`} x1={x} x2={x} y1={top} y2={bottom} />
  );
}

/** The emphasized marker on the hovered point of a line/area chart. */
export function ActiveDot({ cx, cy, cls = "" }: { cx: number; cy: number; cls?: string }) {
  return <circle className={`dot active ${cls}`} cx={cx} cy={cy} r={4.5} />;
}

/**
 * The themed tooltip. Positioned as an HTML overlay inside a `.chart-wrap`
 * whose width equals the SVG's, so a viewBox x maps to a left-percentage that
 * lands on the crosshair. It anchors left, centered, or right depending on
 * where the pointer is, so it never spills past the chart edge.
 */
export function ChartTip({
  x,
  width = CHART_W,
  pinned = false,
  children,
}: {
  x: number;
  width?: number;
  pinned?: boolean;
  children: ReactNode;
}) {
  const frac = clamp(x / width, 0, 1);
  const side = frac > 0.66 ? "end" : frac < 0.34 ? "start" : "mid";
  const style =
    side === "end"
      ? { right: `${(1 - frac) * 100}%` }
      : side === "start"
        ? { left: `${frac * 100}%` }
        : { left: `${frac * 100}%`, transform: "translateX(-50%)" };
  return (
    <div
      className={`chart-tip ${side}${pinned ? " pinned" : ""}`}
      style={style}
      role="presentation"
    >
      {pinned ? <span className="tip-pin">📌 pinned — click to release</span> : null}
      {children}
    </div>
  );
}

/** Tooltip heading — the point's identity (call #, turn #, date…). */
export function TipHead({ children }: { children: ReactNode }) {
  return <div className="tip-head">{children}</div>;
}

/**
 * One tooltip row: an optional series key coloured to the mark, a muted label,
 * and the value as the strong element — the legend's hierarchy inverted,
 * because here the reader has the series and wants the number. `color` is a CSS
 * value (usually a `var(--…)`); it is applied inline so a row never has to know
 * a per-series class name.
 */
export function TipRow({
  label,
  value,
  color,
  keyKind = "line",
}: {
  label: string;
  value: ReactNode;
  color?: string;
  keyKind?: "line" | "swatch";
}) {
  return (
    <div className="tip-row">
      {color ? <span className={`tip-key ${keyKind}`} style={{ background: color }} /> : null}
      <span className="tip-lbl">{label}</span>
      <span className="tip-val">{value}</span>
    </div>
  );
}
