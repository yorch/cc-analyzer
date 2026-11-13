import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { rootSlug } from "../../src/core/claude-roots.ts";
import { openDb } from "../../src/core/db.ts";
import { inspectIndexStatus } from "../../src/core/index-status.ts";
import { reindex } from "../../src/core/indexer.ts";
import { setArchivePath } from "../../src/core/prefs.ts";
import {
  projectAliasId,
  writeMachineAliases,
  writeProjectAliases,
} from "../../src/core/project-aliases.ts";
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

describe("scoped alias re-ingest", () => {
  const cwds = {
    a: "/Users/alice/work/app",
    a2: "D:/work/app",
    b: "/Users/alice/work/other",
    f: "/Users/alice/work/failing",
  } as const;
  let root: { path: string; slug: string; source: "default" };

  async function seed(projects: [string, string][]) {
    const rootPath = join(temp, "claude");
    root = { path: rootPath, slug: rootSlug(rootPath), source: "default" as const };
    const fixture = await readFile(
      new URL("../fixtures/sample-session.jsonl", import.meta.url),
      "utf8",
    );
    for (const [directory, cwd] of projects) {
      const project = join(rootPath, "projects", directory);
      await mkdir(project, { recursive: true });
      const content = fixture
        .replaceAll("/Users/dev/proj", cwd)
        .replaceAll('"msg_', `"${directory}-msg_`)
        .replaceAll('"req-', `"${directory}-req-`);
      await writeFile(join(project, `${directory}.jsonl`), content);
    }
  }
  const run = (opts: { rebuild?: boolean } = {}) =>
    reindex(db, { pricing: samplePricing, roots: [root], ...opts });
  const rowFor = (needle: string) =>
    db
      .query("SELECT project_id, project_alias FROM sessions WHERE path LIKE ?")
      .get(`%${needle}%`) as { project_id: string; project_alias: string | null };

  test("adding an alias re-keys only that project's rows", async () => {
    await seed([
      ["proj-a", cwds.a],
      ["proj-b", cwds.b],
    ]);
    await writeProjectAliases(new Map(), archivePath);
    expect((await run()).indexed).toBe(2);
    const bBefore = rowFor("proj-b");

    await writeProjectAliases(new Map([[cwds.a, "App"]]), archivePath);
    const res = await run();
    expect(res.indexed).toBe(1);
    expect(res.skipped).toBe(1);
    expect(rowFor("proj-a")).toMatchObject({ project_alias: "App" });
    expect(rowFor("proj-a").project_id).toBe(projectAliasId("App"));
    expect(rowFor("proj-b")).toEqual(bBefore);
  });

  test("per-machine alias files re-key sessions and index --check agrees", async () => {
    const idA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const idB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    await seed([
      ["proj-a", cwds.a],
      ["proj-b", cwds.b],
    ]);
    expect((await run()).indexed).toBe(2);
    const bBefore = rowFor("proj-b");
    expect((await inspectIndexStatus(db, Date.now(), [root])).stale).toBe(false);

    await writeMachineAliases(
      new Map([[cwds.a, { label: "App", updatedAt: 10 }]]),
      idA,
      archivePath,
    );
    expect(await inspectIndexStatus(db, Date.now(), [root])).toMatchObject({
      stale: true,
      changed: 1,
    });
    const res = await run();
    expect(res.indexed).toBe(1);
    expect(res.skipped).toBe(1);
    expect(rowFor("proj-a")).toMatchObject({
      project_alias: "App",
      project_id: projectAliasId("App"),
    });
    expect(rowFor("proj-b")).toEqual(bBefore);
    expect((await inspectIndexStatus(db, Date.now(), [root])).stale).toBe(false);

    // Another computer's newer tombstone removes the alias; the row is restored.
    await writeMachineAliases(new Map([[cwds.a, { updatedAt: 11 }]]), idB, archivePath);
    expect(await inspectIndexStatus(db, Date.now(), [root])).toMatchObject({ changed: 1 });
    expect((await run()).indexed).toBe(1);
    expect(rowFor("proj-a").project_alias).toBeNull();
    expect((await inspectIndexStatus(db, Date.now(), [root])).stale).toBe(false);
  });

  test("removing an alias restores the root-qualified project id", async () => {
    await seed([["proj-a", cwds.a]]);
    await writeProjectAliases(new Map(), archivePath);
    await run();
    const original = rowFor("proj-a");
    expect(original.project_alias).toBeNull();

    await writeProjectAliases(new Map([[cwds.a, "App"]]), archivePath);
    await run();
    expect(rowFor("proj-a").project_alias).toBe("App");

    await writeProjectAliases(new Map(), archivePath);
    const res = await run();
    expect(res.indexed).toBe(1);
    expect(res.skipped).toBe(0);
    expect(rowFor("proj-a")).toEqual(original);
    expect(original.project_id).toBe(`${root.slug}~proj-a`);
  });

  test("re-labelling one of two paths sharing a label re-keys only that path", async () => {
    await seed([
      ["proj-a", cwds.a],
      ["proj-a2", cwds.a2],
      ["proj-b", cwds.b],
    ]);
    await writeProjectAliases(
      new Map([
        [cwds.a, "Shared"],
        [cwds.a2, "Shared"],
      ]),
      archivePath,
    );
    expect((await run()).indexed).toBe(3);
    expect(rowFor("proj-a").project_id).toBe(rowFor("proj-a2").project_id);

    await writeProjectAliases(
      new Map([
        [cwds.a, "Shared"],
        [cwds.a2, "Renamed"],
      ]),
      archivePath,
    );
    const res = await run();
    expect(res.indexed).toBe(1);
    expect(res.skipped).toBe(2);
    expect(rowFor("proj-a").project_alias).toBe("Shared");
    expect(rowFor("proj-a2").project_alias).toBe("Renamed");
    expect(rowFor("proj-a2").project_id).toBe(projectAliasId("Renamed"));
  });

  test("a failed run that applied an alias does not freeze later edits (failing analysis)", async () => {
    await seed([
      ["proj-a", cwds.a],
      ["proj-b", cwds.b],
      ["proj-f", cwds.f],
    ]);
    await writeProjectAliases(new Map(), archivePath);
    await run();
    const fFile = join(root.path, "projects", "proj-f", "proj-f.jsonl");
    // proj-f becomes stale and unreadable, so its analysis fails on every run.
    await writeFile(fFile, `${await readFile(fFile, "utf8")}\n`);
    await chmod(fFile, 0o000);
    try {
      await writeProjectAliases(new Map([[cwds.a, "App"]]), archivePath);
      await run();
      expect(rowFor("proj-a").project_alias).toBe("App");

      await writeProjectAliases(new Map([[cwds.b, "Other"]]), archivePath);
      await run();
    } finally {
      await chmod(fFile, 0o644);
    }
    expect(rowFor("proj-a").project_alias).toBeNull();
    expect(rowFor("proj-a").project_id).toBe(`${root.slug}~proj-a`);
    expect(rowFor("proj-b").project_alias).toBe("Other");
  });

  test("a retained unreadable root does not freeze later alias edits", async () => {
    const root2Path = join(temp, "claude2");
    const root2 = { path: root2Path, slug: rootSlug(root2Path), source: "default" as const };
    await seed([
      ["proj-a", cwds.a],
      ["proj-b", cwds.b],
    ]);
    const fixture = await readFile(
      new URL("../fixtures/sample-session.jsonl", import.meta.url),
      "utf8",
    );
    await mkdir(join(root2Path, "projects", "proj-x"), { recursive: true });
    await writeFile(
      join(root2Path, "projects", "proj-x", "proj-x.jsonl"),
      fixture
        .replaceAll("/Users/dev/proj", "/Users/alice/work/x")
        .replaceAll('"msg_', '"proj-x-msg_')
        .replaceAll('"req-', '"proj-x-req-'),
    );
    const runBoth = () => reindex(db, { pricing: samplePricing, roots: [root, root2] });
    await writeProjectAliases(new Map(), archivePath);
    await runBoth();
    // The second root vanishes (unmounted volume) but stays configured.
    await rm(join(root2Path, "projects"), { recursive: true, force: true });

    await writeProjectAliases(new Map([[cwds.a, "App"]]), archivePath);
    await runBoth();
    expect(rowFor("proj-a").project_alias).toBe("App");

    await writeProjectAliases(new Map([[cwds.b, "Other"]]), archivePath);
    await runBoth();
    expect(rowFor("proj-a").project_alias).toBeNull();
    expect(rowFor("proj-b").project_alias).toBe("Other");
    // The unreachable root's row is retained, not wiped.
    expect(rowFor("proj-x")).toBeDefined();
  });

  test("a pure revert after a failed run heals", async () => {
    await seed([
      ["proj-a", cwds.a],
      ["proj-f", cwds.f],
    ]);
    await writeProjectAliases(new Map(), archivePath);
    await run();
    const fFile = join(root.path, "projects", "proj-f", "proj-f.jsonl");
    await writeFile(fFile, `${await readFile(fFile, "utf8")}\n`);
    await chmod(fFile, 0o000);
    try {
      await writeProjectAliases(new Map([[cwds.a, "App"]]), archivePath);
      await run();
      expect(rowFor("proj-a").project_alias).toBe("App");
      // Revert to the exact map the last fully-successful run saw.
      await writeProjectAliases(new Map(), archivePath);
      await run();
    } finally {
      await chmod(fFile, 0o644);
    }
    expect(rowFor("proj-a").project_alias).toBeNull();
    expect(rowFor("proj-a").project_id).toBe(`${root.slug}~proj-a`);
  });

  test("index --check reports exactly the work reindex does for an alias edit", async () => {
    await seed([
      ["proj-a", cwds.a],
      ["proj-b", cwds.b],
      ["proj-f", cwds.f],
    ]);
    await writeProjectAliases(new Map(), archivePath);
    await run();
    await writeProjectAliases(new Map([[cwds.a, "App"]]), archivePath);
    const status = await inspectIndexStatus(db, Date.now(), [root]);
    expect(status).toMatchObject({ stale: true, added: 0, changed: 1, deleted: 0 });
    const res = await run();
    expect(res.indexed).toBe(status.changed);
    expect(await inspectIndexStatus(db, Date.now(), [root])).toMatchObject({
      stale: false,
      changed: 0,
    });
  });

  test("a file changed by size/mtime is still re-ingested alongside alias selection", async () => {
    await seed([
      ["proj-a", cwds.a],
      ["proj-b", cwds.b],
    ]);
    await run();
    const bFile = join(root.path, "projects", "proj-b", "proj-b.jsonl");
    await writeFile(bFile, `${await readFile(bFile, "utf8")}\n`);
    await writeProjectAliases(new Map([[cwds.a, "App"]]), archivePath);
    const res = await run();
    expect(res.indexed).toBe(2);
    expect(res.skipped).toBe(0);
  });

  test("a NULL project_path in the index does not break selection", async () => {
    await seed([
      ["proj-a", cwds.a],
      ["proj-b", cwds.b],
    ]);
    await run();
    db.query("UPDATE sessions SET project_path = NULL WHERE path LIKE '%proj-b%'").run();
    await writeProjectAliases(new Map([[cwds.a, "App"]]), archivePath);
    const res = await run();
    expect(res.indexed).toBe(1);
    expect(res.skipped).toBe(1);
  });

  test("--rebuild still re-ingests everything", async () => {
    await seed([
      ["proj-a", cwds.a],
      ["proj-b", cwds.b],
    ]);
    await run();
    expect((await run()).skipped).toBe(2);
    const res = await run({ rebuild: true });
    expect(res.indexed).toBe(2);
    expect(res.skipped).toBe(0);
  });
});
