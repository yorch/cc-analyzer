// Typed client for the cc-analyzer JSON API. Row/summary shapes come straight
// from the core stats layer via the bun-free stats-types module (type-only
// imports, erased at build time), so server and client cannot drift; only the
// response envelopes and the shapes of non-stats endpoints live here.

import type {
  BashCommandRow,
  BranchRow,
  CacheSummary as CacheSummaryRow,
  CacheTtlSplit,
  ConcurrencySummary,
  CostDistribution,
  DayRow,
  DurationSummary,
  ErrorWeekRow,
  EstimatedShareRow,
  HeatCell,
  HotFileRow,
  IdleCacheBucket,
  ModelDayRow,
  ModelRow,
  MonthRow,
  NameUsageRow,
  PermissionModeRow,
  PortfolioSummary,
  ProjectCacheRow,
  ProjectRow,
  RetryStats,
  RunRate,
  ScatterSession,
  SessionCacheRow,
  SessionRankRow,
  SidechainDayRow,
  SidechainProjectRow,
  SidechainSummary,
  SkillUsageRow,
  StopReasonRow,
  StreakSummary,
  TestRunSummary,
  ToolUsageRow,
  TurnDepthStats,
  VersionRow,
  WebToolsProjectRow,
  WebToolsSummary,
} from "../../src/core/stats-types.ts";

export type {
  BashCommandRow,
  BranchRow,
  CacheMetrics,
  CacheSummary as CacheSummaryRow,
  CacheTtlSplit,
  CacheVerdict,
  ConcurrencyDayRow,
  ConcurrencySummary,
  CostBucket,
  CostDistribution,
  DayRow,
  DepthBucket,
  DurationSummary,
  ErrorWeekRow,
  EstimatedShareRow,
  HeatCell,
  HotFileRow,
  IdleCacheBucket,
  ModelDayRow,
  ModelRow,
  MonthRow,
  NameUsageRow,
  PermissionModeRow,
  PortfolioSummary,
  ProjectCacheRow,
  ProjectRow,
  RetryStats,
  RetryToolRow,
  RunRate,
  ScatterSession,
  SessionCacheRow,
  SessionRankRow,
  SidechainDayRow,
  SidechainProjectRow,
  SidechainSummary,
  SkillDayCount,
  SkillUsageRow,
  StopReasonRow,
  StreakSummary,
  TestRunSummary,
  ToolUsageRow,
  TurnDepthStats,
  VersionRow,
  WebToolsProjectRow,
  WebToolsSummary,
} from "../../src/core/stats-types.ts";
export { cacheVerdict } from "../../src/core/stats-types.ts";

export interface TokenSplit {
  ioTokens: number;
  cacheTokens: number;
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

export interface InsightsResponse {
  summary: CacheSummaryRow;
  projects: ProjectCacheRow[];
  ttl: CacheTtlSplit;
  idleBuckets: IdleCacheBucket[];
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
