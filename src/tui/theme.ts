/**
 * Amber-phosphor design system for the TUI.
 *
 * Single source of palette + semantic roles so screens reference intent
 * ("cost", "heading", "ok") rather than raw hex. Colors are hex strings; Ink
 * hands them to chalk, which auto-downsamples to 256/16-color on weaker
 * terminals (amber → yellow), so the identity degrades gracefully rather than
 * breaking. There is no painted full-screen background — a terminal shows its
 * own — so the phosphor look comes from amber foregrounds, borders, and the
 * inverse selection bar.
 *
 * Inherited from the docs-site "amber phosphor" theme
 * (site/.vitepress/theme/custom.css).
 */

import type { StepKind } from "../core/steps.ts";
import type { TranscriptKind } from "../core/transcript.ts";

export const palette = {
  amber: "#ffb454", // bright phosphor — headings, accents, selection
  amberHi: "#ffc978", // highlight / hover
  amberDim: "#d7a24a", // cost figures, links
  ink: "#e7d6ad", // body copy — warm parchment
  ink2: "#b09a6d", // secondary text
  ink3: "#7c6f4f", // muted / comments / dim
  green: "#74d68a", // ok ticks (used sparingly)
  red: "#ff6b5e", // errors
  blue: "#7fb0e0", // tool results / web
  magenta: "#d79ee0", // skills / models
  line: "#2a2a1f", // borders / rules
  bg: "#0b0c0a", // near-black — used only as the selection foreground
} as const;

/** Intent-named roles. Screens use these, not raw palette entries. */
export const role = {
  heading: palette.amber,
  cost: palette.amberDim,
  body: palette.ink,
  muted: palette.ink3,
  ok: palette.green,
  error: palette.red,
  accent: palette.amber,
  border: palette.line,
} as const;

export interface SelectionStyle {
  color?: string;
  backgroundColor?: string;
}

/**
 * Props for a selectable row: amber inverse when selected, default otherwise.
 * Paired with `gutter()` this replaces the old flat `backgroundColor="cyan"` on
 * a bare text run, which only tinted the text width and left a ragged highlight.
 */
export function selection(selected: boolean): SelectionStyle {
  return selected ? { color: palette.bg, backgroundColor: palette.amber } : {};
}

/** Leading marker for a selectable row: "❯ " when selected, blanks otherwise. */
export function gutter(selected: boolean): string {
  return selected ? "❯ " : "  ";
}

const SPARK = "▁▂▃▄▅▆▇█";
const SPARK_FLOOR = SPARK[0] ?? " ";

/** One-char-per-value block sparkline; "" for no data. */
export function sparkline(values: number[]): string {
  if (values.length === 0) return "";
  const max = Math.max(...values);
  if (max <= 0) return SPARK_FLOOR.repeat(values.length);
  const last = SPARK.length - 1;
  return values
    .map((v) => SPARK[Math.round((Math.max(0, v) / max) * last)] ?? SPARK_FLOOR)
    .join("");
}

/** Proportional block bar, up to `width` cells wide. */
export function bar(value: number, max: number, width = 16): string {
  if (max <= 0) return "";
  const filled = Math.round((Math.max(0, value) / max) * width);
  return "█".repeat(Math.max(0, Math.min(width, filled)));
}

export const STEP_ICON: Record<StepKind, string> = {
  note: "»",
  thinking: "◦",
  run: "$",
  read: "▤",
  edit: "✎",
  search: "⌕",
  skill: "◆",
  subagent: "⌥",
  web: "◍",
  task: "☑",
  ask: "?",
  tool: "·",
};

export const STEP_COLOR: Record<StepKind, string> = {
  note: palette.ink,
  thinking: palette.ink3,
  run: palette.amber,
  read: palette.ink3,
  edit: palette.amberHi,
  search: palette.amber,
  skill: palette.magenta,
  subagent: palette.blue,
  web: palette.blue,
  task: palette.ink3,
  ask: palette.amber,
  tool: palette.ink3,
};

export const KIND_COLOR: Record<TranscriptKind, string> = {
  prompt: palette.amber,
  text: palette.ink,
  thinking: palette.ink3,
  tool_use: palette.amberHi,
  tool_result: palette.blue,
};
