import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CACHE_FORMAT_VERSION } from "../../src/core/pricing-source.ts";
import { VERSION } from "../../src/core/version.ts";
import { samplePricing } from "../helpers/pricing.ts";

const cliPath = fileURLToPath(new URL("../../src/cli/index.ts", import.meta.url));
const fixture = fileURLToPath(new URL("../fixtures/sample-session.jsonl", import.meta.url));
const tmpDir = join(tmpdir(), `cc-analyzer-cli-${process.pid}-${Date.now()}`);

beforeAll(async () => {
  mkdirSync(join(tmpDir, "claude", "projects", "proj-a"), { recursive: true });
  mkdirSync(join(tmpDir, "claude", "projects", "proj-b"), { recursive: true });
  mkdirSync(join(tmpDir, "state"), { recursive: true });
  mkdirSync(join(tmpDir, "project", "web"), { recursive: true });
  mkdirSync(join(tmpDir, "other-project"), { recursive: true });
  const sample = await Bun.file(fixture).text();
  writeFileSync(
    join(tmpDir, "claude", "projects", "proj-a", "sess-1.jsonl"),
    sample.replaceAll("/Users/dev/proj", join(tmpDir, "project")),
  );
  writeFileSync(
    join(tmpDir, "claude", "projects", "proj-b", "sess-2.jsonl"),
    sample
      .replaceAll("/Users/dev/proj", join(tmpDir, "other-project"))
      .replaceAll("sess-1", "sess-2"),
  );
  // Seed a fresh pricing cache so no spawned CLI ever touches the network.
  writeFileSync(
    join(tmpDir, "state", "pricing.json"),
    JSON.stringify({
      fetchedAt: Date.now(),
      formatVersion: CACHE_FORMAT_VERSION,
      table: samplePricing,
    }),
  );
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/** Run the CLI in an isolated env (temp dirs, update check off, no TTY). */
async function run(
  args: string[],
  env: Record<string, string | undefined> = {},
  cwd?: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", cliPath, ...args], {
    cwd,
    env: {
      ...process.env,
      CC_ANALYZER_CLAUDE_DIR: join(tmpDir, "claude"),
      CC_ANALYZER_STATE_DIR: join(tmpDir, "state"),
      CC_ANALYZER_NO_UPDATE_CHECK: "1",
      CC_ANALYZER_TELEMETRY: "0",
      ...env,
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

describe("CLI dispatch & exit codes", () => {
  test("version prints the embedded version and exits 0", async () => {
    const r = await run(["version"]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout.trim()).toBe(VERSION);
  });

  test("an unknown command exits 2 with usage", async () => {
    const r = await run(["frobnicate"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("unknown command");
  });

  test("sessions without a projectId exits 2", async () => {
    const r = await run(["sessions"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("missing <projectId>");
  });

  test("launching the TUI without a TTY exits non-zero with a hint", async () => {
    const r = await run([]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("needs a terminal");
  });

  test("serve rejects a non-numeric --port with exit 2", async () => {
    const r = await run(["serve", "--port=abc"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("invalid --port");
  });

  test("analyze --json emits clean JSON on stdout", async () => {
    const r = await run([
      "analyze",
      join(tmpDir, "claude", "projects", "proj-a", "sess-1.jsonl"),
      "--json",
    ]);
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout) as { totals: { turns: number } };
    expect(parsed.totals.turns).toBe(2);
  });

  test("analyze with a missing session exits 1", async () => {
    const r = await run(["analyze", "does-not-exist"]);
    expect(r.code).toBe(1);
  });

  test("projects lists the fixture projects", async () => {
    const r = await run(["projects"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("2 projects");
  });

  test("a quick command lets its telemetry request settle before exiting", async () => {
    let body: { props?: { name?: string } } | undefined;
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        body = (await req.json()) as { props?: { name?: string } };
        return new Response("", { status: 202 });
      },
    });
    try {
      const r = await run(["projects"], {
        CC_ANALYZER_TELEMETRY_URL: server.url.origin,
        CC_ANALYZER_TELEMETRY: "1",
        DO_NOT_TRACK: undefined,
        CI: undefined,
      });
      expect(r.code).toBe(0);
      expect(body?.props?.name).toBe("projects");
    } finally {
      server.stop(true);
    }
  });

  test("stats presents a structured, ANSI-free report when piped", async () => {
    expect((await run(["index"])).code).toBe(0);
    const r = await run(["stats"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("◆ cc-analyzer · portfolio");
    expect(r.stdout).toContain("▸ Activity");
    expect(r.stdout).toContain("▸ Efficiency & reliability");
    expect(r.stdout).toContain("✓ Read-only · session data stayed local");
    expect(r.stdout).not.toContain("\u001B[");
  });

  test("stats --current scopes the report from a nested working directory", async () => {
    expect((await run(["index"])).code).toBe(0);
    const portfolio = JSON.parse((await run(["stats", "--json"])).stdout) as {
      scope: { type: string };
      index: { stale: boolean; lastRefreshedAt: string | null };
      summary: { sessions: number; projects: number };
    };
    expect(portfolio.scope).toEqual({ type: "portfolio" });
    expect(portfolio.index.stale).toBe(false);
    expect(portfolio.index.lastRefreshedAt).not.toBeNull();
    expect(portfolio.summary).toMatchObject({ sessions: 2, projects: 2 });

    const projectPath = join(tmpDir, "project");
    const nested = join(projectPath, "web");
    const r = await run(["stats", "--current", "--json"], {}, nested);
    expect(r.code, r.stderr).toBe(0);
    const parsed = JSON.parse(r.stdout) as {
      scope: { type: string; projectId: string; projectPath: string };
      summary: { sessions: number; projects: number };
      byProject: { projectPath: string | null }[];
    };
    expect(parsed.scope).toEqual({
      type: "project",
      projectId: "proj-a",
      projectPath,
    });
    expect(parsed.summary.sessions).toBe(1);
    expect(parsed.summary.projects).toBe(1);
    expect(parsed.byProject).toEqual([]);

    const human = await run(["stats", "--current"], {}, nested);
    expect(human.code, human.stderr).toBe(0);
    expect(human.stdout).toContain(`◆ cc-analyzer · ${projectPath}`);
    expect(human.stdout).toContain("· 1 session ·");
    expect(human.stdout).not.toContain("Top projects by cost");
  });

  test("stats --current explains when the working directory is not indexed", async () => {
    const r = await run(["stats", "--current"], {}, tmpDir);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("No indexed Claude Code project contains");
    expect(r.stderr).toContain("cc-analyzer index");
  });

  test("index --check reports exact stale counts without refreshing", async () => {
    expect((await run(["index", "--check"])).code).toBe(0);
    const added = join(tmpDir, "claude", "projects", "proj-b", "new-session.jsonl");
    writeFileSync(added, "{}\n");
    try {
      const stale = await run(["index", "--check"]);
      expect(stale.code).toBe(1);
      expect(stale.stdout).toContain("Index is stale: 1 new, 0 changed, 0 deleted sessions.");
    } finally {
      rmSync(added, { force: true });
    }
  });
});
