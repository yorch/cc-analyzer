import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { adoptArchiveMachine, archiveSessions, listArchiveRoots } from "../../src/core/archive.ts";
import { type ClaudeRoot, rootSlug } from "../../src/core/claude-roots.ts";
import { openDb } from "../../src/core/db.ts";
import {
  dedupeSessions,
  fileCoveredBy,
  findProject,
  findSessionById,
  isRedundant,
  listAllSessions,
  listProjects,
  listSessions,
  listSessionsIn,
  type SessionInfo,
  TAIL_WINDOW_BYTES,
} from "../../src/core/discover.ts";
import { archiveSkippedWarning } from "../../src/core/index-refresh.ts";
import { inspectIndexStatus } from "../../src/core/index-status.ts";
import { type ReindexResult, reindex } from "../../src/core/indexer.ts";
import {
  readStoredArchiveMachineId,
  setArchiveDuringIndex,
  setArchivePath,
} from "../../src/core/prefs.ts";
import { CACHE_FORMAT_VERSION } from "../../src/core/pricing-source.ts";
import { listIndexedProjects } from "../../src/core/queries.ts";
import { reportRefresh } from "../../src/tui/run.tsx";
import { type TempStateDir, tempStateDir } from "../helpers/claude-dir.ts";
import { samplePricing } from "../helpers/pricing.ts";

const FIXTURE = readFileSync(
  fileURLToPath(new URL("../fixtures/sample-session.jsonl", import.meta.url)),
  "utf8",
);
const PROJECT = "-Users-dev-proj";
const SESSION = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const MACHINE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MACHINE_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

let temp: string;
let state: TempStateDir;
let live: ClaudeRoot;
let repo: string;
let db: Database;

/** Fixture text whose message/request ids carry `tag`, so two sessions share no API call. */
const transcript = (tag = "x") =>
  FIXTURE.replaceAll("msg_", `msg${tag}_`).replaceAll("req-", `req${tag}-`);

/** A sidechain-only copy of the fixture's first assistant call (one subagent API call). */
const subagentLine = () =>
  `${(FIXTURE.split("\n")[1] ?? "")
    .replace('"isSidechain":false', '"isSidechain":true')
    .replace("msg_1", "msg_sub1")
    .replace("req-1", "req-sub1")}\n`;

function put(path: string, text: string, mtimeSec?: number): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  if (mtimeSec !== undefined) utimesSync(path, mtimeSec, mtimeSec);
}

const liveSession = (id = SESSION) => join(live.path, "projects", PROJECT, `${id}.jsonl`);

/** A machine's archived copy for the live root's slug, in the layout `archive run` writes. */
const archived = (machine: string, id = SESSION) =>
  join(repo, "machines", machine, "roots", live.slug, "projects", PROJECT, `${id}.jsonl`);

function recordMachine(machine: string, hostnames = [hostname()]): void {
  put(
    join(repo, "machines", machine, "machine.json"),
    `${JSON.stringify({ version: 1, id: machine, label: "m", hostnames })}\n`,
  );
}

const run = () => reindex(db, { pricing: samplePricing, roots: [live], concurrency: 2 });

const rows = () =>
  db
    .query("SELECT path, turns, api_calls AS calls, cost_total AS cost FROM sessions ORDER BY path")
    .all() as { path: string; turns: number; calls: number; cost: number }[];

/** What `--check` predicts, in the indexer's own terms. */
const predicted = async () => {
  const s = await inspectIndexStatus(db, Date.now(), [live]);
  return { indexed: s.added + s.changed, deleted: s.deleted };
};

const calls = () => rows().reduce((sum, r) => sum + r.calls, 0);
const kind = (path: string): "archive" | "live" => (path.includes("machines") ? "archive" : "live");

/**
 * The convergence contract: `--check` predicts exactly the work `index` does,
 * and a second `index` has none. Returns the first run's result.
 */
async function converge(opts: { heal?: boolean } = {}) {
  const expected = await predicted();
  const result = await run();
  expect({ indexed: result.indexed, deleted: result.deleted }).toEqual(expected);
  if (opts.heal) {
    // A file shed claims another copy needs: that copy is re-analyzed on the NEXT
    // run, and `--check` reports it as real pending work in between.
    const pending = await predicted();
    expect(pending.indexed).toBeGreaterThan(0);
    expect((await inspectIndexStatus(db, Date.now(), [live])).stale).toBe(true);
    const healed = await run();
    expect({ indexed: healed.indexed, deleted: healed.deleted }).toEqual(pending);
  }
  const again = await run();
  expect({ indexed: again.indexed, deleted: again.deleted }).toEqual({ indexed: 0, deleted: 0 });
  expect((await inspectIndexStatus(db, Date.now(), [live])).stale).toBe(false);
  return result;
}

beforeEach(() => {
  temp = mkdtempSync(join(tmpdir(), "cc-suppress-"));
  state = tempStateDir("cc-suppress-state");
  const root = join(temp, "claude");
  live = { path: root, slug: rootSlug(root), source: "default" };
  repo = join(temp, "archive");
  mkdirSync(repo, { recursive: true });
  setArchivePath(repo);
  put(liveSession(), transcript());
  db = openDb(join(state.dir, "index.db"));
});

afterEach(() => {
  db.close();
  state.cleanup();
  rmSync(temp, { recursive: true, force: true });
});

describe("suppression is per session, not per root or machine", () => {
  test("1: a live session and its own archived copy are one row, the live one", async () => {
    await archiveSessions([live]);
    expect(await listArchiveRoots()).toHaveLength(1);
    const result = await run();
    expect(result.total).toBe(1);
    expect(rows().map((r) => r.path)).toEqual([liveSession()]);
  });

  test("2 (B1): emptying live projects/ keeps the archived session, with its cost", async () => {
    await archiveSessions([live]);
    await run();
    const [before] = rows();
    expect(before?.turns).toBeGreaterThan(0);
    // A reset / manual cleanup: the directory stays, the project is gone.
    rmSync(join(live.path, "projects", PROJECT), { recursive: true });
    const expected = await predicted();
    const result = await run();
    const after = rows();
    expect(after).toHaveLength(1);
    expect(after[0]?.path).toContain("machines");
    expect(after[0]?.turns).toBe(before?.turns as number);
    // The takeover row must not be refused the calls the pruned live row had
    // claimed (it indexed at 0 calls / $0 when claims did not transfer).
    expect(after[0]?.calls).toBe(before?.calls as number);
    expect(after[0]?.cost).toBeCloseTo(before?.cost as number, 10);
    // Test 8: --check predicts exactly the work the indexer then does.
    expect(expected).toEqual({ indexed: result.indexed, deleted: result.deleted });
    expect((await inspectIndexStatus(db, Date.now(), [live])).stale).toBe(false);
  });

  test("3 (B3): live orphan subagents + archived parent shows the main chain", async () => {
    put(
      join(live.path, "projects", PROJECT, SESSION, "subagents", "agent-a.jsonl"),
      subagentLine(),
    );
    await archiveSessions([live]);
    await run();
    const [full] = rows();
    expect(full?.turns).toBeGreaterThan(0);
    // The live parent is deleted but `<id>/subagents/` stays, so the live
    // projects/ directory is still populated: root-level suppression kept
    // hiding the archive and the row collapsed to its subagent calls.
    rmSync(liveSession());
    const expected = await predicted();
    const result = await run();
    const after = rows();
    expect(after).toHaveLength(1);
    expect(after[0]?.path).toContain("machines");
    expect(after[0]?.turns).toBe(full?.turns as number);
    expect(after[0]?.calls).toBe(full?.calls as number);
    expect(after[0]?.cost).toBeCloseTo(full?.cost as number, 10);
    expect(expected).toEqual({ indexed: result.indexed, deleted: result.deleted });
  });

  test("3b: when the archived copy is an orphan too, the live orphan stays the row", async () => {
    put(
      join(live.path, "projects", PROJECT, SESSION, "subagents", "agent-a.jsonl"),
      subagentLine(),
    );
    rmSync(liveSession());
    put(
      join(
        repo,
        "machines",
        MACHINE_A,
        "roots",
        live.slug,
        "projects",
        PROJECT,
        SESSION,
        "subagents",
        "agent-a.jsonl",
      ),
      subagentLine(),
    );
    const all = await listAllSessions([live, ...(await listArchiveRoots())]);
    expect(all).toHaveLength(1);
    expect(all[0]?.root).toBe(live.path);
    expect(all[0]?.parentExists).toBe(false);
  });

  test("4 (C): a second computer sharing hostname and slug adopts the first's id and loses nothing", async () => {
    // Computer A archived its session; this computer (B) has the same hostname
    // and ~/.claude path (so the same slug) but a different session.
    recordMachine(MACHINE_A);
    put(archived(MACHINE_A), transcript("a"));
    rmSync(liveSession());
    put(liveSession(OTHER), transcript("b"));
    expect(readStoredArchiveMachineId()).toBeUndefined();
    await adoptArchiveMachine(MACHINE_A, repo);
    expect(readStoredArchiveMachineId()).toBe(MACHINE_A);
    const result = await run();
    expect(result.deleted).toBe(0);
    expect(rows().map((r) => r.path)).toEqual([archived(MACHINE_A), liveSession(OTHER)].sort());
    // And again: nothing is pruned on the next scan either.
    expect((await run()).deleted).toBe(0);
    expect(rows()).toHaveLength(2);
  });

  test("5: one session archived by two machines is one row, the newest copy", async () => {
    put(archived(MACHINE_A), transcript(), 1_700_000_000);
    put(archived(MACHINE_B), transcript(), 1_700_000_500);
    rmSync(liveSession());
    const result = await run();
    expect(result.total).toBe(1);
    expect(rows().map((r) => r.path)).toEqual([archived(MACHINE_B)]);
  });

  test("listProjects hides a project whose every session is shadowed, and recounts partial ones", async () => {
    await archiveSessions([live]);
    const id = readStoredArchiveMachineId() as string;
    put(archived(id, OTHER), transcript("o"));
    const roots = [live, ...(await listArchiveRoots())];
    // OTHER exists only in the archive, SESSION is shadowed: the archive project stays, with 1.
    expect((await listProjects(roots)).filter((p) => p.root !== live.path)).toHaveLength(1);
    expect(
      (await listProjects(roots)).filter((p) => p.root !== live.path).map((p) => p.sessionCount),
    ).toEqual([1]);
    rmSync(archived(id, OTHER));
    expect((await listProjects(roots)).filter((p) => p.root !== live.path)).toEqual([]);
  });
});

