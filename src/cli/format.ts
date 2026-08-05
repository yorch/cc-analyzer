/**
 * Human-friendly formatting helpers for terminal output.
 *
 * Money, counts, and durations live in the bun-free `core/format-shared.ts` —
 * the digest's markdown and the web digest card print the same strings — and
 * are re-exported here so terminal call sites keep one import source.
 */

import { formatCount } from "../core/format-shared.ts";

export {
  formatCompactDuration,
  formatCount,
  formatDuration,
  formatSignedCount,
  formatSignedUSD,
  formatUSD,
  pct,
} from "../core/format-shared.ts";

/** Token count next to a cost: "213M" or "213M +52B cache". */
export function formatTokens(io: number, cache: number): string {
  const base = formatCount(io);
  return cache > 0 ? `${base} +${formatCount(cache)} cache` : base;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatRelativeTime(mtimeMs: number, now = Date.now()): string {
  const diff = now - mtimeMs;
  const min = Math.floor(diff / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(mtimeMs).toISOString().slice(0, 10);
}

export interface TableOptions {
  align?: Array<"left" | "right">;
}

/** Render a simple aligned text table, with optional numeric column alignment. */
export function table(headers: string[], rows: string[][], options: TableOptions = {}): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const pad = (cells: string[]) =>
    cells
      .map((c, i) =>
        options.align?.[i] === "right" ? c.padStart(widths[i] ?? 0) : c.padEnd(widths[i] ?? 0),
      )
      .join("  ");
  const sep = widths.map((w) => "-".repeat(w)).join("  ");
  return [pad(headers), sep, ...rows.map(pad)].join("\n");
}

export function truncate(s: string, max: number): string {
  const clean = s.replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}
