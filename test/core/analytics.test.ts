import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../src/core/db.ts";
import { skillUsage, subagentUsage, toolUsage } from "../../src/core/stats.ts";

interface Seed {
  path: string;
  tools?: Record<string, number>;
  toolErrors?: Record<string, number>;
  skills?: string[];
  subagents?: string[];
}

function insert(db: Database, s: Seed): void {
  db.query(
    `INSERT INTO sessions (path, project_id, tools_json, tool_errors_json, skills_json, subagents_json)
     VALUES (?,?,?,?,?,?)`,
  ).run(
    s.path,
    "p",
    JSON.stringify(s.tools ?? {}),
    JSON.stringify(s.toolErrors ?? {}),
    JSON.stringify(s.skills ?? []),
    JSON.stringify(s.subagents ?? []),
  );
}

let db: Database;
beforeAll(() => {
  db = openDb(":memory:");
  insert(db, {
    path: "s1",
    tools: { Bash: 10, Read: 5 },
    toolErrors: { Bash: 2 },
    skills: ["superpowers:brainstorming"],
    subagents: ["general-purpose"],
  });
  insert(db, {
    path: "s2",
    tools: { Bash: 20, Edit: 3 },
    toolErrors: { Edit: 1 },
    skills: ["superpowers:brainstorming", "artifact-design"],
  });
  insert(db, { path: "s3", tools: { Read: 7 }, subagents: ["general-purpose"] });
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

describe("skillUsage / subagentUsage", () => {
  test("rank names by how many sessions used each", () => {
    expect(skillUsage(db)).toEqual([
      { name: "superpowers:brainstorming", sessions: 2 },
      { name: "artifact-design", sessions: 1 },
    ]);
    expect(subagentUsage(db)).toEqual([{ name: "general-purpose", sessions: 2 }]);
  });
});

describe("schema migration", () => {
  const tmp = join(tmpdir(), `cc-analyzer-mig-${process.pid}-${Date.now()}.db`);
  afterAll(() => rmSync(tmp, { force: true }));

  test("a v1 index is dropped and recreated with the tool_errors_json column", () => {
    // Build an old (v1) database by hand: sessions without tool_errors_json.
    const old = new Database(tmp);
    old.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);");
    // v1 shape: every column the schema's indexes reference, minus tool_errors_json.
    old.exec(
      "CREATE TABLE sessions (path TEXT PRIMARY KEY, project_id TEXT NOT NULL, month TEXT, day TEXT, tools_json TEXT);",
    );
    old
      .query("INSERT INTO sessions (path, project_id, tools_json) VALUES ('old', 'p', '{}')")
      .run();
    old.query("INSERT INTO meta (key, value) VALUES ('schema_version', '1')").run();
    old.close();

    const migrated = openDb(tmp);
    const cols = (migrated.query("PRAGMA table_info(sessions)").all() as { name: string }[]).map(
      (c) => c.name,
    );
    expect(cols).toContain("tool_errors_json");
    // dropped → empty, so a rebuild repopulates it accurately
    expect((migrated.query("SELECT COUNT(*) AS n FROM sessions").get() as { n: number }).n).toBe(0);
    expect(
      (
        migrated.query("SELECT value FROM meta WHERE key='schema_version'").get() as {
          value: string;
        }
      ).value,
    ).toBe("2");
    migrated.close();
  });
});
