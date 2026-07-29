import type { Database } from "bun:sqlite";
import type { Context } from "hono";
import { Hono } from "hono";
import { analyzeSession } from "../core/analyze.ts";
import type { CostBasis } from "../core/cost-framing.ts";
import { isDayString, lastCompleteWeek, weekPeriod } from "../core/digest.ts";
import { buildWeeklyDigest } from "../core/digest-signals.ts";
import { inspectIndexStatus } from "../core/index-status.ts";
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
import {
  activityHeatmap,
  analyticsRollup,
  buildPortfolioStats,
  cacheWasteByProject,
  cacheWasteBySession,
  compactionUsage,
  concurrency,
  contextTax,
  errorRateByWeek,
  hotFiles,
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
  /**
   * One memo table for every cached thing here — built values and serialized
   * payloads alike. A slot holds one value at a time and rebuilds when its
   * `key` changes; the slot is re-inserted on every read so Map iteration order
   * is true recency, which is what `capSlots` evicts by (`Map.set` on an
   * existing key does NOT reorder, so without the delete the *first requested*
   * slot would be dropped first — the opposite of the intent).
   */
  const cache = new Map<string, { key: string; value: unknown }>();
  const memo = <T>(name: string, key: string, build: () => T): T => {
    const hit = cache.get(name);
    const value = hit?.key === key ? (hit.value as T) : build();
    cache.delete(name);
    cache.set(name, { key, value });
    return value;
  };
  /** Memoize a route's *serialized* payload — the common case, where nothing
   * outside the memo key can change the response body. */
  const cachedJson = (c: Context, name: string, key: string, build: () => unknown) =>
    c.body(
      memo(name, key, () => JSON.stringify(build())),
      200,
      { "content-type": "application/json" },
    );
  /** Keep at most `max` slots whose name starts with `prefix`, least recently
   * requested first. Only routes whose slot name embeds a client-supplied value
   * need this — every other keyspace here is bounded by the index itself, and
   * unknown project ids 404 before reaching the memo. */
  const capSlots = (prefix: string, max: number): void => {
    const keys = [...cache.keys()].filter((k) => k.startsWith(prefix));
    for (const k of keys.slice(0, Math.max(0, keys.length - max))) cache.delete(k);
  };

  // The single-scan usage rollup, shared by /api/analytics and the portfolio
  // signals below (which would otherwise scan the table a second time).
  const rollup = () => memo("rollup", fingerprint(), () => analyticsRollup(db));
  // The assembled portfolio signals — an index scan plus the setup audit's
  // filesystem walk — shared by /api/insights, /api/audit, and the digest's
  // insight snapshot on /api/report, so the three assemble them once between
  // them and cannot disagree. Memoized on the index fingerprint plus the local
  // day, because the audit's staleness rules roll over at midnight.
  const signals = (today: string) =>
    memo("signals", `${fingerprint()}:${today}`, () =>
      assemblePortfolioSignals(db, pricing, { rollup: rollup() }),
    );
  const portfolioDiagnostics = (today: string) =>
    memo("diagnostics", `${fingerprint()}:${today}`, () =>
      buildPortfolioDiagnostics(signals(today)),
    );

  api.get("/api/stats", (c) => {
    const today = localDayOfMs(Date.now());
    // `today` is part of the key: streaks/run-rate must roll over at midnight.
    const stats = memo("stats", `${fingerprint()}:${today}`, () =>
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
    return cachedJson(c, "insights", `${fingerprint()}:${today}`, () => {
      const s = signals(today);
      return {
        summary: s.cache.summary,
        // The one list not taken off the shared signals: the rules only need
        // the default top slice, while this view filters client-side and so
        // needs every project.
        projects: cacheWasteByProject(db, MAX_PROJECT_ROWS),
        ttl: s.cache.ttl,
        idleBuckets: s.cache.idleBuckets,
        diagnostics: portfolioDiagnostics(today),
      };
    });
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
      ...rollup(),
      webTools: webToolUsage(db),
      sidechain: { summary: sidechainSummary(db), byProject: sidechainByProject(db) },
      compactions: compactionUsage(db),
      contextTax: contextTax(db),
      whatIf: whatIfRepricing(db, pricing),
      parseCoverage: parseCoverage(db),
    })),
  );

  // Setup audit: the installed inventory (scanned live off the Claude dir)
  // cross-referenced with observed usage from the index. It is one of the
  // portfolio signals, so this route just serves that field instead of
  // rescanning — the signals memo already keys on the index fingerprint plus
  // `today` (staleness rolls over at midnight) and rebuilds the whole payload,
  // inventory included, whenever the index changes. `signals()` never disables
  // the audit, so the field is always present.
  api.get("/api/audit", (c) => {
    const today = localDayOfMs(Date.now());
    return cachedJson(c, "audit", `${fingerprint()}:${today}`, () => signals(today).audit);
  });

  // Weekly digest: one period's usage with deltas against the period before,
  // plus the current-state insight snapshot (shared with /api/insights through
  // the memo above, so the two routes assemble those signals once between
  // them). `insights=0` drops that snapshot — the dashboard card renders none
  // of it and shouldn't pay for the signal assembly on first paint.
  //
  // The period is resolved BEFORE the memo, so each ISO week gets its own slot:
  // two days of the same week share one entry, and asking for an older week
  // doesn't evict the default one. The cost-basis preference rides in the memo
  // KEY rather than being patched over a cached digest: it is baked into the
  // digest (the framing sentence, and the markdown the SPA copies), and
  // flipping the toggle is rare enough that one cheap period rebuild beats
  // keeping a second, unmemoized merge step here.
  api.get("/api/report", (c) => {
    const week = c.req.query("week");
    if (week !== undefined && !isDayString(week)) {
      return c.json({ error: "week must be a YYYY-MM-DD day" }, 400);
    }
    const today = localDayOfMs(Date.now());
    const period = week ? weekPeriod(week) : lastCompleteWeek(today);
    const withInsights = c.req.query("insights") !== "0";
    const costBasis = getCostBasis();
    // `week` is a client-supplied (if validated) day, so the slot name is the
    // one keyspace here a caller can grow: keep the most recently *requested*
    // weeks and drop the rest — a dropped week costs one rebuild, nothing more.
    const body = cachedJson(
      c,
      `report:${period.start}:${withInsights ? "full" : "light"}`,
      `${fingerprint()}:${today}:${costBasis}`,
      () =>
        buildWeeklyDigest(db, pricing, {
          week,
          today,
          costBasis,
          insights: withInsights ? portfolioDiagnostics(today) : [],
        }),
    );
    capSlots("report:", MAX_REPORT_SLOTS);
    return body;
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
