import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "../../src/core/db.ts";
import { reindex } from "../../src/core/indexer.ts";
import { createApi } from "../../src/web/api.ts";
import { createApp, isLoopbackHost } from "../../src/web/server.ts";
import { samplePricing as pricing } from "../helpers/pricing.ts";

const tmpDir = join("/tmp", `cc-analyzer-api-${process.pid}-${Date.now()}`);
const fixture = fileURLToPath(new URL("../fixtures/sample-session.jsonl", import.meta.url));
let prevClaudeDir: string | undefined;
let db: Database;
let api: ReturnType<typeof createApi>;

beforeAll(async () => {
  const content = await Bun.file(fixture).text();
  mkdirSync(join(tmpDir, "projects", "proj-a"), { recursive: true });
  writeFileSync(join(tmpDir, "projects", "proj-a", "sess-1.jsonl"), content);
  prevClaudeDir = process.env.CC_ANALYZER_CLAUDE_DIR;
  process.env.CC_ANALYZER_CLAUDE_DIR = tmpDir;
  db = openDb(":memory:");
  await reindex(db, { pricing });
  api = createApi(db, pricing);
});

afterAll(() => {
  db.close();
  if (prevClaudeDir === undefined) delete process.env.CC_ANALYZER_CLAUDE_DIR;
  else process.env.CC_ANALYZER_CLAUDE_DIR = prevClaudeDir;
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("web API", () => {
  test("GET /api/stats returns a portfolio view", async () => {
    const res = await api.request("/api/stats");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { summary: { sessions: number }; byModel: unknown[] };
    expect(body.summary.sessions).toBe(1);
    expect(body.byModel.length).toBeGreaterThan(0);
  });

  test("GET /api/projects lists projects", async () => {
    const res = await api.request("/api/projects");
    const body = (await res.json()) as { projectId: string }[];
    expect(body).toHaveLength(1);
    expect(body[0]?.projectId).toBe("proj-a");
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
    expect(body.projects[0]?.projectId).toBe("proj-a");
    // fixture: 1000 written, 9000 read → ratio 9, well amortized
    expect(body.projects[0]?.ratio).toBeCloseTo(9, 5);
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
    const stalePath = join(tmpDir, "projects", "proj-a", "sess-stale.jsonl");
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
