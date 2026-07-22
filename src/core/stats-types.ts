/**
 * Pure data shapes (and the tiny pure helpers on them) shared by the stats
 * layer and the web SPA. This module must stay free of bun-typed imports —
 * the browser tsconfig type-checks it too.
 */
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
 * (session-scoped, correlational) cost. */
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
  /** Σ cost_total over sessions that used the skill. Correlational, not causal:
   * a session using N skills counts its full cost toward each of them. */
  totalCost: number;
  avgCostPerSession: number;
  /** Per-day invocation counts, oldest first, for the adoption sparkline. */
  daily: SkillDayCount[];
}

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
  topDecileShare: number;
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

export interface RetryStats {
  /** Total repeated-identical tool calls across the portfolio. */
  total: number;
  /** Sessions with at least one retry. */
  sessions: number;
  byTool: RetryToolRow[];
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
