import { afterEach, beforeEach, describe, expect, test } from "bun:test";
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
import { MAX_ALIAS_UPDATED_AT } from "../../src/core/project-aliases.ts";

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

  describe("per-computer alias files", () => {
    const gitOut = async (...args: string[]) => {
      const proc = Bun.spawn(["git", ...args], {
        cwd: archivePath,
        stdout: "pipe",
        stderr: "pipe",
      });
      return (await new Response(proc.stdout).text()).trim();
    };
    const OTHER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const ownFile = () =>
      join(archivePath, "machines", readStoredArchiveMachineId() as string, "project-aliases.json");

    test("writes only this computer's files and commits only those paths", async () => {
      // No archive run first, so machine.json is new in the alias commit.
      await keepArchiveMachine(archivePath);
      expect(await setProjectAlias("/Users/alice/project", "Shared Project")).toBe(true);
      const id = readStoredArchiveMachineId() as string;
      // The exact file list of the commit: the clean-repo precondition alone
      // would hide committing too much.
      expect((await gitOut("show", "--name-only", "--format=", "HEAD")).split("\n").sort()).toEqual(
        [`machines/${id}/machine.json`, `machines/${id}/project-aliases.json`].sort(),
      );
      expect(await gitOut("status", "--porcelain")).toBe("");
      expect(await Bun.file(join(archivePath, "project-aliases.json")).exists()).toBe(false);
      const body = JSON.parse(await readFile(ownFile(), "utf8"));
      expect(body.version).toBe(2);
      expect(body.aliases["/Users/alice/project"]).toMatchObject({ label: "Shared Project" });
    });

    test("removing writes a tombstone; removing nothing is a no-op", async () => {
      await archiveSessions([sourceRoot]);
      expect(await setProjectAlias("/Users/alice/none", undefined)).toBe(false);
      await setProjectAlias("/Users/alice/project", "Shared Project");
      expect(await setProjectAlias("/Users/alice/project", undefined)).toBe(true);
      const body = JSON.parse(await readFile(ownFile(), "utf8"));
      expect(body.aliases["/Users/alice/project"]).toMatchObject({ removed: true });
      expect(await listProjectAliases()).toEqual([]);
      expect(await setProjectAlias("/Users/alice/project", undefined)).toBe(false);
    });

    test("an unchanged set makes no commit", async () => {
      await archiveSessions([sourceRoot]);
      await setProjectAlias("/Users/alice/project", "Shared Project");
      const head = await gitOut("rev-parse", "HEAD");
      expect(await setProjectAlias("/Users/alice/project", "Shared Project")).toBe(false);
      expect(await gitOut("rev-parse", "HEAD")).toBe(head);
    });

    test("removing a legacy-only alias tombstones it in this computer's file", async () => {
      await archiveSessions([sourceRoot]);
      await writeFile(
        join(archivePath, "project-aliases.json"),
        '{"version":1,"aliases":{"/Users/alice/legacy":"Legacy"}}\n',
      );
      await gitOut("add", "project-aliases.json");
      await gitOut("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "legacy");
      expect(await listProjectAliases()).toEqual([["/Users/alice/legacy", "Legacy"]]);
      expect(await setProjectAlias("/Users/alice/legacy", undefined)).toBe(true);
      expect(await listProjectAliases()).toEqual([]);
      // The legacy file is never rewritten.
      expect(await readFile(join(archivePath, "project-aliases.json"), "utf8")).toContain("Legacy");
    });

    test("an edit beats another computer's far-future timestamp (skew-proof)", async () => {
      await archiveSessions([sourceRoot]);
      const future = Date.now() + 10 * 365 * 24 * 3600 * 1000;
      const file = join(archivePath, "machines", OTHER, "project-aliases.json");
      await mkdir(join(archivePath, "machines", OTHER), { recursive: true });
      await writeFile(
        file,
        JSON.stringify({
          version: 2,
          aliases: { "/Users/alice/project": { label: "Remote", updatedAt: future } },
        }),
      );
      await gitOut("add", "machines");
      await gitOut("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "other");
      expect(await setProjectAlias("/Users/alice/project", "Mine")).toBe(true);
      expect(await listProjectAliases()).toEqual([["/Users/alice/project", "Mine"]]);
      const body = JSON.parse(await readFile(ownFile(), "utf8"));
      expect(body.aliases["/Users/alice/project"].updatedAt).toBe(future + 1);
      // And removal of another computer's alias wins the same way.
      expect(await setProjectAlias("/Users/alice/project", undefined)).toBe(true);
      expect(await listProjectAliases()).toEqual([]);
    });

    const commitAs = async (message: string) => {
      await gitOut("add", "-A");
      await gitOut("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", message);
    };
    const writeOther = async (entry: unknown) => {
      await mkdir(join(archivePath, "machines", OTHER), { recursive: true });
      await writeFile(
        join(archivePath, "machines", OTHER, "project-aliases.json"),
        JSON.stringify({ version: 2, aliases: { "/Users/alice/project": entry } }),
      );
      await commitAs("other");
    };

    test("refuses to stamp above the ceiling and leaves the repository untouched", async () => {
      await archiveSessions([sourceRoot]);
      await writeOther({ label: "Poison", updatedAt: MAX_ALIAS_UPDATED_AT });
      const head = await gitOut("rev-parse", "HEAD");
      const err = await setProjectAlias("/Users/alice/project", "Mine").catch((e) => e as Error);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain(`machines/${OTHER}/project-aliases.json`);
      expect((err as Error).message).toContain("commit");
      expect(await gitOut("rev-parse", "HEAD")).toBe(head);
      expect(await gitOut("status", "--porcelain")).toBe("");
      expect(await Bun.file(ownFile()).exists()).toBe(false);
      // The poisoned archive is still readable (exactly-ceiling is valid).
      expect(await listProjectAliases()).toEqual([["/Users/alice/project", "Poison"]]);
    });

    test("alias set records and commits machine.json even without an archive run", async () => {
      const kept = await keepArchiveMachine(archivePath);
      expect(kept.source).toBe("local");
      expect(await setProjectAlias("/Users/alice/project", "Shared")).toBe(true);
      const id = readStoredArchiveMachineId() as string;
      const record = JSON.parse(
        await readFile(join(archivePath, "machines", id, "machine.json"), "utf8"),
      );
      expect(record.hostnames).toEqual([hostname()]);
      expect(await gitOut("status", "--porcelain")).toBe("");
      expect(await gitOut("ls-files", `machines/${id}/machine.json`)).toBe(
        `machines/${id}/machine.json`,
      );
      // A second computer cannot adopt this live computer's id.
      await expect(adoptArchiveMachine(id, archivePath, { host: "other-host" })).rejects.toThrow(
        "records hostnames",
      );
    });

    test("a failed edit on a fresh path leaves no repository behind", async () => {
      const fresh = join(temp, "fresh-archive");
      setArchivePath(fresh);
      await expect(setProjectAlias("/Users/alice/project", "X")).rejects.toThrow("archive machine");
      expect(await stat(fresh).catch(() => null)).toBeNull();
    });

    test("without a recorded identity an edit explains how to get one", async () => {
      await archiveSessions([sourceRoot]);
      await rm(join(temp, "state"), { recursive: true, force: true });
      setArchivePath(archivePath);
      expect(readStoredArchiveMachineId()).toBeUndefined();
      await expect(setProjectAlias("/Users/alice/project", "X")).rejects.toThrow(
        "archive machine adopt",
      );
      expect(await gitOut("status", "--porcelain")).toBe("");
    });
  });

  test("lists every machine's archive roots, this computer's own included", async () => {
    // Suppressing a backup copy of a live session is per session (see
    // `dedupeSessions`), never per root: a root-level skip hid sessions whenever
    // the live tree was emptied or incomplete.
    const result = await archiveSessions([sourceRoot]);
    const roots = await listArchiveRoots(archivePath);
    expect(roots.map((r) => r.slug)).toEqual([`archive-${result.machine?.id}-${sourceRoot.slug}`]);
    expect(roots.every((r) => r.source === "archive")).toBe(true);
    await rm(sourceRoot.path, { recursive: true, force: true });
    expect(await listArchiveRoots(archivePath)).toHaveLength(1);
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

  test("A ordering: a read path first persists nothing, and a lost id changes no row", async () => {
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
    const first = await archiveSessions([sourceRoot]);
    const db = openDb(":memory:");
    await reindex(db, { pricing: samplePricing, roots: [sourceRoot] });
    const before = db.query("SELECT SUM(turns) AS t FROM sessions").get() as { t: number };
    await rm(join(temp, "state", "archive-machine-id"));
    // The read path that used to mint silently (index --check, TUI, serve, ...).
    await inspectIndexStatus(db, Date.now(), [sourceRoot]);
    await inspectIndexStatus(db, Date.now(), [sourceRoot]);
    expect(readStoredArchiveMachineId()).toBeUndefined();
    // Test 6: a plain index with the id lost used to add the machine's own
    // archive as a second row (2 rows / twice the turns). Identity no longer
    // takes part in which copy is shown.
    await reindex(db, { pricing: samplePricing, roots: [sourceRoot] });
    const lost = db.query("SELECT COUNT(*) AS n, SUM(turns) AS t FROM sessions").get() as {
      n: number;
      t: number;
    };
    expect(lost).toEqual({ n: 1, t: before.t });
    expect(before.t).toBeGreaterThan(0);
    // Adopting changes nothing the index shows.
    await adoptArchiveMachine(first.machine?.id as string, archivePath);
    await reindex(db, { pricing: samplePricing, roots: [sourceRoot] });
    const fixed = db.query("SELECT COUNT(*) AS n, SUM(turns) AS t FROM sessions").get() as {
      n: number;
      t: number;
    };
    expect(fixed).toEqual({ n: 1, t: before.t });
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
    const roots = await listArchiveRoots(archivePath);
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
    await adoptArchiveMachine(id.toUpperCase(), archivePath);
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
    expect(adopt.out).not.toContain("rebuild");
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
    expect(await listArchiveRoots(archivePath)).toBeDefined();
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
    const discovered = await listArchiveRoots(archivePath);
    expect(discovered.map((r) => r.slug)).toEqual([`archive-${id}-${sourceRoot.slug}`]);
    const db = openDb(":memory:");
    await reindex(db, { pricing: samplePricing, roots: [sourceRoot] });
    // Never the legacy directory; and the live copy shadows the real machine's archive.
    expect((await rows(db)).map((r) => r.path)).toEqual([sessionPath]);
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

  test("2: a lost identity changes nothing index --check or index print; archive machine still says so", async () => {
    await realSession();
    const a = await archiveSessions([sourceRoot]);
    const id = a.machine?.id as string;
    expect((await cli("index")).code).toBe(0);
    await rm(join(temp, "state", "archive-machine-id"));
    // The old warning claimed sessions "are counted twice"; they are not, so
    // read surfaces say nothing and the index is simply current.
    const check = await cli("index", "--check");
    expect(check.code).toBe(0);
    expect(check.err).toBe("");
    expect(check.out).toContain("Index is current (0 changes)");
    const idx = await cli("index");
    expect(idx.err).toBe("");
    expect(idx.out).toContain("Indexed 0, skipped 1, deleted 0 (1 sessions)");
    // Identity-aware commands still explain it.
    const machine = await cli("archive", "machine");
    expect(machine.err).toContain("warning: this computer has no recorded identity");
    expect(machine.err).toContain(`archive machine adopt ${id}`);
    expect(machine.err).not.toContain("counted twice");
  }, 60_000);

  test("2b: archive-during-index that the identity refuses is reported, and indexing still runs", async () => {
    const { reindex } = await import("../../src/core/indexer.ts");
    const { openDb } = await import("../../src/core/db.ts");
    const { samplePricing } = await import("../helpers/pricing.ts");
    await realSession();
    await archiveSessions([sourceRoot]);
    await rm(join(temp, "state", "archive-machine-id"));
    const db = openDb(":memory:");
    const skipped = await reindex(db, {
      pricing: samplePricing,
      roots: [sourceRoot],
      archive: true,
    });
    expect(skipped.archiveSkipped).toContain("archive machine adopt");
    expect(skipped.total).toBe(1);
    const plain = await reindex(db, { pricing: samplePricing, roots: [sourceRoot] });
    expect(plain.archiveSkipped).toBeUndefined();
    // A genuinely first run archives under the id it persists and reports no skip.
    await rm(archivePath, { recursive: true, force: true });
    await rm(join(temp, "state", "archive-machine-id"), { force: true });
    const first = await reindex(db, { pricing: samplePricing, roots: [sourceRoot], archive: true });
    expect(first.archiveSkipped).toBeUndefined();
    expect(readStoredArchiveMachineId()).toBeDefined();
  });

  test("3: adopting hides nothing, even sessions this computer never had", async () => {
    // Two computers, same hostname and same ~/.claude path hash: the archive
    // holds a session this computer's live root lacks. Adoption used to refuse
    // (and, forced, delete that session's row); suppression is per session now.
    const { reindex } = await import("../../src/core/indexer.ts");
    const { openDb } = await import("../../src/core/db.ts");
    const { samplePricing } = await import("../helpers/pricing.ts");
    await realSession();
    const a = await archiveSessions([sourceRoot]);
    const id = a.machine?.id as string;
    const projects = join(archivePath, "machines", id, "roots", sourceRoot.slug, "projects");
    const otherPath = join(projects, "-Users-test-project", "other-computer.jsonl");
    await Bun.write(otherPath, await Bun.file(fixture).text());
    await rm(join(temp, "state", "archive-machine-id"));
    await adoptArchiveMachine(id, archivePath);
    expect(readStoredArchiveMachineId()).toBe(id);
    const db = openDb(":memory:");
    await reindex(db, { pricing: samplePricing, roots: [sourceRoot] });
    expect((await rows(db)).map((r) => r.path)).toEqual([otherPath, sessionPath].sort());
  });

  test("4: keep needs --force when a candidate records this host, and names the consequence", async () => {
    const a = await archiveSessions([sourceRoot]);
    await rm(join(temp, "state", "archive-machine-id"));
    await expect(keepArchiveMachine(archivePath)).rejects.toThrow("archived a second time");
    expect(readStoredArchiveMachineId()).toBeUndefined();
    const kept = await keepArchiveMachine(archivePath, { force: true });
    expect(kept.passedOver.map((m) => m.id)).toEqual([a.machine?.id as string]);
    // A candidate for another host needs no force.
    await rm(join(temp, "state", "archive-machine-id"));
    expect((await keepArchiveMachine(archivePath, { host: "elsewhere" })).passedOver).toHaveLength(
      1,
    );
  });

  test("4/5: CLI keep restates the candidates and the consequence, and needs no rebuild", async () => {
    await realSession();
    const a = await archiveSessions([sourceRoot]);
    await rm(join(temp, "state", "archive-machine-id"));
    const refused = await cli("archive", "machine", "keep");
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("--force");
    const kept = await cli("archive", "machine", "keep", "--force");
    expect(kept.code).toBe(0);
    expect(kept.out).toContain(a.machine?.id as string);
    expect(kept.out).toContain("archived a second time");
    expect(kept.out).not.toContain("rebuild");
    expect((await cli("index")).code).toBe(0);
    const check = await cli("index", "--check");
    expect(check.code).toBe(0);
    expect(check.out).not.toContain("rebuild");
  }, 90_000);

  test("5: lost id, then adopt, then plain index: correct cost with no rebuild", async () => {
    const { reindex } = await import("../../src/core/indexer.ts");
    const { openDb } = await import("../../src/core/db.ts");
    const { samplePricing } = await import("../helpers/pricing.ts");
    await realSession();
    const first = await archiveSessions([sourceRoot]);
    // Grow the live file so the archive copy carries the OLDER mtime. Before
    // the change that copy was analyzed (and claimed the usage) first, left the
    // live row at $0 once adoption pruned the duplicate, and needed --rebuild.
    await new Promise((r) => setTimeout(r, 20));
    await writeFile(sessionPath, `${await readFile(sessionPath, "utf8")}{"type":"summary"}\n`);
    const healthy = openDb(":memory:");
    await reindex(healthy, { pricing: samplePricing, roots: [sourceRoot] });
    const baseline = (await rows(healthy))[0]?.cost as number;
    expect(baseline).toBeGreaterThan(0);

    await rm(join(temp, "state", "archive-machine-id"));
    const db = openDb(":memory:");
    await reindex(db, { pricing: samplePricing, roots: [sourceRoot] });
    const lost = await rows(db);
    expect(lost.map((r) => r.path)).toEqual([sessionPath]);
    expect(lost[0]?.cost).toBeCloseTo(baseline, 8);

    await adoptArchiveMachine(first.machine?.id as string, archivePath);
    await reindex(db, { pricing: samplePricing, roots: [sourceRoot] });
    const plain = await rows(db);
    expect(plain.map((r) => r.path)).toEqual([sessionPath]);
    expect(plain[0]?.cost).toBeCloseTo(baseline, 8);
  });
});
