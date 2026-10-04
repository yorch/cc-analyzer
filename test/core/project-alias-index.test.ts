import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { rootSlug } from "../../src/core/claude-roots.ts";
import { openDb } from "../../src/core/db.ts";
import { inspectIndexStatus } from "../../src/core/index-status.ts";
import { reindex } from "../../src/core/indexer.ts";
import { setArchivePath } from "../../src/core/prefs.ts";
import { writeProjectAliases } from "../../src/core/project-aliases.ts";
import { resolveIndexedProject } from "../../src/core/queries.ts";
import { spendByProject } from "../../src/core/stats.ts";
import { samplePricing } from "../helpers/pricing.ts";

let temp: string;
let archivePath: string;
let previousStateDir: string | undefined;
let db: Database;

beforeEach(async () => {
  previousStateDir = process.env.CC_ANALYZER_STATE_DIR;
  temp = await mkdtemp(join("/tmp", `cc-analyzer-project-alias-index-${process.pid}-`));
  process.env.CC_ANALYZER_STATE_DIR = join(temp, "state");
  archivePath = join(temp, "archive");
  await mkdir(archivePath, { recursive: true });
  setArchivePath(archivePath);
  db = openDb(":memory:");
});

afterEach(async () => {
  db.close();
  if (previousStateDir === undefined) delete process.env.CC_ANALYZER_STATE_DIR;
  else process.env.CC_ANALYZER_STATE_DIR = previousStateDir;
  await rm(temp, { recursive: true, force: true });
});

describe("project alias indexing", () => {
  test("groups distinct working directories and reindexes when the shared map changes", async () => {
    const rootPath = join(temp, "claude");
    const root = { path: rootPath, slug: rootSlug(rootPath), source: "default" as const };
    const fixture = await readFile(
      new URL("../fixtures/sample-session.jsonl", import.meta.url),
      "utf8",
    );
    const paths = [
      ["proj-a", "/Users/alice/work/app"],
      ["proj-b", "D:/work/app"],
    ] as const;
    for (const [directory, cwd] of paths) {
      const project = join(rootPath, "projects", directory);
      await mkdir(project, { recursive: true });
      const content = fixture
        .replaceAll("/Users/dev/proj", cwd)
        .replaceAll('"msg_', `"${directory}-msg_`)
        .replaceAll('"req-', `"${directory}-req-`);
      await writeFile(join(project, `${directory}.jsonl`), content);
    }

    await writeProjectAliases(new Map(paths.map(([, cwd]) => [cwd, "Shared App"])), archivePath);
    const first = await reindex(db, { pricing: samplePricing, roots: [root] });
    expect(first.indexed).toBe(2);
    expect(spendByProject(db)).toHaveLength(1);
    expect(spendByProject(db)[0]).toMatchObject({ projectAlias: "Shared App", sessions: 2 });
    const aliasId = resolveIndexedProject(db, "Shared App");
    expect(aliasId.status).toBe("found");

    await writeProjectAliases(new Map(paths.map(([, cwd]) => [cwd, "Renamed App"])), archivePath);
    expect(await inspectIndexStatus(db, Date.now(), [root])).toMatchObject({
      stale: true,
      changed: 2,
    });
    const second = await reindex(db, { pricing: samplePricing, roots: [root] });
    expect(second.indexed).toBe(2);
    expect(second.skipped).toBe(0);
    expect(spendByProject(db)).toHaveLength(1);
    expect(spendByProject(db)[0]?.projectAlias).toBe("Renamed App");
  });
});
