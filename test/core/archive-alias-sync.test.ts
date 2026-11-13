import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { listProjectAliases, setProjectAlias } from "../../src/core/archive.ts";
import { setArchiveMachineId, setArchivePath } from "../../src/core/prefs.ts";
import { writeProjectAliases } from "../../src/core/project-aliases.ts";

const ID_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ID_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PATH = "/Users/shared/app";

let temp: string;
let previousStateDir: string | undefined;

async function git(cwd: string, ...args: string[]) {
  const proc = Bun.spawn(
    ["git", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args],
    { cwd, stdout: "pipe", stderr: "pipe" },
  );
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { out: out.trim(), err: err.trim(), code };
}

/** Run `fn` as one computer: its own state dir, identity, and clone. */
async function as<T>(computer: { state: string; clone: string }, fn: () => Promise<T>): Promise<T> {
  process.env.CC_ANALYZER_STATE_DIR = computer.state;
  setArchivePath(computer.clone);
  return fn();
}

async function makeComputer(bare: string, name: string, id: string) {
  const clone = join(temp, name);
  const state = join(temp, `${name}-state`);
  expect((await git(temp, "clone", "-q", bare, clone)).code).toBe(0);
  const computer = { state, clone };
  await as(computer, async () => setArchiveMachineId(id));
  await mkdir(join(clone, "machines", id), { recursive: true });
  await writeFile(
    join(clone, "machines", id, "machine.json"),
    JSON.stringify({ version: 1, id, label: name, hostnames: [name] }),
  );
  await git(clone, "add", "machines");
  await git(clone, "commit", "-qm", `machine ${name}`);
  return computer;
}

beforeEach(async () => {
  previousStateDir = process.env.CC_ANALYZER_STATE_DIR;
  temp = await mkdtemp(join("/tmp", `cc-analyzer-alias-sync-${process.pid}-`));
});

afterEach(async () => {
  if (previousStateDir === undefined) delete process.env.CC_ANALYZER_STATE_DIR;
  else process.env.CC_ANALYZER_STATE_DIR = previousStateDir;
  await rm(temp, { recursive: true, force: true });
});

describe("alias edits on two computers merge without Git conflicts", () => {
  test("conflicting labels for one path merge cleanly and both clones agree", async () => {
    const bare = join(temp, "origin.git");
    expect((await git(temp, "init", "-q", "--bare", "-b", "main", bare)).code).toBe(0);
    // Seed the bare repo so both clones start from the same commit.
    const seed = join(temp, "seed");
    await git(temp, "clone", "-q", bare, seed);
    await git(seed, "checkout", "-q", "-b", "main");
    await writeFile(join(seed, "README"), "archive\n");
    await git(seed, "add", ".");
    await git(seed, "commit", "-qm", "seed");
    expect((await git(seed, "push", "-q", "origin", "main")).code).toBe(0);

    const a = await makeComputer(bare, "a", ID_A);
    const b = await makeComputer(bare, "b", ID_B);

    // Both edit the SAME path with different labels, plus one distinct path each.
    await as(a, async () => {
      await setProjectAlias(PATH, "Label from A");
      await setProjectAlias("/Users/alice/only-a", "Only A");
    });
    await as(b, async () => {
      await setProjectAlias(PATH, "Label from B");
      await setProjectAlias("/Users/bob/only-b", "Only B");
    });

    expect((await git(a.clone, "push", "-q", "origin", "HEAD:main")).code).toBe(0);
    await git(b.clone, "fetch", "-q", "origin");
    const merge = await git(b.clone, "merge", "--no-edit", "origin/main");
    expect(merge.code).toBe(0);
    expect(merge.out + merge.err).not.toContain("CONFLICT");
    expect((await git(b.clone, "push", "-q", "origin", "HEAD:main")).code).toBe(0);
    await git(a.clone, "pull", "-q", "--no-rebase", "--no-edit", "origin", "main");

    const fromA = await as(a, () => listProjectAliases());
    const fromB = await as(b, () => listProjectAliases());
    expect(fromA).toEqual(fromB);
    expect(fromA.map(([p]) => p).sort()).toEqual(
      [PATH, "/Users/alice/only-a", "/Users/bob/only-b"].sort(),
    );
    // B edited the shared path last (and ties/clock skew resolve identically on both).
    expect(Object.fromEntries(fromA)[PATH]).toBe("Label from B");

    // B removes an alias A created; the tombstone survives a further merge.
    await as(b, async () => {
      expect(await setProjectAlias("/Users/alice/only-a", undefined)).toBe(true);
    });
    await git(b.clone, "push", "-q", "origin", "HEAD:main");
    await git(a.clone, "pull", "-q", "--no-rebase", "--no-edit", "origin", "main");
    const afterRemove = await as(a, () => listProjectAliases());
    expect(afterRemove.map(([p]) => p)).not.toContain("/Users/alice/only-a");
  });

  test("the old single shared file DOES conflict in the same scenario", async () => {
    const bare = join(temp, "origin.git");
    await git(temp, "init", "-q", "--bare", "-b", "main", bare);
    const seed = join(temp, "seed");
    await git(temp, "clone", "-q", bare, seed);
    await git(seed, "checkout", "-q", "-b", "main");
    await writeFile(join(seed, "README"), "archive\n");
    await git(seed, "add", ".");
    await git(seed, "commit", "-qm", "seed");
    await git(seed, "push", "-q", "origin", "main");
    const one = join(temp, "one");
    const two = join(temp, "two");
    await git(temp, "clone", "-q", bare, one);
    await git(temp, "clone", "-q", bare, two);
    await writeProjectAliases(new Map([[PATH, "Label from one"]]), one);
    await writeProjectAliases(new Map([[PATH, "Label from two"]]), two);
    for (const dir of [one, two]) {
      await git(dir, "add", ".");
      await git(dir, "commit", "-qm", "alias");
    }
    await git(one, "push", "-q", "origin", "HEAD:main");
    await git(two, "fetch", "-q", "origin");
    const merge = await git(two, "merge", "--no-edit", "origin/main");
    expect(merge.code).not.toBe(0);
    expect(merge.out + merge.err).toContain("CONFLICT");
  });
});