describe("--check and the indexer agree, and old duplicates heal", () => {
  test("7/8: duplicate rows from an earlier version collapse and the survivor gets its cost back", async () => {
    // Reconstruct what an identity-based version left behind: the live row at
    // $0 because the OLDER archive copy claimed every call, plus the archive row.
    await archiveSessions([live]);
    await run();
    const [good] = rows();
    expect(good?.cost).toBeGreaterThan(0);
    const archivePath = archived(readStoredArchiveMachineId() as string);
    const archiveRoot = (await listArchiveRoots())[0] as ClaudeRoot;
    db.query("CREATE TEMP TABLE dup AS SELECT * FROM sessions").run();
    db.query("UPDATE dup SET path = ?, claude_dir = ?").run(archivePath, archiveRoot.path);
    db.query("INSERT INTO sessions SELECT * FROM dup").run();
    db.query("UPDATE usage_keys SET path = ?").run(archivePath);
    db.query(
      "UPDATE sessions SET api_calls = 0, cost_total = 0, cost_input = 0, cost_output = 0, cost_cache_write = 0, cost_cache_read = 0 WHERE path = ?",
    ).run(liveSession());
    expect(rows().find((r) => r.path === liveSession())?.cost).toBe(0);

    const status = await inspectIndexStatus(db, Date.now(), [live]);
    expect(status).toMatchObject({ added: 0, changed: 1, deleted: 1, stale: true });
    const result = await run();
    expect({ indexed: result.indexed, deleted: result.deleted }).toEqual({
      indexed: 1,
      deleted: 1,
    });
    const healed = rows();
    expect(healed.map((r) => r.path)).toEqual([liveSession()]);
    expect(healed[0]?.calls).toBe(good?.calls as number);
    expect(healed[0]?.cost).toBeCloseTo(good?.cost as number, 10);
    expect((await inspectIndexStatus(db, Date.now(), [live])).stale).toBe(false);
  });
});

/** `SessionInfo` for a session as discovered on disk, built through the real lister. */
async function discover(root: string, id = SESSION): Promise<SessionInfo> {
  const dir = join(root, "projects", PROJECT);
  const found = (await listSessionsIn({ id: `${root}~x`, dir, root })).find((s) => s.id === id);
  if (!found) throw new Error(`no session ${id} under ${root}`);
  return found;
}

describe("redundancy: a copy is dropped only when another holds all of its content", () => {
  let a: string;
  let b: string;
  const file = (root: string, text: string, id = SESSION) =>
    put(join(root, "projects", PROJECT, `${id}.jsonl`), text);
  const sub = (root: string, name: string, text: string, id = SESSION) =>
    put(join(root, "projects", PROJECT, id, "subagents", name), text);
  beforeEach(() => {
    a = join(temp, "copy-a");
    b = join(temp, "copy-b");
  });

  test("a true prefix is redundant to the longer copy, never the reverse", async () => {
    file(a, transcript());
    file(b, transcript() + transcript("more"));
    expect(await isRedundant(await discover(a), await discover(b))).toBe(true);
    expect(await isRedundant(await discover(b), await discover(a))).toBe(false);
  });

  test("same size, different bytes is NOT redundant (a diverged copy)", async () => {
    file(a, transcript("one"));
    file(b, transcript("two"));
    expect(statSync(join(a, "projects", PROJECT, `${SESSION}.jsonl`)).size).toBe(
      statSync(join(b, "projects", PROJECT, `${SESSION}.jsonl`)).size,
    );
    expect(await isRedundant(await discover(a), await discover(b))).toBe(false);
  });

  test("a loser with an extra subagent file is NOT redundant; matching is by basename", async () => {
    file(a, transcript());
    sub(a, "agent-x.jsonl", subagentLine());
    file(b, transcript());
    expect(await isRedundant(await discover(a), await discover(b))).toBe(false);
    sub(b, "agent-x.jsonl", subagentLine() + subagentLine());
    expect(await isRedundant(await discover(a), await discover(b))).toBe(true);
    // A winner with MORE files than the loser does not prevent redundancy.
    sub(b, "agent-y.jsonl", subagentLine());
    expect(await isRedundant(await discover(a), await discover(b))).toBe(true);
    // A different basename is a different file.
    rmSync(join(b, "projects", PROJECT, SESSION, "subagents", "agent-x.jsonl"));
    expect(await isRedundant(await discover(a), await discover(b))).toBe(false);
  });

  test("an orphan loser needs only its subagent files; a winner's parent is a bonus", async () => {
    sub(a, "agent-x.jsonl", subagentLine());
    file(b, transcript());
    sub(b, "agent-x.jsonl", subagentLine());
    const orphan = await discover(a);
    expect(orphan.parentExists).toBe(false);
    expect(await isRedundant(orphan, await discover(b))).toBe(true);
    // ...and a loser WITH a parent is not covered by a winner that lacks one.
    expect(await isRedundant(await discover(b), orphan)).toBe(false);
  });

  test("a zero-byte loser file is redundant to anything readable", async () => {
    file(a, "");
    file(b, transcript());
    expect(await isRedundant(await discover(a), await discover(b))).toBe(true);
  });

  test("any I/O error means NOT redundant: an unreadable winner keeps both copies", async () => {
    file(a, transcript());
    file(b, transcript());
    const winner = join(b, "projects", PROJECT, `${SESSION}.jsonl`);
    chmodSync(winner, 0o000);
    try {
      expect(await isRedundant(await discover(a), await discover(b))).toBe(false);
    } finally {
      chmodSync(winner, 0o644);
    }
    expect(await fileCoveredBy(join(a, "gone.jsonl"), winner)).toBe(false);
    expect(await fileCoveredBy(winner, join(a, "gone.jsonl"))).toBe(false);
  });

  test("only the tail window is compared: a prefix of a huge file passes, a fork inside the window fails", async () => {
    const line = (n: number) => `${JSON.stringify({ n, pad: "x".repeat(80) })}\n`;
    const lines = Array.from({ length: 4000 }, (_, i) => line(i));
    const big = lines.join("");
    expect(big.length).toBeGreaterThan(TAIL_WINDOW_BYTES * 4);
    file(b, big);
    file(a, lines.slice(0, 3000).join(""));
    expect(await isRedundant(await discover(a), await discover(b))).toBe(true);
    // Forked a few lines before the loser's end: its tail window differs from the winner's.
    file(a, lines.slice(0, 2990).join("") + line(99999) + lines.slice(2991, 3000).join(""));
    expect(await isRedundant(await discover(a), await discover(b))).toBe(false);
  });
});

