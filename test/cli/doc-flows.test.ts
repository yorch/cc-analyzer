import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CACHE_FORMAT_VERSION } from "../../src/core/pricing-source.ts";
import { samplePricing } from "../helpers/pricing.ts";

/**
 * The command sequences `site/install.md` tells users to run, executed.
 *
 * These exist because the two most damaging defects this feature shipped with
 * were both in the *first command of a documented flow* — `claude-dir add`
 * silently dropping the directory already in effect, then silently persisting a
 * one-invocation `--claude-dir` root. Both passed a full green suite: the unit
 * tests exercised the functions, and nothing ran the sequence a user is told to
 * type. A flow test asserts the outcome the docs promise, so the docs and the
 * behaviour cannot drift apart quietly.
 *
 * Each block below mirrors one "### I …" section of that page. If a flow here
 * changes, the page changed and one of the two is wrong.
 */

const cliPath = fileURLToPath(new URL("../../src/cli/index.ts", import.meta.url));
const fixture = fileURLToPath(new URL("../fixtures/sample-session.jsonl", import.meta.url));
const root = join(tmpdir(), `cc-analyzer-flows-${process.pid}-${Date.now()}`);

/** A Claude data dir holding one project with one session. */
function seedClaudeDir(dir: string, projectName: string, sessionName: string): void {
  mkdirSync(join(dir, "projects", projectName), { recursive: true });
  writeFileSync(
    join(dir, "projects", projectName, `${sessionName}.jsonl`),
    readFileSync(fixture, "utf8").replaceAll("sess-1", sessionName),
  );
}

/** A fresh state dir with a warm pricing cache, so no run touches the network. */
function seedStateDir(dir: string): string {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "pricing.json"),
    JSON.stringify({
      fetchedAt: Date.now(),
      formatVersion: CACHE_FORMAT_VERSION,
      table: samplePricing,
    }),
  );
  return dir;
}

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Run the CLI the way a user would, with only the environment the flow being
 * tested actually sets. Every variable is passed explicitly (undefined clears
 * it) so a flow cannot accidentally inherit configuration from another.
 */
