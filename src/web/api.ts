import type { Database } from "bun:sqlite";
import type { Context } from "hono";
import { Hono } from "hono";
import { stream } from "hono/streaming";
import { analyzeSession } from "../core/analyze.ts";
import {
  CLAUDE_NOT_FOUND_MESSAGE,
  isValidModel,
  resolveClaudeBinary,
  runClaudeAnalysis,
  type Spawner,
} from "../core/claude-handoff.ts";
import type { CostBasis } from "../core/cost-framing.ts";
import { isDayString, lastCompleteWeek, weekPeriod } from "../core/digest.ts";
import { buildWeeklyDigest } from "../core/digest-signals.ts";
import { sessionSourceAt, sessionTree } from "../core/discover.ts";
import { inspectIndexStatus } from "../core/index-status.ts";
import { parseSessionTree } from "../core/parser.ts";
import { buildPortfolioDiagnostics } from "../core/portfolio-diagnostics.ts";
import { assemblePortfolioSignals } from "../core/portfolio-signals.ts";
import { getAnalysisModel, getCostBasis, setAnalysisModel, setCostBasis } from "../core/prefs.ts";
import type { PricingTable } from "../core/pricing.ts";
import {
  listIndexedProjects,
  listIndexedSessions,
  resolveIndexedProject,
  type SessionWithProject,
  searchSessions,
  sessionPathById,
  sessionRowById,
} from "../core/queries.ts";
import { inspectSessionHealth } from "../core/session-health.ts";
import { sessionWhatIf } from "../core/session-insights.ts";
import {
  buildSessionHtml,
  buildSessionMarkdown,
  sanitizeFilename,
} from "../core/session-markdown.ts";
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
  MAX_PROJECT_ROWS,
  modelMixByDay,
  parseCoverage,
  projectTrends,
  sessionCostRank,
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
// filter). Shared with the TUI's full-width joins via stats-types.

// How many weeks of digest stay memoized at once. Generous for the one thing a
// human does (page back through recent weeks) while bounding the one memo
// keyspace a client can enumerate.
const MAX_REPORT_SLOTS = 16;

// How many per-session cost ranks stay memoized. The keyspace is bounded by
// sessions that actually resolve in the index (unknown ids 404 first), but a
// crawl over a big portfolio could still bloat the Map — cap it by recency.
const MAX_RANK_SLOTS = 256;

/** Injectable seams for the analyze-with-Claude route, so tests can stand in a
 *  fake binary and subprocess without a real `claude` install. Defaults resolve
 *  the real binary and spawner. */
export interface ApiDeps {
  resolveClaudeBinary?: () => string | undefined;
  spawn?: Spawner;
  /** Newline-heartbeat interval (ms) for the analyze stream, keeping the
   *  connection alive through Claude Code's silent think gaps. Injectable so
   *  tests can drive it fast; defaults to 5s. */
  heartbeatMs?: number;
}