describe("dedupeSessions", () => {
  const info = (over: Partial<SessionInfo> & { root: string }): SessionInfo => ({
    id: SESSION,
    projectId: "x",
    path: join(over.root, "projects", PROJECT, `${over.id ?? SESSION}.jsonl`),
    sizeBytes: 10,
    mtimeMs: 1,
    subagentPaths: [],
    agentMeta: new Map(),
    parentExists: true,
    ...over,
  });
  const arch = (path: string): ClaudeRoot => ({ path, slug: `archive-${path}`, source: "archive" });
  const roots: ClaudeRoot[] = [
    { path: "/live", slug: "l", source: "default" },
    { path: "/live2", slug: "l2", source: "default" },
    arch("/a"),
    arch("/b"),
  ];
  const always = async () => true;
  const never = async () => false;

  test("nothing to dedupe without archive roots, and no I/O without an archive copy", async () => {
    const sessions = [info({ root: "/live" }), info({ root: "/live2" })];
    const boom = async () => {
      throw new Error("must not be consulted");
    };
    expect(
      (await dedupeSessions(sessions, [roots[0] as ClaudeRoot], new Set(), boom)).sessions,
    ).toEqual(sessions);
    expect((await dedupeSessions(sessions, roots, new Set(), boom)).sessions).toEqual(sessions);
  });

  test("two non-archive copies are never dropped against each other, whatever the check says", async () => {
    const l1 = info({ root: "/live", sizeBytes: 1 });
    const l2 = info({ root: "/live2", sizeBytes: 9 });
    const a = info({ root: "/a", sizeBytes: 9 });
    const { sessions } = await dedupeSessions([l1, l2, a], roots, new Set(), always);
    // The archive is dropped (redundant to a live copy); both live copies stay.
    expect(sessions).toEqual([l1, l2]);
  });

  test("everything redundant collapses onto the most preferred copy, which is deterministic", async () => {
    const a = info({ root: "/a", mtimeMs: 5 });
    const b = info({ root: "/b", mtimeMs: 5 });
    expect((await dedupeSessions([b, a], roots, new Set(), always)).sessions).toEqual([a]);
    expect((await dedupeSessions([a, b], roots, new Set(), always)).sessions).toEqual([a]);
    const newer = info({ root: "/b", mtimeMs: 9 });
    expect((await dedupeSessions([a, newer], roots, new Set(), always)).sessions).toEqual([newer]);
    const live = info({ root: "/live", mtimeMs: 0 });
    expect((await dedupeSessions([a, live], roots, new Set(), always)).sessions).toEqual([live]);
    const bigger = info({ root: "/b", sizeBytes: 99 });
    expect((await dedupeSessions([a, bigger], roots, new Set(), always)).sessions).toEqual([
      bigger,
    ]);
  });

  test("nothing redundant keeps every copy (hiding beats nothing)", async () => {
    const copies = [info({ root: "/live" }), info({ root: "/a" }), info({ root: "/b" })];
    expect((await dedupeSessions(copies, roots, new Set(), never)).sessions).toEqual(copies);
  });

  test("a copy with its parent is preferred over an orphan, and the orphan reports who covers it", async () => {
    const orphan = info({ root: "/live", parentExists: false, sizeBytes: 99 });
    const full = info({ root: "/a" });
    const { sessions, shadowed } = await dedupeSessions([orphan, full], roots, new Set(), always);
    expect(sessions).toEqual([full]);
    expect(shadowed.get(orphan.path)).toEqual([full.path]);
  });

  test("the same id in a different project directory is a different session", async () => {
    const a = info({ root: "/live" });
    const b = info({ root: "/a", path: "/a/projects/-Users-other/s.jsonl" });
    expect((await dedupeSessions([a, b], roots, new Set(), always)).sessions).toEqual([a, b]);
  });

  test("a retained live key hides every archived copy without inspecting any file", async () => {
    const a = info({ root: "/a" });
    const key = `${PROJECT}\0${SESSION}`;
    const boom = async () => {
      throw new Error("must not be consulted");
    };
    const { sessions, shadowed } = await dedupeSessions([a], roots, new Set([key]), boom);
    expect(sessions).toEqual([]);
    expect(shadowed.get(a.path)).toEqual([]);
  });
});

/** Id of the machine this test's computer archived under (after an `archiveSessions`). */
const me = () => readStoredArchiveMachineId() as string;
const total = () => rows().reduce((sum, r) => sum + r.cost, 0);
const OTHER2 = "33333333-3333-4333-8333-333333333333";

describe("archive-during-index refusals are reported by every indexing surface", () => {
  const skipped = { archiveSkipped: "no identity: run `archive machine adopt`" } as ReindexResult;

  test("1a: archiveSkippedWarning is silent unless the archive step was refused", () => {
    expect(archiveSkippedWarning(undefined)).toBeUndefined();
    expect(archiveSkippedWarning({} as ReindexResult)).toBeUndefined();
    expect(archiveSkippedWarning(skipped)).toBe(
      "warning: no identity: run `archive machine adopt`",
    );
  });

  test("1b: the TUI startup report prints the refusal", () => {
    const lines: string[] = [];
    reportRefresh({ ...skipped, indexed: 2 } as ReindexResult, (m) => lines.push(m));
    expect(lines).toEqual([
      "Indexed 2 Claude Code sessions.",
      "warning: no identity: run `archive machine adopt`",
    ]);
    const quiet: string[] = [];
    reportRefresh(undefined, (m) => quiet.push(m));
    expect(quiet).toEqual([]);
  });

  test("1c: `serve --refresh` prints the refusal (real call site)", async () => {
    await archiveSessions([live]);
    rmSync(join(state.dir, "archive-machine-id"));
    setArchiveDuringIndex(true);
    writeFileSync(
      join(state.dir, "pricing.json"),
      JSON.stringify({
        fetchedAt: Date.now(),
        formatVersion: CACHE_FORMAT_VERSION,
        table: samplePricing,
      }),
    );
    const cli = fileURLToPath(new URL("../../src/cli/index.ts", import.meta.url));
    const probe = Bun.serve({ port: 0, fetch: () => new Response("") });
    const port = probe.port;
    probe.stop(true);
    const proc = Bun.spawn(["bun", cli, "serve", "--refresh", `--port=${port}`], {
      env: {
        ...process.env,
        CC_ANALYZER_CLAUDE_DIR: live.path,
        CC_ANALYZER_STATE_DIR: state.dir,
        CC_ANALYZER_NO_UPDATE_CHECK: "1",
        CC_ANALYZER_TELEMETRY: "0",
      },
      stdout: "ignore",
      stderr: "pipe",
    });
    let err = "";
    const decoder = new TextDecoder();
    const timer = setTimeout(() => proc.kill(), 30_000);
    try {
      for await (const chunk of proc.stderr) {
        err += decoder.decode(chunk);
        if (err.includes("warning:")) break;
      }
    } finally {
      clearTimeout(timer);
      proc.kill();
    }
    expect(err).toContain("warning:");
    expect(err).toContain("archive machine adopt");
  }, 60_000);
});

