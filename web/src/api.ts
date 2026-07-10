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
export interface MonthRow {
  month: string;
  cost: number;
  sessions: number;
  tokens: number;
}
export interface ProjectRow {
  projectId: string;
  projectPath: string | null;
  cost: number;
  sessions: number;
  tokens: number;
}
export interface ModelRow {
  model: string;
  calls: number;
  cost: number;
}
export interface SessionRankRow {
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

export interface IndexedProject {
  projectId: string;
  projectPath: string | null;
  sessions: number;
  cost: number;
  lastActivityMs: number;
}
export interface IndexedSession {
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

export interface CostBreakdown {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
  total: number;
  estimated: boolean;
}
export interface Turn {
  index: number;
  prompt: string;
  cost: CostBreakdown;
  apiCalls: { model?: string }[];
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
    webSearches: number;
    webFetches: number;
  };
  turns: Turn[];
  models: Record<string, { apiCalls: number; cost: CostBreakdown }>;
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
};
