import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import {
  adoptArchiveMachine,
  archiveSessions,
  keepArchiveMachine,
  listArchiveMachineEntries,
  listArchiveRoots,
  listProjectAliases,
  readArchiveMachines,
  resolveArchiveMachine,
  setProjectAlias,
} from "../../src/core/archive.ts";
import { type ClaudeRoot, rootSlug } from "../../src/core/claude-roots.ts";
import {
  getArchiveMachineLabel,
  readStoredArchiveMachineId,
  setArchiveMachineLabel,
  setArchivePath,
} from "../../src/core/prefs.ts";

// Several tests spawn real `git` and `bun` subprocesses; see test/cli/cli.test.ts
// for the load measurement behind this timeout.
setDefaultTimeout(10_000);

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
    expect(root).toContain(readStoredArchiveMachineId() as string);
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

describe("archive machine identity", () => {
  const fixture = join(import.meta.dir, "..", "fixtures", "sample-session.jsonl");

  test("regression: losing the local machine id does not double-count sessions", async () => {
    const { reindex } = await import("../../src/core/indexer.ts");
    const { openDb } = await import("../../src/core/db.ts");
    const { samplePricing } = await import("../helpers/pricing.ts");
    const { copyFile } = await import("node:fs/promises");
    await copyFile(fixture, sessionPath);
    await rm(join(sourceRoot.path, "projects", "-Users-test-project", "session-1"), {
      recursive: true,
      force: true,
    });
    const previousClaude = process.env.CC_ANALYZER_CLAUDE_DIR;
    process.env.CC_ANALYZER_CLAUDE_DIR = sourceRoot.path;
    try {
      const first = await archiveSessions([sourceRoot]);
      const db = openDb(":memory:");
      await reindex(db, { pricing: samplePricing, roots: [sourceRoot] });
      const before = db.query("SELECT SUM(turns) AS t FROM sessions").get() as { t: number };
      await rm(join(temp, "state", "archive-machine-id"));
      // A lost identity must not archive under a guessed one.
      await expect(archiveSessions([sourceRoot])).rejects.toThrow("archive machine adopt");
      await adoptArchiveMachine(first.machine?.id as string, archivePath);
      await archiveSessions([sourceRoot]);
      const machineDirs = (await readdir(join(archivePath, "machines"))).length;
      expect(machineDirs).toBe(1);
      await reindex(db, { pricing: samplePricing, roots: [sourceRoot] });
      const rows = db.query("SELECT COUNT(*) AS n, SUM(turns) AS t FROM sessions").get() as {
        n: number;
        t: number;
      };
      expect(rows.n).toBe(1);
      expect(before.t).toBeGreaterThan(0);
      expect(rows.t).toBe(before.t);
    } finally {
      if (previousClaude === undefined) delete process.env.CC_ANALYZER_CLAUDE_DIR;
      else process.env.CC_ANALYZER_CLAUDE_DIR = previousClaude;
    }
  });

  test("pre-identity archive: a lost id mints but still lists the orphaned directory", async () => {
    const first = await archiveSessions([sourceRoot]);
    const oldId = first.machine?.id as string;
    await rm(join(archivePath, "machines", oldId, "machine.json"));
    await rm(join(temp, "state", "archive-machine-id"));
    expect(await readArchiveMachines(archivePath)).toEqual([]);
    const resolved = await resolveArchiveMachine(archivePath, "some-other-host");
    expect(resolved.source).toBe("unidentified");
    expect(resolved.candidates).toEqual([{ id: oldId, hostnames: [], identified: false }]);
  });

  test("a brand-new computer against an empty or absent archive has no candidates", async () => {
    const absent = await resolveArchiveMachine(join(temp, "no-such-archive"));
    expect(absent).toMatchObject({ source: "unidentified", candidates: [] });
    await mkdir(join(archivePath, "machines"), { recursive: true });
    const empty = await resolveArchiveMachine(archivePath);
    expect(empty).toMatchObject({ source: "unidentified", candidates: [] });
  });

  test("listArchiveMachineEntries lists unidentified directories without inventing a record", async () => {
    const first = await archiveSessions([sourceRoot]);
    const stray = "33333333-3333-4333-8333-333333333333";
    const damaged = "44444444-4444-4444-8444-444444444444";
    await mkdir(join(archivePath, "machines", stray), { recursive: true });
    await mkdir(join(archivePath, "machines", damaged), { recursive: true });
    await writeFile(join(archivePath, "machines", damaged, "machine.json"), "{not json");
    await mkdir(join(archivePath, "machines", "not-an-id"), { recursive: true });
    const entries = await listArchiveMachineEntries(archivePath);
    expect(entries.map((e) => e.id)).toEqual([first.machine?.id as string, stray, damaged].sort());
    const byId = new Map(entries.map((e) => [e.id, e]));
    expect(byId.get(first.machine?.id as string)).toMatchObject({
      identified: true,
      hostnames: [hostname()],
    });
    for (const id of [stray, damaged]) {
      expect(byId.get(id)).toEqual({ id, hostnames: [], identified: false });
    }
  });

  test("archive show lists an unidentified machine directory", async () => {
    const stray = "55555555-5555-4555-8555-555555555555";
    await mkdir(join(archivePath, "machines", stray), { recursive: true });
    const proc = Bun.spawn(
      ["bun", "run", join(import.meta.dir, "../../src/cli/index.ts"), "archive", "show"],
      {
        env: {
          ...process.env,
          CC_ANALYZER_STATE_DIR: join(temp, "state"),
          CC_ANALYZER_TELEMETRY: "0",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    expect(out).toContain("Machines in archive:");
    expect(out).toContain(stray);
    expect(out).toContain("(unidentified)");
  }, 30_000);

  test("A ordering: a read path first does not silence the warning, and nothing is persisted", async () => {
    const { reindex } = await import("../../src/core/indexer.ts");
    const { inspectIndexStatus } = await import("../../src/core/index-status.ts");
    const { openDb } = await import("../../src/core/db.ts");
    const { samplePricing } = await import("../helpers/pricing.ts");
    const { copyFile } = await import("node:fs/promises");
    await copyFile(fixture, sessionPath);
    await rm(join(sourceRoot.path, "projects", "-Users-test-project", "session-1"), {
      recursive: true,
      force: true,
    });
    const previousClaude = process.env.CC_ANALYZER_CLAUDE_DIR;
    process.env.CC_ANALYZER_CLAUDE_DIR = sourceRoot.path;
    try {
      const first = await archiveSessions([sourceRoot]);
      const db = openDb(":memory:");
      await reindex(db, { pricing: samplePricing, roots: [sourceRoot] });
      const before = db.query("SELECT SUM(turns) AS t FROM sessions").get() as { t: number };
      await rm(join(temp, "state", "archive-machine-id"));
      // The read path that used to mint silently (index --check, TUI, serve, ...).
      await inspectIndexStatus(db, Date.now(), [sourceRoot]);
      await inspectIndexStatus(db, Date.now(), [sourceRoot]);
      expect(readStoredArchiveMachineId()).toBeUndefined();
      // Archive-during-index stays off (the default): index must still resolve identity.
      const result = await reindex(db, { pricing: samplePricing, roots: [sourceRoot] });
      expect(result.archiveMachine?.source).toBe("unidentified");
      expect(result.archiveMachine?.candidates.map((m) => m.id)).toEqual([
        first.machine?.id as string,
      ]);
      expect(result.archiveMachine?.suggestion?.id).toBe(first.machine?.id as string);
      // Still unresolved, so it warns again on the next run.
      const again = await reindex(db, { pricing: samplePricing, roots: [sourceRoot] });
      expect(again.archiveMachine?.source).toBe("unidentified");
      // Adopting resolves it and the duplicate row is pruned.
      await adoptArchiveMachine(first.machine?.id as string, archivePath);
      const fixed = await reindex(db, { pricing: samplePricing, roots: [sourceRoot] });
      expect(fixed.archiveMachine?.source).toBe("local");
      const rows = db.query("SELECT COUNT(*) AS n, SUM(turns) AS t FROM sessions").get() as {
        n: number;
        t: number;
      };
      expect(rows.n).toBe(1);
      expect(rows.t).toBe(before.t);
    } finally {
      if (previousClaude === undefined) delete process.env.CC_ANALYZER_CLAUDE_DIR;
      else process.env.CC_ANALYZER_CLAUDE_DIR = previousClaude;
    }
  });

  test("lost id with a different hostname mints a new id and signals it", async () => {
    await archiveSessions([sourceRoot]);
    const original = readStoredArchiveMachineId() as string;
    await rm(join(temp, "state", "archive-machine-id"));
    const resolved = await resolveArchiveMachine(archivePath, "some-other-host");
    expect(resolved.source).toBe("unidentified");
    expect(resolved.id).not.toBe(original);
    expect(resolved.candidates.map((m) => m.id)).toEqual([original]);
  });

  test("C: a matching hostname is only suggested, never adopted or persisted", async () => {
    const first = await archiveSessions([sourceRoot]);
    await rm(join(temp, "state", "archive-machine-id"));
    const resolved = await resolveArchiveMachine(archivePath);
    expect(resolved.source).toBe("unidentified");
    expect(resolved.id).not.toBe(first.machine?.id);
    expect(resolved.suggestion?.id).toBe(first.machine?.id as string);
    expect(readStoredArchiveMachineId()).toBeUndefined();
  });

  test("C: two machines sharing hostname and root slug do not hide each other's sessions", async () => {
    // Machine A's archive exists; this computer (B) lost its id. B's live root has
    // the same path, hence the same slug, and the same hostname as A.
    const a = await archiveSessions([sourceRoot]);
    await rm(join(temp, "state", "archive-machine-id"));
    const roots = await listArchiveRoots(archivePath, [sourceRoot]);
    expect(roots.map((r) => r.slug)).toEqual([`archive-${a.machine?.id}-${sourceRoot.slug}`]);
    expect(readStoredArchiveMachineId()).toBeUndefined();
  });

  test("C guard: adopt refuses an id recorded for another host unless forced", async () => {
    const a = await archiveSessions([sourceRoot]);
    const id = a.machine?.id as string;
    await rm(join(temp, "state", "archive-machine-id"));
    await expect(
      adoptArchiveMachine(id, archivePath, { host: "another-computer" }),
    ).rejects.toThrow("--force");
    expect(readStoredArchiveMachineId()).toBeUndefined();
    await adoptArchiveMachine(id, archivePath, { host: "another-computer", force: true });
    expect(readStoredArchiveMachineId()).toBe(id);
  });

  test("C guard: an unidentified entry (no machine.json) is still adoptable", async () => {
    const a = await archiveSessions([sourceRoot]);
    const id = a.machine?.id as string;
    await rm(join(archivePath, "machines", id, "machine.json"));
    await rm(join(temp, "state", "archive-machine-id"));
    await adoptArchiveMachine(id, archivePath, { host: "another-computer" });
    expect(readStoredArchiveMachineId()).toBe(id);
  });

  test("adopt lowercases the id before validating", async () => {
    const a = await archiveSessions([sourceRoot]);
    const id = a.machine?.id as string;
    await rm(join(temp, "state", "archive-machine-id"));
    await adoptArchiveMachine(id.toUpperCase(), archivePath, { liveRoots: [sourceRoot] });
    expect(readStoredArchiveMachineId()).toBe(id);
  });

  test("archive run refuses an unresolved identity when machines exist", async () => {
    await archiveSessions([sourceRoot]);
    await rm(join(temp, "state", "archive-machine-id"));
    await expect(archiveSessions([sourceRoot])).rejects.toThrow(/adopt .*keep|keep/s);
    await expect(archiveSessions([sourceRoot])).rejects.toThrow("archive machine adopt");
    expect(readStoredArchiveMachineId()).toBeUndefined();
    expect((await readdir(join(archivePath, "machines"))).length).toBe(1);
  });

  test("archive run on a genuinely first run proceeds and persists the identity", async () => {
    expect(readStoredArchiveMachineId()).toBeUndefined();
    const result = await archiveSessions([sourceRoot]);
    expect(result.machine?.source).toBe("local");
    expect(readStoredArchiveMachineId()).toBe(result.machine?.id as string);
  });

  test("archive machine keep persists a fresh id so the next resolution is local", async () => {
    await archiveSessions([sourceRoot]);
    const old = readStoredArchiveMachineId();
    await rm(join(temp, "state", "archive-machine-id"));
    const kept = await keepArchiveMachine(archivePath, { force: true });
    expect(kept.id).not.toBe(old as string);
    expect(readStoredArchiveMachineId()).toBe(kept.id);
    expect(await resolveArchiveMachine(archivePath)).toMatchObject({
      id: kept.id,
      source: "local",
    });
    // And archiving is no longer refused.
    expect((await archiveSessions([sourceRoot])).machine?.id).toBe(kept.id);
  });

  test("B/D: CLI machine does not persist, reports unresolved; show and run use full ids", async () => {
    const a = await archiveSessions([sourceRoot]);
    const id = a.machine?.id as string;
    await rm(join(temp, "state", "archive-machine-id"));
    const cli = async (...args: string[]) => {
      const proc = Bun.spawn(
        ["bun", "run", join(import.meta.dir, "../../src/cli/index.ts"), ...args],
        {
          env: {
            ...process.env,
            CC_ANALYZER_STATE_DIR: join(temp, "state"),
            CC_ANALYZER_CLAUDE_DIR: sourceRoot.path,
            CC_ANALYZER_TELEMETRY: "0",
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [out, err, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      return { out, err, code };
    };
    const machine = await cli("archive", "machine");
    expect(machine.out).toContain("Source: unidentified");
    expect(machine.err).toContain(`archive machine adopt ${id}`);
    expect(machine.err).toContain("hostname matches");
    expect(readStoredArchiveMachineId()).toBeUndefined();
    const show = await cli("archive", "show");
    expect(show.out).toContain(id);
    const run = await cli("archive", "run");
    expect(run.code).toBe(1);
    expect(run.err).toContain(`archive machine adopt ${id}`);
    expect(run.err).toContain("archive machine keep");
    const adopt = await cli("archive", "machine", "adopt", id);
    expect(adopt.code).toBe(0);
    expect(adopt.out).toContain("index --rebuild");
    expect((await cli("archive", "machine")).out).toContain("Source: local");
  }, 60_000);

  test("machine.json is written and committed, and never gains a host the record excludes", async () => {
    const result = await archiveSessions([sourceRoot]);
    const id = result.machine?.id as string;
    const file = join(archivePath, "machines", id, "machine.json");
    const record = JSON.parse(await readFile(file, "utf8"));
    expect(record).toMatchObject({ version: 1, id, hostnames: [hostname()] });
    const tracked = Bun.spawnSync(["git", "ls-files", `machines/${id}/machine.json`], {
      cwd: archivePath,
    });
    expect(tracked.stdout.toString().trim()).toBe(`machines/${id}/machine.json`);
    // Simulate a renamed host: a prior run recorded another hostname.
    await writeFile(file, JSON.stringify({ ...record, hostnames: ["old-host"] }));
    Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qam", "x"], {
      cwd: archivePath,
    });
    // Archiving from here must NOT launder the other host's record into one that
    // names this host: that would erase the adopt guard.
    const again = await archiveSessions([sourceRoot]);
    expect(again.copied).toBe(0);
    const machines = await readArchiveMachines(archivePath);
    expect(machines[0]?.hostnames).toEqual(["old-host"]);
  });

  test("label defaults to the hostname and round-trips", async () => {
    expect(getArchiveMachineLabel()).toBe(hostname());
    setArchiveMachineLabel("  Work laptop ");
    expect(getArchiveMachineLabel()).toBe("Work laptop");
    const result = await archiveSessions([sourceRoot]);
    const [machine] = await readArchiveMachines(archivePath);
    expect(machine).toMatchObject({ id: result.machine?.id, label: "Work laptop" });
    setArchiveMachineLabel(undefined);
    expect(getArchiveMachineLabel()).toBe(hostname());
  });

  test("adopt rejects an id absent from the archive and accepts a present one", async () => {
    const result = await archiveSessions([sourceRoot]);
    await expect(
      adoptArchiveMachine("11111111-2222-3333-4444-555555555555", archivePath),
    ).rejects.toThrow("No machine");
    await expect(adoptArchiveMachine("not-an-id", archivePath)).rejects.toThrow("valid");
    await rm(join(temp, "state", "archive-machine-id"));
    await adoptArchiveMachine(result.machine?.id as string, archivePath);
    expect(readStoredArchiveMachineId()).toBe(result.machine?.id as string);
  });

  test("unchanged sessions are not re-copied", async () => {
    const result = await archiveSessions([sourceRoot]);
    const archived = join(
      result.roots[0] as string,
      "projects",
      "-Users-test-project",
      "session-1.jsonl",
    );
    const before = (await stat(archived)).mtimeMs;
    await new Promise((r) => setTimeout(r, 20));
    const again = await archiveSessions([sourceRoot]);
    expect(again.copied).toBe(0);
    expect((await stat(archived)).mtimeMs).toBe(before);
    // Same size, different bytes still copies.
    await writeFile(sessionPath, '{"type":"USER"}\n');
    expect((await archiveSessions([sourceRoot])).copied).toBe(1);
    expect(await readFile(archived, "utf8")).toBe('{"type":"USER"}\n');
  });

  test("a malformed machine.json is skipped without throwing", async () => {
    const result = await archiveSessions([sourceRoot]);
    const dir = join(archivePath, "machines", result.machine?.id as string);
    await writeFile(join(dir, "machine.json"), "{not json");
    await mkdir(join(archivePath, "machines", "22222222-2222-2222-2222-222222222222"), {
      recursive: true,
    });
    expect(await readArchiveMachines(archivePath)).toEqual([]);
    expect(await listArchiveRoots(archivePath, [])).toBeDefined();
    expect((await resolveArchiveMachine(archivePath)).source).toBe("local");
  });
});

describe("archive identity gaps", () => {
  const fixture = join(import.meta.dir, "..", "fixtures", "sample-session.jsonl");
  const cliPath = join(import.meta.dir, "../../src/cli/index.ts");
  const cli = async (...args: string[]) => {
    const proc = Bun.spawn(["bun", "run", cliPath, ...args], {
      env: {
        ...process.env,
        CC_ANALYZER_STATE_DIR: join(temp, "state"),
        CC_ANALYZER_CLAUDE_DIR: sourceRoot.path,
        CC_ANALYZER_TELEMETRY: "0",
        CC_ANALYZER_NO_UPDATE_CHECK: "1",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { out, err, code };
  };

  async function realSession(): Promise<void> {
    const { copyFile } = await import("node:fs/promises");
    await copyFile(fixture, sessionPath);
    await rm(join(sourceRoot.path, "projects", "-Users-test-project", "session-1"), {
      recursive: true,
      force: true,
    });
  }

  async function rows(db: import("bun:sqlite").Database) {
    return db.query("SELECT path, cost_total AS cost FROM sessions ORDER BY path").all() as {
      path: string;
      cost: number | null;
    }[];
  }

  test("1: a non-UUID machine directory adds no session rows and is invisible to discovery", async () => {
    const { reindex } = await import("../../src/core/indexer.ts");
    const { openDb } = await import("../../src/core/db.ts");
    const { samplePricing } = await import("../helpers/pricing.ts");
    await realSession();
    await archiveSessions([sourceRoot]);
    const id = readStoredArchiveMachineId() as string;
    const legacy = join(archivePath, "machines", "legacy-machine-0001");
    const copy = await Bun.$`cp -R ${join(archivePath, "machines", id)} ${legacy}`.quiet();
    expect(copy.exitCode).toBe(0);
    Bun.spawnSync(["git", "add", "-A"], { cwd: archivePath });
    Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "legacy"], {
      cwd: archivePath,
    });
    // Lose identity: nothing should make the legacy directory a second row set.
    await rm(join(temp, "state", "archive-machine-id"));
    const discovered = await listArchiveRoots(archivePath, [sourceRoot]);
    expect(discovered.map((r) => r.slug)).toEqual([`archive-${id}-${sourceRoot.slug}`]);
    const db = openDb(":memory:");
    await reindex(db, { pricing: samplePricing, roots: [sourceRoot] });
    // Only the real machine's copy doubles it (identity unresolved); never the legacy one.
    expect((await rows(db)).filter((r) => r.path.includes("legacy-machine"))).toEqual([]);
  });

  test("1: an archive with history is not a first run even when machines/ is not readable", async () => {
    await archiveSessions([sourceRoot]);
    await rm(join(temp, "state", "archive-machine-id"));
    // Simulate a sparse checkout / mid-download sync: machines/ is absent.
    await rm(join(archivePath, "machines"), { recursive: true, force: true });
    Bun.spawnSync(["git", "add", "-A"], { cwd: archivePath });
    Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "gone"], {
      cwd: archivePath,
    });
    expect((await resolveArchiveMachine(archivePath)).candidates).toEqual([]);
    await expect(archiveSessions([sourceRoot])).rejects.toThrow("archive machine keep");
    expect(readStoredArchiveMachineId()).toBeUndefined();
  });

  test("2: index --check and archive machine warn on stderr about an unresolved identity", async () => {
    await realSession();
    const a = await archiveSessions([sourceRoot]);
    const id = a.machine?.id as string;
    expect((await cli("index")).code).toBe(0);
    await rm(join(temp, "state", "archive-machine-id"));
    const check = await cli("index", "--check");
    expect(check.err).toContain("warning: this computer has no recorded identity");
    expect(check.err).toContain(`archive machine adopt ${id}`);
    expect(check.out).not.toContain("warning");
  }, 60_000);

  test("3: adopt refuses to hide sessions absent locally, allows genuine recovery", async () => {
    // Two computers, same hostname and same ~/.claude path hash: this computer's
    // live root is missing a session the other computer archived.
    const a = await archiveSessions([sourceRoot]);
    const id = a.machine?.id as string;
    const projects = join(archivePath, "machines", id, "roots", sourceRoot.slug, "projects");
    await writeFile(
      join(projects, "-Users-test-project", "other-computer.jsonl"),
      '{"type":"user"}\n',
    );
    await rm(join(temp, "state", "archive-machine-id"));
    await expect(adoptArchiveMachine(id, archivePath, { liveRoots: [sourceRoot] })).rejects.toThrow(
      "would hide 1 archived session that is not present",
    );
    expect(readStoredArchiveMachineId()).toBeUndefined();
    const forced = await adoptArchiveMachine(id, archivePath, {
      liveRoots: [sourceRoot],
      force: true,
    });
    expect(forced.hiddenSessions).toBe(1);
    expect(readStoredArchiveMachineId()).toBe(id);
    // Genuine recovery: the archive mirrors the live files.
    await rm(join(projects, "-Users-test-project", "other-computer.jsonl"));
    await rm(join(temp, "state", "archive-machine-id"));
    expect(await adoptArchiveMachine(id, archivePath, { liveRoots: [sourceRoot] })).toEqual({
      hiddenSessions: 0,
    });
  });

  test("4: keep needs --force when a candidate records this host, and names the consequence", async () => {
    const a = await archiveSessions([sourceRoot]);
    await rm(join(temp, "state", "archive-machine-id"));
    await expect(keepArchiveMachine(archivePath)).rejects.toThrow("counted twice");
    expect(readStoredArchiveMachineId()).toBeUndefined();
    const kept = await keepArchiveMachine(archivePath, { force: true });
    expect(kept.passedOver.map((m) => m.id)).toEqual([a.machine?.id as string]);
    // A candidate for another host needs no force.
    await rm(join(temp, "state", "archive-machine-id"));
    expect((await keepArchiveMachine(archivePath, { host: "elsewhere" })).passedOver).toHaveLength(
      1,
    );
  });

  test("4/5: CLI keep restates the candidates, the consequence and the rebuild instruction", async () => {
    await realSession();
    const a = await archiveSessions([sourceRoot]);
    await rm(join(temp, "state", "archive-machine-id"));
    const refused = await cli("archive", "machine", "keep");
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("--force");
    const kept = await cli("archive", "machine", "keep", "--force");
    expect(kept.code).toBe(0);
    expect(kept.out).toContain(a.machine?.id as string);
    expect(kept.out).toContain("counted twice");
    expect(kept.out).toContain("index --rebuild");
    const check = await cli("index", "--check");
    expect(check.code).toBe(1);
    expect(check.out).toContain("index --rebuild");
    expect((await cli("index", "--rebuild")).code).toBe(0);
    expect((await cli("index", "--check")).out).not.toContain("needs a rebuild");
  }, 90_000);

  test("5: after adopt a plain index still has the wrong cost; --rebuild repairs it", async () => {
    const { reindex } = await import("../../src/core/indexer.ts");
    const { openDb } = await import("../../src/core/db.ts");
    const { samplePricing } = await import("../helpers/pricing.ts");
    await realSession();
    const first = await archiveSessions([sourceRoot]);
    // Grow the live file so the archive copy carries the OLDER mtime and is
    // analyzed (and claims usage) first.
    await new Promise((r) => setTimeout(r, 20));
    await writeFile(sessionPath, `${await readFile(sessionPath, "utf8")}{"type":"summary"}\n`);
    const healthy = openDb(":memory:");
    await reindex(healthy, { pricing: samplePricing, roots: [sourceRoot] });
    const baseline = (await rows(healthy))[0]?.cost as number;
    expect(baseline).toBeGreaterThan(0);

    await rm(join(temp, "state", "archive-machine-id"));
    const db = openDb(":memory:");
    await reindex(db, { pricing: samplePricing, roots: [sourceRoot] });
    const doubled = await rows(db);
    expect(doubled).toHaveLength(2);
    const live = doubled.find((r) => r.path === sessionPath);
    expect(live?.cost ?? 0).toBe(0);
    expect(doubled.find((r) => r.path !== sessionPath)?.cost).toBeCloseTo(baseline, 8);

    await adoptArchiveMachine(first.machine?.id as string, archivePath, {
      liveRoots: [sourceRoot],
    });
    await reindex(db, { pricing: samplePricing, roots: [sourceRoot] });
    const plain = await rows(db);
    expect(plain).toHaveLength(1);
    expect(plain[0]?.cost ?? 0).toBe(0);

    await reindex(db, { pricing: samplePricing, roots: [sourceRoot], rebuild: true });
    const repaired = await rows(db);
    expect(repaired).toHaveLength(1);
    expect(repaired[0]?.cost).toBeCloseTo(baseline, 8);
  });
});