describe("a surviving copy is re-analyzed when the competing row is pruned", () => {
  test("U1: a duplicate row held the claims, then the live file is deleted", async () => {
    await archiveSessions([live]);
    await run();
    const [good] = rows();
    const archivePath = archived(me());
    const archiveRoot = (await listArchiveRoots())[0] as ClaudeRoot;
    // What an earlier build left: both rows exist, the live row owns the
    // claims, and the archive row was refused every call ($0).
    db.query("CREATE TEMP TABLE dup AS SELECT * FROM sessions").run();
    const st = statSync(archivePath);
    db.query(
      "UPDATE dup SET path = ?, claude_dir = ?, mtime_ms = ?, size_bytes = ?, api_calls = 0, cost_total = 0, cost_input = 0, cost_output = 0, cost_cache_write = 0, cost_cache_read = 0",
    ).run(archivePath, archiveRoot.path, st.mtimeMs, st.size);
    db.query("INSERT INTO sessions SELECT * FROM dup").run();
    // The live file is cleaned up by Claude Code: the live row is pruned, the
    // archive row's (size, mtime) are unchanged.
    rmSync(liveSession());
    const expected = await predicted();
    expect(expected).toEqual({ indexed: 1, deleted: 1 });
    const result = await run();
    expect({ indexed: result.indexed, deleted: result.deleted }).toEqual(expected);
    const after = rows();
    expect(after.map((r) => r.path)).toEqual([archivePath]);
    expect(after[0]?.calls).toBe(good?.calls as number);
    expect(after[0]?.cost).toBeCloseTo(good?.cost as number, 10);
    expect((await inspectIndexStatus(db, Date.now(), [live])).stale).toBe(false);
  });

  test("U3: the live root goes away, then is de-configured: the archived copy keeps its cost", async () => {
    await run();
    const truth = total();
    await archiveSessions([live]);
    renameSync(live.path, `${live.path}.off`);
    await run();
    // De-configure the dead root: the retained live row is pruned and the
    // archive row appears; it must not be refused the calls the live row held.
    const result = await reindex(db, { pricing: samplePricing, roots: [], concurrency: 2 });
    expect(result.deleted).toBe(1);
    expect(rows().map((r) => r.path)).toEqual([archived(me())]);
    expect(total()).toBeCloseTo(truth, 10);
  });
});

describe("an unreadable live root keeps shadowing its own backups", () => {
  test("5a: unmounted live root: one row, rebuild does not double the cost", async () => {
    await archiveSessions([live]);
    await run();
    const before = total();
    renameSync(live.path, `${live.path}.gone`);
    expect(await predicted()).toEqual({ indexed: 0, deleted: 0 });
    await run();
    expect(rows().map((r) => r.path)).toEqual([liveSession()]);
    await reindex(db, { pricing: samplePricing, roots: [live], concurrency: 2, rebuild: true });
    expect(rows()).toHaveLength(1);
    expect(total()).toBeCloseTo(before, 10);
  });

  test("5b: a live projects/ that stats but cannot be listed behaves the same", async () => {
    await archiveSessions([live]);
    await run();
    const before = total();
    const projectsDir = join(live.path, "projects");
    chmodSync(projectsDir, 0o000);
    try {
      expect(await predicted()).toEqual({ indexed: 0, deleted: 0 });
      await reindex(db, { pricing: samplePricing, roots: [live], concurrency: 2, rebuild: true });
      expect(rows()).toHaveLength(1);
      expect(total()).toBeCloseTo(before, 10);
    } finally {
      chmodSync(projectsDir, 0o755);
    }
  });
});

describe("copies are ranked by data, not by 'live wins' or mtime", () => {
  test("6a: a truncated live file does not shadow a complete archive, in either direction", async () => {
    await archiveSessions([live]);
    await run();
    const good = total();
    expect(rows().map((r) => r.path)).toEqual([liveSession()]);
    // Live is truncated: the archive is the complete copy and takes the row over.
    put(liveSession(), "");
    const expected = await predicted();
    const result = await run();
    expect({ indexed: result.indexed, deleted: result.deleted }).toEqual(expected);
    expect(rows().map((r) => r.path)).toEqual([archived(me())]);
    expect(total()).toBeCloseTo(good, 10);
    // And back: live is restored to at least the archive's size, so live wins again.
    put(liveSession(), transcript());
    const back = await predicted();
    const result2 = await run();
    expect({ indexed: result2.indexed, deleted: result2.deleted }).toEqual(back);
    expect(rows().map((r) => r.path)).toEqual([liveSession()]);
    expect(total()).toBeCloseTo(good, 10);
    expect((await inspectIndexStatus(db, Date.now(), [live])).stale).toBe(false);
  });

  test("6b: a live parent whose subagents/ were deleted does not hide the archived subagent spend", async () => {
    const sub = join(live.path, "projects", PROJECT, SESSION, "subagents");
    put(join(sub, "agent-a.jsonl"), subagentLine());
    await archiveSessions([live]);
    await run();
    const [full] = rows();
    rmSync(join(live.path, "projects", PROJECT, SESSION), { recursive: true });
    await run();
    const [after] = rows();
    expect(after?.path).toContain("machines");
    expect(after?.calls).toBe(full?.calls as number);
    expect(after?.cost).toBeCloseTo(full?.cost as number, 10);
  });

  test("6c: a session continued on two computers keeps BOTH copies and loses no call", async () => {
    // Shared history, then this computer and machine A each appended their own
    // turns. Neither copy contains the other, so neither may be hidden: the
    // ledger single-counts the shared base (3 calls) on top of both tails.
    const base = transcript("base");
    put(liveSession(), base + transcript("liveTail"));
    put(archived(MACHINE_A), base + transcript("aTail1") + transcript("aTail2"));
    await converge();
    expect(rows().map((r) => kind(r.path))).toEqual(["archive", "live"]);
    expect(calls()).toBe(12);
    // `analyze <id>` opens this computer's own copy.
    const roots = [live, ...(await listArchiveRoots())];
    expect((await findSessionById(SESSION, roots))?.root).toBe(live.path);
  });

  test("6d: live equal to its backup still wins (the common case)", async () => {
    await archiveSessions([live]);
    // Equal size, backup newer: size ties, so live beats archive before mtime is consulted.
    utimesSync(archived(me()), 4_000_000_000, 4_000_000_000);
    await run();
    expect(rows().map((r) => r.path)).toEqual([liveSession()]);
  });

  test("6e: archive vs archive prefers the larger copy even when the smaller is newer", async () => {
    put(archived(MACHINE_A), transcript() + transcript("more"), 1_700_000_000);
    put(archived(MACHINE_B), transcript(), 1_700_000_900);
    rmSync(liveSession());
    await run();
    expect(rows().map((r) => r.path)).toEqual([archived(MACHINE_A)]);
  });
});

describe("project and session lookups agree with the dedupe", () => {
  test("3: an id opens the live copy even when the archive project has more sessions", async () => {
    await archiveSessions([live]);
    put(archived(me(), OTHER), transcript("o"));
    put(archived(me(), OTHER2), transcript("p"));
    put(liveSession(), transcript() + transcript("grow"));
    const roots = [live, ...(await listArchiveRoots())];
    const found = await findSessionById(SESSION, roots);
    expect(found?.root).toBe(live.path);
    await run();
    expect(rows().find((r) => r.path.includes(SESSION))?.path).toBe(found?.path as string);
  });

  test("3b: an id opens the archive when the live copy is truncated, like the indexer", async () => {
    await archiveSessions([live]);
    put(liveSession(), "");
    const roots = [live, ...(await listArchiveRoots())];
    const found = await findSessionById(SESSION, roots);
    expect(found?.path).toBe(archived(me()));
    await run();
    expect(rows().map((r) => r.path)).toEqual([archived(me())]);
  });

  test("4: an archive project whose surviving sessions are all orphans stays listed", async () => {
    put(
      join(
        repo,
        "machines",
        MACHINE_A,
        "roots",
        "other",
        "projects",
        "-Users-x-y",
        SESSION,
        "subagents",
        "agent-a.jsonl",
      ),
      subagentLine(),
    );
    const roots = [live, ...(await listArchiveRoots())];
    const orphanProject = (await listProjects(roots)).find((p) => p.root !== live.path);
    expect(orphanProject).toBeDefined();
    expect(orphanProject?.sessionCount).toBe(0);
    expect((await findProject(orphanProject?.id as string, roots)).status).toBe("found");
    expect(await listSessions(orphanProject?.id as string, roots)).toHaveLength(1);
    await run();
    // The orphan session is indexed, which is why its project must stay reachable.
    expect(rows().filter((r) => r.path.includes("-Users-x-y"))).toHaveLength(1);
  });
});

