import type { Database } from "bun:sqlite";
import type { Context } from "hono";
import { Hono } from "hono";
import { analyzeSession } from "../core/analyze.ts";
import type { CostBasis } from "../core/cost-framing.ts";
import { isDayString, lastCompleteWeek, weekPeriod } from "../core/digest.ts";
import { buildWeeklyDigest } from "../core/digest-signals.ts";
import { inspectIndexStatus } from "../core/index-status.ts";
import { scanInventory } from "../core/inventory.ts";
import { parseSessionFile } from "../core/parser.ts";
import { buildPortfolioDiagnostics } from "../core/portfolio-diagnostics.ts";
import { assemblePortfolioSignals } from "../core/portfolio-signals.ts";
import { getCostBasis, setCostBasis } from "../core/prefs.ts";
import type { PricingTable } from "../core/pricing.ts";
import {
  listIndexedProjects,
  listIndexedSessions,
  searchSessions,
  sessionPathById,
} from "../core/queries.ts";
import { buildSetupAudit } from "../core/setup-audit.ts";
import {
  activityHeatmap,
  analyticsRollup,
  buildPortfolioStats,
  cacheSummary,
  cacheTtlSplit,
  cacheWasteByProject,
  cacheWasteBySession,
  compactionUsage,
  concurrency,
  contextTax,
  errorRateByWeek,
  hotFiles,
  idleVsCache,
  localDayOfMs,
  modelMixByDay,
  parseCoverage,
  projectTrends,
  sessionScatter,
  sidechainByDay,
  sidechainByProject,
  sidechainSummary,
  spendByDay,
  webToolUsage,
  whatIfRepricing,
} from "../core/stats.ts";
import { buildTranscript } from "../core/transcript.ts";

// The dashboard/insights lists are filtered client-side, so the server must
// return more than a top-N slice (else low-spend projects vanish from the
// filter) — but still cap the payload so a pathological portfolio can't ship
// unbounded JSON. Far above any realistic project count.
const MAX_PROJECT_ROWS = 2000;

// How many weeks of digest stay memoized at once. Generous for the one thing a
// human does (page back through recent weeks) while bounding the one memo
// keyspace a client can enumerate.
const MAX_REPORT_SLOTS = 16;

