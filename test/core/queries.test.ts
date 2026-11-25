import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "../../src/core/db.ts";
import { reindex } from "../../src/core/indexer.ts";
import {
  isIndexEmpty,
  knownProjectLabels,
  listAllSessions,
  listIndexedProjects,
  listIndexedSessions,
  resolveIndexedProject,
  searchSessions,
  sessionRowById,
} from "../../src/core/queries.ts";
import { tempClaudeDir } from "../helpers/claude-dir.ts";
import { samplePricing as pricing } from "../helpers/pricing.ts";

const fixture = fileURLToPath(new URL("../fixtures/sample-session.jsonl", import.meta.url));
let claude: ReturnType<typeof tempClaudeDir>;
let db: Database;

beforeAll(async () => {
  claude = tempClaudeDir("cc-analyzer-q");
  const content = await Bun.file(fixture).text();
  mkdirSync(join(claude.dir, "projects", "proj-a"), { recursive: true });
  writeFileSync(join(claude.dir, "projects", "proj-a", "s1.jsonl"), content);
  // A distinct second session (unique message/request ids): a byte-identical
  // copy would be cross-file de-duplicated by the indexer and count $0.
  writeFileSync(
    join(claude.dir, "projects", "proj-a", "s2.jsonl"),
    content.replaceAll('"msg_', '"s2-msg_').replaceAll('"req-', '"s2-req-'),
  );
  db = openDb(":memory:");
  await reindex(db, { pricing });
});

afterAll(() => {
  db.close();
  claude.cleanup();
});

describe("queries", () => {
  test("isIndexEmpty reflects contents", () => {
    expect(isIndexEmpty(db)).toBe(false);
    expect(isIndexEmpty(openDb(":memory:"))).toBe(true);
  });

  test("listIndexedProjects rolls up sessions, cost and tokens", () => {
    const projects = listIndexedProjects(db);
    expect(projects).toHaveLength(1);
    expect(projects[0]?.sessions).toBe(2);
    expect(projects[0]?.projectPath).toBe("/Users/dev/proj");
    expect(projects[0]?.cost).toBeGreaterThan(0);
    // 2 sessions × (io 123, cache 10000) from the fixture
    expect(projects[0]?.ioTokens).toBe(246);
    expect(projects[0]?.cacheTokens).toBe(20000);
  });

  test("listIndexedSessions returns per-session rows with token split", () => {
    const resolved = resolveIndexedProject(db, "proj-a");
    expect(resolved.status).toBe("found");
    const sessions = listIndexedSessions(db, resolved.status === "found" ? resolved.id : "proj-a");
    expect(sessions).toHaveLength(2);
    expect(sessions[0]?.turns).toBe(2);
    expect(typeof sessions[0]?.costEstimated).toBe("boolean");
    expect(sessions[0]?.ioTokens).toBe(123);
    expect(sessions[0]?.cacheTokens).toBe(10000);
  });

  test("listAllSessions returns every session with its project path", () => {
    const all = listAllSessions(db);
    expect(all).toHaveLength(2);
    expect(all[0]?.projectPath).toBe("/Users/dev/proj");
    expect(typeof all[0]?.costEstimated).toBe("boolean");
  });

  test("searchSessions matches on project path and returns project-tagged rows", () => {
    const hits = searchSessions(db, "dev/proj");
    expect(hits).toHaveLength(2);
    expect(hits[0]?.projectPath).toBe("/Users/dev/proj");
    expect(searchSessions(db, "no-such-session-xyz")).toHaveLength(0);
  });

  test("searchSessions honors the limit", () => {
    expect(searchSessions(db, "dev/proj", 1)).toHaveLength(1);
  });
});

describe("searchSessions · LIKE escaping", () => {
  test("wildcard characters in the query match literally", () => {
    // "%" appears in no title/id/path, so it must match nothing (not everything).
    expect(searchSessions(db, "%")).toHaveLength(0);
    expect(searchSessions(db, "_")).toHaveLength(0);
    expect(searchSessions(db, "proj").length).toBeGreaterThan(0);
  });
});

describe("sessionRowById resolution order", () => {
  function seed(rows: [string, string, string, number][]) {
    const d = openDb(":memory:");
    for (const [path, claudeDir, sessionId, mtime] of rows) {
      d.query(
        "INSERT INTO sessions (path, claude_dir, project_id, session_id, mtime_ms, size_bytes) VALUES (?, ?, 'p', ?, ?, 1)",
      ).run(path, claudeDir, sessionId, mtime);
    }
    return d;
  }

  test("live root beats archive root regardless of mtime", () => {
    const d = seed([
      ["/r/machines/m1/roots/x/projects/p/abc.jsonl", "/r/machines/m1/roots/x", "abc", 9],
      ["/home/.claude/projects/p/abc.jsonl", "/home/.claude", "abc", 1],
    ]);
    expect(sessionRowById(d, "abc")?.path).toBe("/home/.claude/projects/p/abc.jsonl");
  });

  test("basename match works with backslash separators and breaks ties by mtime", () => {
    const d = seed([
      ["C:\\u\\.claude\\projects\\p\\zzz.jsonl", "C:\\u\\.claude", "other", 1],
      ["/a/projects/p/zzz.jsonl", "/a", "other2", 5],
    ]);
    // No session_id match: falls to basename; newest mtime among exact basenames wins.
    expect(sessionRowById(d, "zzz")?.path).toBe("/a/projects/p/zzz.jsonl");
    const d2 = seed([["C:\\u\\projects\\p\\zzz.jsonl", "C:\\u", "o", 1]]);
    expect(sessionRowById(d2, "zzz")?.path).toBe("C:\\u\\projects\\p\\zzz.jsonl");
  });
});

describe("alias groups spanning Claude roots", () => {
  const ins = (d: Database, path: string, root: string, pid: string, alias: string | null) =>
    d
      .prepare(
        "INSERT INTO sessions (path, claude_dir, project_id, project_alias, project_path, session_id, mtime_ms, size_bytes) VALUES (?, ?, ?, ?, '/w/app', ?, 1, 1)",
      )
      .run(path, root, pid, alias, path);

  test("claudeDir is '' only when the group spans roots", () => {
    const d = openDb(":memory:");
    ins(d, "/a/1", "/a/.claude", "aaaaaaaa~al", "app");
    ins(d, "/b/1", "/b/.claude", "aaaaaaaa~al", "app");
    ins(d, "/c/1", "/c/.claude", "cccccccc~x", null);
    ins(d, "/c/2", "/c/.claude", "cccccccc~x", null);
    ins(d, "/d/1", "/a/.claude", "dddddddd~one", "solo");
    const byId = (rows: { projectId: string; claudeDir: string }[]) =>
      Object.fromEntries(rows.map((r) => [r.projectId, r.claudeDir]));
    const expected = {
      "aaaaaaaa~al": "",
      "cccccccc~x": "/c/.claude",
      "dddddddd~one": "/a/.claude",
    };
    expect(byId(listIndexedProjects(d))).toEqual(expected);
    expect(byId(knownProjectLabels(d))).toEqual(expected);
    d.close();
  });
});
