// Typed client for the cc-analyzer JSON API. Row, summary, and session shapes
// come straight from core via bun-free type-only imports (erased at build
// time), so server and client cannot drift. Only the response envelopes and
// the indexed listing shapes (whose core home, queries.ts, is bun-typed) live
// here.

import type { SessionAnalysis } from "../../src/core/analyze.ts";
import type { CostBasis } from "../../src/core/cost-framing.ts";
import type { WeeklyDigest } from "../../src/core/digest.ts";
import type { IndexStatus } from "../../src/core/index-status-types.ts";
import type { PortfolioDiagnostic } from "../../src/core/portfolio-diagnostics.ts";
import type { SetupAudit } from "../../src/core/setup-audit.ts";
import type {
  AnalyticsRollup,
  CacheSummary,
  CacheTtlSplit,
  CompactionUsage,
  ConcurrencySummary,
  ContextTax,
  DayRow,
  ErrorWeekRow,
  HeatCell,
  HotFileRow,
  IdleCacheBucket,
  ModelDayRow,
  ParseCoverageStats,
  PortfolioStats,
  ProjectCacheRow,
  ProjectTrends,
  ScatterSession,
  SessionCacheRow,
  SessionCostRank,
  SidechainDayRow,
  SidechainProjectRow,
  SidechainSummary,
  WebToolsProjectRow,
  WebToolsSummary,
  WhatIfRepricing,
} from "../../src/core/stats-types.ts";
import type { TranscriptItem } from "../../src/core/transcript.ts";

export type {
  ApiCall,
  Compaction,
  SessionAnalysis,
  SessionTotals,
  SidechainBurst,
  Turn,
} from "../../src/core/analyze.ts";
// Runtime chart and diagnostic builders are bun-free core code, so the SPA
// computes the same numbers and recommendations as the CLI and TUI.
export * from "../../src/core/chart-series.ts";
// Cost-basis framing — bun-free, so the SPA renders the exact same wording as
// the CLI/TUI for the one preference that can turn "cost" into "spend" or vice
// versa.
export * from "../../src/core/cost-framing.ts";
// Weekly-digest shapes, period math, and the markdown builder — bun-free, so
// the SPA's "copy as markdown" button produces byte-identical output to
// `cc-analyzer report --md` with no extra endpoint.
export * from "../../src/core/digest.ts";
// The shared number formatters behind the digest's markdown — so a number in
// the web digest card reads exactly as it does in the copied markdown and in
// `cc-analyzer report`. (The SPA's own `format.ts` keeps the locale-aware
// `Intl` helpers for everything else.)
export * from "../../src/core/format-shared.ts";
// Portfolio-diagnostic shapes, codes, and thresholds — bun-free, so the SPA
// renders the same rule vocabulary the server computes findings with.
export * from "../../src/core/portfolio-diagnostics.ts";
export type { CostBreakdown, TokenCounts } from "../../src/core/pricing.ts";
export * from "../../src/core/session-diagnostics.ts";
// Session-scoped cost insights: the outcome ratios are bun-free and computed
// client-side off the session payload; the what-if shapes ride on the same
// module so a session's repricing renders with the portfolio's vocabulary.
export {
  OUTCOME_CAVEAT,
  type OutcomeRow,
  outcomeRows,
  type SessionOutcomes,
  sessionOutcomes,
} from "../../src/core/session-insights.ts";
// Setup-audit shapes, thresholds, and the mandatory caveat string — bun-free,
// so the SPA renders the same audit vocabulary as the CLI.
export * from "../../src/core/setup-audit.ts";
export * from "../../src/core/stats-types.ts";
export type { StepKind, TurnStep } from "../../src/core/steps.ts";
export type { TranscriptItem } from "../../src/core/transcript.ts";

/** Back-compat alias: the insights views call the cache summary a "row". */
export type CacheSummaryRow = CacheSummary;

export interface TokenSplit {
  ioTokens: number;
  cacheTokens: number;
}
/** `/api/stats` returns the core-built portfolio shape plus the cost-basis
 *  display preference, read fresh per request at the route level (not part of
 *  `PortfolioStats` — that stays a pure, core-only shape). */
