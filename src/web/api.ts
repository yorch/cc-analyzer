import type { Database } from "bun:sqlite";
import { Hono } from "hono";
import { analyzeSession } from "../core/analyze.ts";
import { parseSessionFile } from "../core/parser.ts";
import type { PricingTable } from "../core/pricing.ts";
import {
  listIndexedProjects,
  listIndexedSessions,
  searchSessions,
  sessionPathById,
} from "../core/queries.ts";
import {
  activityHeatmap,
  bashCommandUsage,
  branchUsage,
  cacheSummary,
  cacheTtlSplit,
  cacheWasteByProject,
  cacheWasteBySession,
  concurrency,
  costDistribution,
  durationSummary,
  errorRateByWeek,
  estimatedShareByProject,
  hotFiles,
  idleVsCache,
  localDayOfMs,
  modelMixByDay,
  permissionModeUsage,
  portfolioSummary,
  retryStats,
  runRate,
  sessionScatter,
  sidechainByDay,
  sidechainByProject,
  sidechainSummary,
  skillAnalytics,
  spendByDay,
  spendByModel,
  spendByMonth,
  spendByProject,
  stopReasonUsage,
  streaks,
  subagentUsage,
  testRunSummary,
  toolUsage,
  topSessions,
  turnDepthStats,
  versionAdoption,
  webToolUsage,
} from "../core/stats.ts";
import { buildTranscript } from "../core/transcript.ts";

// The dashboard/insights lists are filtered client-side, so the server must
// return more than a top-N slice (else low-spend projects vanish from the
// filter) — but still cap the payload so a pathological portfolio can't ship
// unbounded JSON. Far above any realistic project count.
const MAX_PROJECT_ROWS = 2000;

/** Build the JSON API (routes under `/api`). Pure over its db + pricing inputs. */
export function createApi(db: Database, pricing: PricingTable): Hono {
  const api = new Hono();

  api.get("/api/stats", (c) => {
    const today = localDayOfMs(Date.now());
    return c.json({
      summary: portfolioSummary(db),
      byMonth: spendByMonth(db),
      byProject: spendByProject(db, MAX_PROJECT_ROWS),
      byModel: spendByModel(db),
      top: topSessions(db, 20),
      duration: durationSummary(db),
      distribution: costDistribution(db),
      streaks: streaks(db, today),
      runRate: runRate(db, today),
      sidechain: sidechainSummary(db),
      estimatedByProject: estimatedShareByProject(db),
    });
  });

  api.get("/api/projects", (c) => c.json(listIndexedProjects(db)));

  // Cache-efficiency insights: projects ranked by un-amortized cache-write $,
  // plus a portfolio summary; drill into one project's sessions. The TTL split
  // and idle-share buckets diagnose *why* writes didn't amortize.
  api.get("/api/insights", (c) =>
    c.json({
      summary: cacheSummary(db),
      projects: cacheWasteByProject(db, MAX_PROJECT_ROWS),
      ttl: cacheTtlSplit(db),
      idleBuckets: idleVsCache(db),
    }),
  );

  api.get("/api/insights/:id/sessions", (c) =>
    c.json(cacheWasteBySession(db, c.req.param("id"), 200)),
  );

  // Time-series for the trends view: raw daily spend series (also feeds the
  // contribution calendar client-side), weekday×hour heatmap, model mix,
  // concurrency lanes, weekly error rate, sidechain trend, and the
  // cost/duration/prompt scatter points.
  api.get("/api/trends", (c) =>
    c.json({
      daily: spendByDay(db),
      heatmap: activityHeatmap(db),
      modelMix: modelMixByDay(db),
      concurrency: concurrency(db),
      errorWeekly: errorRateByWeek(db),
      sidechainDaily: sidechainByDay(db),
      scatter: sessionScatter(db),
    }),
  );

  // Tool/skill/subagent usage analytics, plus shell commands, retries, web
  // tools, permission modes, stop reasons, turn depth, versions, branches.
  api.get("/api/analytics", (c) =>
    c.json({
      tools: toolUsage(db),
      skills: skillAnalytics(db),
      subagents: subagentUsage(db),
      bash: bashCommandUsage(db),
      tests: testRunSummary(db),
      retries: retryStats(db),
      webTools: webToolUsage(db),
      permissionModes: permissionModeUsage(db),
      stopReasons: stopReasonUsage(db),
      turnDepth: turnDepthStats(db),
      versions: versionAdoption(db),
      branches: branchUsage(db),
      sidechain: { summary: sidechainSummary(db), byProject: sidechainByProject(db) },
    }),
  );

  api.get("/api/projects/:id/sessions", (c) => c.json(listIndexedSessions(db, c.req.param("id"))));

  // Files Claude touched across a project's sessions, hottest first.
  api.get("/api/projects/:id/files", (c) => c.json(hotFiles(db, c.req.param("id"))));

  // Registered before "/api/sessions/:id" so "search" isn't captured as an id.
  api.get("/api/sessions/search", (c) => {
    const q = c.req.query("q") ?? "";
    const parsed = Number(c.req.query("limit") ?? "100");
    // Clamp: LIMIT -1 is "unlimited" in SQLite, and huge values are abuse.
    const limit = Number.isInteger(parsed) ? Math.min(Math.max(parsed, 1), 1000) : 100;
    return c.json(q.trim() ? searchSessions(db, q, limit) : []);
  });

  // The index is a disposable cache, so an indexed path can be stale — a
  // deleted session file must 404 with a hint, not crash into a 500.
  const readSession = async (path: string) => {
    try {
      return await parseSessionFile(path);
    } catch {
      return undefined;
    }
  };
  const staleIndex = { error: "session file is missing; re-run `cc-analyzer index`" };

  api.get("/api/sessions/:id", async (c) => {
    const path = sessionPathById(db, c.req.param("id"));
    if (!path) return c.json({ error: "session not found" }, 404);
    const parsed = await readSession(path);
    if (!parsed) return c.json(staleIndex, 404);
    return c.json(analyzeSession(parsed.events, pricing));
  });

  api.get("/api/sessions/:id/transcript", async (c) => {
    const path = sessionPathById(db, c.req.param("id"));
    if (!path) return c.json({ error: "session not found" }, 404);
    const parsed = await readSession(path);
    if (!parsed) return c.json(staleIndex, 404);
    return c.json(buildTranscript(parsed.events));
  });

  return api;
}
