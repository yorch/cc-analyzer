/**
 * The one number-formatting family, shared by every renderer that isn't the
 * browser's `Intl` layer.
 *
 * Money, counts, and durations were independently re-implemented three times
 * (terminal renderer, weekly digest, web card) and drifted: one copy grew the
 * rounding-bucket fix below, another kept printing "1000.0k". This module is
 * the single source. It is **bun-free and pure** (like `stats-types.ts` /
 * `digest.ts`), so the CLI, the TUI, the digest's markdown, and the SPA can all
 * import it and print the same string for the same number.
 *
 * `src/cli/format.ts` re-exports these for terminal call sites; `web/src/format.ts`
 * keeps its own `Intl`-based, locale-aware helpers for the SPA's chrome — the
 * digest card imports these so its numbers match the markdown it copies.
 */

/** Formatting a delta rather than a magnitude: keep the sign, then abbreviate. */
export interface SignOptions {
  /**
   * Treat the value as signed: format its magnitude and prefix "-" when
   * negative. Off by default, which keeps plain counts (tokens, invocations —
   * never negative) rendering exactly as they always have.
   */
  signed?: boolean;
}

export function formatUSD(n: number): string {
  if (!Number.isFinite(n)) return "-";
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  if (abs === 0) return "$0.00";
  if (abs < 0.01) return `${sign}$${abs.toFixed(4)}`;
  return `${sign}$${abs.toFixed(2)}`;
}

function abbreviate(n: number): string {
  if (n < 1000) return String(n);
  // Bucket on the rounded value so 999_960 renders as "1.0M", not "1000.0k".
  if (Math.round(n / 100) < 10_000) return `${(n / 1000).toFixed(1)}k`;
  if (Math.round(n / 100_000) < 10_000) return `${(n / 1_000_000).toFixed(1)}M`;
  return `${(n / 1_000_000_000).toFixed(2)}B`;
}

export function formatCount(n: number, opts: SignOptions = {}): string {
  if (!Number.isFinite(n)) return "-";
  if (!opts.signed) return abbreviate(n);
  return n < 0 ? `-${abbreviate(-n)}` : abbreviate(n);
}

/** A count that may be a delta: `-30.0k` rather than `-30000`. */
export const formatSignedCount = (n: number): string => formatCount(n, { signed: true });

function durationOf(ms: number | undefined, seconds: boolean): string {
  if (ms === undefined || Number.isNaN(ms)) return "-";
  const sign = ms < 0 ? "-" : "";
  const s = Math.round(Math.abs(ms) / 1000);
  if (s < 60) return `${sign}${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return seconds ? `${sign}${m}m ${s % 60}s` : `${sign}${m}m`;
  return `${sign}${Math.floor(m / 60)}h ${m % 60}m`;
}

/** Duration with the leftover seconds in the minutes band ("3m 20s") — the
 * terminal form, where the extra precision is worth the width. */
export const formatDuration = (ms: number | undefined): string => durationOf(ms, true);

/** Duration rounded to whole minutes ("3m") — the compact form the digest and
 * the web cards use, where the column is a glance, not a measurement. */
export const formatCompactDuration = (ms: number | undefined): string => durationOf(ms, false);
