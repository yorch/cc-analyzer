/**
 * Weekly digest — shapes and pure builders.
 *
 * Everything else cc-analyzer computes is pull-based: the user has to go look.
 * The digest is the push-shaped view — one week of usage, what changed against
 * the week before, and what to fix — rendered as paste-ready markdown for
 * notes/Slack.
 *
 * This module is the bun-free half (like `stats-types.ts` /
 * `portfolio-diagnostics.ts`): plain shapes, period math, delta math, and the
 * markdown renderer. The bun-side assembler that reads the index lives in
 * `digest-signals.ts`. The SPA imports this module directly, so it can build
 * the exact same markdown the CLI prints — no extra endpoint.
 *
 * Scoping honesty: every period-scoped number here is *session-day-scoped* —
 * a session counts toward the period containing its start day (the `day`
 * column), with all of its cost, even if it ran past midnight. That is the
 * only attribution the index supports, and the rendered footer says so.
 */

import { type CostBasis, costFramingNote } from "./cost-framing.ts";
import { formatCompactDuration, formatSignedCount, formatUSD } from "./format-shared.ts";
import type { PortfolioDiagnostic } from "./portfolio-diagnostics.ts";
import type { CacheSummary, DayRange } from "./stats-types.ts";
import { CORRECTION_CAVEAT, SKILL_COST_CAVEAT, shiftDay, weekOf } from "./stats-types.ts";

/* ——— Period math ————————————————————————————————————————————————————
 * Periods are inclusive `DayRange`s (YYYY-MM-DD, oldest day first) — the same
 * shape the period-scoped rollups filter the `day` column with — and
 * Monday-anchored ISO weeks by default, off the same `weekOf`/`shiftDay` rules
 * the rest of the stats layer buckets weeks with, so a digest week and a trend
 * week are the same week. */

/** Whole ISO week (Mon–Sun) containing `day`. */
export function weekPeriod(day: string): DayRange {
  const start = weekOf(day);
  return { start, end: shiftDay(start, 6) };
}

/**
 * The last *complete* ISO week relative to `today` — i.e. the week before the
 * one `today` falls in. A digest of the current, half-finished week would
 * always look like a decline against a full prior week, so the default period
 * is only ever a week that has actually ended.
 */
export function lastCompleteWeek(today: string): DayRange {
  return weekPeriod(shiftDay(weekOf(today), -7));
}

/** Days in an inclusive period (1 for a single day, 7 for a week). */
export function periodDays(p: DayRange): number {
  const ms = Date.parse(`${p.end}T00:00:00Z`) - Date.parse(`${p.start}T00:00:00Z`);
  return Math.round(ms / 86_400_000) + 1;
}

/** The equally long period immediately before `p` — the digest's baseline. */
export function priorPeriod(p: DayRange): DayRange {
  const days = periodDays(p);
  return { start: shiftDay(p.start, -days), end: shiftDay(p.end, -days) };
}