async function cli(args: string[], env: Record<string, string | undefined>): Promise<Run> {
  const proc = Bun.spawn(["bun", cliPath, ...args], {
    env: {
      ...process.env,
      CC_ANALYZER_CLAUDE_DIR: undefined,
      CLAUDE_CONFIG_DIR: undefined,
      CC_ANALYZER_NO_UPDATE_CHECK: "1",
      CC_ANALYZER_TELEMETRY: "0",
      ...env,
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

/** Distinct project ids in the index — the thing every flow's `index` produces. */
function indexedProjects(stateDir: string): string[] {
  const db = new Database(join(stateDir, "index.db"), { readonly: true });
  try {
    const rows = db.query("SELECT DISTINCT project_id AS id FROM sessions").all() as {
      id: string;
    }[];
    return rows.map((r) => r.id).sort();
  } finally {
    db.close();
  }
}

beforeAll(() => mkdirSync(root, { recursive: true }));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("doc flow · I use the default ~/.claude", () => {
  test("`index` then `stats`, with nothing configured", async () => {
    const home = join(root, "default-home");
    const state = seedStateDir(join(root, "default-state"));
    // The default tier is `~/.claude`, so point HOME at a fixture home rather
    // than special-casing the resolver — this exercises the real default path.
    seedClaudeDir(join(home, ".claude"), "-work-app", "s1");
    const env = { HOME: home, CC_ANALYZER_STATE_DIR: state };

    const indexed = await cli(["index"], env);
    expect(indexed.code, indexed.stderr).toBe(0);
    expect(indexedProjects(state)).toHaveLength(1);

    const stats = await cli(["stats"], env);
    expect(stats.code, stats.stderr).toBe(0);
    expect(stats.stdout).toContain("1 sessions");
  });
});

describe("doc flow · I moved Claude Code's data directory", () => {
  test("CLAUDE_CONFIG_DIR alone is enough — no cc-analyzer configuration", async () => {
    const relocated = join(root, "relocated");
    const state = seedStateDir(join(root, "relocated-state"));
    seedClaudeDir(relocated, "-work-api", "s2");
    const env = { CLAUDE_CONFIG_DIR: relocated, CC_ANALYZER_STATE_DIR: state };

    const indexed = await cli(["index"], env);
    expect(indexed.code, indexed.stderr).toBe(0);
    expect(indexedProjects(state)).toHaveLength(1);

    const projects = await cli(["projects"], env);
    expect(projects.code, projects.stderr).toBe(0);
    expect(projects.stdout).toContain("1 projects");

    // The page promises this names the directory and the setting behind it.
    const which = await cli(["claude-dir"], env);
    expect(which.stdout).toContain(relocated);
    expect(which.stdout).toContain("CLAUDE_CONFIG_DIR");
  });
});

describe("doc flow · I have several Claude profiles", () => {
  test("two `claude-dir add`s then `index` yields one portfolio over both", async () => {
    const work = join(root, "profiles-work");
    const personal = join(root, "profiles-personal");
    const state = seedStateDir(join(root, "profiles-state"));
    seedClaudeDir(work, "-work-app", "w1");
    seedClaudeDir(personal, "-home-notes", "p1");
    const env = { CC_ANALYZER_STATE_DIR: state };

    // `set` first, `add` after — exactly as the page shows. Two `add`s would
    // also keep the default `~/.claude`, which is correct but not this flow.
    const first = await cli(["claude-dir", "set", work], env);
    expect(first.code, first.stderr).toBe(0);
    const second = await cli(["claude-dir", "add", personal], env);
    expect(second.code, second.stderr).toBe(0);
    // Both directories, and the docs promise the reindex reminder.
    expect(second.stdout).toContain(work);
    expect(second.stdout).toContain(personal);
    expect(second.stdout).toContain("cc-analyzer index");

    const indexed = await cli(["index"], env);
    expect(indexed.code, indexed.stderr).toBe(0);
    // "several are analyzed together as a single portfolio": both projects,
    // one index. This is what the dropped-root defect broke.
    expect(indexedProjects(state)).toHaveLength(2);

    const stats = await cli(["stats"], env);
    expect(stats.code, stats.stderr).toBe(0);
    expect(stats.stdout).toContain("2 projects");
  });

  test("adding a profile keeps the directory that was already in effect", async () => {
    // The regression that motivated this file: with nothing persisted, the
    // effective root comes from a lower tier, and the exclusive prefs tier would
    // drop it — then `index` would prune every one of its rows.
    const inherited = join(root, "keep-inherited");
    const added = join(root, "keep-added");
    const state = seedStateDir(join(root, "keep-state"));
    seedClaudeDir(inherited, "-work-inherited", "i1");
    seedClaudeDir(added, "-work-added", "a1");
    const env = { CLAUDE_CONFIG_DIR: inherited, CC_ANALYZER_STATE_DIR: state };

    expect((await cli(["index"], env)).code).toBe(0);
    expect(indexedProjects(state)).toHaveLength(1);

    expect((await cli(["claude-dir", "add", added], env)).code).toBe(0);
    const after = await cli(["index"], env);
    expect(after.code, after.stderr).toBe(0);
    // Two, not one: the inherited directory survived the add.
    expect(indexedProjects(state)).toHaveLength(2);
    expect(after.stdout).not.toContain("deleted 1");
  });

  test("two `add`s from a clean slate keep the default too — as the page warns", async () => {
    // Not a bug: `add` appends to what is in effect, and the default counts.
    // Pinned because the page explains this, and an explanation that stops
    // being true is worse than none.
    const a = join(root, "warn-a");
    const b = join(root, "warn-b");
    const home = join(root, "warn-home");
    const state = seedStateDir(join(root, "warn-state"));
    seedClaudeDir(join(home, ".claude"), "-work-default", "df1");
    seedClaudeDir(a, "-work-a", "aa1");
    seedClaudeDir(b, "-work-b", "bb1");
    const env = { HOME: home, CC_ANALYZER_STATE_DIR: state };

    await cli(["claude-dir", "add", a], env);
    await cli(["claude-dir", "add", b], env);
    expect((await cli(["index"], env)).code).toBe(0);
    expect(indexedProjects(state)).toHaveLength(3);
  });

  test("`remove` then `index` drops only that profile's sessions", async () => {
    const keep = join(root, "rm-keep");
    const drop = join(root, "rm-drop");
    const state = seedStateDir(join(root, "rm-state"));
    seedClaudeDir(keep, "-work-keep", "k1");
    seedClaudeDir(drop, "-work-drop", "d1");
    const env = { CC_ANALYZER_STATE_DIR: state };

    await cli(["claude-dir", "set", keep], env);
    await cli(["claude-dir", "add", drop], env);
    await cli(["index"], env);
    expect(indexedProjects(state)).toHaveLength(2);

    expect((await cli(["claude-dir", "remove", drop], env)).code).toBe(0);
    expect((await cli(["index"], env)).code).toBe(0);
    // "removing a directory removes its sessions from the index".
    const left = indexedProjects(state);
    expect(left).toHaveLength(1);
  });

  test("`reset` returns to the default resolution", async () => {
    const configured = join(root, "reset-configured");
    const state = seedStateDir(join(root, "reset-state"));
    seedClaudeDir(configured, "-work-cfg", "c1");
    const env = { CC_ANALYZER_STATE_DIR: state };

    await cli(["claude-dir", "set", configured], env);
    expect((await cli(["claude-dir"], env)).stdout).toContain(configured);

    const reset = await cli(["claude-dir", "reset"], env);
    expect(reset.code, reset.stderr).toBe(0);
    expect((await cli(["claude-dir"], env)).stdout).not.toContain(configured);
  });
});

describe("doc flow · I just want to peek at another directory once", () => {
  test("the flag covers exactly the four commands the page lists", async () => {
    const peek = join(root, "peek");
    const state = seedStateDir(join(root, "peek-state"));
    seedClaudeDir(peek, "-work-peek", "pk1");
    const env = { CC_ANALYZER_STATE_DIR: state };
    const flag = `--claude-dir=${peek}`;

    const projects = await cli([flag, "projects"], env);
    expect(projects.code, projects.stderr).toBe(0);
    expect(projects.stdout).toContain("1 projects");

    const sessions = await cli([flag, "sessions", "-work-peek"], env);
    expect(sessions.code, sessions.stderr).toBe(0);
    expect(sessions.stdout).toContain("1 sessions");

    for (const cmd of ["analyze", "doctor"]) {
      const r = await cli([flag, cmd, "pk1"], env);
      // Resolved and ran — not refused by the index-backed guard.
      expect(r.stderr).not.toContain("--claude-dir cannot be used with");
    }
  });

  test("a one-off peek never touches the persisted configuration", async () => {
    // The second `add` defect: a directory scoped to one command being written
    // into prefs.json permanently.
    const peek = join(root, "peek2");
    const state = seedStateDir(join(root, "peek2-state"));
    seedClaudeDir(peek, "-work-peek2", "pk2");
    const env = { CC_ANALYZER_STATE_DIR: state };

    await cli([`--claude-dir=${peek}`, "projects"], env);
    const shown = await cli(["claude-dir"], env);
    expect(shown.stdout).not.toContain(peek);
  });

  test("index-backed commands refuse the flag, pointing at the durable way", async () => {
    const peek = join(root, "peek3");
    const state = seedStateDir(join(root, "peek3-state"));
    seedClaudeDir(peek, "-work-peek3", "pk3");
    const r = await cli([`--claude-dir=${peek}`, "stats"], { CC_ANALYZER_STATE_DIR: state });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("cc-analyzer claude-dir set");
  });
});

describe("doc flow · if your portfolio looks empty", () => {
  test("`claude-dir` names the directory searched and marks it unreadable", async () => {
    const missing = join(root, "does-not-exist");
    const state = seedStateDir(join(root, "empty-state"));
    const r = await cli(["claude-dir"], {
      CLAUDE_CONFIG_DIR: missing,
      CC_ANALYZER_STATE_DIR: state,
    });
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain(missing);
    expect(r.stdout).toContain("no projects/ directory");
    expect(r.stdout).toContain("cc-analyzer claude-dir set");
  });
});
