import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Spawner } from "../../src/core/claude-handoff.ts";
import { openDb } from "../../src/core/db.ts";
import { reindex } from "../../src/core/indexer.ts";
import { getCostBasis, setCostBasis } from "../../src/core/prefs.ts";
import { projectIdParts } from "../../src/core/project-labels.ts";
import { createApi } from "../../src/web/api.ts";
import { createApp, isLoopbackHost } from "../../src/web/server.ts";
import { tempClaudeDir } from "../helpers/claude-dir.ts";
import { samplePricing as pricing } from "../helpers/pricing.ts";

const fixture = fileURLToPath(new URL("../fixtures/sample-session.jsonl", import.meta.url));
let claude: ReturnType<typeof tempClaudeDir>;
let db: Database;
let api: ReturnType<typeof createApi>;

beforeAll(async () => {
  claude = tempClaudeDir("cc-analyzer-api");
  const content = await Bun.file(fixture).text();
  mkdirSync(join(claude.dir, "projects", "proj-a"), { recursive: true });
  writeFileSync(join(claude.dir, "projects", "proj-a", "sess-1.jsonl"), content);
  // A minimal installed setup so /api/audit has something to cross-reference.
  mkdirSync(join(claude.dir, "skills", "tidy"), { recursive: true });
  writeFileSync(join(claude.dir, "skills", "tidy", "SKILL.md"), "# tidy\n");
  writeFileSync(
    `${claude.dir}.json`,
    JSON.stringify({ mcpServers: { github: { command: "gh-mcp" } } }),
  );
  db = openDb(":memory:");
  await reindex(db, { pricing });
  api = createApi(db, pricing);
});

afterAll(() => {
  db.close();
  rmSync(`${claude.dir}.json`, { force: true });
  claude.cleanup();
});

/** Run `fn` against a fresh, empty `CC_ANALYZER_STATE_DIR` (so prefs.json
 *  starts unset) and restore the previous env var + clean up afterwards —
 *  the same pattern the pre-existing cost-basis test used inline. */
async function withStateDir<T>(fn: () => Promise<T> | T): Promise<T> {
  const prevStateDir = process.env.CC_ANALYZER_STATE_DIR;
  const stateDir = `${claude.dir}-state-${Math.random().toString(36).slice(2)}`;
  mkdirSync(stateDir, { recursive: true });
  process.env.CC_ANALYZER_STATE_DIR = stateDir;
  try {
    return await fn();
  } finally {
    if (prevStateDir === undefined) delete process.env.CC_ANALYZER_STATE_DIR;
    else process.env.CC_ANALYZER_STATE_DIR = prevStateDir;
    rmSync(stateDir, { recursive: true, force: true });
  }
}

