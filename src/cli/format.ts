/** Human-friendly formatting helpers for terminal output. */

export function formatUSD(n: number): string {
  if (!Number.isFinite(n)) return "-";
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  if (abs === 0) return "$0.00";
  if (abs < 0.01) return `${sign}$${abs.toFixed(4)}`;
  return `${sign}$${abs.toFixed(2)}`;
}

export function formatCount(n: number): string {
  if (!Number.isFinite(n)) return "-";
  if (n < 1000) return String(n);
  // Bucket on the rounded value so 999_960 renders as "1.0M", not "1000.0k".
  if (Math.round(n / 100) < 10_000) return `${(n / 1000).toFixed(1)}k`;
  if (Math.round(n / 100_000) < 10_000) return `${(n / 1_000_000).toFixed(1)}M`;
  return `${(n / 1_000_000_000).toFixed(2)}B`;
}

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

export function formatDuration(ms: number | undefined): string {
  if (ms === undefined || Number.isNaN(ms)) return "-";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
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

/** Render a simple aligned text table. */
export function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const pad = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i] ?? 0)).join("  ");
  const sep = widths.map((w) => "-".repeat(w)).join("  ");
  return [pad(headers), sep, ...rows.map(pad)].join("\n");
}

export function truncate(s: string, max: number): string {
  const clean = s.replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}
