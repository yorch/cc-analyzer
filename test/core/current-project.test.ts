import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { indexedProjectForPath } from "../../src/core/queries.ts";

function database(): Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE sessions (
      project_id TEXT NOT NULL,
      project_path TEXT
    );
    INSERT INTO sessions VALUES
      ('parent', '/Users/dev'),
      ('project', '/Users/dev/project'),
      ('other', '/Users/dev/other'),
      ('unknown', NULL);
  `);
  return db;
}

describe("indexedProjectForPath", () => {
  test("matches an exact project cwd", () => {
    const db = database();
    expect(indexedProjectForPath(db, "/Users/dev/project")).toEqual({
      projectId: "project",
      projectPath: "/Users/dev/project",
    });
    db.close();
  });

  test("uses the closest indexed ancestor from a nested cwd", () => {
    const db = database();
    expect(indexedProjectForPath(db, "/Users/dev/project/web/src")?.projectId).toBe("project");
    db.close();
  });

  test("does not match a sibling with a shared path prefix", () => {
    const db = database();
    expect(indexedProjectForPath(db, "/Users/developer")).toBeUndefined();
    db.close();
  });
});