/** True for a well-formed YYYY-MM-DD calendar day (the `--week` / `?week=` guard). */
export function isDayString(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/* ——— Delta math ——————————————————————————————————————————————————————
 * Every headline metric carries its prior-period value. `share` is null-safe
 * by design: with no prior activity there is no percentage to quote (a jump
 * from $0 is not "+∞%"), and render sites say "new" instead. */

export interface DigestDelta {
  current: number;
  prior: number;
  /** current − prior. */
  absolute: number;
  /** (current − prior) / prior; null when the prior period was empty (0). */
  share: number | null;
}

export function digestDelta(current: number, prior: number): DigestDelta {
  return {
    current,
    prior,
    absolute: current - prior,
    share: prior === 0 ? null : (current - prior) / prior,
  };
}

/* ——— Digest shapes ————————————————————————————————————————————————— */

export interface DigestHeadline {
  cost: DigestDelta;
  sessions: DigestDelta;
  activeMs: DigestDelta;
  ioTokens: DigestDelta;
  cacheTokens: DigestDelta;
}

export interface DigestProjectRow {
  projectId: string;
  projectPath: string | null;
  cost: number;
  sessions: number;
  /** Cost against the same project in the prior period. */
  delta: DigestDelta;
}

export interface DigestModelRow {
  model: string;
  /** API calls in the period — 0 for a model only the prior period ran. */
  calls: number;
  cost: number;
  priorCost: number;
}

/** Period cache economics. Literally `CacheSummary`, computed by the same
 * `cacheSummary()` query with the period's day filter — a second shape would be
 * a second place for the definition of "waste" to drift. */
export type DigestCache = CacheSummary;

/** Period reliability signals, all folded off the period's indexed rows. */
export interface DigestReliability {
  toolCalls: number;
  toolErrors: number;
  /** toolErrors / toolCalls; 0 when nothing ran. */
  toolErrorRate: number;
  testRuns: number;
  testFailures: number;
  retries: number;
  /** Worst consecutive failing-test streak in the period (thrash). */
  worstTestFailStreak: number;
  redundantReads: number;
  correctionTurns: number;
  interruptionTurns: number;
  turns: number;
  /** correctionTurns / turns; 0 when there are no turns. */
  correctionShare: number;
}

export interface DigestSkillRow {
  name: string;
  invocations: number;
  attributedTurns: number;
  attributedCost: number;
}

/** One week of usage, its deltas, and the current-state insight snapshot. */
export interface WeeklyDigest {
  period: DayRange;
  /** The equally long period the deltas compare against. */
  prior: DayRange;
  /** The local day the period was resolved from (`localDayOfMs(Date.now())`). */
  today: string;
  headline: DigestHeadline;
  /** Highest-cost projects in the period (≤ 5). */
  projects: DigestProjectRow[];
  /** Models used in EITHER period, ranked by the larger of the two costs — so
   *  a model dropped this week still appears, with 0 calls. */
  models: DigestModelRow[];
  cache: DigestCache;
  reliability: DigestReliability;
  /** Top skills by turn-scoped cost in the period (≤ 5). */
  skills: DigestSkillRow[];
  /**
   * Portfolio diagnostics computed on the WHOLE indexed portfolio, not on the
   * period: they are current-state findings ("your cache is leaky today"), and
   * a single week rarely carries enough evidence to fire the thresholds
   * honestly. Every render site labels them as current state.
   */
  insights: PortfolioDiagnostic[];
  /** Display-only framing preference; never changes a number, only its wording. */
  costBasis: CostBasis;
}

/** Sessions in the period, the number the "nothing happened" branch keys off. */
export function isEmptyPeriod(d: WeeklyDigest): boolean {
  return d.headline.sessions.current === 0;
}

/* ——— Markdown rendering ————————————————————————————————————————————
 * Plain CommonMark, no ANSI: the output is meant to be pasted into notes or
 * chat. Numbers go through the shared bun-free formatter family
 * (`format-shared.ts`) — the signed variants, since every delta cell can be
 * negative — so a digest cell and the same number in the CLI or the web card
 * are formatted identically. */

const pct = (share: number): string => `${share >= 0 ? "+" : ""}${(share * 100).toFixed(0)}%`;

/**
 * A delta as `+$1.90 (+18%)`. With no prior activity there is no percentage to
 * quote, so it reads `+$1.90 (new)`; an exactly flat metric reads "no change".
 */
export function formatDigestDelta(d: DigestDelta, fmt: (n: number) => string): string {
  if (d.absolute === 0) return "no change";
  const signed = `${d.absolute > 0 ? "+" : ""}${fmt(d.absolute)}`;
  return `${signed} (${d.share === null ? "new" : pct(d.share)})`;
}

/** The five labels of the summary table, in render order. Each renderer keeps
 * its own wording (the terminal's lowercase columns and cost noun, the
 * markdown's Title Case) — only the numbers are shared. */
export type DigestSummaryLabels = readonly [string, string, string, string, string];

/**
 * The summary table's rows as `[label, this period, prior, change]`. The
 * terminal renderer (`renderWeeklyDigest`) and the markdown one both build the
 * table from this, so a cell cannot read differently in `cc-analyzer report`
 * and in `report --md`.
 */
export function digestSummaryRows(d: WeeklyDigest, labels: DigestSummaryLabels): string[][] {
  const h = d.headline;
  const plain = (n: number): string => String(n);
  return [
    [
      labels[0],
      formatUSD(h.cost.current),
      formatUSD(h.cost.prior),
      formatDigestDelta(h.cost, formatUSD),
    ],
    [
      labels[1],
      plain(h.sessions.current),
      plain(h.sessions.prior),
      formatDigestDelta(h.sessions, plain),
    ],
    [
      labels[2],
      formatCompactDuration(h.activeMs.current),
      formatCompactDuration(h.activeMs.prior),
      formatDigestDelta(h.activeMs, formatCompactDuration),
    ],
    [
      labels[3],
      formatSignedCount(h.ioTokens.current),
      formatSignedCount(h.ioTokens.prior),
      formatDigestDelta(h.ioTokens, formatSignedCount),
    ],
    [
      labels[4],
      formatSignedCount(h.cacheTokens.current),
      formatSignedCount(h.cacheTokens.prior),
      formatDigestDelta(h.cacheTokens, formatSignedCount),
    ],
  ];
}

const row = (cells: string[]): string => `| ${cells.join(" | ")} |`;

function mdTable(headers: string[], align: ("left" | "right")[], rows: string[][]): string {
  const sep = headers.map((_, i) => (align[i] === "right" ? "---:" : "---"));
  return [row(headers), row(sep), ...rows.map(row)].join("\n");
}

/** Escape the one character that would break a markdown table cell. */
const cell = (s: string): string => s.replaceAll("|", "\\|");

/**
 * Render a digest as paste-ready markdown. Deterministic and side-effect free
 * — the CLI (`cc-analyzer report --md`) and the web "copy as markdown" button
 * both call this, so the two can't produce different reports.
 */
export function buildDigestMarkdown(d: WeeklyDigest): string {
  const out: string[] = [];
  const h = d.headline;

  out.push(`## Claude Code weekly digest — ${d.period.start} → ${d.period.end}`);
  out.push("");
  out.push(`Compared with ${d.prior.start} → ${d.prior.end}.`);
  const framing = costFramingNote(d.costBasis);
  if (framing) {
    out.push("");
    out.push(`_${framing}_`);
  }
  out.push("");

  if (isEmptyPeriod(d)) {
    out.push("No sessions in this period.");
    out.push("");
    if (h.sessions.prior > 0) {
      out.push(
        `The prior period had ${h.sessions.prior} ${h.sessions.prior === 1 ? "session" : "sessions"} ` +
          `and ${formatUSD(h.cost.prior)} of usage.`,
      );
      out.push("");
    }
  } else {
    out.push("### Summary");
    out.push("");
    out.push(
      mdTable(
        ["Metric", "This period", "Prior", "Change"],
        ["left", "right", "right", "right"],
        digestSummaryRows(d, [
          "Cost",
          "Sessions",
          "Active time",
          "Input+output tokens",
          "Cache tokens",
        ]),
      ),
    );
    out.push("");

    if (d.projects.length > 0) {
      out.push("### Top projects");
      out.push("");
      out.push(
        mdTable(
          ["Project", "Cost", "Sessions", "Change"],
          ["left", "right", "right", "right"],
          d.projects.map((p) => [
            cell(p.projectPath ?? p.projectId),
            formatUSD(p.cost),
            String(p.sessions),
            formatDigestDelta(p.delta, formatUSD),
          ]),
        ),
      );
      out.push("");
    }

    if (d.models.length > 0) {
      out.push("### Models");
      out.push("");
      out.push(
        mdTable(
          ["Model", "Calls", "Cost", "Prior"],
          ["left", "right", "right", "right"],
          d.models.map((m) => [
            cell(m.model),
            formatSignedCount(m.calls),
            formatUSD(m.cost),
            formatUSD(m.priorCost),
          ]),
        ),
      );
      out.push("");
    }

    out.push("### Cache");
    out.push("");
    out.push(
      `- Writes ${formatUSD(d.cache.writeCost)}, reads ${formatUSD(d.cache.readCost)}, ` +
        `un-amortized ${formatUSD(d.cache.waste)} (written but never read back).`,
    );
    out.push("");

    const r = d.reliability;
    out.push("### Reliability");
    out.push("");
    out.push(
      `- Tool calls: ${formatSignedCount(r.toolCalls)} (${formatSignedCount(r.toolErrors)} errors, ` +
        `${(r.toolErrorRate * 100).toFixed(1)}%)`,
    );
    out.push(
      r.testRuns > 0
        ? `- Test runs: ${formatSignedCount(r.testRuns)} (${formatSignedCount(r.testFailures)} failed); ` +
            `worst failing streak ${r.worstTestFailStreak}`
        : "- Test runs: none detected",
    );
    out.push(
      `- Repeated identical tool calls: ${formatSignedCount(r.retries)} · ` +
        `redundant file reads: ${formatSignedCount(r.redundantReads)}`,
    );
    out.push(
      `- Corrections: ${formatSignedCount(r.correctionTurns)} of ${formatSignedCount(r.turns)} turns ` +
        `(${(r.correctionShare * 100).toFixed(0)}%) · ${formatSignedCount(r.interruptionTurns)} interrupted`,
    );
    out.push("");
    out.push(`_${CORRECTION_CAVEAT}_`);
    out.push("");

    if (d.skills.length > 0) {
      out.push("### Skills");
      out.push("");
      out.push(
        mdTable(
          ["Skill", "Invocations", "Turns", "Turn $"],
          ["left", "right", "right", "right"],
          d.skills.map((s) => [
            cell(s.name),
            formatSignedCount(s.invocations),
            formatSignedCount(s.attributedTurns),
            formatUSD(s.attributedCost),
          ]),
        ),
      );
      out.push("");
      out.push(`_${SKILL_COST_CAVEAT}_`);
      out.push("");
    }
  }

  out.push("### Insights (current state, whole portfolio)");
  out.push("");
  if (d.insights.length === 0) {
    out.push("No findings — the portfolio looks healthy by every rule.");
  } else {
    for (const f of d.insights) {
      out.push(`- **${f.severity === "warning" ? "!" : "·"} ${f.title}** — ${f.evidence}`);
      out.push(`  - Next: ${f.action}`);
    }
  }
  out.push("");
  out.push("---");
  out.push("");
  out.push(
    "Sessions are attributed to their start day, so a session that runs past midnight counts " +
      "entirely in the period it began. Insights above are current state across the whole " +
      "portfolio, not period-scoped.",
  );
  out.push("");
  out.push("Generated by `cc-analyzer report`.");
  return out.join("\n");
}
