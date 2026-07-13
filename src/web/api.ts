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
  cacheSummary,
  cacheWasteByProject,
  cacheWasteBySession,
  portfolioSummary,
  skillUsage,
  spendByDay,
  spendByModel,
  spendByMonth,
  spendByProject,
  subagentUsage,
  toolUsage,
  topSessions,
} from "../core/stats.ts";
import { buildTranscript } from "../core/transcript.ts";

/** Build the JSON API (routes under `/api`). Pure over its db + pricing inputs. */
export function createApi(db: Database, pricing: PricingTable): Hono {
  const api = new Hono();

  api.get("/api/stats", (c) =>
    c.json({
      summary: portfolioSummary(db),
      byMonth: spendByMonth(db),
      byProject: spendByProject(db, 50),
      byModel: spendByModel(db),
      top: topSessions(db, 20),
    }),
  );

  api.get("/api/projects", (c) => c.json(listIndexedProjects(db)));

  // Cache-efficiency insights: projects ranked by un-amortized cache-write $,
  // plus a portfolio summary; drill into one project's sessions.
  api.get("/api/insights", (c) =>
    c.json({ summary: cacheSummary(db), projects: cacheWasteByProject(db, 100) }),
  );

  api.get("/api/insights/:id/sessions", (c) =>
    c.json(cacheWasteBySession(db, c.req.param("id"), 200)),
  );

  // Time-series for the trends view: raw daily spend series + weekday×hour
  // activity heatmap. Bucketing/metric selection happens client-side.
  api.get("/api/trends", (c) => c.json({ daily: spendByDay(db), heatmap: activityHeatmap(db) }));

  // Tool/skill/subagent usage analytics.
  api.get("/api/analytics", (c) =>
    c.json({ tools: toolUsage(db), skills: skillUsage(db), subagents: subagentUsage(db) }),
  );

  api.get("/api/projects/:id/sessions", (c) => c.json(listIndexedSessions(db, c.req.param("id"))));

  // Registered before "/api/sessions/:id" so "search" isn't captured as an id.
  api.get("/api/sessions/search", (c) => {
    const q = c.req.query("q") ?? "";
    const parsed = Number(c.req.query("limit") ?? "100");
    const limit = Number.isFinite(parsed) ? parsed : 100;
    return c.json(q.trim() ? searchSessions(db, q, limit) : []);
  });

  api.get("/api/sessions/:id", async (c) => {
    const path = sessionPathById(db, c.req.param("id"));
    if (!path) return c.json({ error: "session not found" }, 404);
    const { events } = await parseSessionFile(path);
    return c.json(analyzeSession(events, pricing));
  });

  api.get("/api/sessions/:id/transcript", async (c) => {
    const path = sessionPathById(db, c.req.param("id"));
    if (!path) return c.json({ error: "session not found" }, 404);
    const { events } = await parseSessionFile(path);
    return c.json(buildTranscript(events));
  });

  return api;
}
