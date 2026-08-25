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
  /** The Claude data dir this project lives under (several can be configured). */
  claudeDir: string;
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
  /** Persisted default model for "Analyze with Claude Code". */
  analysisModel: string;
}

/** One streamed event from `POST /api/sessions/:id/analyze`. Mirrors
 *  `AnalysisEvent` in `src/core/claude-handoff.ts` (a bun-side module the SPA
 *  can't import), kept in sync by hand — the shape is small and stable. */
export type AnalysisEvent =
  | { type: "text"; delta: string }
  | { type: "result"; text: string; costUsd?: number; model: string }
  | { type: "error"; message: string };

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
export type SessionResponse = SessionAnalysis & {
  /** The session's project, by globally unique id. `projectPath` alone is
   *  ambiguous when two Claude roots hold a project for the same directory. */
  projectId?: string;
  insights?: SessionInsightsPayload;
};

/** Thrown by `get`/`putJson` on a non-2xx response. Carries the parsed JSON
 *  error body (when there is one) alongside the status, so a call site that
 *  cares about a *specific* error shape — e.g. the ambiguous-project-id `409`
 *  built by `projectParam` in `src/web/api.ts` — can inspect it instead of
 *  pattern-matching `error.message`. `message` stays `"<status> <url>"` and
 *  `name` deliberately stays the inherited `"Error"` (not `"ApiError"`) —
 *  every pre-existing `useAsync` caller renders `String(err)` verbatim via
 *  `Error.prototype.toString`, which prefixes the *name*; overriding it would
 *  have silently changed "Error: 404 …" to "ApiError: 404 …" everywhere a
 *  failed fetch is shown, not just the two call sites that read `.body`. */
export class ApiError extends Error {
  readonly status: number;
  readonly url: string;
  readonly body: unknown;

  constructor(status: number, url: string, body: unknown) {
    super(`${status} ${url}`);
    this.status = status;
    this.url = url;
    this.body = body;
  }
}

async function errorBody(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return undefined;
  }
}

async function get<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new ApiError(res.status, url, await errorBody(res));
  return (await res.json()) as T;
}

async function putJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new ApiError(res.status, url, await errorBody(res));
  return (await res.json()) as T;
}

/** POST the analyze request and dispatch each NDJSON line as an AnalysisEvent. */
async function streamAnalyze(
  id: string,
  model: string,
  onEvent: (event: AnalysisEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const url = `/api/sessions/${encodeURIComponent(id)}/analyze`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model }),
    signal,
  });
  if (!res.ok || !res.body) throw new ApiError(res.status, url, await errorBody(res));
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const flush = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      onEvent(JSON.parse(trimmed) as AnalysisEvent);
    } catch {
      // ignore malformed NDJSON line (heartbeat / partial)
    }
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl = buf.indexOf("\n");
    while (nl !== -1) {
      flush(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
      nl = buf.indexOf("\n");
    }
  }
  flush(buf);
}

/** The shape `projectParam` (`src/web/api.ts`) sends on a `409`: a bare
 *  project id/name matched more than one root-qualified project. */
export interface AmbiguousProjectError {
  error: string;
  candidates: string[];
}

/** Narrow an error caught from a project-scoped call (`sessions`,
 *  `projectFiles`, `projectTrends`, `insightsSessions`) to its candidate id
 *  list, or `null` when it isn't that specific ambiguity. */
export function ambiguousProjectCandidates(err: unknown): string[] | null {
  if (!(err instanceof ApiError) || err.status !== 409) return null;
  const body = err.body as Partial<AmbiguousProjectError> | undefined;
  return Array.isArray(body?.candidates) ? body.candidates : null;
}

