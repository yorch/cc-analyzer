import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  archiveSessions,
  listArchiveRoots,
  listProjectAliases,
  setProjectAlias,
} from "../../src/core/archive.ts";
import { type ClaudeRoot, rootSlug } from "../../src/core/claude-roots.ts";
import { getArchiveMachineId, setArchivePath } from "../../src/core/prefs.ts";

let temp: string;
let previousStateDir: string | undefined;
let sourceRoot: ClaudeRoot;
let sessionPath: string;
let archivePath: string;

beforeEach(async () => {
  previousStateDir = process.env.CC_ANALYZER_STATE_DIR;
  temp = join("/tmp", `cc-analyzer-archive-${process.pid}-${Date.now()}-${Math.random()}`);
  const state = join(temp, "state");
  process.env.CC_ANALYZER_STATE_DIR = state;
  const rootPath = join(temp, "claude");
  sourceRoot = { path: rootPath, slug: rootSlug(rootPath), source: "default" };
  const project = join(rootPath, "projects", "-Users-test-project");
  sessionPath = join(project, "session-1.jsonl");
  archivePath = join(temp, "archive");
  await mkdir(join(project, "session-1", "subagents"), { recursive: true });
  await writeFile(sessionPath, '{"type":"user"}\n');
  await writeFile(
    join(project, "session-1", "subagents", "agent-a.jsonl"),
    '{"type":"assistant"}\n',
  );
  await writeFile(
    join(project, "session-1", "subagents", "agent-a.meta.json"),
    '{"agentType":"Explore"}\n',
  );
  setArchivePath(archivePath);
});

afterEach(async () => {
  if (previousStateDir === undefined) delete process.env.CC_ANALYZER_STATE_DIR;
  else process.env.CC_ANALYZER_STATE_DIR = previousStateDir;
  await rm(temp, { recursive: true, force: true });
});

describe("archiveSessions", () => {
  test("copies whole raw trees into a machine-scoped Git repository and commits", async () => {
    const result = await archiveSessions([sourceRoot]);
    expect(result).toMatchObject({ copied: 1, unchanged: 0, committed: true });
    const root = result.roots[0];
    expect(root).toBeDefined();
    const archivedParent = join(
      root as string,
      "projects",
      "-Users-test-project",
      "session-1.jsonl",
    );
    expect(await readFile(archivedParent, "utf8")).toBe('{"type":"user"}\n');
    expect(
      await readFile(
        join(
          root as string,
          "projects",
          "-Users-test-project",
          "session-1",
          "subagents",
          "agent-a.jsonl",
        ),
        "utf8",
      ),
    ).toBe('{"type":"assistant"}\n');
    expect(
      await readFile(
        join(
          root as string,
          "projects",
          "-Users-test-project",
          "session-1",
          "subagents",
          "agent-a.meta.json",
        ),
        "utf8",
      ),
    ).toContain("Explore");
    expect(root).toContain(getArchiveMachineId());
  });

  test("stores aliases in a local Git commit and supports removal", async () => {
    const result = await archiveSessions([sourceRoot]);
    expect(result.committed).toBe(true);
    await expect(setProjectAlias("relative/project", "Shared Project")).rejects.toThrow("absolute");
    await expect(setProjectAlias("/Users/alice/project", " ")).rejects.toThrow("empty");
    expect(await setProjectAlias("/Users/alice/project", "Shared Project")).toBe(true);
    expect(await listProjectAliases()).toEqual([["/Users/alice/project", "Shared Project"]]);
    expect(await setProjectAlias("/Users/alice/project", "Shared Project")).toBe(false);
    expect(await setProjectAlias("/Users/alice/project", undefined)).toBe(true);
    expect(await listProjectAliases()).toEqual([]);
  });

  test("exposes another machine's archive roots, but avoids a live source duplicate", async () => {
    await archiveSessions([sourceRoot]);
    expect(await listArchiveRoots(archivePath, [sourceRoot])).toEqual([]);
    const remoteSource = { ...sourceRoot, path: join(temp, "other-claude"), slug: "otherroot" };
    expect(await listArchiveRoots(archivePath, [remoteSource])).toHaveLength(1);
    await rm(sourceRoot.path, { recursive: true, force: true });
    expect(await listArchiveRoots(archivePath, [sourceRoot])).toHaveLength(1);
  });

  test("skips identical snapshots and commits changed sessions", async () => {
    await archiveSessions([sourceRoot]);
    const unchanged = await archiveSessions([sourceRoot]);
    expect(unchanged).toMatchObject({ copied: 0, unchanged: 1, committed: false });
    await writeFile(sessionPath, '{"type":"user","updated":true}\n');
    const updated = await archiveSessions([sourceRoot]);
    expect(updated).toMatchObject({ copied: 1, committed: true });
  });

  test("refuses an archive repository with uncommitted changes", async () => {
    await archiveSessions([sourceRoot]);
    await writeFile(join(archivePath, "manual.txt"), "do not commit this\n");
    await expect(archiveSessions([sourceRoot])).rejects.toThrow("uncommitted changes");
  });
});