export type StatsResponse = PortfolioStats & { costBasis: CostBasis };

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
  /** Ranked portfolio findings from the bun-free rules engine, warnings first. */
  diagnostics: PortfolioDiagnostic[];
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
 * compaction, and cost-optimization aggregates. */
export interface AnalyticsResponse extends AnalyticsRollup {
  webTools: { summary: WebToolsSummary; byProject: WebToolsProjectRow[] };
  sidechain: { summary: SidechainSummary; byProject: SidechainProjectRow[] };
  compactions: CompactionUsage;
  contextTax: ContextTax;
  whatIf: WhatIfRepricing;
  /** How much of the indexed JSONL this build of the parser understood. */
  parseCoverage: ParseCoverageStats;
}

/** `/api/prefs` response shape — same for GET and the PUT echo. */
export interface PrefsResponse {
  costBasis: CostBasis;
}

/** Server-computed session insights riding on `/api/sessions/:id`: the
 * what-if needs the pricing table and the rank needs the index, so neither
 * can be derived client-side (unlike `sessionOutcomes`, which can). */
export interface SessionInsightsPayload {
  whatIf: WhatIfRepricing;
  /** Null when the session isn't in the index (analyzed by bare path). */
  rank: SessionCostRank | null;
}

/** The session payload: the full analysis plus the insights sibling.
 * `insights` stays optional so a cached/older server response still renders. */
export type SessionResponse = SessionAnalysis & { insights?: SessionInsightsPayload };

async function get<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return (await res.json()) as T;
}

async function putJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return (await res.json()) as T;
}

export const api = {
  indexStatus: () => get<IndexStatus>("/api/index-status"),
  stats: () => get<StatsResponse>("/api/stats"),
  prefs: () => get<PrefsResponse>("/api/prefs"),
  // The one write call in the client: persists the cost-basis display
  // preference (see the write-endpoint note in src/web/api.ts). Never touches
  // Claude session data — only cc-analyzer's own prefs.json.
  setCostBasis: (costBasis: CostBasis) => putJson<PrefsResponse>("/api/prefs", { costBasis }),
  projects: () => get<IndexedProject[]>("/api/projects"),
  sessions: (projectId: string) =>
    get<IndexedSession[]>(`/api/projects/${encodeURIComponent(projectId)}/sessions`),
  projectFiles: (projectId: string) =>
    get<HotFileRow[]>(`/api/projects/${encodeURIComponent(projectId)}/files`),
  projectTrends: (projectId: string) =>
    get<ProjectTrends>(`/api/projects/${encodeURIComponent(projectId)}/trends`),
  session: (id: string) => get<SessionResponse>(`/api/sessions/${encodeURIComponent(id)}`),
  transcript: (id: string) =>
    get<TranscriptItem[]>(`/api/sessions/${encodeURIComponent(id)}/transcript`),
  searchSessions: (q: string) =>
    get<SessionWithProject[]>(`/api/sessions/search?q=${encodeURIComponent(q)}`),
  insights: () => get<InsightsResponse>("/api/insights"),
  insightsSessions: (projectId: string) =>
    get<SessionCacheRow[]>(`/api/insights/${encodeURIComponent(projectId)}/sessions`),
  trends: () => get<TrendsResponse>("/api/trends"),
  analytics: () => get<AnalyticsResponse>("/api/analytics"),
  audit: () => get<SetupAudit>("/api/audit"),
  /** One week's digest. `insights: false` asks the server to skip the
   * current-state insight snapshot — the dashboard card renders none of it, and
   * assembling those signals is the expensive half of the response. */
  report: (week?: string, opts: { insights?: boolean } = {}) => {
    const params = new URLSearchParams();
    if (week) params.set("week", week);
    if (opts.insights === false) params.set("insights", "0");
    const query = params.toString();
    return get<WeeklyDigest>(query ? `/api/report?${query}` : "/api/report");
  },
};
