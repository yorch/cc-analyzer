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
export interface StatsResponse {
  summary: PortfolioSummary;
  byMonth: MonthRow[];
  byProject: ProjectRow[];
  byModel: ModelRow[];
  top: SessionRankRow[];
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
export interface InsightsResponse {
  summary: CacheSummaryRow;
  projects: ProjectCacheRow[];
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
export interface TrendsResponse {
  daily: DayRow[];
  heatmap: HeatCell[];
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
export interface AnalyticsResponse {
  tools: ToolUsageRow[];
  skills: NameUsageRow[];
  subagents: NameUsageRow[];
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
  cost: CostBreakdown;
  tokens: TokenCounts;
  steps: TurnStep[];
}
export interface Turn {
  index: number;
  prompt: string;
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
  durationMs?: number;
  totals: {
    turns: number;
    apiCalls: number;
    toolCalls: number;
    cost: CostBreakdown;
    tokens: TokenCounts;
    webSearches: number;
    webFetches: number;
  };
  turns: Turn[];
  models: Record<string, { apiCalls: number; cost: CostBreakdown; tokens: TokenCounts }>;
  tools: Record<string, number>;
  skills: string[];
  subagents: string[];
  filesTouched: string[];
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
