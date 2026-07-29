/**
 * Pure data shapes (and the tiny pure helpers on them) shared by the stats
 * layer and the web SPA. This module must stay free of bun-typed imports —
 * the browser tsconfig type-checks it too.
 */

/* ——— Shared date helpers ————————————————————————————————————————————
 * One canonical implementation of each date rule; the indexer, stats layer,
 * TUI, and web all bucket days/weeks through these so they cannot drift. */

/** Local-time YYYY-MM-DD of an epoch ms (the rule behind the `day` column). */
export function localDayOfMs(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Shift a YYYY-MM-DD day string by n days. */
export function shiftDay(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Monday (UTC) of the ISO week containing a YYYY-MM-DD day. */
export function weekOf(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

/** Sort a counter record descending and render "k:n, k:n, …" (top `limit`). */
export function topEntries(rec: Record<string, number>, limit = Number.POSITIVE_INFINITY): string {
  return Object.entries(rec)
    .sort((x, y) => y[1] - x[1])
    .slice(0, limit)
    .map(([k, n]) => `${k}:${n}`)
    .join(", ");
}

/* ——— Series bucketing shared by both frontends ——————————————————————
 * The TUI trends/preview charts and the web Trends/Project pages bucket the
 * same `DayRow` series; one implementation here means they cannot total a
 * week or month differently. */

export type Granularity = "day" | "week" | "month";
export type BurnMetric = "cost" | "tokens" | "sessions";

export interface SeriesPoint {
  label: string;
  cost: number;
  sessions: number;
  ioTokens: number;
  cacheTokens: number;
}

/**
 * Regroup the daily series into day / week / month buckets, summing each metric.
 * Relies on `daily` being sorted ascending (as `spendByDay` returns it) so equal
 * bucket keys are contiguous.
 */
export function bucketSeries(daily: DayRow[], granularity: Granularity): SeriesPoint[] {
  if (granularity === "day") {
    return daily.map((d) => ({
      label: d.day,
      cost: d.cost,
      sessions: d.sessions,
      ioTokens: d.ioTokens,
      cacheTokens: d.cacheTokens,
    }));
  }
  const out: SeriesPoint[] = [];
  let curKey = "";
  for (const d of daily) {
    const key = granularity === "month" ? d.day.slice(0, 7) : weekOf(d.day);
    let p = out[out.length - 1];
    if (!p || key !== curKey) {
      p = { label: key, cost: 0, sessions: 0, ioTokens: 0, cacheTokens: 0 };
      out.push(p);
      curKey = key;
    }
    p.cost += d.cost;
    p.sessions += d.sessions;
    p.ioTokens += d.ioTokens;
    p.cacheTokens += d.cacheTokens;
  }
  return out;
}

export function metricValue(p: SeriesPoint, metric: BurnMetric): number {
  if (metric === "cost") return p.cost;
  if (metric === "sessions") return p.sessions;
  return p.ioTokens + p.cacheTokens;
}

/**
 * Dense weekly totals across a daily series' active span (gap weeks count as
 * 0), oldest first — the series behind the adoption sparklines. Each bucket is
 * an ISO week (Monday-anchored, via `weekOf`).
 */
export function weeklySeries(daily: { day: string; count: number }[]): number[] {
  if (daily.length === 0) return [];
  const byWeek = new Map<string, number>();
  for (const d of daily) byWeek.set(weekOf(d.day), (byWeek.get(weekOf(d.day)) ?? 0) + d.count);
  const keys = [...byWeek.keys()].sort();
  const first = keys[0];
  const last = keys[keys.length - 1];
  if (first === undefined || last === undefined) return [];
  const out: number[] = [];
  const cur = new Date(`${first}T00:00:00Z`);
  const end = new Date(`${last}T00:00:00Z`);
  while (cur <= end) {
    out.push(byWeek.get(cur.toISOString().slice(0, 10)) ?? 0);
    cur.setUTCDate(cur.getUTCDate() + 7);
  }
  return out;
}

/* ——— Contribution calendar ——————————————————————————————————————————
 * Grid math shared by the TUI (ramp chars) and web (SVG rects) calendars:
 * one column per week ending at the newest day, Monday-first rows, padded
 * final column clamped so future days emit no cells. */

export interface CalendarCell {
  day: string;
  v: number;
}

export interface CalendarGrid {
  /** Columns of up to 7 cells (Mon…Sun); future days are omitted. */
  weeks: CalendarCell[][];
  /** Busiest day's value (0 when there is no data). */
  max: number;
  firstDay: string;
  lastDay: string;
}

/** Bucket a daily series into a contribution-calendar grid of `weeks` columns. */
export function calendarWeeks(daily: { day: string; v: number }[], weeks: number): CalendarGrid {
  const last = daily[daily.length - 1]?.day;
  if (!last) return { weeks: [], max: 0, firstDay: "", lastDay: "" };
  const byDay = new Map(daily.map((d) => [d.day, d.v]));
  // Pad the final column out to its Sunday so the last week renders whole —
  // but emit no cells past `last`: those days haven't happened.
  const end = new Date(`${last}T00:00:00Z`);
  end.setUTCDate(end.getUTCDate() + ((7 - ((end.getUTCDay() + 6) % 7) - 1) % 7));
  const grid: CalendarCell[][] = [];
  let max = 0;
  let firstDay = "";
  for (let w = weeks - 1; w >= 0; w--) {
    const col: CalendarCell[] = [];
    for (let r = 6; r >= 0; r--) {
      const d = new Date(end);
      d.setUTCDate(d.getUTCDate() - w * 7 - r);
      const day = d.toISOString().slice(0, 10);
      if (w === weeks - 1 && r === 6) firstDay = day;
      if (day > last) continue;
      const v = byDay.get(day) ?? 0;
      if (v > max) max = v;
      col.push({ day, v });
    }
    grid.push(col);
  }
  return { weeks: grid, max, firstDay, lastDay: last };
}

export interface PortfolioSummary {
  sessions: number;
  projects: number;
  cost: number;
  estimatedShare: number;
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  firstDay: string | null;
  lastDay: string | null;
}

export interface MonthRow {
  month: string;
  cost: number;
  sessions: number;
  ioTokens: number;
  cacheTokens: number;
}

/** One day of the spend burn series (day is the stored YYYY-MM-DD column). */
export interface DayRow {
  day: string;
  cost: number;
  sessions: number;
  ioTokens: number;
  cacheTokens: number;
}

/** One weekday×hour cell of the activity heatmap (local time). */
export interface HeatCell {
  /** 0=Sunday … 6=Saturday, from strftime('%w'). */
  weekday: number;
  /** 0…23, local hour. */
  hour: number;
  sessions: number;
  cost: number;
}

export interface ProjectRow {
  projectId: string;
  projectPath: string | null;
  cost: number;
  sessions: number;
  ioTokens: number;
  cacheTokens: number;
}

export interface SessionRankRow {
  sessionId: string | null;
  projectPath: string | null;
  title: string | null;
  cost: number;
  ioTokens: number;
  cacheTokens: number;
  startTime: string | null;
}

export interface ModelRow {
  model: string;
  calls: number;
  cost: number;
  ioTokens: number;
  cacheTokens: number;
}

/** Cache-efficiency metrics shared by the project and session insight rows. */
export interface CacheMetrics {
  writeTokens: number;
  readTokens: number;
  writeCost: number;
  readCost: number;
  inputCost: number;
  outputCost: number;
  totalCost: number;
  /** readTokens / writeTokens; 0 when nothing was written. */
  ratio: number;
  /** Cache-write $ that was not read back: Σ writeCost × max(0, 1 − min(1, read/write)). */
  waste: number;
}

export interface ProjectCacheRow extends CacheMetrics {
  projectId: string;
  projectPath: string | null;
  sessions: number;
}

export interface SessionCacheRow extends CacheMetrics {
  sessionId: string | null;
  title: string | null;
  startTime: string | null;
  projectPath: string | null;
}

export interface CacheSummary {
  writeCost: number;
  readCost: number;
  waste: number;
  totalCost: number;
}

export type CacheVerdict = "efficient" | "ok" | "leaky";

/** Classify cache amortization from the read:write token ratio. */
export function cacheVerdict(ratio: number): CacheVerdict {
  if (ratio >= 2) return "efficient";
  if (ratio >= 1) return "ok";
  return "leaky";
}

/** Aggregate tool usage across all sessions, with error counts and rate. */
export interface ToolUsageRow {
  tool: string;
  uses: number;
  errors: number;
  /** errors / uses, in [0, 1]. */
  errorRate: number;
  sessions: number;
}

/** A name (subagent) and how many sessions used it. */
export interface NameUsageRow {
  name: string;
  sessions: number;
}

/** A day and how many times a skill was invoked on it (adoption sparkline). */
export interface SkillDayCount {
  day: string;
  count: number;
}

/** Rich per-skill analytics: invocation depth, reach, reliability, adoption, and
 * cost at two scopes — turn-scoped attribution (the primary number) plus the
 * session-scoped upper bound. */
export interface SkillUsageRow {
  name: string;
  /** Total `Skill` invocations across all sessions. */
  invocations: number;
  /** Sessions that invoked the skill at least once. */
  sessions: number;
  /** Distinct projects that invoked the skill. */
  projects: number;
  /** Invocations whose result was an error. */
  errors: number;
  /** errors / invocations, in [0, 1]. */
  errorRate: number;
  /** Earliest / latest day (YYYY-MM-DD) the skill was used, or null if undated. */
  firstUsed: string | null;
  lastUsed: string | null;
  /** Turns (across all sessions) that invoked the skill, and Σ cost of those
   * turns — the turn-scoped attribution, which is the primary cost number.
   * Tighter than `totalCost`, but still correlational at the margin: a turn
   * invoking several skills counts its full cost toward each. */
  attributedTurns: number;
  attributedCost: number;
  /** Σ cost_total over sessions that used the skill — the whole-session upper
   * bound. Correlational, not causal: a session using N skills counts its full
   * cost toward each of them. */
  totalCost: number;
  avgCostPerSession: number;
  /** Per-day invocation counts, oldest first, for the adoption sparkline. */
  daily: SkillDayCount[];
}

/**
 * The caveat every skill-cost surface must print, verbatim — the two scopes
 * mean different things and neither is causal, so the wording cannot drift
 * between the CLI, the TUI and the web app.
 */
export const SKILL_COST_CAVEAT =
  "Turn-scoped cost is the cost of the turns that invoked the skill (a turn invoking several " +
  "skills counts its full cost toward each); session-scoped is the whole-session upper bound. " +
  "Correlational, not causal.";

export interface DurationSummary {
  /** Sessions carrying a positive duration. */
  sessions: number;
  totalMs: number;
  avgMs: number;
  medianMs: number;
  p90Ms: number;
  /** Σ active_ms over the same sessions (event gaps ≤ 5m). */
  totalActiveMs: number;
  /** totalActiveMs / totalMs — how much of the open time was real work. */
  activeShare: number;
}

/** One session as a scatter point (cost vs duration/activity/prompt length). */
export interface ScatterSession {
  sessionId: string | null;
  title: string | null;
  projectPath: string | null;
  cost: number;
  durationMs: number;
  activeMs: number;
  turns: number;
  promptChars: number;
}

export interface CostBucket {
  label: string;
  count: number;
}

export interface CostDistribution {
  sessions: number;
  mean: number;
  p50: number;
  p90: number;
  p99: number;
  max: number;
  /** Share of total spend carried by the most expensive 10% of sessions. */
  /** Null when the portfolio has fewer than 10 sessions — no real decile. */
  topDecileShare: number | null;
  /** Log-scale cost buckets, cheapest first. */
  buckets: CostBucket[];
}

export interface StreakSummary {
  /** Distinct days with at least one session. */
  activeDays: number;
  longestStreak: number;
  /** Consecutive active days ending today or yesterday (0 when cold). */
  currentStreak: number;
  /** Active days in the 30-day window ending `today`. */
  last30ActiveDays: number;
}

export interface RunRate {
  /** Current month (YYYY-MM) and its spend so far. */
  month: string;
  monthToDate: number;
  /** Previous month: spend through the same day-of-month, and its final total. */
  prevMonth: string;
  prevMonthSamePoint: number;
  prevMonthTotal: number;
  /** Naive month-end projection: monthToDate / dayOfMonth × daysInMonth. */
  projected: number;
}

export interface CacheTtlSplit {
  write5mTokens: number;
  write1hTokens: number;
  writeCost: number;
}

export interface WebToolsSummary {
  searches: number;
  fetches: number;
  /** Sessions that used web search or fetch at least once. */
  sessions: number;
}

export interface WebToolsProjectRow {
  projectId: string;
  projectPath: string | null;
  searches: number;
  fetches: number;
}

export interface EstimatedShareRow {
  projectId: string;
  projectPath: string | null;
  cost: number;
  estimatedCost: number;
  /** estimatedCost / cost, in [0, 1]. */
  share: number;
}

export interface SidechainSummary {
  cost: number;
  calls: number;
  totalCost: number;
  totalCalls: number;
  /** cost / totalCost. */
  share: number;
}

export interface SidechainDayRow {
  day: string;
  sidechainCost: number;
  totalCost: number;
}

export interface SidechainProjectRow {
  projectId: string;
  projectPath: string | null;
  cost: number;
  sidechainCost: number;
  share: number;
}

export interface HotFileRow {
  file: string;
  /** Sessions that wrote/edited the file (per-session deduped). */
  sessions: number;
  lastDay: string | null;
}

export interface ModelDayRow {
  day: string;
  model: string;
  cost: number;
}

export interface PermissionModeRow {
  mode: string;
  turns: number;
  sessions: number;
  /** Σ cost_total of sessions using the mode — correlational, like skill cost. */
  totalCost: number;
  avgCostPerSession: number;
}

export interface StopReasonRow {
  reason: string;
  count: number;
  sessions: number;
}

export interface DepthBucket {
  label: string;
  turns: number;
}

export interface TurnDepthStats {
  turns: number;
  avgDepth: number;
  maxDepth: number;
  /** Turn counts bucketed by API calls per turn: 1 / 2–3 / 4–7 / 8–15 / 16+. */
  buckets: DepthBucket[];
  /** Average depth per month (is delegation deepening over time?). */
  byMonth: { month: string; avgDepth: number; turns: number }[];
}

export interface VersionRow {
  version: string;
  sessions: number;
  firstDay: string | null;
  lastDay: string | null;
}

export interface BranchRow {
  branch: string;
  sessions: number;
  cost: number;
}

export interface BashCommandRow {
  command: string;
  uses: number;
  errors: number;
  errorRate: number;
  sessions: number;
}

export interface TestRunSummary {
  runs: number;
  failures: number;
  /** Sessions that ran tests at least once. */
  sessions: number;
  failureRate: number;
}

export interface RetryToolRow {
  tool: string;
  retries: number;
  sessions: number;
}

/* ——— Thrash: edit→test→fail loops and redundant same-file re-reads ——————
 * Both signals come off the schema v12 columns (`test_fail_streak`,
 * `redundant_reads`, `reread_files_json`). The per-session cutoffs live here,
 * beside the shape, so the rollup, the session diagnostics, and the portfolio
 * rules count a "thrashing session" identically. */

/** A session counts as edit-test thrashing at this many consecutive failing
 * test runs without a pass. Two fails in a row is a normal debugging step;
 * three is the loop repeating without progress. */
export const THRASH_STREAK_MIN = 3;

/** A session counts as reread-heavy at this many redundant reads (3rd+ read of
 * a file on one chain). One or two redundant reads happen in any long session;
 * four means whole files are being re-paid into context repeatedly. */
export const THRASH_REREAD_MIN = 4;

/** A file portfolio-wide and how many sessions re-read it (≥ 3 reads). */
export interface RereadFileRow {
  file: string;
  sessions: number;
}

/** Portfolio thrash rollup (part of `AnalyticsRollup`). */
export interface ThrashStats {
  /** Sessions whose longest consecutive-failing-test streak ≥ THRASH_STREAK_MIN. */
  testThrashSessions: number;
  /** The worst such streak anywhere in the portfolio. */
  worstTestFailStreak: number;
  /** Σ redundant Read invocations across all sessions. */
  redundantReads: number;
  /** Sessions with ≥ THRASH_REREAD_MIN redundant reads. */
  rereadSessions: number;
  /** Most re-read files by session count, top 10. */
  topRereadFiles: RereadFileRow[];
}

/* ——— Corrections: prompts that redo the previous turn ————————————————
 * Two schema v13 columns: `correction_turns` (real prompts opening with a
 * correction marker, per `isCorrectionPrompt` in events.ts) and
 * `interruption_turns` (turns carrying the machine-written "[Request
 * interrupted by user…]" marker). The strongest available prompt-quality
 * signal: a high correction share means tokens were spent redoing work. */

/** One ISO week of the correction trend (weeks with sessions but no dated
 * corrections still appear, with correctionTurns 0). */
export interface CorrectionWeekRow {
  week: string;
  correctionTurns: number;
  /** Real-prompt turns that week (the share's denominator). */
  turns: number;
}

/** Portfolio corrections rollup (part of `AnalyticsRollup`). */
export interface CorrectionStats {
  /** Sessions with ≥ 1 correction turn. */
  sessions: number;
  correctionTurns: number;
  interruptionTurns: number;
  /** Real-prompt turns portfolio-wide (Σ of the `turns` column). */
  turns: number;
  /** correctionTurns / turns; 0 when there are no turns. */
  correctionShare: number;
  /** interruptionTurns / turns; 0 when there are no turns. */
  interruptionShare: number;
  /** Weekly trend, oldest first (sessions without a day are excluded). */
  weekly: CorrectionWeekRow[];
}

/**
 * The caveat every corrections surface must print, verbatim — the detection is
 * a language-biased heuristic, so the wording cannot drift between the CLI,
 * the TUI and the web app.
 */
export const CORRECTION_CAVEAT =
  "Corrections are detected by a conservative English-only keyword heuristic over how prompts " +
  "open; it undercounts by design, and non-English corrections are missed entirely.";

/** The portfolio overview shared by `cc-analyzer stats` and `/api/stats` —
 * assembled only by `buildPortfolioStats`, so the two surfaces cannot drift. */
export interface PortfolioStats {
  summary: PortfolioSummary;
  byMonth: MonthRow[];
  byProject: ProjectRow[];
  byModel: ModelRow[];
  top: SessionRankRow[];
  duration: DurationSummary;
  distribution: CostDistribution;
  streaks: StreakSummary;
  runRate: RunRate;
  sidechain: SidechainSummary;
  estimatedByProject: EstimatedShareRow[];
}

/** Everything `analyticsRollup` computes in its single table scan. */
export interface AnalyticsRollup {
  tools: ToolUsageRow[];
  skills: SkillUsageRow[];
  subagents: NameUsageRow[];
  bash: BashCommandRow[];
  tests: TestRunSummary;
  retries: RetryStats;
  thrash: ThrashStats;
  corrections: CorrectionStats;
  permissionModes: PermissionModeRow[];
  stopReasons: StopReasonRow[];
  turnDepth: TurnDepthStats;
  versions: VersionRow[];
  branches: BranchRow[];
}

export interface RetryStats {
  /** Total repeated-identical tool calls across the portfolio. */
  total: number;
  /** Sessions with at least one retry. */
  sessions: number;
  byTool: RetryToolRow[];
}

/** Everything the project page charts need — `/api/projects/:id/trends`. */
export interface ProjectTrends {
  daily: DayRow[];
  modelMix: ModelDayRow[];
  scatter: ScatterSession[];
  distribution: CostDistribution;
  turnDepth: TurnDepthStats;
  tools: ToolUsageRow[];
}

/**
 * Portfolio compaction pressure. "Own" compactions exclude both subagent
 * compactions (their own context windows) and inherited boundaries (copied
 * from the parent session at the start of a continuation file) — so one real
 * compaction is never counted in two session rows.
 */
export interface CompactionSummary {
  /** Sessions with ≥1 own main-chain compaction. */
  sessions: number;
  totalSessions: number;
  /** Own main-chain compactions across the portfolio. */
  compactions: number;
  auto: number;
  manual: number;
  /** Own compactions whose trigger wasn't recorded (older Claude Code files
   * log only the summary prompt, which carries no trigger). */
  unknown: number;
  /** Compactions inside subagent transcripts (not counted above). */
  sidechain: number;
  /** Inherited boundaries at continuation-file starts (not counted above). */
  inherited: number;
}

export interface CompactionProjectRow {
  projectId: string;
  projectPath: string | null;
  sessions: number;
  sessionsWithCompaction: number;
  /** Own main-chain compactions as RAW per-row sums of the `compactions`
   * column — a copied session file counts in each row here, unlike the
   * uuid-deduped portfolio summary. */
  compactions: number;
  /** sessionsWithCompaction / sessions. */
  share: number;
}

export interface CompactionUsage {
  summary: CompactionSummary;
  byProject: CompactionProjectRow[];
}

/* ——— Parse coverage ——————————————————————————————————————————————————
 * How much of the indexed JSONL this build of the parser understood. The
 * session format is undocumented and moves between Claude Code releases, and
 * the parser is deliberately tolerant (invalid JSON is skipped, a drifted
 * schema is kept as an "unknown" event) — this is what makes that tolerance
 * visible instead of silent. Split by Claude Code version, because a format
 * change lands with a version. */

export interface ParseCoverageSummary {
  /** Indexed sessions the counters were summed over. */
  sessions: number;
  lines: number;
  /** Lines that produced no event at all (invalid JSON / non-object). */
  parseErrors: number;
  /** Lines kept only as tolerant "unknown" events (drifted or unknown type). */
  unknownEvents: number;
  /** (parseErrors + unknownEvents) / lines; 0 when no lines are indexed. */
  unparsedShare: number;
}

export interface ParseCoverageVersionRow extends ParseCoverageSummary {
  /** The Claude Code version the session is attributed to (best effort). */
  version: string;
}

export interface ParseCoverageStats {
  summary: ParseCoverageSummary;
  /** Newest version first — the first row is the version to judge the parser by. */
  byVersion: ParseCoverageVersionRow[];
}

/* ——— Context tax ————————————————————————————————————————————————————
 * What a session costs before the user types anything: the prompt-side tokens
 * of its first main-chain API call (system prompt + CLAUDE.md + MCP tool
 * schemas). Per project, because that overhead is a property of the project's
 * configuration. A heuristic — see `SessionAnalysis.firstPromptTokens`. */

export interface ContextTaxRow {
  projectId: string;
  projectPath: string | null;
  /** Sessions carrying a baseline (a main-chain API call). */
  sessions: number;
  avgTokens: number;
  medianTokens: number;
  p90Tokens: number;
}

export interface ContextTaxSummary {
  /** Sessions carrying a baseline, portfolio-wide. */
  sessions: number;
  medianTokens: number;
  p90Tokens: number;
}

export interface ContextTax {
  summary: ContextTaxSummary;
  byProject: ContextTaxRow[];
}

/* ——— What-if model repricing ————————————————————————————————————————
 * Each model's ACTUAL token mix, replayed at another model's rates. Strictly a
 * rate comparison: a different model would have produced a different number of
 * tokens (and different quality), neither of which is priced in here. Carry
 * that caveat to every render site. */

export interface WhatIfAlternative {
  model: string;
  /** The actual mix priced at this model's rates. */
  cost: number;
  /** cost − the actual cost; negative means the alternative is cheaper. */
  delta: number;
}

export interface WhatIfRow {
  model: string;
  calls: number;
  /** What this model's mix actually cost (as indexed). */
  cost: number;
  /** Cheapest alternative first. */
  alternatives: WhatIfAlternative[];
}

export interface WhatIfSummary {
  /** Σ actual cost over the models that could be repriced. */
  actualCost: number;
  /** The single model that would be cheapest if EVERY repriced model's mix ran
   * on it. Null when there is nothing to compare against. */
  bestModel: string | null;
  bestCost: number;
  /** bestCost − actualCost; negative means routing everything there is cheaper. */
  bestDelta: number;
  /** True when the alternatives came from the canonical fallback ladder rather
   * than from models the user actually ran. */
  fallbackAlternatives: boolean;
}

export interface WhatIfRepricing {
  summary: WhatIfSummary;
  rows: WhatIfRow[];
}

export interface ConcurrencyDayRow {
  day: string;
  maxConcurrent: number;
}

export interface ConcurrencySummary {
  /** Highest number of sessions ever open at once. */
  peak: number;
  /** Share of active days with ≥2 sessions overlapping. */
  parallelDayShare: number;
  days: ConcurrencyDayRow[];
}

export interface IdleCacheBucket {
  /** Idle-share bucket label ("<25%", …): 1 − activeMs/durationMs. */
  bucket: string;
  sessions: number;
  /** Aggregate cache read:write token ratio for the bucket. */
  ratio: number;
  /** Share of the bucket's cache-write $ that was never read back. */
  wasteShare: number;
}

export interface ErrorWeekRow {
  week: string;
  toolCalls: number;
  errors: number;
  errorRate: number;
}