describe("no real API call is lost when copies disagree", () => {
  const subDir = () => join(live.path, "projects", PROJECT, SESSION);
  const subFile = () => join(subDir(), "subagents", "agent-a.jsonl");

  test("STALE-SUB: an archive keeping a subagent file live lost does not hide live's new turns", async () => {
    put(subFile(), subagentLine().repeat(40));
    await archiveSessions([live]);
    await run();
    const before = calls();
    expect(before).toBe(4); // 3 main-chain + 1 subagent (40 repeated lines = one call)
    rmSync(subDir(), { recursive: true });
    appendFileSync(liveSession(), transcript("newturn"));
    await converge({ heal: true });
    // Live (parent + new turn) and archive (old parent + stale subagent) each hold
    // calls the other lacks: both rows stay and the ledger counts the base once.
    expect(rows().map((r) => kind(r.path))).toEqual(["archive", "live"]);
    expect(calls()).toBe(7);
    const roots = [live, ...(await listArchiveRoots())];
    expect((await findSessionById(SESSION, roots))?.root).toBe(live.path);
  });

  test("FLIP: the winner flips archive -> both -> archive and the call count never drops", async () => {
    put(subFile(), subagentLine());
    await archiveSessions([live]);
    await run();
    expect(calls()).toBe(4);
    // Live loses its subagent file: the archive (parent + subagent) contains live.
    rmSync(subDir(), { recursive: true });
    await converge();
    expect(rows().map((r) => kind(r.path))).toEqual(["archive"]);
    expect(calls()).toBe(4);
    // Live grows past the archive WITHOUT the subagent file: neither contains the other.
    appendFileSync(liveSession(), transcript("grow"));
    await converge();
    expect(rows().map((r) => kind(r.path))).toEqual(["archive", "live"]);
    expect(calls()).toBe(7);
    // The next archive run copies the grown parent next to the stale subagent: the
    // archive now contains live again.
    await archiveSessions([live]);
    await converge();
    expect(rows().map((r) => kind(r.path))).toEqual(["archive"]);
    expect(calls()).toBe(7);
  });

  test("N3: two live copies, one truncated, plus an equal archive: both live copies stay, the archive goes", async () => {
    const root2 = join(temp, "claude2");
    const live2: ClaudeRoot = { path: root2, slug: rootSlug(root2), source: "default" };
    const second = join(root2, "projects", PROJECT, `${SESSION}.jsonl`);
    put(second, transcript());
    await archiveSessions([live]);
    // The first live copy is truncated (it is covered by the archive, but live copies
    // are never dropped against each other, and the archive is covered by the full one).
    put(liveSession(), "");
    const roots = [live, live2];
    const result = await reindex(db, { pricing: samplePricing, roots, concurrency: 2 });
    expect(result.total).toBe(2);
    expect(
      rows()
        .map((r) => r.path)
        .sort(),
    ).toEqual([liveSession(), second].sort());
    const status = await inspectIndexStatus(db, Date.now(), roots);
    expect(status.stale).toBe(false);
    expect((await reindex(db, { pricing: samplePricing, roots, concurrency: 2 })).indexed).toBe(0);
  });

  test("N10: an id that only has an orphan is not found (there is no main chain to open)", async () => {
    put(subFile(), subagentLine());
    rmSync(liveSession());
    const roots = [live, ...(await listArchiveRoots())];
    expect(await findSessionById(SESSION, roots)).toBeUndefined();
    // But once any copy has its parent, that copy is found.
    put(archived(MACHINE_A), transcript());
    const withArchive = [live, ...(await listArchiveRoots())];
    expect((await findSessionById(SESSION, withArchive))?.path).toBe(archived(MACHINE_A));
  });
});

describe("lookups and retained archive roots with several surviving copies", () => {
  test("an id opens the live copy of a diverged session even when the archive project is bigger", async () => {
    const base = transcript("base");
    put(liveSession(), base + transcript("liveTail"));
    put(archived(MACHINE_A), base + transcript("aTail"));
    put(archived(MACHINE_A, OTHER), transcript("o"));
    put(archived(MACHINE_A, OTHER2), transcript("p"));
    const roots = [live, ...(await listArchiveRoots())];
    const found = await findSessionById(SESSION, roots);
    expect(found?.root).toBe(live.path);
  });

  test("N8: an unreadable ARCHIVE root is not a live copy: another archive's copy is not hidden by it", async () => {
    put(archived(MACHINE_A), transcript(), 1_700_000_900);
    put(archived(MACHINE_B), transcript(), 1_700_000_100);
    rmSync(liveSession());
    await run();
    expect(rows().map((r) => r.path)).toEqual([archived(MACHINE_A)]);
    const before = total();
    const hidden = join(repo, "machines", MACHINE_A, "roots", live.slug, "projects");
    chmodSync(hidden, 0o000);
    try {
      await run();
    } finally {
      chmodSync(hidden, 0o755);
    }
    // A's row is retained while its root cannot be listed; B's copy is visible
    // again and gets a row, without the session's cost being counted twice.
    expect(rows().map((r) => r.path)).toEqual([archived(MACHINE_A), archived(MACHINE_B)]);
    expect(total()).toBeCloseTo(before, 10);
  });
});

describe("a survivor's re-ingest debt is persisted until it is paid", () => {
  /**
   * What the unreleased main build left behind: BOTH rows exist and the
   * ARCHIVE row owns every usage claim, so the live row sits at $0.
   */
  async function mainEraDuplicates() {
    await archiveSessions([live]);
    await run();
    const [good] = rows();
    const archivePath = archived(me());
    const archiveRoot = (await listArchiveRoots())[0] as ClaudeRoot;
    const st = statSync(archivePath);
    db.query("CREATE TEMP TABLE dup AS SELECT * FROM sessions").run();
    db.query("UPDATE dup SET path = ?, claude_dir = ?, mtime_ms = ?, size_bytes = ?").run(
      archivePath,
      archiveRoot.path,
      st.mtimeMs,
      st.size,
    );
    db.query("INSERT INTO sessions SELECT * FROM dup").run();
    db.query("UPDATE usage_keys SET path = ?").run(archivePath);
    db.query(
      "UPDATE sessions SET api_calls = 0, cost_total = 0, cost_input = 0, cost_output = 0, cost_cache_write = 0, cost_cache_read = 0 WHERE path = ?",
    ).run(liveSession());
    return { good: good as { calls: number; cost: number }, archivePath };
  }

  test("FAIL: the survivor's analysis fails in the healing run, and a later run still heals it", async () => {
    // Shape U1 mirrored: the LIVE row owns the claims, the archive row is at $0.
    await archiveSessions([live]);
    await run();
    const [good] = rows();
    const archivePath = archived(me());
    const archiveRoot = (await listArchiveRoots())[0] as ClaudeRoot;
    const st = statSync(archivePath);
    db.query("CREATE TEMP TABLE dup AS SELECT * FROM sessions").run();
    db.query(
      "UPDATE dup SET path = ?, claude_dir = ?, mtime_ms = ?, size_bytes = ?, api_calls = 0, cost_total = 0, cost_input = 0, cost_output = 0, cost_cache_write = 0, cost_cache_read = 0",
    ).run(archivePath, archiveRoot.path, st.mtimeMs, st.size);
    db.query("INSERT INTO sessions SELECT * FROM dup").run();
    // The live file goes away, but the archived survivor is unreadable during the run.
    rmSync(liveSession());
    chmodSync(archivePath, 0o000);
    try {
      const result = await run();
      expect(result.deleted).toBe(1);
      expect(rows().map((r) => [r.path, r.cost])).toEqual([[archivePath, 0]]);
      // A permanently unreadable file keeps the debt through every failing run.
      await run();
      expect(debtKeys()).toBe(1);
    } finally {
      chmodSync(archivePath, 0o644);
    }
    // `--check` is NOT fresh: the debt was persisted although (size, mtime) never changed.
    const status = await inspectIndexStatus(db, Date.now(), [live]);
    expect(status).toMatchObject({ changed: 1, stale: true });
    await converge();
    expect(rows()[0]?.calls).toBe(good?.calls as number);
    expect(rows()[0]?.cost).toBeCloseTo(good?.cost as number, 10);
  });

  test("RETAIN-UPGRADE: the live root is unmounted during the healing run, then comes back", async () => {
    const { good } = await mainEraDuplicates();
    renameSync(live.path, `${live.path}.off`);
    try {
      await run();
      // The retained live row still shadows its archive copy, so only it remains.
      expect(rows().map((r) => kind(r.path))).toEqual(["live"]);
    } finally {
      renameSync(`${live.path}.off`, live.path);
    }
    expect((await inspectIndexStatus(db, Date.now(), [live])).stale).toBe(true);
    await converge();
    expect(rows().map((r) => kind(r.path))).toEqual(["live"]);
    expect(rows()[0]?.calls).toBe(good.calls);
    expect(rows()[0]?.cost).toBeCloseTo(good.cost, 10);
  });

  test("a healthy duplicate collapse pays the debt in the same run and leaves nothing owed", async () => {
    const { good } = await mainEraDuplicates();
    const result = await run();
    expect(result.deleted).toBe(1);
    expect(rows()[0]?.cost).toBeCloseTo(good.cost, 10);
    expect(db.query("SELECT COUNT(*) AS n FROM reanalyze_keys").get()).toEqual({ n: 0 });
    expect((await inspectIndexStatus(db, Date.now(), [live])).stale).toBe(false);
  });
});