/** Build the JSON API (routes under `/api`). Pure over its db + pricing inputs. */
export function createApi(db: Database, pricing: PricingTable): Hono {
  const api = new Hono();

  api.get("/api/index-status", async (c) => c.json(await inspectIndexStatus(db)));

  // The index only changes when `cc-analyzer index` runs, so the aggregate
  // endpoints memoize their serialized payload against a cheap fingerprint of
  // the sessions table (row count + newest indexed_at). A reindex — even from
  // another process — changes the fingerprint and invalidates on next request.
  const fingerprint = (): string => {
    const r = db
      .query("SELECT COUNT(*) AS n, COALESCE(MAX(indexed_at), 0) AS t FROM sessions")
      .get() as { n: number; t: number };
    return `${r.n}:${r.t}`;
  };
  const cache = new Map<string, { key: string; body: string }>();
  const cachedJson = (c: Context, name: string, key: string, build: () => unknown) => {
    const hit = cache.get(name);
    if (hit?.key !== key) cache.set(name, { key, body: JSON.stringify(build()) });
    return c.body((cache.get(name) as { body: string }).body, 200, {
      "content-type": "application/json",
    });
  };
  // Same idea as `cachedJson`, but keeps the built object (not its JSON string)
  // so a caller can merge in something that changes independently of the index
  // fingerprint — like the cost-basis preference below — without re-running
  // the expensive rollup.
  const objCache = new Map<string, { key: string; value: unknown }>();
  const cachedValue = <T>(name: string, key: string, build: () => T): T => {
    const hit = objCache.get(name);
    if (hit?.key !== key) objCache.set(name, { key, value: build() });
    return (objCache.get(name) as { value: T }).value;
  };
  /** Keep at most `max` slots whose name starts with `prefix`, oldest first (a
   * Map iterates in insertion order). Only routes whose slot name embeds a
   * client-supplied value need this — every other keyspace here is bounded by
   * the index itself, and unknown project ids 404 before reaching the memo. */
  const capSlots = <T>(slots: Map<string, T>, prefix: string, max: number): void => {
    const keys = [...slots.keys()].filter((k) => k.startsWith(prefix));
    for (const k of keys.slice(0, Math.max(0, keys.length - max))) slots.delete(k);
  };

  // Current-state portfolio diagnostics, shared by /api/insights and the
  // digest's insight snapshot on /api/report: both want the identical findings,
  // and assembling the signals scans the index and rescans the setup inventory.
  // Memoized on the index fingerprint plus the local day, because the audit's
  // staleness rules roll over at midnight.
  const portfolioDiagnostics = (today: string) =>
    cachedValue("diagnostics", `${fingerprint()}:${today}`, () =>
      buildPortfolioDiagnostics(assemblePortfolioSignals(db, pricing)),
    );

  api.get("/api/stats", (c) => {
    const today = localDayOfMs(Date.now());
    // `today` is part of the key: streaks/run-rate must roll over at midnight.
    const stats = cachedValue("stats", `${fingerprint()}:${today}`, () =>
      buildPortfolioStats(db, today, { projectLimit: MAX_PROJECT_ROWS, topLimit: 20 }),
    );
    // costBasis is a display preference read fresh every request (it's not
    // part of buildPortfolioStats — that stays a pure, core-only shape) so
    // flipping it with `cc-analyzer cost-basis` is reflected immediately,
    // even though the underlying rollup stays memoized.
    return c.json({ ...stats, costBasis: getCostBasis() });
  });

  // Cost-basis preference: the only write endpoint in this API. It never
  // touches ~/.claude — it persists to cc-analyzer's own prefs.json in the
  // state dir (see prefs.ts), so the tool's read-only guarantee over Claude
  // data is untouched. It's safe as a plain, unauthenticated write because the
  // server binds to loopback by default (runServe in server.ts) and is meant
  // for a single local user; the DNS-rebinding Host-header guard in
  // createApp still applies on top when loopback-only.
  api.get("/api/prefs", (c) => c.json({ costBasis: getCostBasis() }));
  // PUT is the primary write verb (replacing the whole prefs resource); POST
  // is accepted too since a JSON body handler is trivial to share in Hono and
  // it saves SPA callers from caring which verb to use.
  api.on(["PUT", "POST"], "/api/prefs", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    const costBasis = (body as { costBasis?: unknown } | null)?.costBasis;
    if (costBasis !== "api" && costBasis !== "subscription") {
      return c.json({ error: 'costBasis must be "api" or "subscription"' }, 400);
    }
    setCostBasis(costBasis satisfies CostBasis);
    return c.json({ costBasis });
  });

  api.get("/api/projects", (c) => c.json(listIndexedProjects(db)));

  // Cache-efficiency insights: projects ranked by un-amortized cache-write $,
  // plus a portfolio summary; drill into one project's sessions. The TTL split
  // and idle-share buckets diagnose *why* writes didn't amortize. The ranked
  // portfolio diagnostics ride along: their signals include the setup audit
  // (a filesystem scan, like /api/audit), so the memo key mirrors the audit
  // route's `fingerprint():today` — staleness rolls over at midnight.
  api.get("/api/insights", (c) => {
    const today = localDayOfMs(Date.now());
    return cachedJson(c, "insights", `${fingerprint()}:${today}`, () => ({
      summary: cacheSummary(db),
      projects: cacheWasteByProject(db, MAX_PROJECT_ROWS),
      ttl: cacheTtlSplit(db),
      idleBuckets: idleVsCache(db),
      diagnostics: portfolioDiagnostics(today),
    }));
  });

  api.get("/api/insights/:id/sessions", (c) =>
    c.json(cacheWasteBySession(db, c.req.param("id"), 200)),
  );

  // Time-series for the trends view: raw daily spend series (also feeds the
  // contribution calendar client-side), weekday×hour heatmap, model mix,
  // concurrency lanes, weekly error rate, sidechain trend, and the
  // cost/duration/prompt scatter points.
  api.get("/api/trends", (c) =>
    cachedJson(c, "trends", fingerprint(), () => ({
      daily: spendByDay(db),
      heatmap: activityHeatmap(db),
      modelMix: modelMixByDay(db),
      concurrency: concurrency(db),
      errorWeekly: errorRateByWeek(db),
      sidechainDaily: sidechainByDay(db),
      scatter: sessionScatter(db),
    })),
  );

  // Tool/skill/subagent usage analytics plus shell commands, retries, web
  // tools, permission modes, stop reasons, turn depth, versions, branches —
  // one table scan via analyticsRollup instead of one per metric. The cost
  // optimization rollups (context tax, what-if repricing) ride along: they are
  // portfolio-wide aggregates on the same fingerprint, so memoizing them here
  // costs one payload instead of two more round trips. Parse coverage rides
  // along for the same reason — it is one more scan of the same rows.
  api.get("/api/analytics", (c) =>
    cachedJson(c, "analytics", fingerprint(), () => ({
      ...analyticsRollup(db),
      webTools: webToolUsage(db),
      sidechain: { summary: sidechainSummary(db), byProject: sidechainByProject(db) },
      compactions: compactionUsage(db),
      contextTax: contextTax(db),
      whatIf: whatIfRepricing(db, pricing),
      parseCoverage: parseCoverage(db),
    })),
  );

  // Setup audit: the installed inventory (scanned live off the Claude dir)
  // cross-referenced with observed usage from the index. It depends on the
  // filesystem too, but the inventory scan is cheap — memoizing on the index
  // fingerprint plus `today` (staleness rolls over at midnight) rebuilds the
  // whole payload, inventory included, whenever the index changes.
  api.get("/api/audit", (c) => {
    const today = localDayOfMs(Date.now());
    return cachedJson(c, "audit", `${fingerprint()}:${today}`, () =>
      buildSetupAudit(scanInventory(), analyticsRollup(db), today),
    );
  });

  // Weekly digest: one period's usage with deltas against the period before,
  // plus the current-state insight snapshot (shared with /api/insights through
  // the memo above, so the two routes assemble those signals once between
  // them). The period is resolved BEFORE the memo, so each ISO week gets its
  // own slot: two days of the same week share one entry, and asking for an
  // older week doesn't evict the default one. `cachedValue` (not `cachedJson`)
  // so the cost-basis display preference can be merged fresh per request,
  // exactly like /api/stats does.
  api.get("/api/report", (c) => {
    const week = c.req.query("week");
    if (week !== undefined && !isDayString(week)) {
      return c.json({ error: "week must be a YYYY-MM-DD day" }, 400);
    }
    const today = localDayOfMs(Date.now());
    const period = week ? weekPeriod(week) : lastCompleteWeek(today);
    const digest = cachedValue(`report:${period.start}`, `${fingerprint()}:${today}`, () =>
      buildWeeklyDigest(db, pricing, { week, today, insights: portfolioDiagnostics(today) }),
    );
    // `week` is a client-supplied (if validated) day, so the slot name is the
    // one keyspace here a caller can grow: keep the most recently *requested*
    // weeks and drop the rest — a dropped week costs one rebuild, nothing more.
    capSlots(objCache, "report:", MAX_REPORT_SLOTS);
    return c.json({ ...digest, costBasis: getCostBasis() });
  });

  api.get("/api/projects/:id/sessions", (c) => c.json(listIndexedSessions(db, c.req.param("id"))));

  // Project-scoped chart series: burn, model mix, scatter, and distributions.
  // Memoized per project id against the same index fingerprint. Unknown ids
  // 404 *before* touching the memo Map — its keyspace must stay bounded by
  // real projects, not by whatever ids clients probe.
  api.get("/api/projects/:id/trends", (c) => {
    const id = c.req.param("id");
    const known = db.query("SELECT 1 FROM sessions WHERE project_id = ? LIMIT 1").get(id);
    if (!known) return c.json({ error: "project not found" }, 404);
    return cachedJson(c, `ptrends:${id}`, fingerprint(), () => projectTrends(db, id));
  });

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
    return c.json(analyzeSession(parsed.events, pricing, { coverage: parsed.coverage }));
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
