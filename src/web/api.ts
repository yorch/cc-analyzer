import type { Database } from "bun:sqlite";
import { Hono } from "hono";
import { analyzeSession } from "../core/analyze.ts";
import { parseSessionFile } from "../core/parser.ts";
import type { PricingTable } from "../core/pricing.ts";
import { listIndexedProjects, listIndexedSessions, sessionPathById } from "../core/queries.ts";
import {
  portfolioSummary,
  spendByModel,
  spendByMonth,
  spendByProject,
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

  api.get("/api/projects/:id/sessions", (c) => c.json(listIndexedSessions(db, c.req.param("id"))));

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
