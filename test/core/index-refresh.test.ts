import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openDb } from "../../src/core/db.ts";
import { refreshIndexIfNeeded } from "../../src/core/index-refresh.ts";
import { inspectIndexStatus, lastIndexScanAt } from "../../src/core/index-status.ts";
import { type TempClaudeDir, tempClaudeDir } from "../helpers/claude-dir.ts";
import { samplePricing } from "../helpers/pricing.ts";
import { insertSession } from "../helpers/sessions.ts";

let claude: TempClaudeDir;
let db: Database;
let sessionPath: string;

beforeAll(() => {
  claude = tempClaudeDir("cc-index-refresh");
  db = openDb(":memory:");
  const projectDir = join(claude.dir, "projects", "proj");
  mkdirSync(projectDir, { recursive: true });
  sessionPath = join(projectDir, "session.jsonl");
  writeFileSync(
    sessionPath,
    `${JSON.stringify({
      type: "user",
      cwd: "/project",
      sessionId: "session",
      uuid: "u1",
      timestamp: "2026-07-23T10:00:00.000Z",
      message: { role: "user", content: "hello" },
    })}\n`,
  );
});

afterAll(() => {
  db.close();
  claude.cleanup();
});

describe("refreshIndexIfNeeded", () => {
  test("builds an empty index", async () => {
    const result = await refreshIndexIfNeeded(db, { pricing: samplePricing });
    expect(result).toMatchObject({ total: 1, indexed: 1, skipped: 0 });
    expect(lastIndexScanAt(db)).toBeNumber();
    expect(await inspectIndexStatus(db)).toMatchObject({
      stale: false,
      added: 0,
      changed: 0,
      deleted: 0,
    });
  });

  test("leaves a populated index alone unless refresh is requested", async () => {
    expect(await refreshIndexIfNeeded(db, { pricing: samplePricing })).toBeUndefined();
    expect(await refreshIndexIfNeeded(db, { refresh: true, pricing: samplePricing })).toMatchObject(
      {
        total: 1,
        indexed: 0,
        skipped: 1,
      },
    );
  });

  test("detects added, changed, and deleted files without parsing them", async () => {
    writeFileSync(sessionPath, `${await Bun.file(sessionPath).text()}\n`);
    writeFileSync(join(claude.dir, "projects", "proj", "new.jsonl"), "{}\n");
    insertSession(db, { path: "/deleted/session.jsonl", project_id: "deleted" });

    expect(await inspectIndexStatus(db)).toMatchObject({
      stale: true,
      added: 1,
      changed: 1,
      deleted: 1,
    });
  });
});
