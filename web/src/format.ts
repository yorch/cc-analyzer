export function usd(n: number): string {
  const digits = n !== 0 && Math.abs(n) < 0.01 ? 4 : Math.abs(n) < 1000 ? 2 : 0;
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(n);
}

export function count(n: number): string {
  if (n < 1000) return String(n);
  return new Intl.NumberFormat(undefined, {
    notation: "compact",
    maximumFractionDigits: n >= 1_000_000_000 ? 2 : 1,
  }).format(n);
}

import type { TokenCounts } from "./api.ts";

/** Token count next to a cost: "213M" or "213M +52B cache". */
export function tokens(io: number, cache: number): string {
  const base = count(io);
  return cache > 0 ? `${base} +${count(cache)} cache` : base;
}

export const ioOf = (t: TokenCounts): number => t.inputTokens + t.outputTokens;
export const cacheOf = (t: TokenCounts): number =>
  t.cacheWrite5mTokens + t.cacheWrite1hTokens + t.cacheReadTokens;
/** Token label from a TokenCounts: "213M +52B cache". */
export const tokensOf = (t: TokenCounts): string => tokens(ioOf(t), cacheOf(t));

export function duration(ms?: number): string {
  if (ms === undefined || Number.isNaN(ms)) return "-";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d`;
}

export function relTime(ms: number): string {
  const diff = Date.now() - ms;
  const min = Math.floor(diff / 60000);
  if (min < 60) return `${Math.max(min, 0)}m ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return date(ms);
}

export function date(value: number | string): string {
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(new Date(value));
}

export function shortPath(p: string | null | undefined, fallback = "?"): string {
  if (!p) return fallback;
  const parts = p.split("/").filter(Boolean);
  return parts.length <= 2 ? p : `…/${parts.slice(-2).join("/")}`;
}