export const api = {
  indexStatus: () => get<IndexStatus>("/api/index-status"),
  stats: () => get<StatsResponse>("/api/stats"),
  prefs: () => get<PrefsResponse>("/api/prefs"),
  // The one write call in the client: persists the cost-basis display
  // preference (see the write-endpoint note in src/web/api.ts). Never touches
  // Claude session data — only cc-analyzer's own prefs.json.
  setCostBasis: (costBasis: CostBasis) => putJson<PrefsResponse>("/api/prefs", { costBasis }),
  // Persists the default model for "Analyze with Claude Code" — like
  // setCostBasis, only touches cc-analyzer's own prefs.json.
  setAnalysisModel: (analysisModel: string) =>
    putJson<PrefsResponse>("/api/prefs", { analysisModel }),
  // Spawns a local `claude` headless (server-side) and streams its retrospective
  // back as NDJSON. `onEvent` fires per event; the promise resolves when the run
  // ends. Opt-in and billable — the caller gates it behind a button.
  analyze: (
    id: string,
    model: string,
    onEvent: (event: AnalysisEvent) => void,
    signal?: AbortSignal,
  ) => streamAnalyze(id, model, onEvent, signal),
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
  /** Resolve a session by ID or file path — tries indexed lookup first, then direct path. */
  resolveSession: async (idOrPath: string): Promise<SessionResponse> => {
    const trimmed = idOrPath.trim();
    // Try as ID first (handles both uuid and path via server fallback)
    try {
      return await get<SessionResponse>(`/api/sessions/${encodeURIComponent(trimmed)}`);
    } catch (err) {
      if (
        err instanceof ApiError &&
        err.status === 404 &&
        (trimmed.endsWith(".jsonl") || trimmed.includes("/"))
      ) {
        throw err;
      }
      throw err;
    }
  },
  insights: () => get<InsightsResponse>("/api/insights"),
  insightsSessions: (projectId: string) =>
    get<SessionCacheRow[]>(`/api/insights/${encodeURIComponent(projectId)}/sessions`),
  trends: () => get<TrendsResponse>("/api/trends"),
  analytics: () => get<AnalyticsResponse>("/api/analytics"),
  audit: () => get<SetupAudit>("/api/audit"),
  /** Download a shareable per-session export. Mirrors the CLI `analyze --md|--html|--json --out`. */
  sessionReport: (
    id: string,
    opts: { format?: "md" | "html" | "json"; redact?: boolean; transcript?: boolean } = {},
  ) => {
    const params = new URLSearchParams();
    if (opts.format) params.set("format", opts.format);
    if (opts.redact) params.set("redact", "1");
    if (opts.transcript) params.set("transcript", "1");
    const q = params.toString();
    const url = `/api/sessions/${encodeURIComponent(id)}/report${q ? `?${q}` : ""}`;
    return {
      url,
      fetch: () =>
        fetch(url).then((r) => {
          if (!r.ok) throw new ApiError(r.status, url, undefined);
          return r.blob();
        }),
    };
  },
  /** Fetch the markdown export as text (for Copy button). */
  sessionReportText: (id: string, opts: { redact?: boolean; transcript?: boolean } = {}) => {
    const params = new URLSearchParams({ format: "md" });
    if (opts.redact) params.set("redact", "1");
    if (opts.transcript) params.set("transcript", "1");
    return fetch(`/api/sessions/${encodeURIComponent(id)}/report?${params.toString()}`).then(
      (r) => {
        if (!r.ok) throw new ApiError(r.status, `/api/sessions/${id}/report`, undefined);
        return r.text();
      },
    );
  },
  /** Bulk export: portfolio / project / session × json / csv / md / html (mixable), with redact/split privacy.
   *  Mirrors the CLI `export` — always streams a zip.
   */
  bulkExport: (
    opts: {
      format?: string;
      project?: string;
      session?: string;
      redact?: boolean;
      split?: boolean;
      transcript?: boolean;
    } = {},
  ) => {
    const params = new URLSearchParams();
    if (opts.format) params.set("format", opts.format);
    if (opts.project) params.set("project", opts.project);
    if (opts.session) params.set("session", opts.session);
    if (opts.redact) params.set("redact", "1");
    if (opts.split) params.set("split", "1");
    if (opts.transcript) params.set("transcript", "1");
    const q = params.toString();
    const url = `/api/export${q ? `?${q}` : ""}`;
    return {
      url,
      fetch: () =>
        fetch(url).then((r) => {
          if (!r.ok) throw new ApiError(r.status, url, undefined);
          return r.blob();
        }),
    };
  },
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