/** One API call as a transcript line; `n` names it (its message id), `side` marks a subagent call. */
const callLine = (n: number, side = false) =>
  (FIXTURE.split("\n")[3] ?? "")
    .replace('"msg_2"', `"m${n}"`)
    .replace('"req-2"', `"r${n}"`)
    .replace('"isSidechain":false', `"isSidechain":${side}`);
const callsText = (...ns: number[]) =>
  [FIXTURE.split("\n")[0], ...ns.map((n) => callLine(n))].map((l) => `${l}\n`).join("");
const subOf = (parent: string) => join(dirname(parent), SESSION, "subagents", "agent-x.jsonl");

/** Ground truth: distinct message ids across every transcript file still on disk. */
function distinctCallsOnDisk(): number {
  const ids = new Set<string>();
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith(".jsonl")) {
        for (const m of readFileSync(full, "utf8").matchAll(/"id":"(m\d+)"/g)) ids.add(m[1] ?? "");
      }
    }
  };
  walk(live.path);
  walk(repo);
  return ids.size;
}
// One file at a time: which copy first claims a shared call is attribution, and
// the shapes below need the older copy to be the holder.
const runSerial = () => reindex(db, { pricing: samplePricing, roots: [live], concurrency: 1 });
const debtKeys = () =>
  (db.query("SELECT COUNT(*) AS n FROM reanalyze_keys").get() as { n: number }).n;
const skipAsRoot = process.getuid?.() === 0;

describe("the usage ledger never double-counts and heals what a file shed", () => {
  test.skipIf(skipAsRoot)(
    "DOUBLE: a holder whose re-analysis keeps failing keeps its claims; a diverged copy cannot take them",
    async () => {
      put(liveSession(), callsText(1, 2, 3), 1000);
      await run();
      expect(calls()).toBe(3);
      put(archived(MACHINE_A), callsText(1, 2, 9), 2000);
      put(liveSession(), callsText(1, 2, 3, 4), 3000);
      chmodSync(liveSession(), 0o000);
      try {
        // Live is unreadable (stat works, so it is retried and fails): its old row keeps
        // counting 1,2,3; the archive may only add its own unique call 9.
        await run();
        expect(calls()).toBe(4); // truth is 5 once live is readable again
        await run();
        expect(calls()).toBe(4);
      } finally {
        chmodSync(liveSession(), 0o644);
      }
      await converge();
      expect(calls()).toBe(distinctCallsOnDisk());
      expect(calls()).toBe(5);
    },
  );

  // Live and the archive diverge (neither contains the other) and both keep a row;
  // `holder` was indexed first and owns the shared calls. Mutating it so it sheds
  // calls the other copy carries must not lose them for good.
  type Shape = {
    name: string;
    older: "live" | "archive";
    live: [number[], number | null];
    archive: [number[], number | null];
    mutate: () => void;
  };
  const shapes: Shape[] = [
    {
      name: "live loses its subagents/ directory",
      older: "live",
      live: [[1, 2], 50],
      archive: [[1, 7], 50],
      mutate: () => rmSync(join(dirname(liveSession()), SESSION), { recursive: true }),
    },
    {
      name: "the archive copy loses its subagents/ directory",
      older: "archive",
      live: [[1, 2], 50],
      archive: [[1, 7], 50],
      mutate: () => rmSync(join(dirname(archived(MACHINE_A)), SESSION), { recursive: true }),
    },
    {
      name: "live's parent is truncated",
      older: "live",
      live: [[1, 2, 3], null],
      archive: [[1, 3, 7], null],
      mutate: () => put(liveSession(), callsText(1, 2), 5000),
    },
  ];
  for (const shape of shapes) {
    test(`LOST: ${shape.name}: two runs converge, --check reports the pending work in between`, async () => {
      const at = (who: "live" | "archive") => (who === shape.older ? 1000 : 2000);
      const write = (path: string, [ns, sub]: [number[], number | null], mt: number) => {
        put(path, callsText(...ns), mt);
        if (sub !== null) put(subOf(path), `${callLine(sub, true)}\n`, mt);
      };
      write(liveSession(), shape.live, at("live"));
      write(archived(MACHINE_A), shape.archive, at("archive"));
      await runSerial();
      expect(rows().map((r) => kind(r.path))).toEqual(["archive", "live"]);
      expect(calls()).toBe(distinctCallsOnDisk());
      expect(debtKeys()).toBe(0);

      shape.mutate();
      await runSerial();
      // The shed calls are owed, not forgotten: `--check` says so and a second run pays.
      expect(debtKeys()).toBe(1);
      expect((await predicted()).indexed).toBeGreaterThan(0);
      expect(calls()).toBeLessThanOrEqual(distinctCallsOnDisk());
      await converge();
      expect(debtKeys()).toBe(0);
      expect(calls()).toBe(distinctCallsOnDisk());
    });
  }

  test.skipIf(skipAsRoot)(
    "PARTIAL: one survivor heals, the other is unreadable: the debt stays until BOTH are re-analyzed",
    async () => {
      // Three diverged copies; the oldest (B) owns the calls it shares with the others.
      const b = archived(MACHINE_B);
      const a = archived(MACHINE_A);
      put(b, callsText(1, 7, 8), 1000);
      put(a, callsText(1, 7, 9), 2000);
      put(liveSession(), callsText(1, 2), 3000);
      await runSerial();
      expect(rows()).toHaveLength(3);
      expect(calls()).toBe(distinctCallsOnDisk());
      // B disappears; A is unreadable in the run that has to hand its calls on.
      rmSync(b);
      chmodSync(a, 0o000);
      try {
        await runSerial();
        // Live healed (it took call 1); A could not be re-analyzed, so call 7 is owed.
        expect(debtKeys()).toBe(1);
        expect((await predicted()).indexed).toBeGreaterThan(0);
        // Live succeeds again, A still fails: one success must not settle the key.
        await runSerial();
        expect(debtKeys()).toBe(1);
      } finally {
        chmodSync(a, 0o644);
      }
      await converge();
      expect(debtKeys()).toBe(0);
      expect(calls()).toBe(distinctCallsOnDisk());
    },
  );

  test("a session that is alone never owes a re-analysis, however much it sheds", async () => {
    put(liveSession(), callsText(1, 2, 3), 1000);
    put(subOf(liveSession()), `${callLine(50, true)}\n`, 1000);
    await run();
    expect(calls()).toBe(4);
    rmSync(join(dirname(liveSession()), SESSION), { recursive: true });
    put(liveSession(), callsText(1), 2000);
    await converge();
    expect(debtKeys()).toBe(0);
    expect(calls()).toBe(1);
  });

  test("a copy that merely grows (no claim released) leaves nothing owed", async () => {
    put(liveSession(), callsText(1, 2), 1000);
    put(archived(MACHINE_A), callsText(1, 7), 2000);
    await run();
    put(liveSession(), callsText(1, 2, 3), 3000);
    await converge();
    expect(debtKeys()).toBe(0);
    expect(calls()).toBe(distinctCallsOnDisk());
  });
});

