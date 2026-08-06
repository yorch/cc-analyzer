import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

  test("analyze human output includes actionable diagnostics", async () => {
    const r = await run(["analyze", join(tmpDir, "claude", "projects", "proj-a", "sess-1.jsonl")]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Actionable diagnostics");
    expect(r.stdout).toContain("No notable context or cost patterns");
  });

  test("analyze reports parse coverage, not just skipped lines", async () => {
    const r = await run(["analyze", join(tmpDir, "claude", "projects", "proj-a", "sess-1.jsonl")]);
    expect(r.code).toBe(0);
    // The fixture parses cleanly but carries one future/unknown event type.
    expect(r.stdout).toContain(
      "(0 unparseable lines skipped, 1 kept as unknown events, of 10 lines)",
    );
  });

  test("analyze --json carries the session's parse coverage", async () => {
    const r = await run([
      "analyze",
      join(tmpDir, "claude", "projects", "proj-a", "sess-1.jsonl"),
      "--json",
    ]);
    const parsed = JSON.parse(r.stdout) as {
      parseCoverage: { lines: number; parseErrors: number; unknownEvents: number };
    };
    expect(parsed.parseCoverage).toEqual({ lines: 10, parseErrors: 0, unknownEvents: 1 });
  });

  test("analyze with a missing session exits 1", async () => {
    const r = await run(["analyze", "does-not-exist"]);
    expect(r.code).toBe(1);
  });

  test("doctor reports a structurally complete session as healthy", async () => {
    const path = join(tmpDir, "healthy.jsonl");
    writeFileSync(
      path,
      [
        {
          type: "user",
          uuid: "u1",
          parentUuid: null,
          sessionId: "healthy",
          message: { role: "user", content: "hello" },
        },
        {
          type: "assistant",
          uuid: "a1",
          parentUuid: "u1",
          sessionId: "healthy",
          message: { role: "assistant", content: [{ type: "text", text: "done" }] },
        },
      ]
        .map((event) => JSON.stringify(event))
        .join("\n"),
    );
    try {
      const r = await run(["doctor", path]);
      expect(r.code, r.stderr).toBe(0);
      expect(r.stdout).toContain("Session health: healthy");
      expect(r.stdout).toContain("0 parse errors · 0 unknown events");
      expect(r.stdout).toContain("No structural health problems were detected");
      expect(r.stdout).toContain("Read-only check");
    } finally {
      rmSync(path, { force: true });
    }
  });

  test("doctor --json reports findings and exits 1 for a damaged session", async () => {
    const path = join(tmpDir, "damaged.jsonl");
    writeFileSync(
      path,
      `${JSON.stringify({
        type: "user",
        uuid: "u1",
        parentUuid: null,
        sessionId: "broken",
        message: { role: "user", content: "unfinished" },
      })}\nnot-json\n`,
    );
    try {
      const r = await run(["doctor", path, "--json"]);
      expect(r.code).toBe(1);
      const report = JSON.parse(r.stdout) as {
        status: string;
        findings: Array<{ code: string }>;
      };
      expect(report.status).toBe("damaged");
      expect(report.findings.map((finding) => finding.code)).toContain("unparseable-lines");
    } finally {
      rmSync(path, { force: true });
    }
  });

  test("doctor without a session exits 2", async () => {
    const r = await run(["doctor"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("missing <id|path>");
  });

  test("projects lists the fixture projects", async () => {
    const r = await run(["projects"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("2 projects");
  });

  // A quick command exits in ~100ms, far too little for a cold TLS handshake,
  // and `process.exit()` kills an in-flight socket outright. The event is
  // therefore delivered by a detached child that outlives its parent — which is
  // what the ordering assertion below pins down: an in-process request would
  // necessarily have arrived *before* the parent exited, not after.
  test("a quick command's telemetry outlives the process that fired it", async () => {
    let body: { props?: { name?: string } } | undefined;
    let receivedAt = 0;
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        body = (await req.json()) as { props?: { name?: string } };
        receivedAt = performance.now();
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
      const exitedAt = performance.now();
      expect(r.code).toBe(0);
      // Nothing waits on the poster, so give it room to boot and connect.
      for (let i = 0; i < 200 && !body; i++) await Bun.sleep(25);
      expect(body?.props?.name).toBe("projects");
      expect(receivedAt).toBeGreaterThan(exitedAt);
    } finally {
      server.stop(true);
    }
  });

  test("the poster subcommand is hidden from help and prints nothing", async () => {
    const help = await run(["help"]);
    expect(help.stdout).not.toContain("__telemetry-post");
    // Reachable by hand, but silent and successful — it is a beacon, not a command.
    const r = await run(["__telemetry-post"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("");
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
      projectId: expect.stringMatching(/^[0-9a-f]{8}~proj-a$/),
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

  test('cost-basis shows "api" by default', async () => {
    const r = await run(["cost-basis"]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain("api");
  });

  test("cost-basis sets and round-trips subscription, then resets to api", async () => {
    try {
      const set = await run(["cost-basis", "subscription"]);
      expect(set.code, set.stderr).toBe(0);
      expect(set.stdout).toContain("subscription");

      const show = await run(["cost-basis"]);
      expect(show.code).toBe(0);
      expect(show.stdout).toContain("subscription");
    } finally {
      // Reset so later tests in this shared state dir see the default basis.
      expect((await run(["cost-basis", "api"])).code).toBe(0);
    }
  });

  test("cost-basis rejects an unknown value", async () => {
    const r = await run(["cost-basis", "bogus"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("usage: cc-analyzer cost-basis");
  });

  test("stats carries the subscription framing note, and omits it for api", async () => {
    expect((await run(["index"])).code).toBe(0);

    const apiRun = await run(["stats"]);
    expect(apiRun.code, apiRun.stderr).toBe(0);
    expect(apiRun.stdout).not.toContain("API-equivalent value");

    try {
      expect((await run(["cost-basis", "subscription"])).code).toBe(0);
      const subRun = await run(["stats"]);
      expect(subRun.code, subRun.stderr).toBe(0);
      expect(subRun.stdout).toContain("API-equivalent value");
      expect(subRun.stdout).toContain("not a bill");
    } finally {
      expect((await run(["cost-basis", "api"])).code).toBe(0);
    }
  });

  test("audit reports the inventory and its findings, and --json is clean", async () => {
    // An installed setup that the fixture sessions never touch.
    mkdirSync(join(tmpDir, "claude", "skills", "tidy"), { recursive: true });
    writeFileSync(join(tmpDir, "claude", "skills", "tidy", "SKILL.md"), "# tidy\n");
    mkdirSync(join(tmpDir, "claude", "agents"), { recursive: true });
    writeFileSync(join(tmpDir, "claude", "agents", "reviewer.md"), "# reviewer\n");
    try {
      expect((await run(["index"])).code).toBe(0);

      const human = await run(["audit"]);
      expect(human.code, human.stderr).toBe(0);
      expect(human.stdout).toContain("◆ cc-analyzer · setup audit");
      expect(human.stdout).toContain("▸ Inventory");
      expect(human.stdout).toContain("▸ Findings");
      expect(human.stdout).toContain("Machine-local and historical");
      expect(human.stdout).not.toContain("[");

      const parsed = JSON.parse((await run(["audit", "--json"])).stdout) as {
        counts: { skills: number; agents: number };
        findings: { code: string; subject: string }[];
      };
      expect(parsed.counts).toMatchObject({ skills: 1, agents: 1 });
      expect(parsed.findings.map((f) => f.code).sort()).toEqual(["unused-agent", "unused-skill"]);
    } finally {
      rmSync(join(tmpDir, "claude", "skills"), { recursive: true, force: true });
      rmSync(join(tmpDir, "claude", "agents"), { recursive: true, force: true });
      rmSync(join(tmpDir, "claude", "agents.tmp"), { force: true });
    }
  });

  test("audit rolls installed plugins up into a Plugins table and the JSON", async () => {
    const plugin = join(tmpDir, "claude", "plugins", "toolkit");
    mkdirSync(join(plugin, ".claude-plugin"), { recursive: true });
    writeFileSync(
      join(plugin, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: "toolkit" }),
    );
    mkdirSync(join(plugin, "skills", "deploy"), { recursive: true });
    writeFileSync(join(plugin, "skills", "deploy", "SKILL.md"), "# deploy\n");
    try {
      expect((await run(["index"])).code).toBe(0);

      const human = await run(["audit"]);
      expect(human.code, human.stderr).toBe(0);
      expect(human.stdout).toContain("▸ Plugins");
      expect(human.stdout).toContain("toolkit");
      // The turn-$ column carries the shared skill-cost caveat.
      expect(human.stdout).toContain("Turn-scoped cost is the cost of the turns");

      const parsed = JSON.parse((await run(["audit", "--json"])).stdout) as {
        plugins: { plugin: string; skillsShipped: number; skillsUsed: number }[];
        findings: { code: string; subject: string }[];
      };
      expect(parsed.plugins).toHaveLength(1);
      expect(parsed.plugins[0]).toMatchObject({
        plugin: "toolkit",
        skillsShipped: 1,
        skillsUsed: 0,
      });
      // One finding for the dead plugin, not one per shipped component.
      expect(parsed.findings.filter((f) => f.code === "unused-skill")).toEqual([]);
      expect(parsed.findings.map((f) => f.code)).toContain("unused-plugin");
    } finally {
      rmSync(join(tmpDir, "claude", "plugins"), { recursive: true, force: true });
    }
  });

  test("insights renders ranked portfolio findings, and --json is clean", async () => {
    expect((await run(["index"])).code).toBe(0);

    const human = await run(["insights"]);
    expect(human.code, human.stderr).toBe(0);
    expect(human.stdout).toContain("◆ cc-analyzer · portfolio insights");
    expect(human.stdout).toContain("▸ Findings");
    // Two tiny fixture sessions cross no conservative threshold.
    expect(human.stdout).toContain("rules checked");
    expect(human.stdout).not.toContain("[");

    const parsed = JSON.parse((await run(["insights", "--json"])).stdout) as {
      code: string;
      severity: string;
    }[];
    expect(Array.isArray(parsed)).toBe(true);
  });

  // The fixture sessions are dated 2026-07-01 (a Wednesday), i.e. the ISO week
  // 2026-06-29 → 2026-07-05.
  const FIXTURE_WEEK = "2026-07-01";

  test("report renders the weekly digest for the requested week", async () => {
    expect((await run(["index"])).code).toBe(0);

    const human = await run(["report", "--week", FIXTURE_WEEK]);
    expect(human.code, human.stderr).toBe(0);
    expect(human.stdout).toContain("◆ cc-analyzer · weekly digest");
    expect(human.stdout).toContain("2026-06-29 → 2026-07-05 · vs 2026-06-22 → 2026-06-28");
    expect(human.stdout).toContain("▸ Summary");
    expect(human.stdout).toContain("▸ Insights · current state, whole portfolio");
    // Both fixture sessions started in that week.
    expect(human.stdout).toContain("sessions");
    expect(human.stdout).not.toContain("\u001B[");
  });

  test("report --md prints paste-ready markdown, --json the plain digest", async () => {
    const md = await run(["report", `--week=${FIXTURE_WEEK}`, "--md"]);
    expect(md.code, md.stderr).toBe(0);
    expect(md.stdout.startsWith("## Claude Code weekly digest — 2026-06-29 → 2026-07-05")).toBe(
      true,
    );
    expect(md.stdout).toContain("### Summary");
    expect(md.stdout).toContain("Generated by `cc-analyzer report`.");
    expect(md.stdout).not.toContain("\u001B[");

    const parsed = JSON.parse((await run(["report", "--week", FIXTURE_WEEK, "--json"])).stdout) as {
      period: { start: string; end: string };
      headline: { sessions: { current: number } };
      insights: unknown[];
    };
    expect(parsed.period).toEqual({ start: "2026-06-29", end: "2026-07-05" });
    expect(parsed.headline.sessions.current).toBe(2);
    expect(Array.isArray(parsed.insights)).toBe(true);
  });

  test("report defaults to the last complete week; an empty one is not an error", async () => {
    const r = await run(["report"]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain("◆ cc-analyzer · weekly digest");
  });

  test("report rejects a --week with no value instead of eating the next flag", async () => {
    for (const args of [
      ["report", "--week"],
      ["report", "--week", "--md"],
      ["report", "--week="],
    ]) {
      const r = await run(args);
      expect(r.code, r.stderr).toBe(2);
      expect(r.stderr).toContain("missing value for --week");
      expect(r.stdout).toBe("");
    }
  });

  test("report refuses --md and --json together", async () => {
    const r = await run(["report", "--md", "--json"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("cannot be used together");
    expect(r.stdout).toBe("");
  });

  test("report rejects a malformed --week and refuses an empty index", async () => {
    const bad = await run(["report", "--week", "last-monday"]);
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain("invalid --week");

    const emptyState = join(tmpDir, "empty-state");
    mkdirSync(emptyState, { recursive: true });
    try {
      const empty = await run(["report"], { CC_ANALYZER_STATE_DIR: emptyState });
      expect(empty.code).toBe(1);
      expect(empty.stderr).toContain("Index is empty");
    } finally {
      rmSync(emptyState, { recursive: true, force: true });
    }
  });

  test("index --check reports portfolio parse coverage from the indexed rows", async () => {
    const r = await run(["index", "--check"]);
    expect(r.code).toBe(0);
    // Two fixture sessions × 10 lines, one unknown event type each.
    expect(r.stdout).toContain("Parse coverage: 90.0% of 20 indexed lines fully parsed");
    expect(r.stdout).toContain("(0 unreadable, 2 unknown events)");
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

describe("Claude data directories", () => {
  const second = join(tmpDir, "claude-2");

  test("--claude-dir= overrides the environment for one invocation", async () => {
    const r = await run([`--claude-dir=${second}`, "projects"]);
    expect(r.code, r.stderr).toBe(0);
    // The second root is empty, so the env-configured projects must not appear.
    expect(r.stdout).toContain("No projects found under:");
    expect(r.stdout).toContain(second);
  });

  test("the flag may appear before the command", async () => {
    const r = await run([`--claude-dir=${second}`, "projects"]);
    expect(r.code, r.stderr).toBe(0);
    const after = await run(["projects", `--claude-dir=${second}`]);
    expect(after.stdout).toBe(r.stdout);
  });

  test("the flag is stripped from argv rather than read as a positional", async () => {
    // Without stripping, the path would land in positional[0] and be taken as
    // the project id, so this would fail on a missing operand instead.
    const r = await run([`--claude-dir=${second}`, "sessions"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("missing <projectId>");
  });

  test("the space-separated form is rejected rather than silently ignored", async () => {
    const r = await run(["--claude-dir", second, "projects"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--claude-dir=<path>");
  });

  test("a valueless flag exits 2", async () => {
    const r = await run(["--claude-dir=", "projects"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("needs a path");
  });

  test("several roots are analyzed together, each project tagged with its dir", async () => {
    mkdirSync(join(second, "projects", "proj-c"), { recursive: true });
    const sample = readFileSync(fixture, "utf8");
    writeFileSync(join(second, "projects", "proj-c", "sess-3.jsonl"), sample);
    try {
      const r = await run([`--claude-dir=${join(tmpDir, "claude")}:${second}`, "projects"]);
      expect(r.code, r.stderr).toBe(0);
      expect(r.stdout).toContain("3 projects");
      expect(r.stdout).toContain("claude dir");
    } finally {
      rmSync(second, { recursive: true, force: true });
    }
  });

  test("the empty state names the directories actually searched", async () => {
    const r = await run([`--claude-dir=${join(tmpDir, "nowhere")}`, "projects"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(join(tmpDir, "nowhere"));
    expect(r.stdout).toContain("--claude-dir");
  });

  test("claude-dir reports the resolved dirs and where they came from", async () => {
    const r = await run(["claude-dir"], { CC_ANALYZER_CLAUDE_DIR: undefined });
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain("Reading Claude Code data from:");
  });

  test("claude-dir does not nudge a working setup to configure anything", async () => {
    // The default ~/.claude and an inherited CLAUDE_CONFIG_DIR persist nothing
    // and are both fine; telling those users to set something reads as a fault.
    const r = await run(["claude-dir"]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain(join(tmpDir, "claude"));
    expect(r.stdout).not.toContain("claude-dir set");
    expect(r.stdout).not.toContain("No Claude sessions found");
  });

  test("claude-dir marks a directory with no projects/ and then offers a fix", async () => {
    const r = await run(["claude-dir"], { CC_ANALYZER_CLAUDE_DIR: join(tmpDir, "nowhere") });
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain("no projects/ directory");
    expect(r.stdout).toContain("No Claude sessions found");
    expect(r.stdout).toContain("cc-analyzer claude-dir set");
  });

  test("claude-dir honours CLAUDE_CONFIG_DIR when nothing else is configured", async () => {
    const r = await run(["claude-dir"], {
      CC_ANALYZER_CLAUDE_DIR: undefined,
      CLAUDE_CONFIG_DIR: second,
    });
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain(second);
    expect(r.stdout).toContain("CLAUDE_CONFIG_DIR");
  });

  test("claude-dir set/add/remove persist, and reset clears", async () => {
    const prefsState = join(tmpDir, "prefs-state");
    mkdirSync(prefsState, { recursive: true });
    const env = { CC_ANALYZER_STATE_DIR: prefsState, CC_ANALYZER_CLAUDE_DIR: undefined };
    try {
      expect((await run(["claude-dir", "set", second], env)).code).toBe(0);
      const added = await run(["claude-dir", "add", join(tmpDir, "claude")], env);
      expect(added.stdout).toContain(second);
      expect(added.stdout).toContain(join(tmpDir, "claude"));

      const removed = await run(["claude-dir", "remove", second], env);
      expect(removed.code).toBe(0);
      expect(removed.stdout).not.toContain(`${second}  (`);

      const reset = await run(["claude-dir", "reset"], env);
      expect(reset.code).toBe(0);
      expect(reset.stdout).toContain("Cleared.");
    } finally {
      rmSync(prefsState, { recursive: true, force: true });
    }
  });

  // The index always covers every configured directory, so a one-invocation
  // scope is either ignored (reads) or destructive (`index` prunes the rest).
  for (const cmd of ["index", "stats", "audit", "insights", "report", "serve"]) {
    test(`--claude-dir is refused on \`${cmd}\`, which reads the index`, async () => {
      const r = await run([`--claude-dir=${second}`, cmd]);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("--claude-dir cannot be used with");
      expect(r.stderr).toContain("cc-analyzer claude-dir set <path>");
    });
  }

  test("the refusal on `index` names the destructive consequence, not just the no-op", async () => {
    const r = await run([`--claude-dir=${second}`, "index"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("drop the rows");
  });

  test("--claude-dir still works on the commands that read session files", async () => {
    for (const cmd of [["projects"], ["sessions"], ["analyze"], ["doctor"]]) {
      const r = await run([`--claude-dir=${second}`, ...cmd]);
      // 0 or a usage/not-found code — anything but the guard's refusal.
      expect(r.stderr).not.toContain("--claude-dir cannot be used with");
    }
  });

  test("the env override is not guarded — it stays the test/CI escape hatch", async () => {
    // Every other CLI test drives index-backed commands through this variable.
    const r = await run(["stats"], { CC_ANALYZER_CLAUDE_DIR: join(tmpDir, "claude") });
    expect(r.stderr).not.toContain("cannot be used with");
  });

  test("the first `add` keeps the root already in effect", async () => {
    // With nothing persisted, the effective root comes from a lower tier. Since
    // the prefs tier is exclusive, writing a one-element list would silently
    // drop it — and the next `index` would prune every one of its rows.
    const prefsState = join(tmpDir, "add-state");
    mkdirSync(prefsState, { recursive: true });
    const inEffect = join(tmpDir, "claude");
    try {
      const r = await run(["claude-dir", "add", second], {
        CC_ANALYZER_STATE_DIR: prefsState,
        CC_ANALYZER_CLAUDE_DIR: undefined,
        CLAUDE_CONFIG_DIR: inEffect,
      });
      expect(r.code, r.stderr).toBe(0);
      // Both the previously-effective root and the newly added one.
      expect(r.stdout).toContain(inEffect);
      expect(r.stdout).toContain(second);

      const stored = JSON.parse(readFileSync(join(prefsState, "prefs.json"), "utf8")) as {
        claudeDirs: string[];
      };
      expect(stored.claudeDirs).toEqual([inEffect, second]);
    } finally {
      rmSync(prefsState, { recursive: true, force: true });
    }
  });

  test("`set` still replaces rather than appending", async () => {
    const prefsState = join(tmpDir, "set-state");
    mkdirSync(prefsState, { recursive: true });
    try {
      const env = {
        CC_ANALYZER_STATE_DIR: prefsState,
        CC_ANALYZER_CLAUDE_DIR: undefined,
        CLAUDE_CONFIG_DIR: join(tmpDir, "claude"),
      };
      await run(["claude-dir", "set", second], env);
      const stored = JSON.parse(readFileSync(join(prefsState, "prefs.json"), "utf8")) as {
        claudeDirs: string[];
      };
      expect(stored.claudeDirs).toEqual([second]);
    } finally {
      rmSync(prefsState, { recursive: true, force: true });
    }
  });

  test("`sessions` accepts a bare project name, not just the stored id", async () => {
    // Stored ids are root-qualified; nobody should have to type a hash.
    const r = await run(["sessions", "proj-a"]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain("sessions");
  });

  test("`sessions` accepts the full stored id too", async () => {
    const list = await run(["projects"]);
    expect(list.code, list.stderr).toBe(0);
    // Round-trip through the index-independent path: resolve, then use.
    const r = await run(["sessions", "proj-a"]);
    expect(r.code).toBe(0);
  });

  test("an ambiguous bare name lists the candidates instead of picking one", async () => {
    // Same encoded project name under two roots — the collision the id scheme
    // exists to preserve. Silently choosing one would be the old failure mode.
    const other = join(tmpDir, "amb-root");
    mkdirSync(join(other, "projects", "proj-a"), { recursive: true });
    writeFileSync(join(other, "projects", "proj-a", "s.jsonl"), readFileSync(fixture, "utf8"));
    try {
      const r = await run([
        `--claude-dir=${join(tmpDir, "claude")}:${other}`,
        "sessions",
        "proj-a",
      ]);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("matches 2 projects");
      expect(r.stderr).toContain("Use the full id");
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  test("an unknown project name is reported as unknown", async () => {
    const r = await run(["sessions", "-no-such-project"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("No project");
  });

  test("`add` does not bake a one-invocation --claude-dir root into prefs", async () => {
    // The flag is scoped to a single command; persisting it would silently make
    // a throwaway directory permanent, and drop the real one on the next index.
    const prefsState = join(tmpDir, "transient-state");
    mkdirSync(prefsState, { recursive: true });
    const persistent = join(tmpDir, "claude");
    try {
      const r = await run([`--claude-dir=${second}`, "claude-dir", "add", join(tmpDir, "added")], {
        CC_ANALYZER_STATE_DIR: prefsState,
        CC_ANALYZER_CLAUDE_DIR: undefined,
        CLAUDE_CONFIG_DIR: persistent,
      });
      expect(r.code, r.stderr).toBe(0);
      const stored = JSON.parse(readFileSync(join(prefsState, "prefs.json"), "utf8")) as {
        claudeDirs: string[];
      };
      // The persistent root plus the added one — not the flag's.
      expect(stored.claudeDirs).toEqual([persistent, join(tmpDir, "added")]);
      expect(stored.claudeDirs).not.toContain(second);
      // …and the confirmation admits the flag is still overriding.
      expect(r.stdout).toContain("overriding the stored list");
    } finally {
      rmSync(prefsState, { recursive: true, force: true });
    }
  });

  test("claude-dir rejects a bad subcommand and a missing operand", async () => {
    expect((await run(["claude-dir", "frobnicate"])).code).toBe(2);
    expect((await run(["claude-dir", "add"])).code).toBe(2);
  });
});
