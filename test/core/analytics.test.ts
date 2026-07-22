import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, SCHEMA_VERSION } from "../../src/core/db.ts";
import { skillAnalytics, subagentUsage, toolUsage } from "../../src/core/stats.ts";

interface Seed {
  path: string;
  projectId?: string;
  day?: string;
  cost?: number;
  tools?: Record<string, number>;
  toolErrors?: Record<string, number>;
  skills?: Record<string, number>;
  skillErrors?: Record<string, number>;
  subagents?: string[];
}

function insert(db: Database, s: Seed): void {
  db.query(
    `INSERT INTO sessions
       (path, project_id, day, cost_total, tools_json, tool_errors_json,
        skills_json, skill_errors_json, subagents_json)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run(
    s.path,
    s.projectId ?? "p",
    s.day ?? null,
    s.cost ?? 0,
    JSON.stringify(s.tools ?? {}),
    JSON.stringify(s.toolErrors ?? {}),
    JSON.stringify(s.skills ?? {}),
    JSON.stringify(s.skillErrors ?? {}),
    JSON.stringify(s.subagents ?? []),
  );
}

let db: Database;
beforeAll(() => {
  db = openDb(":memory:");
  insert(db, {
    path: "s1",
    projectId: "p1",
    day: "2026-05-01",
    cost: 1,
    tools: { Bash: 10, Read: 5 },
    toolErrors: { Bash: 2 },
    skills: { "superpowers:brainstorming": 1 },
    subagents: ["general-purpose"],
  });
  insert(db, {
    path: "s2",
    projectId: "p1",
    day: "2026-05-08",
    cost: 2,
    tools: { Bash: 20, Edit: 3 },
    toolErrors: { Edit: 1 },
    skills: { "superpowers:brainstorming": 2, "artifact-design": 1 },
    skillErrors: { "artifact-design": 1 },
  });
  insert(db, {
    path: "s3",
    projectId: "p2",
    day: "2026-06-01",
    cost: 4,
    tools: { Read: 7 },
    skills: { "superpowers:brainstorming": 1 },
    subagents: ["general-purpose"],
  });
});

describe("toolUsage", () => {
  test("ranks by invocations with error counts, rate, and session frequency", () => {
    const rows = toolUsage(db);
    expect(rows.map((r) => r.tool)).toEqual(["Bash", "Read", "Edit"]);
    const bash = rows.find((r) => r.tool === "Bash");
    expect(bash).toMatchObject({ uses: 30, errors: 2, sessions: 2 });
    expect(bash?.errorRate).toBeCloseTo(2 / 30, 5);
    expect(rows.find((r) => r.tool === "Read")).toMatchObject({ uses: 12, errors: 0, sessions: 2 });
    expect(rows.find((r) => r.tool === "Edit")?.errorRate).toBeCloseTo(1 / 3, 5);
  });
});

describe("skillAnalytics", () => {
  test("folds invocations, reach, reliability, adoption, and session-scoped cost", () => {
    const rows = skillAnalytics(db);
    expect(rows.map((r) => r.name)).toEqual(["superpowers:brainstorming", "artifact-design"]);

    const brain = rows.find((r) => r.name === "superpowers:brainstorming");
    expect(brain).toMatchObject({
      invocations: 4,
      sessions: 3,
      projects: 2,
      errors: 0,
      errorRate: 0,
      firstUsed: "2026-05-01",
      lastUsed: "2026-06-01",
      totalCost: 7,
    });
    expect(brain?.avgCostPerSession).toBeCloseTo(7 / 3, 5);
    expect(brain?.daily).toEqual([
      { day: "2026-05-01", count: 1 },
      { day: "2026-05-08", count: 2 },
      { day: "2026-06-01", count: 1 },
    ]);

    const art = rows.find((r) => r.name === "artifact-design");
    expect(art).toMatchObject({
      invocations: 1,
      sessions: 1,
      projects: 1,
      errors: 1,
      errorRate: 1,
      firstUsed: "2026-05-08",
      lastUsed: "2026-05-08",
      totalCost: 2,
    });
  });
});

describe("subagentUsage", () => {
  test("ranks subagent names by how many sessions used each", () => {
    expect(subagentUsage(db)).toEqual([{ name: "general-purpose", sessions: 2 }]);
  });
});

describe("schema migration", () => {
  const tmp = join(tmpdir(), `cc-analyzer-mig-${process.pid}-${Date.now()}.db`);
  afterAll(() => rmSync(tmp, { force: true }));

  test("an older index is dropped and recreated with the skill_errors_json column", () => {
    // Build an old database by hand: sessions without skill_errors_json.
    const old = new Database(tmp);
    old.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);");
    // Old shape: every column the schema's indexes reference, minus skill_errors_json.
    old.exec(
      "CREATE TABLE sessions (path TEXT PRIMARY KEY, project_id TEXT NOT NULL, month TEXT, day TEXT, tools_json TEXT);",
    );
    old
      .query("INSERT INTO sessions (path, project_id, tools_json) VALUES ('old', 'p', '{}')")
      .run();
    old.query("INSERT INTO meta (key, value) VALUES ('schema_version', '2')").run();
    old.close();

    const migrated = openDb(tmp);
    const cols = (migrated.query("PRAGMA table_info(sessions)").all() as { name: string }[]).map(
      (c) => c.name,
    );
    expect(cols).toContain("skill_errors_json");
    // dropped → empty, so a rebuild repopulates it accurately
    expect((migrated.query("SELECT COUNT(*) AS n FROM sessions").get() as { n: number }).n).toBe(0);
    expect(
      (
        migrated.query("SELECT value FROM meta WHERE key='schema_version'").get() as {
          value: string;
        }
      ).value,
    ).toBe(SCHEMA_VERSION);
    migrated.close();
  });
});