describe("`index --rebuild` keeps the ledger and the rows in step through failures", () => {
  const away = () => `${join(live.path, "projects")}.away`;
  const ledgerKeys = () =>
    (db.query("SELECT COUNT(*) AS n FROM usage_keys").get() as { n: number }).n;
  const rebuild = () =>
    reindex(db, { pricing: samplePricing, roots: [live], concurrency: 1, rebuild: true });

  test.skipIf(skipAsRoot)(
    "REBUILD-DOUBLE: a rebuild while a kept copy is unreadable owes it a re-analysis, never a double count",
    async () => {
      put(liveSession(), callsText(1, 2, 3), 1000);
      put(archived(MACHINE_A), callsText(1, 2, 9), 2000); // diverged: both kept
      await run();
      expect(calls()).toBe(4);
      chmodSync(liveSession(), 0o000);
      try {
        await rebuild();
        // Live's row survived (its analysis failed) and the archive claimed 1, 2 and 9
        // in the cleared ledger: the session is owed a re-analysis, not silently settled.
        expect(debtKeys()).toBe(1);
        expect((await predicted()).indexed).toBeGreaterThan(0);
      } finally {
        chmodSync(liveSession(), 0o644);
      }
      await converge();
      expect(debtKeys()).toBe(0);
      expect(calls()).toBe(4);
      expect(calls()).toBe(distinctCallsOnDisk());
      expect(ledgerKeys()).toBe(calls());
    },
  );

  test.skipIf(skipAsRoot)(
    "a rebuild that fails on a file with no row yet owes nothing",
    async () => {
      put(liveSession(), callsText(1, 2, 3), 1000);
      chmodSync(liveSession(), 0o000);
      try {
        await rebuild();
        expect(rows()).toHaveLength(0);
        expect(debtKeys()).toBe(0);
      } finally {
        chmodSync(liveSession(), 0o644);
      }
      await converge();
      expect(calls()).toBe(3);
    },
  );

  test("a healthy rebuild of a session with two kept copies owes nothing and keeps every call once", async () => {
    put(liveSession(), callsText(1, 2, 3), 1000);
    put(archived(MACHINE_A), callsText(1, 2, 9), 2000);
    await run();
    await rebuild();
    expect(debtKeys()).toBe(0);
    expect(calls()).toBe(4);
    expect(ledgerKeys()).toBe(4);
    expect((await predicted()).indexed).toBe(0);
  });

  test("a rebuild re-derives the claims of every file it re-analyzes, even a shrunken holder's", async () => {
    put(liveSession(), callsText(1, 2, 3), 1000);
    put(archived(MACHINE_A), callsText(1, 2, 9), 2000);
    await run(); // live (older) holds 1, 2, 3; the archive only gets 9
    put(liveSession(), callsText(1, 8), 3000); // live sheds 2 and 3 (and diverges: 8)
    await rebuild();
    // Stale claims of the shrunken file must not keep blocking the archive from 1 and 2.
    expect(calls()).toBe(distinctCallsOnDisk());
    expect(calls()).toBe(4);
    expect(ledgerKeys()).toBe(calls());
  });

  test("REBUILD-UNMOUNT: a rebuild while the live root is away heals once it returns", async () => {
    put(liveSession(), callsText(1, 2, 3), 1000);
    put(archived(MACHINE_A), callsText(1, 2, 9), 2000);
    await run();
    renameSync(join(live.path, "projects"), away());
    try {
      await rebuild();
    } finally {
      renameSync(away(), join(live.path, "projects"));
    }
    await converge();
    expect(debtKeys()).toBe(0);
    expect(calls()).toBe(4);
    expect(ledgerKeys()).toBe(calls());
  });
});

describe("`index --rebuild` with a retained root", () => {
  const away = () => `${join(live.path, "projects")}.away`;

  test("REBUILD-RETAINED: a rebuild after an incremental run under an unmounted root keeps the debt and the claims", async () => {
    put(liveSession(), callsText(1, 2, 3), 1000);
    put(archived(MACHINE_A), callsText(1, 2, 9), 2000);
    await run();
    renameSync(join(live.path, "projects"), away());
    try {
      await run(); // prunes the archive row: its session is owed a re-analysis
      expect(debtKeys()).toBe(1);
      await reindex(db, { pricing: samplePricing, roots: [live], concurrency: 1, rebuild: true });
      // The retained live row was not re-analyzed: its claims and the debt stand.
      expect(debtKeys()).toBe(1);
      expect((db.query("SELECT COUNT(*) AS n FROM usage_keys").get() as { n: number }).n).toBe(3);
    } finally {
      renameSync(away(), join(live.path, "projects"));
    }
    await converge();
    expect(debtKeys()).toBe(0);
    expect(calls()).toBe(4);
    expect((db.query("SELECT COUNT(*) AS n FROM usage_keys").get() as { n: number }).n).toBe(4);
  });
});

describe("a retained live row never stores a fake mtime", () => {
  const away = () => `${join(live.path, "projects")}.away`;

  test("UNMOUNT: the pruned archive row's debt is kept in a table, rows keep their real mtime", async () => {
    put(liveSession(), callsText(1, 2), 1000);
    put(archived(MACHINE_A), callsText(1, 7, 8), 2000);
    await run();
    expect(calls()).toBe(4);
    renameSync(join(live.path, "projects"), away());
    try {
      await run();
      // Known limitation, pinned on purpose: while the live root is unreadable its
      // retained row stands in for the session, so the archive copy's unique calls
      // (7, 8) are hidden and the total is temporarily short. Showing the larger
      // archive copy next to the retained row would double-count after a rebuild
      // (retained rows keep their numbers outside the ledger). It heals on return.
      expect(rows().map((r) => kind(r.path))).toEqual(["live"]);
      expect(calls()).toBe(2);
      expect(debtKeys()).toBe(1);
      // No row carries a sentinel: the project list shows the file's real mtime.
      const mtimes = db.query("SELECT mtime_ms AS m FROM sessions").all() as { m: number }[];
      expect(mtimes.every((r) => r.m === 1_000_000)).toBe(true);
      const projects = listIndexedProjects(db);
      expect(projects.map((p) => p.lastActivityMs)).toEqual([1_000_000]);
    } finally {
      renameSync(away(), join(live.path, "projects"));
    }
    expect((await inspectIndexStatus(db, Date.now(), [live])).stale).toBe(true);
    await converge();
    expect(debtKeys()).toBe(0);
    expect(calls()).toBe(distinctCallsOnDisk());
    expect(
      (db.query("SELECT COUNT(*) AS n FROM sessions WHERE mtime_ms < 0").get() as { n: number }).n,
    ).toBe(0);
  });
});

describe("a complete archived copy is never overwritten by a truncated live file", () => {
  test("CLOBBER: truncated live source is skipped and reported, by archive run and by archive-during-index", async () => {
    await archiveSessions([live]);
    const copy = archived(me());
    const size = statSync(copy).size;
    put(liveSession(), "");
    const result = await archiveSessions([live]);
    expect(result).toMatchObject({ copied: 0, notUpdated: 1, committed: false });
    expect(statSync(copy).size).toBe(size);
    setArchiveDuringIndex(true);
    await run();
    expect(statSync(copy).size).toBe(size);
    // A live prefix of the archived file is also a truncation...
    put(liveSession(), transcript().slice(0, size - 40));
    expect((await archiveSessions([live])).notUpdated).toBe(1);
    expect(statSync(copy).size).toBe(size);
    // ...and the index reads the complete data.
    expect(rows().map((r) => kind(r.path))).toEqual(["archive"]);
  });

  test("a live file that merely differs (diverged) is still copied over; Git keeps the old one", async () => {
    await archiveSessions([live]);
    put(liveSession(), transcript("div"));
    const result = await archiveSessions([live]);
    expect(result).toMatchObject({ copied: 1, notUpdated: 0 });
    expect(readFileSync(archived(me()), "utf8")).toBe(transcript("div"));
  });

  test("a live file that grew is copied over (the common case)", async () => {
    await archiveSessions([live]);
    appendFileSync(liveSession(), transcript("grow"));
    expect(await archiveSessions([live])).toMatchObject({ copied: 1, notUpdated: 0 });
  });

  test("`archive run` prints the note", async () => {
    await archiveSessions([live]);
    put(liveSession(), "");
    const out = await cli("archive", "run");
    expect(out.code).toBe(0);
    expect(out.out).toContain(
      "1 session not updated: the live copy is a truncated version of the archived one.",
    );
  }, 60_000);
});

