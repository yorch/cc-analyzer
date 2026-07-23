// Typed client for the cc-analyzer JSON API. Row, summary, and session shapes
// come straight from core via bun-free type-only imports (erased at build
// time), so server and client cannot drift. Only the response envelopes and
// the indexed listing shapes (whose core home, queries.ts, is bun-typed) live
// here.

import type { SessionAnalysis } from "../../src/core/analyze.ts";
import type { IndexStatus } from "../../src/core/index-status-types.ts";
import type {
  AnalyticsRollup,
  CacheSummary,
  CacheTtlSplit,
  CompactionUsage,
  ConcurrencySummary,
  DayRow,
  ErrorWeekRow,
  HeatCell,
  HotFileRow,
  IdleCacheBucket,
  ModelDayRow,
  PortfolioStats,
  ProjectCacheRow,
  ProjectTrends,
  ScatterSession,
  SessionCacheRow,
  SidechainDayRow,
  SidechainProjectRow,
  SidechainSummary,
  WebToolsProjectRow,
  WebToolsSummary,
} from "../../src/core/stats-types.ts";
import type { TranscriptItem } from "../../src/core/transcript.ts";

export type {
  ApiCall,
  Compaction,
  SessionAnalysis,
  SessionTotals,
  Turn,
} from "../../src/core/analyze.ts";
// Runtime chart and diagnostic builders are bun-free core code, so the SPA
// computes the same numbers and recommendations as the CLI and TUI.
export * from "../../src/core/chart-series.ts";
export type { CostBreakdown, TokenCounts } from "../../src/core/pricing.ts";
export * from "../../src/core/session-diagnostics.ts";
export * from "../../src/core/stats-types.ts";
export type { StepKind, TurnStep } from "../../src/core/steps.ts";
export type { TranscriptItem } from "../../src/core/transcript.ts";

/** Back-compat alias: the insights views call the cache summary a "row". */
export type CacheSummaryRow = CacheSummary;

export interface TokenSplit {
  ioTokens: number;
  cacheTokens: number;
}
/** `/api/stats` returns the core-built portfolio shape verbatim. */
export type StatsResponse = PortfolioStats;

export interface IndexedProject extends TokenSplit {
  projectId: string;
  projectPath: string | null;
  sessions: number;
  cost: number;
  lastActivityMs: number;
  /** Own main-chain compactions across the project's sessions. */
  compactions: number;
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

/** `/api/analytics` is the single-scan rollup plus the web-tool, sidechain,
 * and compaction SQL aggregates. */
export interface AnalyticsResponse extends AnalyticsRollup {
  webTools: { summary: WebToolsSummary; byProject: WebToolsProjectRow[] };
  sidechain: { summary: SidechainSummary; byProject: SidechainProjectRow[] };
  compactions: CompactionUsage;
}

async function get<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return (await res.json()) as T;
}

export const api = {
  indexStatus: () => get<IndexStatus>("/api/index-status"),
  stats: () => get<StatsResponse>("/api/stats"),
  projects: () => get<IndexedProject[]>("/api/projects"),
  sessions: (projectId: string) =>
    get<IndexedSession[]>(`/api/projects/${encodeURIComponent(projectId)}/sessions`),
  projectFiles: (projectId: string) =>
    get<HotFileRow[]>(`/api/projects/${encodeURIComponent(projectId)}/files`),
  projectTrends: (projectId: string) =>
    get<ProjectTrends>(`/api/projects/${encodeURIComponent(projectId)}/trends`),
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