describe("web API", () => {
  test("GET /api/stats returns a portfolio view", async () => {
    const res = await api.request("/api/stats");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { summary: { sessions: number }; byModel: unknown[] };
    expect(body.summary.sessions).toBe(1);
    expect(body.byModel.length).toBeGreaterThan(0);
  });

  test("GET /api/stats carries the cost-basis preference, read fresh each request", async () => {
    const prevStateDir = process.env.CC_ANALYZER_STATE_DIR;
    const stateDir = `${claude.dir}-state`;
    mkdirSync(stateDir, { recursive: true });
    process.env.CC_ANALYZER_STATE_DIR = stateDir;
    try {
      const before = (await (await api.request("/api/stats")).json()) as { costBasis: string };
      expect(before.costBasis).toBe("api");

      setCostBasis("subscription");
      const after = (await (await api.request("/api/stats")).json()) as { costBasis: string };
      expect(after.costBasis).toBe("subscription");
    } finally {
      if (prevStateDir === undefined) delete process.env.CC_ANALYZER_STATE_DIR;
      else process.env.CC_ANALYZER_STATE_DIR = prevStateDir;
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  test("GET /api/prefs returns the current cost-basis preference (default api)", async () => {
    await withStateDir(async () => {
      const res = await api.request("/api/prefs");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ costBasis: "api", analysisModel: "sonnet" });
    });
  });

  test("PUT /api/prefs persists a valid cost basis and echoes it back", async () => {
    await withStateDir(async () => {
      const res = await api.request("/api/prefs", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ costBasis: "subscription" }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ costBasis: "subscription", analysisModel: "sonnet" });
      expect(getCostBasis()).toBe("subscription"); // persisted, not just echoed
    });
  });

  test("PUT /api/prefs rejects an unknown cost basis with 400, preference unchanged", async () => {
    await withStateDir(async () => {
      const res = await api.request("/api/prefs", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ costBasis: "yolo" }),
      });
      expect(res.status).toBe(400);
      expect((await res.json()) as { error: string }).toMatchObject({
        error: expect.stringContaining('"api" or "subscription"'),
      });
      expect(getCostBasis()).toBe("api"); // untouched
    });
  });

  test("PUT /api/prefs rejects malformed JSON with 400", async () => {
    await withStateDir(async () => {
      const res = await api.request("/api/prefs", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: "not json",
      });
      expect(res.status).toBe(400);
    });
  });

  test("POST /api/prefs is accepted as an alias for PUT", async () => {
    await withStateDir(async () => {
      const res = await api.request("/api/prefs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ costBasis: "subscription" }),
      });
      expect(res.status).toBe(200);
      expect(getCostBasis()).toBe("subscription");
    });
  });

  test("a cost-basis change via PUT /api/prefs is reflected on the next /api/stats fetch", async () => {
    await withStateDir(async () => {
      const before = (await (await api.request("/api/stats")).json()) as { costBasis: string };
      expect(before.costBasis).toBe("api");

      await api.request("/api/prefs", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ costBasis: "subscription" }),
      });

      const after = (await (await api.request("/api/stats")).json()) as { costBasis: string };
      expect(after.costBasis).toBe("subscription");
    });
  });

  test("GET /api/index-status reports exact source freshness", async () => {
    const res = await api.request("/api/index-status");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      stale: false,
      added: 0,
      changed: 0,
      deleted: 0,
    });
  });

  test("GET /api/projects lists projects", async () => {
    const res = await api.request("/api/projects");
    const body = (await res.json()) as { projectId: string }[];
    expect(body).toHaveLength(1);
    expect(projectIdParts(body[0]?.projectId ?? "").dirName).toBe("proj-a");
  });

  test("GET /api/projects/:id/sessions lists sessions", async () => {
    const res = await api.request("/api/projects/proj-a/sessions");
    const body = (await res.json()) as unknown[];
    expect(body).toHaveLength(1);
  });

  test("GET /api/sessions/:id returns analysis", async () => {
    const res = await api.request("/api/sessions/sess-1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { totals: { turns: number } };
    expect(body.totals.turns).toBe(2);
  });

  test("GET /api/sessions/:id carries server-computed insights (what-if + rank)", async () => {
    const res = await api.request("/api/sessions/sess-1");
    const body = (await res.json()) as {
      insights: {
        whatIf: { summary: { actualCost: number } };
        rank: { portfolio: { sessions: number; pct: number } } | null;
      };
    };
    expect(body.insights.whatIf.summary.actualCost).toBeGreaterThan(0);
    // The session is indexed, so the rank exists and covers the whole index.
    expect(body.insights.rank?.portfolio.sessions).toBeGreaterThan(0);
  });

  test("GET /api/sessions/:id carries the project id, not just its path", async () => {
    // The SPA resolves a session's project from this. Two Claude roots can hold
    // a project for the same working directory, so a `projectPath` match would
    // link to whichever row happened to sort first — the id is unambiguous.
    const res = await api.request("/api/sessions/sess-1");
    const body = (await res.json()) as { projectId?: string; projectPath?: string };
    expect(body.projectId).toBeString();
    expect(projectIdParts(body.projectId ?? "").dirName).toBe("proj-a");
  });

  test("a project route accepts a bare id, so old bookmarks keep working", async () => {
    // Stored ids are root-qualified; a URL saved before that (or typed by hand)
    // resolves when only one root holds the project.
    const res = await api.request("/api/projects/proj-a/sessions");
    expect(res.status).toBe(200);
    expect(((await res.json()) as unknown[]).length).toBeGreaterThan(0);
  });

  test("an unknown project id is a 404", async () => {
    const res = await api.request("/api/projects/nope/sessions");
    expect(res.status).toBe(404);
  });

  test("GET /api/sessions/:id/transcript returns transcript items", async () => {
    const res = await api.request("/api/sessions/sess-1/transcript");
    const body = (await res.json()) as { kind: string }[];
    expect(body[0]?.kind).toBe("prompt");
  });

  test("unknown session id returns 404", async () => {
    const res = await api.request("/api/sessions/nope");
    expect(res.status).toBe(404);
  });

  test("GET /api/sessions/search matches across projects and tags the project", async () => {
    const res = await api.request("/api/sessions/search?q=proj");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { projectPath: string }[];
    expect(body.length).toBeGreaterThan(0);
    expect(body[0]?.projectPath).toBe("/Users/dev/proj");
  });

  test("empty search query returns an empty list", async () => {
    const res = await api.request("/api/sessions/search?q=");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  test("GET /api/insights returns the cache summary and ranked projects", async () => {
    const res = await api.request("/api/insights");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      summary: { writeCost: number };
      projects: { projectId: string; writeTokens: number; readTokens: number; ratio: number }[];
    };
    expect(body.summary.writeCost).toBeGreaterThan(0);
    expect(body.projects).toHaveLength(1); // proj-a has cache-write activity
    expect(projectIdParts(body.projects[0]?.projectId ?? "").dirName).toBe("proj-a");
    // fixture: 1000 written, 9000 read → ratio 9, well amortized
    expect(body.projects[0]?.ratio).toBeCloseTo(9, 5);
  });

  test("GET /api/insights carries the ranked portfolio diagnostics", async () => {
    const res = await api.request("/api/insights");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      diagnostics: { code: string; severity: string; evidence: string; action: string }[];
    };
    expect(Array.isArray(body.diagnostics)).toBe(true);
    // One tiny fixture session crosses no conservative threshold, and the
    // warnings-first ordering must hold for whatever does fire.
    const severities = body.diagnostics.map((d) => d.severity);
    const firstInfo = severities.indexOf("info");
    if (firstInfo !== -1) {
      expect(severities.slice(firstInfo).every((s) => s === "info")).toBe(true);
    }
  });

  test("GET /api/insights/:id/sessions ranks a project's sessions by waste", async () => {
    const res = await api.request("/api/insights/proj-a/sessions");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { writeTokens: number }[];
    expect(body).toHaveLength(1);
    expect(body[0]?.writeTokens).toBe(1000);
  });

  test("GET /api/trends returns the daily series and the activity heatmap", async () => {
    const res = await api.request("/api/trends");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      daily: { day: string; cost: number }[];
      heatmap: { weekday: number; hour: number; sessions: number }[];
    };
    expect(body.daily.length).toBeGreaterThan(0);
    expect(typeof body.daily[0]?.day).toBe("string");
    expect(body.heatmap.length).toBeGreaterThan(0);
    expect(body.heatmap[0]?.sessions).toBeGreaterThan(0);
  });

  test("GET /api/analytics returns tool/skill/subagent usage", async () => {
    const res = await api.request("/api/analytics");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      tools: { tool: string; uses: number; errors: number; errorRate: number }[];
      skills: { name: string; invocations: number; projects: number; daily: unknown[] }[];
      subagents: unknown[];
    };
    expect(body.tools.length).toBeGreaterThan(0);
    expect(typeof body.tools[0]?.tool).toBe("string");
    expect(body.tools[0]?.uses).toBeGreaterThan(0);
    expect(Array.isArray(body.skills)).toBe(true);
    for (const s of body.skills) {
      expect(typeof s.name).toBe("string");
      expect(typeof s.invocations).toBe("number");
      expect(typeof s.projects).toBe("number");
      expect(Array.isArray(s.daily)).toBe(true);
    }
    expect(Array.isArray(body.subagents)).toBe(true);
  });

  test("GET /api/projects/:id/trends returns project-scoped chart series", async () => {
    const res = await api.request("/api/projects/proj-a/trends");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      daily: { day: string; cost: number }[];
      modelMix: unknown[];
      scatter: unknown[];
      distribution: { sessions: number };
      turnDepth: { turns: number };
      tools: { tool: string }[];
    };
    expect(body.daily.length).toBeGreaterThan(0);
    expect(body.modelMix.length).toBeGreaterThan(0);
    expect(body.distribution.sessions).toBe(1);
    expect(body.turnDepth.turns).toBeGreaterThan(0);
    expect(body.tools.some((t) => t.tool === "Bash")).toBe(true);
    // Unknown ids 404 before touching the memo cache — its keyspace must stay
    // bounded by real projects, not by whatever ids clients probe.
    const other = await api.request("/api/projects/nope/trends");
    expect(other.status).toBe(404);
  });

  test("GET /api/analytics includes the compaction rollup", async () => {
    const res = await api.request("/api/analytics");
    const body = (await res.json()) as {
      compactions: { summary: { totalSessions: number; compactions: number } };
    };
    expect(body.compactions.summary.totalSessions).toBeGreaterThan(0);
    expect(body.compactions.summary.compactions).toBe(0); // fixture has none
  });

  test("GET /api/analytics carries the context-tax and what-if rollups", async () => {
    const res = await api.request("/api/analytics");
    const body = (await res.json()) as {
      contextTax: { summary: { sessions: number }; byProject: { projectId: string }[] };
      whatIf: { rows: { model: string; alternatives: { model: string }[] }[] };
    };
    // The fixture session makes main-chain calls, so it carries a baseline.
    expect(body.contextTax.summary.sessions).toBe(1);
    expect(projectIdParts(body.contextTax.byProject[0]?.projectId ?? "").dirName).toBe("proj-a");
    // Both fixture models are priceable, so each is the other's alternative.
    expect(body.whatIf.rows.length).toBeGreaterThan(0);
    expect(body.whatIf.rows[0]?.alternatives.length).toBeGreaterThan(0);
  });

  test("GET /api/analytics carries the parse-coverage rollup", async () => {
    const res = await api.request("/api/analytics");
    const body = (await res.json()) as {
      parseCoverage: {
        summary: { sessions: number; lines: number; unknownEvents: number; unparsedShare: number };
        byVersion: { version: string; lines: number }[];
      };
    };
    expect(body.parseCoverage.summary.sessions).toBe(1);
    expect(body.parseCoverage.summary.lines).toBe(10);
    // The fixture carries one future/unknown event type.
    expect(body.parseCoverage.summary.unknownEvents).toBe(1);
    expect(body.parseCoverage.summary.unparsedShare).toBeCloseTo(0.1, 10);
    expect(body.parseCoverage.byVersion[0]?.version).toBe("1.3.0");
  });

  test("GET /api/sessions/:id carries the session's parse coverage", async () => {
    const list = (await (await api.request("/api/projects/proj-a/sessions")).json()) as {
      sessionId: string;
    }[];
    const id = list[0]?.sessionId as string;
    const body = (await (await api.request(`/api/sessions/${id}`)).json()) as {
      parseCoverage?: { lines: number; parseErrors: number; unknownEvents: number };
    };
    expect(body.parseCoverage).toEqual({ lines: 10, parseErrors: 0, unknownEvents: 1 });
  });

  test("GET /api/audit cross-references the installed setup with usage", async () => {
    const res = await api.request("/api/audit");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      inventory: { present: boolean; skills: { name: string }[] };
      counts: { skills: number; mcpServers: number };
      plugins: unknown[];
      findings: { code: string; subject: string; severity: string }[];
    };
    expect(body.inventory.present).toBe(true);
    // No plugins installed in the fixture setup, but the field always ships.
    expect(body.plugins).toEqual([]);
    expect(body.counts).toMatchObject({ skills: 1, mcpServers: 1 });
    // The fixture session uses neither the installed skill nor the MCP server.
    expect(body.findings.map((f) => f.code)).toEqual(["unused-mcp-server", "unused-skill"]);
    expect(body.findings[0]?.subject).toBe("github");
  });

  test("GET /api/report defaults to the last complete week", async () => {
    // Fresh state dir: the cost-basis assertion below needs the default pref.
    const res = await withStateDir(() => api.request("/api/report"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      period: { start: string; end: string };
      prior: { start: string; end: string };
      today: string;
      headline: { sessions: { current: number; prior: number } };
      insights: unknown[];
      costBasis: string;
    };
    // Monday-anchored, seven days long, and strictly before today.
    expect(body.period.start < body.period.end).toBe(true);
    expect(body.period.end < body.today).toBe(true);
    expect(new Date(`${body.period.start}T00:00:00Z`).getUTCDay()).toBe(1);
    expect(body.prior.end).toBe(
      new Date(Date.parse(`${body.period.start}T00:00:00Z`) - 86_400_000)
        .toISOString()
        .slice(0, 10),
    );
    expect(Array.isArray(body.insights)).toBe(true);
    // The cost-basis display preference rides along like on /api/stats.
    expect(body.costBasis).toBe("api");
  });

  test("GET /api/report?week= scopes to the week containing that day", async () => {
    // The fixture session is dated 2026-07-01 (Wed) → week 06-29 … 07-05.
    const res = await api.request("/api/report?week=2026-07-03");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      period: { start: string; end: string };
      headline: { sessions: { current: number } };
      projects: { projectId: string; cost: number }[];
    };
    expect(body.period).toEqual({ start: "2026-06-29", end: "2026-07-05" });
    expect(body.headline.sessions.current).toBe(1);
    expect(projectIdParts(body.projects[0]?.projectId ?? "").dirName).toBe("proj-a");

    // Same index, different week → a different payload (the memo key carries
    // the requested week, so one week's digest can't be served for another).
    const other = await api.request("/api/report?week=2026-06-22");
    const otherBody = (await other.json()) as { period: { start: string } };
    expect(otherBody.period.start).toBe("2026-06-22");
  });

  test("GET /api/report rejects a malformed week", async () => {
    const res = await api.request("/api/report?week=nope");
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toEqual({
      error: "week must be a YYYY-MM-DD day",
    });
  });

  test("aggregate responses are cached until the index fingerprint changes", async () => {
    const first = await (await api.request("/api/analytics")).text();
    const again = await (await api.request("/api/analytics")).text();
    expect(again).toBe(first); // served from cache: byte-identical

    // A reindex bumps indexed_at → fingerprint changes → payload rebuilt (and
    // still equal in content for the same underlying sessions).
    await reindex(db, { pricing, rebuild: true });
    const rebuilt = await api.request("/api/analytics");
    expect(rebuilt.status).toBe(200);
    const body = (await rebuilt.json()) as { tools: unknown[] };
    expect(body.tools.length).toBeGreaterThan(0);
  });
});

