// Typed client for the cc-analyzer JSON API. Shapes mirror the server's
// core/stats, core/queries, core/analyze and core/transcript outputs.

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
export interface TokenSplit {
  ioTokens: number;
  cacheTokens: number;
}
export interface MonthRow extends TokenSplit {
  month: string;
  cost: number;
  sessions: number;
}
export interface ProjectRow extends TokenSplit {
  projectId: string;
  projectPath: string | null;
  cost: number;
  sessions: number;
}
export interface ModelRow extends TokenSplit {
  model: string;
  calls: number;
  cost: number;
}
export interface SessionRankRow extends TokenSplit {
  sessionId: string | null;
  projectPath: string | null;
  title: string | null;
  cost: number;
  startTime: string | null;
}
export interface DurationSummary {
  sessions: number;
  totalMs: number;
  avgMs: number;
  medianMs: number;
  p90Ms: number;
  totalActiveMs: number;
  activeShare: number;
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
  topDecileShare: number;
  buckets: CostBucket[];
}
export interface StreakSummary {
  activeDays: number;
  longestStreak: number;
  currentStreak: number;
  last30ActiveDays: number;
}
export interface RunRate {
  month: string;
  monthToDate: number;
  prevMonth: string;
  prevMonthSamePoint: number;
  prevMonthTotal: number;
  projected: number;
}
export interface SidechainSummary {
  cost: number;
  calls: number;
  totalCost: number;
  totalCalls: number;
  share: number;
}
export interface EstimatedShareRow {
  projectId: string;
  projectPath: string | null;
  cost: number;
  estimatedCost: number;
  share: number;
}
export interface StatsResponse {
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

export interface IndexedProject extends TokenSplit {
  projectId: string;
  projectPath: string | null;
  sessions: number;
  cost: number;
  lastActivityMs: number;
}
export interface IndexedSession extends TokenSplit {
  sessionId: string | null;
  path: string;
  title: string | null;
  cost: number;
  costEstimated: boolean;
  startTime: string | null;
  turns: number;
  apiCalls: number;
  toolCalls: number;
  mtimeMs: number;
}

export interface SessionWithProject extends IndexedSession {
  projectPath: string | null;
}

export interface CacheMetrics {
  writeTokens: number;
  readTokens: number;
  writeCost: number;
  readCost: number;
  inputCost: number;
  outputCost: number;
  totalCost: number;
  ratio: number;
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
export interface CacheSummaryRow {
  writeCost: number;
  readCost: number;
  waste: number;
  totalCost: number;
}
export interface CacheTtlSplit {
  write5mTokens: number;
  write1hTokens: number;
  writeCost: number;
}
export interface IdleCacheBucket {
  bucket: string;
  sessions: number;
  ratio: number;
  wasteShare: number;
}
export interface InsightsResponse {
  summary: CacheSummaryRow;
  projects: ProjectCacheRow[];
  ttl: CacheTtlSplit;
  idleBuckets: IdleCacheBucket[];
}
export interface DayRow {
  day: string;
  cost: number;
  sessions: number;
  ioTokens: number;
  cacheTokens: number;
}
export interface HeatCell {
  weekday: number; // 0=Sunday … 6=Saturday
  hour: number; // 0…23, local
  sessions: number;
  cost: number;
}
export interface ModelDayRow {
  day: string;
  model: string;
  cost: number;
}
export interface ConcurrencyDayRow {
  day: string;
  maxConcurrent: number;
}
export interface ConcurrencySummary {
  peak: number;
  parallelDayShare: number;
  days: ConcurrencyDayRow[];
}
export interface ErrorWeekRow {
  week: string;
  toolCalls: number;
  errors: number;
  errorRate: number;
}
export interface SidechainDayRow {
  day: string;
  sidechainCost: number;
  totalCost: number;
}
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
export interface TrendsResponse {
  daily: DayRow[];
  heatmap: HeatCell[];
  modelMix: ModelDayRow[];
  concurrency: ConcurrencySummary;
  errorWeekly: ErrorWeekRow[];
  sidechainDaily: SidechainDayRow[];
  scatter: ScatterSession[];
}

export interface ToolUsageRow {
  tool: string;
  uses: number;
  errors: number;
  errorRate: number;
  sessions: number;
}
export interface NameUsageRow {
  name: string;
  sessions: number;
}
export interface SkillDayCount {
  day: string;
  count: number;
}
/** Mirror of core stats.SkillUsageRow. Cost is session-scoped (correlational). */
export interface SkillUsageRow {
  name: string;
  invocations: number;
  sessions: number;
  projects: number;
  errors: number;
  errorRate: number;
  firstUsed: string | null;
  lastUsed: string | null;
  totalCost: number;
  avgCostPerSession: number;
  daily: SkillDayCount[];
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
  sessions: number;
  failureRate: number;
}
export interface RetryToolRow {
  tool: string;
  retries: number;
  sessions: number;
}
export interface RetryStats {
  total: number;
  sessions: number;
  byTool: RetryToolRow[];
}
export interface WebToolsSummary {
  searches: number;
  fetches: number;
  sessions: number;
}
export interface WebToolsProjectRow {
  projectId: string;
  projectPath: string | null;
  searches: number;
  fetches: number;
}
export interface PermissionModeRow {
  mode: string;
  turns: number;
  sessions: number;
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
  buckets: DepthBucket[];
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
export interface SidechainProjectRow {
  projectId: string;
  projectPath: string | null;
  cost: number;
  sidechainCost: number;
  share: number;
}
export interface HotFileRow {
  file: string;
  sessions: number;
  lastDay: string | null;
}
export interface AnalyticsResponse {
  tools: ToolUsageRow[];
  skills: SkillUsageRow[];
  subagents: NameUsageRow[];
  bash: BashCommandRow[];
  tests: TestRunSummary;
  retries: RetryStats;
  webTools: { summary: WebToolsSummary; byProject: WebToolsProjectRow[] };
  permissionModes: PermissionModeRow[];
  stopReasons: StopReasonRow[];
  turnDepth: TurnDepthStats;
  versions: VersionRow[];
  branches: BranchRow[];
  sidechain: { summary: SidechainSummary; byProject: SidechainProjectRow[] };
}

export type CacheVerdict = "efficient" | "ok" | "leaky";
/** Mirror of core stats.cacheVerdict, for the web insights view. */
export function cacheVerdict(ratio: number): CacheVerdict {
  if (ratio >= 2) return "efficient";
  if (ratio >= 1) return "ok";
  return "leaky";
}

export interface CostBreakdown {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
  total: number;
  estimated: boolean;
}
export interface TokenCounts {
  inputTokens: number;
  outputTokens: number;
  cacheWrite5mTokens: number;
  cacheWrite1hTokens: number;
  cacheReadTokens: number;
}
export type StepKind =
  | "note"
  | "thinking"
  | "run"
  | "read"
  | "edit"
  | "search"
  | "skill"
  | "subagent"
  | "web"
  | "task"
  | "ask"
  | "tool";

export interface TurnStep {
  kind: StepKind;
  tool?: string;
  label: string;
  summary: string;
  status?: "ok" | "error";
  resultHint?: string;
  toolUseId?: string;
  detail?: { input?: string; result?: string; truncated?: boolean };
}

export interface ApiCall {
  model?: string;
  timestamp?: string;
  isSidechain?: boolean;
  stopReason?: string;
  cost: CostBreakdown;
  tokens: TokenCounts;
  steps: TurnStep[];
}
export interface Turn {
  index: number;
  prompt: string;
  startTime?: string;
  endTime?: string;
  permissionMode?: string;
  cost: CostBreakdown;
  tokens: TokenCounts;
  apiCalls: ApiCall[];
  toolCounts: Record<string, number>;
}
export interface SessionAnalysis {
  sessionId?: string;
  title?: string;
  projectPath?: string;
  gitBranches: string[];
  versions: string[];
  startTime?: string;
  endTime?: string;
  durationMs?: number;
  totals: {
    turns: number;
    apiCalls: number;
    toolCalls: number;
    cost: CostBreakdown;
    tokens: TokenCounts;
    webSearches: number;
    webFetches: number;
    sidechainApiCalls: number;
    sidechainCost: number;
    activeMs: number;
  };
  turns: Turn[];
  models: Record<string, { apiCalls: number; cost: CostBreakdown; tokens: TokenCounts }>;
  tools: Record<string, number>;
  skills: Record<string, number>;
  subagents: string[];
  filesTouched: string[];
  stopReasons: Record<string, number>;
  permissionModes: Record<string, number>;
  bashCommands: Record<string, number>;
  bashErrors: Record<string, number>;
  testRuns: number;
  testFailures: number;
  retries: number;
  retriesByTool: Record<string, number>;
}
export interface TranscriptItem {
  index: number;
  turnIndex: number;
  role: string;
  kind: string;
  label: string;
  body: string;
  isError?: boolean;
}

async function get<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return (await res.json()) as T;
}

export const api = {
  stats: () => get<StatsResponse>("/api/stats"),
  projects: () => get<IndexedProject[]>("/api/projects"),
  sessions: (projectId: string) =>
    get<IndexedSession[]>(`/api/projects/${encodeURIComponent(projectId)}/sessions`),
  projectFiles: (projectId: string) =>
    get<HotFileRow[]>(`/api/projects/${encodeURIComponent(projectId)}/files`),
  session: (id: string) => get<SessionAnalysis>(`/api/sessions/${encodeURIComponent(id)}`),
  transcript: (id: string) =>
    get<TranscriptItem[]>(`/api/sessions/${encodeURIComponent(id)}/transcript`),
  searchSessions: (q: string) =>
    get<SessionWithProject[]>(`/api/sessions/search?q=${encodeURIComponent(q)}`),
  insights: () => get<InsightsResponse>("/api/insights"),
  insightsSessions: (projectId: string) =>
    get<SessionCacheRow[]>(`/api/insights/${encodeURIComponent(projectId)}/sessions`),
  trends: () => get<TrendsResponse>("/api/trends"),
  analytics: () => get<AnalyticsResponse>("/api/analytics"),
};