async function cli(...args: string[]) {
  return await cliWithRoots(live.path, ...args);
}

async function cliWithRoots(claudeDirs: string, ...args: string[]) {
  const proc = Bun.spawn(
    ["bun", fileURLToPath(new URL("../../src/cli/index.ts", import.meta.url)), ...args],
    {
      env: {
        ...process.env,
        CC_ANALYZER_CLAUDE_DIR: claudeDirs,
        CC_ANALYZER_STATE_DIR: state.dir,
        CC_ANALYZER_NO_UPDATE_CHECK: "1",
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
}

describe("the CLI listings agree with the index", () => {
  test("`projects` and `sessions <id>` count what the index holds, live copies included", async () => {
    put(liveSession(OTHER), transcript("o"));
    await archiveSessions([live]);
    // OTHER's live file is truncated (contained in its backup) and a third session
    // exists only in the archive.
    put(liveSession(OTHER), "");
    put(archived(me(), OTHER2), transcript("p"));
    const rowsBefore = await run();
    expect(rowsBefore.total).toBe(3);
    const index = rows().map((r) => `${kind(r.path)}:${r.path.split("/").pop()}`);
    expect(index).toEqual(
      [`live:${SESSION}.jsonl`, `archive:${OTHER}.jsonl`, `archive:${OTHER2}.jsonl`].sort(),
    );

    const roots = [live, ...(await listArchiveRoots())];
    const projects = await listProjects(roots);
    const liveProject = projects.find((p) => p.root === live.path) as { id: string };
    const archiveProject = projects.find((p) => p.root !== live.path) as { id: string };

    const listing = await cli("projects");
    expect(listing.code).toBe(0);
    const counts = listing.out
      .split("\n")
      .filter((l) => l.includes("/proj"))
      .map((l) => l.trim().split(/\s+/)[0]);
    expect(counts.sort()).toEqual(["1", "2"]);

    const liveList = await cli("sessions", liveProject.id);
    expect(liveList.code).toBe(0);
    expect(liveList.out).toContain(SESSION);
    expect(liveList.out).not.toContain(OTHER);
    expect(liveList.out).toContain("1 sessions");

    const archiveList = await cli("sessions", archiveProject.id);
    expect(archiveList.out).toContain(OTHER);
    expect(archiveList.out).toContain(OTHER2);
    expect(archiveList.out).not.toContain(SESSION);
    expect(archiveList.out).toContain("2 sessions");

    // Same totals as the index: 1 + 2 = 3 rows.
    expect(1 + 2).toBe(rows().length);
  }, 90_000);
});

describe("`sessions <project>` explains an emptied live project", () => {
  test("a live project whose sessions the archive copy holds points at that copy; a truly empty one does not", async () => {
    await archiveSessions([live]);
    // The live file is cut down to a prefix of its backup: the archive copy is the one shown.
    put(liveSession(), `${FIXTURE.split("\n")[0]}\n`);
    mkdirSync(join(live.path, "projects", "-Users-empty"), { recursive: true });
    const roots = [live, ...(await listArchiveRoots())];
    const projects = await listProjects(roots);
    const liveProject = projects.find((p) => p.root === live.path && p.id.endsWith(PROJECT));
    const archiveProject = projects.find((p) => p.root !== live.path) as { id: string };
    expect(liveProject?.sessionCount).toBe(0);

    const redirected = await cli("sessions", liveProject?.id as string);
    expect(redirected.code).toBe(1);
    expect(redirected.err).toContain("archived copy");
    expect(redirected.err).toContain(`cc-analyzer sessions ${archiveProject.id}`);
    expect(redirected.err).not.toContain("No sessions found");

    const emptyProject = projects.find((p) => p.id.endsWith("-Users-empty"));
    expect(emptyProject).toBeDefined();
    const empty = await cli("sessions", emptyProject?.id as string);
    expect(empty.code).toBe(1);
    expect(empty.err).toContain("No sessions found");
  }, 60_000);

  test("an emptied project is not pointed at a same-named project that has no sessions either", async () => {
    const second = join(temp, "claude2");
    mkdirSync(join(second, "projects", PROJECT), { recursive: true });
    rmSync(liveSession());
    const projects = await listProjects([
      live,
      { path: second, slug: rootSlug(second), source: "default" },
    ]);
    const mine = projects.find((p) => p.root === live.path) as { id: string };
    const result = await cliWithRoots(`${live.path}:${second}`, "sessions", mine.id);
    expect(result.code).toBe(1);
    expect(result.err).toContain("No sessions found");
    expect(result.err).not.toContain("archived copy");
  }, 60_000);

  test("FALSE-REDIRECT: an empty project is not pointed at another live root's same-named project", async () => {
    const second = join(temp, "claude2");
    put(join(second, "projects", PROJECT, `${OTHER}.jsonl`), transcript("o"), 1000);
    rmSync(liveSession());
    const both = [live, { path: second, slug: rootSlug(second), source: "default" as const }];
    const projects = await listProjects(both);
    const mine = projects.find((p) => p.root === live.path) as { id: string };
    const theirs = projects.find((p) => p.root === second) as { id: string; sessionCount: number };
    expect(theirs.sessionCount).toBe(1);
    const result = await cliWithRoots(`${live.path}:${second}`, "sessions", mine.id);
    expect(result.code).toBe(1);
    expect(result.err).toContain(`No sessions found for project '${mine.id}'`);
    expect(result.err).not.toContain("archived copy");
    expect(result.err).not.toContain(theirs.id);
  }, 60_000);

  test("a real redirect names only the copy that shadows the sessions, not other same-named projects", async () => {
    // A second project whose live copy is also cut down: its archive must not be named.
    const twoLive = join(live.path, "projects", "-Users-two", `${OTHER}.jsonl`);
    put(twoLive, transcript("t"), 1000);
    await archiveSessions([live]);
    put(twoLive, `${FIXTURE.split("\n")[0]}\n`);
    put(liveSession(), `${FIXTURE.split("\n")[0]}\n`);
    const second = join(temp, "claude2");
    put(join(second, "projects", PROJECT, `${OTHER}.jsonl`), transcript("o"), 1000);
    const both = [live, { path: second, slug: rootSlug(second), source: "default" as const }];
    const roots = [...both, ...(await listArchiveRoots())];
    const projects = await listProjects(roots);
    // The live root holds two projects here, so select by id: `find` on the root
    // alone returns whichever the filesystem lists first, which differs by platform.
    const mine = projects.find((p) => p.root === live.path && p.id.endsWith(PROJECT)) as {
      id: string;
    };
    const shadowing = projects.find(
      (p) => p.root.includes("machines") && p.id.endsWith(PROJECT),
    ) as { id: string };
    const unrelated = projects.find((p) => p.root === second) as { id: string };
    const otherArchive = projects.find(
      (p) => p.root.includes("machines") && p.id.endsWith("-Users-two"),
    ) as { id: string };
    const result = await cliWithRoots(`${live.path}:${second}`, "sessions", mine.id);
    expect(result.code).toBe(1);
    expect(result.err).toContain(`cc-analyzer sessions ${shadowing.id}`);
    expect(result.err).not.toContain(unrelated.id);
    expect(result.err).not.toContain(otherArchive.id);
  }, 60_000);
});