describe("web API · stale index", () => {
  test("a session whose file was deleted after indexing 404s with a hint", async () => {
    const stalePath = join(claude.dir, "projects", "proj-a", "sess-stale.jsonl");
    writeFileSync(stalePath, await Bun.file(fixture).text());
    await reindex(db, { pricing });
    rmSync(stalePath, { force: true });
    // Not reindexed: the index still points at the deleted file.
    const res = await api.request("/api/sessions/sess-stale");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("re-run");
    // Clean the stale row so it doesn't leak into other tests.
    await reindex(db, { pricing });
  });
});

describe("createApp · Host-header guard", () => {
  test("loopback app 403s a non-local Host (DNS-rebinding defense)", async () => {
    const app = createApp(db, pricing, { loopbackOnly: true });
    const res = await app.request("/api/stats", { headers: { host: "evil.example" } });
    expect(res.status).toBe(403);
  });

  test("loopback app allows localhost and bracketed IPv6 loopback", async () => {
    const app = createApp(db, pricing, { loopbackOnly: true });
    const a = await app.request("/api/stats", { headers: { host: "localhost:4317" } });
    const b = await app.request("/api/stats", { headers: { host: "[::1]:4317" } });
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
  });

  test("non-loopback app skips the Host check", async () => {
    const app = createApp(db, pricing, { loopbackOnly: false });
    const res = await app.request("/api/stats", { headers: { host: "example.com" } });
    expect(res.status).toBe(200);
  });

  test("unknown /api path returns JSON 404, not the SPA", async () => {
    const app = createApp(db, pricing, { loopbackOnly: true });
    const res = await app.request("/api/nope", { headers: { host: "localhost" } });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not found" });
  });
});