/** Build the JSON API (routes under `/api`). Pure over its db + pricing inputs. */
export function createApi(db: Database, pricing: PricingTable, deps: ApiDeps = {}): Hono {
  const resolveClaude = deps.resolveClaudeBinary ?? resolveClaudeBinary;
  const heartbeatMs = deps.heartbeatMs ?? 5000;
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
  const prefsPayload = () => ({ costBasis: getCostBasis(), analysisModel: getAnalysisModel() });
  api.get("/api/prefs", (c) => c.json(prefsPayload()));
  // PUT is the primary write verb (replacing the whole prefs resource); POST
  // is accepted too since a JSON body handler is trivial to share in Hono and
  // it saves SPA callers from caring which verb to use. Each field is optional
  // so the SPA can flip the cost basis or the analysis model independently.
  api.on(["PUT", "POST"], "/api/prefs", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    const b = (body ?? {}) as { costBasis?: unknown; analysisModel?: unknown };
    if (b.costBasis !== undefined) {
      if (b.costBasis !== "api" && b.costBasis !== "subscription") {
        return c.json({ error: 'costBasis must be "api" or "subscription"' }, 400);
      }
      setCostBasis(b.costBasis satisfies CostBasis);
    }
    if (b.analysisModel !== undefined) {
      if (typeof b.analysisModel !== "string" || !isValidModel(b.analysisModel)) {
        return c.json({ error: "analysisModel must be a valid model id" }, 400);
      }
      setAnalysisModel(b.analysisModel);
    }
    return c.json(prefsPayload());
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

  /**
   * Resolve `:id` leniently to a stored project id, or produce the response
   * that explains why it could not. Stored ids are root-qualified, so a bare
   * name — an old bookmark, a hand-typed reference — resolves when exactly one
   * root holds that project; when several do, saying so beats picking one.
   */
  const projectParam = (c: Context): { id: string } | { error: Response } => {
    const ref = c.req.param("id") ?? "";
    const match = resolveIndexedProject(db, ref);
    if (match.status === "found") return { id: match.id };
    if (match.status === "ambiguous") {
      return {
        error: c.json(
          {
            error: `'${ref}' matches ${match.candidates.length} projects; use a full id`,
            candidates: match.candidates,
          },
          409,
        ),
      };
    }
    return { error: c.json({ error: "project not found" }, 404) };
  };

  api.get("/api/insights/:id/sessions", (c) => {
    const p = projectParam(c);
    return "error" in p ? p.error : c.json(cacheWasteBySession(db, p.id, 200));
  });

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

  api.get("/api/projects/:id/sessions", (c) => {
    const p = projectParam(c);
    return "error" in p ? p.error : c.json(listIndexedSessions(db, p.id));
  });

  // Project-scoped chart series: burn, model mix, scatter, and distributions.
  // Memoized per project id against the same index fingerprint. Unresolvable
  // ids are rejected *before* touching the memo Map — its keyspace must stay
  // bounded by real projects, not by whatever ids clients probe. The memo is
  // keyed by the *resolved* id, so a bare and a qualified reference to one
  // project share a slot instead of each minting their own.
  api.get("/api/projects/:id/trends", (c) => {
    const p = projectParam(c);
    if ("error" in p) return p.error;
    return cachedJson(c, `ptrends:${p.id}`, fingerprint(), () => projectTrends(db, p.id));
  });

  // Files Claude touched across a project's sessions, hottest first.
  api.get("/api/projects/:id/files", (c) => {
    const p = projectParam(c);
    return "error" in p ? p.error : c.json(hotFiles(db, p.id));
  });

  // Registered before "/api/sessions/:id" so "search" isn't captured as an id.
  api.get("/api/sessions/search", (c) => {
    const q = c.req.query("q") ?? "";
    if (q.length > 200) return c.json({ error: "q too long" }, 400);
    const parsed = Number(c.req.query("limit") ?? "100");
    // Clamp: LIMIT -1 is "unlimited" in SQLite, and huge values are abuse.
    const limit = Number.isInteger(parsed) ? Math.min(Math.max(parsed, 1), 1000) : 100;
    const trimmed = q.trim();
    if (!trimmed) return c.json([]);
    // Exact ID lookup: if q is an exact session id, return that session first (DB-derived, no FS read).
    // Path-like queries are handled as fuzzy search via searchSessions (no direct FS read over HTTP).
    if (/^[0-9a-f-]{8,}/i.test(trimmed)) {
      const exact = sessionRowById(db, trimmed);
      if (exact) {
        type RawSessionRow = Omit<SessionWithProject, "costEstimated"> & { costEstimated: number };
        const session = db
          .query(
            `SELECT session_id AS sessionId, path, title, project_path AS projectPath, cost_total AS cost, cost_estimated AS costEstimated, (input_tokens + output_tokens) AS ioTokens, (cache_write_5m + cache_write_1h + cache_read) AS cacheTokens, start_time AS startTime, turns, api_calls AS apiCalls, tool_calls AS toolCalls, mtime_ms AS mtimeMs FROM sessions WHERE path = ? LIMIT 1`,
          )
          .get(exact.path) as RawSessionRow | undefined;
        if (session) {
          // Return exact match first, then supplement with fuzzy results (deduped)
          const likeResults = searchSessions(db, trimmed, limit - 1);
          const exactPath = exact.path;
          const deduped = likeResults.filter((r) => r.path !== exactPath);
          const mapped: SessionWithProject = {
            sessionId: session.sessionId,
            path: session.path,
            title: session.title,
            projectPath: session.projectPath,
            cost: session.cost,
            costEstimated: session.costEstimated === 1,
            ioTokens: session.ioTokens,
            cacheTokens: session.cacheTokens,
            startTime: session.startTime,
            turns: session.turns,
            apiCalls: session.apiCalls,
            toolCalls: session.toolCalls,
            mtimeMs: session.mtimeMs,
          };
          return c.json([mapped, ...deduped]);
        }
      }
    }
    return c.json(searchSessions(db, trimmed, limit));
  });

  // The index is a disposable cache, so an indexed path can be stale — a
  // deleted session file must 404 with a hint, not crash into a 500.
  const readSession = async (path: string) => {
    try {
      // The whole tree: subagent transcripts live beside the parent file and
      // carry spend that belongs to this session.
      const source = await sessionSourceAt(path);
      // Nothing left on disk at all — a stale row, so 404 rather than serve an
      // empty analysis as though the session were merely uneventful. An orphan
      // (parent deleted, subagent transcripts surviving) is *not* this case:
      // it has real work to show and reads normally.
      if (!source.parentExists && source.subagentPaths.length === 0) return undefined;
      return { ...(await parseSessionTree(sessionTree(source))), agentMeta: source.agentMeta };
    } catch {
      return undefined;
    }
  };
  const staleIndex = { error: "session file is missing; re-run `cc-analyzer index`" };

  // The analysis payload plus a server-computed `insights` sibling: the
  // session-scoped what-if needs the pricing table and the cost rank needs the
  // index — neither is available client-side, and folding them in here avoids
  // a second parse of a potentially huge session file for a separate route.
  // The outcome ratios are NOT here: `sessionOutcomes` is bun-free, so the
  // SPA derives them from this same payload.
  api.get("/api/sessions/:id", async (c) => {
    const rawId = c.req.param("id");
    const id = decodeURIComponent(rawId);
    // Indexed lookup only — Web never does direct filesystem path reads from user input (security).
    // CLI supports id|path via resolveSessionSource, but HTTP is DB-derived only to avoid arbitrary file read.
    const row = sessionRowById(db, id);
    if (!row) return c.json({ error: "session not found" }, 404);
    const resolvedPath = row.path;
    const projectId = row.projectId;
    const parsed = await readSession(resolvedPath);
    if (!parsed) return c.json(staleIndex, 404);
    const analysis = analyzeSession(parsed.events, pricing, {
      coverage: parsed.coverage,
      agentMeta: parsed.agentMeta,
    });
    // The rank depends only on the index, so it memoizes on the fingerprint —
    // flipping between two sessions doesn't rescan the table. The what-if is
    // a pure fold over the handful of models just analyzed; not worth a slot.
    const rank = memo(`rank:${id}`, fingerprint(), () => sessionCostRank(db, id) ?? null);
    capSlots("rank:", MAX_RANK_SLOTS);
    return c.json({
      ...analysis,
      projectId: projectId!,
      insights: { whatIf: sessionWhatIf(analysis.models, pricing), rank },
    });
  });

  api.get("/api/sessions/:id/transcript", async (c) => {
    const rawId = decodeURIComponent(c.req.param("id"));
    const path = sessionPathById(db, rawId);
    if (!path) return c.json({ error: "session not found" }, 404);
    const parsed = await readSession(path);
    if (!parsed) return c.json(staleIndex, 404);
    return c.json(buildTranscript(parsed.events));
  });

  // Shareable per-session export — markdown / html / json, single-file, no server needed
  // to view. Mirrors the CLI `analyze --md|--html|--json --out` builder so both
  // surfaces produce byte-identical reports. Redaction hides prompt/transcript
  // text for external sharing; transcript inclusion is opt-in (size!).
  api.get("/api/sessions/:id/report", async (c) => {
    const id = c.req.param("id");
    const row = sessionRowById(db, id);
    if (!row) return c.json({ error: "session not found" }, 404);
    const parsed = await readSession(row.path);
    if (!parsed) return c.json(staleIndex, 404);
    const analysis = analyzeSession(parsed.events, pricing, {
      coverage: parsed.coverage,
      agentMeta: parsed.agentMeta,
    });
    const format = (c.req.query("format") ?? "md").toLowerCase();
    if (format !== "md" && format !== "markdown" && format !== "html" && format !== "json")
      return c.json({ error: 'format must be "md", "html", or "json"' }, 400);
    const redact = c.req.query("redact") === "1";
    const includeTranscript = c.req.query("transcript") === "1";
    const whatIf = sessionWhatIf(analysis.models, pricing);
    const health = inspectSessionHealth(parsed.events, parsed.errors, parsed.coverage);
    const rank = sessionCostRank(db, id) ?? null;
    const costBasis = getCostBasis();
    const rawTranscript = includeTranscript ? buildTranscript(parsed.events) : undefined;
    const transcript = rawTranscript
      ? rawTranscript.slice(0, 600).map((t) => ({ ...t, body: t.body.slice(0, 2000) }))
      : undefined;
    const base = sanitizeFilename(analysis.sessionId ?? id);
    if (format === "html") {
      const html = buildSessionHtml(analysis, {
        costBasis,
        whatIf,
        health,
        rank,
        redact,
        includeTranscript,
        transcript,
      });
      c.header("Content-Type", "text/html; charset=utf-8");
      c.header("Content-Disposition", `attachment; filename="cc-analyzer-${base}.html"`);
      return c.body(html);
    }
    if (format === "json") {
      // SAFETY: redact strips title/path/files + caps transcript at 600/2000.
      const redactedTranscript =
        includeTranscript && transcript
          ? transcript.map((t) => ({ ...t, body: redact ? "[redacted]" : t.body }))
          : undefined;
      const payload: Record<string, unknown> = {
        ...analysis,
        health,
        whatIf,
        rank,
        costBasis,
        ...(redact
          ? {
              title: "[redacted]",
              projectPath: "[redacted]",
              filesTouched: [],
              bashCommands: {},
              bashErrors: {},
              commandHeads: {},
              commandHeadErrors: {},
              turns: analysis.turns.map((t) => ({ ...t, prompt: "[redacted]" })),
            }
          : {}),
      };
      if (includeTranscript && redactedTranscript) payload.transcript = redactedTranscript;
      c.header("Content-Disposition", `attachment; filename="cc-analyzer-${base}.json"`);
      return c.json(payload);
    }
    const md = buildSessionMarkdown(analysis, {
      costBasis,
      whatIf,
      health,
      rank,
      redact,
      includeTranscript,
      transcript,
    });
    c.header("Content-Type", "text/markdown; charset=utf-8");
    c.header("Content-Disposition", `attachment; filename="cc-analyzer-${base}.md"`);
    return c.body(md);
  });

  // Analyze-with-Claude-Code: spawn a locally-installed `claude` headless and
  // stream its retrospective back to the SPA as NDJSON (one AnalysisEvent per
  // line). This is the tool's one *subprocess* side effect, and it stays
  // read-only over ~/.claude: it points Claude at the session file with
  // `--allowedTools Read` and never `--resume`s (which would append turns to the
  // real session). Safe as an unauthenticated local write because `serve` binds
  // to loopback (server.ts) for a single user and the DNS-rebinding guard
  // applies. The run is the user's own Claude Code session under their normal
  // data dir and costs real tokens, so the SPA makes it explicitly opt-in.
  api.post("/api/sessions/:id/analyze", async (c) => {
    const row = sessionRowById(db, c.req.param("id"));
    if (!row) return c.json({ error: "session not found" }, 404);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      body = {};
    }
    const requested = (body as { model?: unknown } | null)?.model;
    const model =
      typeof requested === "string" && requested.length > 0 ? requested : getAnalysisModel();
    if (!isValidModel(model)) return c.json({ error: "invalid model" }, 400);
    const claudeBin = resolveClaude();
    if (!claudeBin) return c.json({ error: CLAUDE_NOT_FOUND_MESSAGE }, 503);
    const parsed = await readSession(row.path);
    if (!parsed) return c.json(staleIndex, 404);
    const analysis = analyzeSession(parsed.events, pricing, {
      coverage: parsed.coverage,
      agentMeta: parsed.agentMeta,
    });
    const whatIf = sessionWhatIf(analysis.models, pricing);
    c.header("Content-Type", "application/x-ndjson; charset=utf-8");
    c.header("Cache-Control", "no-store");
    return stream(c, async (s) => {
      // Claude Code streams thinking tokens we don't forward, so this response
      // can go silent for a long stretch before its first visible text. Emit a
      // bare newline on an interval as a heartbeat: it keeps bytes flowing so
      // the connection never idles out (see `idleTimeout` in server.ts), and
      // the SPA's NDJSON reader skips blank lines, so it's inert to the client.
      const heartbeat = setInterval(() => {
        s.write("\n").catch(() => {});
      }, heartbeatMs);
      try {
        for await (const event of runClaudeAnalysis(
          { claudeBin, sessionPath: row.path, analysis, model, whatIf },
          { spawn: deps.spawn },
        )) {
          await s.write(`${JSON.stringify(event)}\n`);
        }
      } finally {
        clearInterval(heartbeat);
      }
    });
  });

  return api;
}