describe("isLoopbackHost", () => {
  test("accepts loopback spellings with or without a port", () => {
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("localhost:4317")).toBe(true);
    expect(isLoopbackHost("::1")).toBe(true);
    expect(isLoopbackHost("[::1]:9999")).toBe(true);
  });
  test("rejects non-loopback and garbage", () => {
    expect(isLoopbackHost("0.0.0.0")).toBe(false);
    expect(isLoopbackHost("example.com")).toBe(false);
    expect(isLoopbackHost("")).toBe(false);
  });
});

/** A Spawner emitting canned stream-json, so the analyze route can be exercised
 *  without a real `claude` install. */
function fakeSpawn(lines: string[]): Spawner {
  return () => ({
    stdout: new ReadableStream<Uint8Array>({
      start(controller) {
        const enc = new TextEncoder();
        for (const line of lines) controller.enqueue(enc.encode(line));
        controller.close();
      },
    }),
    stderr: null,
    exited: Promise.resolve(0),
  });
}

describe("POST /api/sessions/:id/analyze", () => {
  test("404s an unknown session id", async () => {
    const local = createApi(db, pricing, { resolveClaudeBinary: () => "/x/claude" });
    const res = await local.request("/api/sessions/nope/analyze", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "sonnet" }),
    });
    expect(res.status).toBe(404);
  });

  test("400s an invalid model before spawning anything", async () => {
    const local = createApi(db, pricing, { resolveClaudeBinary: () => "/x/claude" });
    const res = await local.request("/api/sessions/sess-1/analyze", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "sonnet; rm -rf /" }),
    });
    expect(res.status).toBe(400);
  });

  test("503s when Claude Code is not installed", async () => {
    const local = createApi(db, pricing, { resolveClaudeBinary: () => undefined });
    const res = await local.request("/api/sessions/sess-1/analyze", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "sonnet" }),
    });
    expect(res.status).toBe(503);
  });

  test("streams NDJSON analysis events from the fake claude", async () => {
    const lines = [
      `${JSON.stringify({ type: "stream_event", event: { delta: { type: "text_delta", text: "Hi" } } })}\n`,
      `${JSON.stringify({ type: "result", result: "Hi", total_cost_usd: 0.05 })}\n`,
    ];
    const local = createApi(db, pricing, {
      resolveClaudeBinary: () => "/x/claude",
      spawn: fakeSpawn(lines),
    });
    const res = await local.request("/api/sessions/sess-1/analyze", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "sonnet" }),
    });
    expect(res.status).toBe(200);
    const events = (await res.text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(events.some((e) => e.type === "text" && e.delta === "Hi")).toBe(true);
    const result = events.find((e) => e.type === "result");
    expect(result?.costUsd).toBe(0.05);
  });
});

describe("/api/prefs analysisModel", () => {
  test("GET defaults analysisModel to sonnet", async () => {
    await withStateDir(async () => {
      const res = await api.request("/api/prefs");
      const body = (await res.json()) as { analysisModel: string };
      expect(body.analysisModel).toBe("sonnet");
    });
  });

  test("PUT persists a valid analysisModel and echoes it back", async () => {
    await withStateDir(async () => {
      const res = await api.request("/api/prefs", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ analysisModel: "opus" }),
      });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { analysisModel: string }).analysisModel).toBe("opus");
      const after = (await (await api.request("/api/prefs")).json()) as { analysisModel: string };
      expect(after.analysisModel).toBe("opus");
    });
  });

  test("PUT rejects an invalid analysisModel with 400", async () => {
    await withStateDir(async () => {
      const res = await api.request("/api/prefs", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ analysisModel: "bad model!" }),
      });
      expect(res.status).toBe(400);
    });
  });
});
