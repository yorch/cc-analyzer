import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSessionTree, streamSessionTree } from "../../src/core/parser.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cc-tree-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Write a JSONL file of user events stamped with the given timestamps. */
function writeEvents(name: string, events: unknown[]): string {
  const path = join(dir, name);
  writeFileSync(path, `${events.map((e) => JSON.stringify(e)).join("\n")}\n`);
  return path;
}

function userEvent(ts: string | undefined, uuid: string, sidechain = false) {
  return {
    type: "user",
    uuid,
    timestamp: ts,
    isSidechain: sidechain,
    message: { role: "user", content: uuid },
  };
}

/** The uuids a tree yields, in order. */
async function uuidsOf(paths: string[]): Promise<string[]> {
  const { events } = await parseSessionTree(paths);
  return events.map((e) => (e as { uuid?: string }).uuid ?? "?");
}

/**
 * Whether this process is actually denied reads of a mode-000 file.
 *
 * `chmod 000` only *requests* denial. Root bypasses file permission bits
 * entirely, and Windows does not honor POSIX mode bits either — so in those
 * environments a permission-based test cannot establish the precondition it
 * needs, and would fail on a machine where nothing is wrong. Probing the real
 * behavior is portable where a uid check is not (it covers Windows too) and
 * turns "this mechanism is unavailable here" into a skip rather than a failure.
 *
 * The contract itself — any unreadable file degrades or throws — stays covered
 * unconditionally by the deleted-file tests below, which reproduce everywhere.
 */
function permissionsDenyReads(): boolean {
  const probeDir = mkdtempSync(join(tmpdir(), "cc-perm-"));
  try {
    const file = join(probeDir, "probe");
    writeFileSync(file, "x");
    chmodSync(file, 0o000);
    readFileSync(file);
    return false;
  } catch {
    return true;
  } finally {
    rmSync(probeDir, { recursive: true, force: true });
  }
}

const PERMISSIONS_ENFORCED = permissionsDenyReads();

test("merges files into one timestamp-ordered stream", async () => {
  const parent = writeEvents("parent.jsonl", [
    userEvent("2026-08-06T10:00:00Z", "p1"),
    userEvent("2026-08-06T12:00:00Z", "p2"),
  ]);
  const agent = writeEvents("agent.jsonl", [
    userEvent("2026-08-06T11:00:00Z", "a1", true),
    userEvent("2026-08-06T13:00:00Z", "a2", true),
  ]);

  expect(await uuidsOf([parent, agent])).toEqual(["p1", "a1", "p2", "a2"]);
});

test("keeps within-file order even when a file's timestamps go backwards", async () => {
  const parent = writeEvents("parent.jsonl", [
    userEvent("2026-08-06T12:00:00Z", "p1"),
    userEvent("2026-08-06T10:00:00Z", "p2"),
  ]);
  const agent = writeEvents("agent.jsonl", [userEvent("2026-08-06T11:00:00Z", "a1", true)]);

  const uuids = await uuidsOf([parent, agent]);
  expect(uuids.indexOf("p1")).toBeLessThan(uuids.indexOf("p2"));
});

test("an untimestamped event stays next to the event it followed", async () => {
  const parent = writeEvents("parent.jsonl", [
    userEvent("2026-08-06T10:00:00Z", "p1"),
    userEvent(undefined, "p1-tail"),
    userEvent("2026-08-06T12:00:00Z", "p2"),
  ]);
  const agent = writeEvents("agent.jsonl", [userEvent("2026-08-06T11:00:00Z", "a1", true)]);

  expect(await uuidsOf([parent, agent])).toEqual(["p1", "p1-tail", "a1", "p2"]);
});

test("ties resolve to the parent, which leads the tree", async () => {
  const ts = "2026-08-06T10:00:00Z";
  const parent = writeEvents("parent.jsonl", [userEvent(ts, "p1")]);
  const agent = writeEvents("agent.jsonl", [userEvent(ts, "a1", true)]);

  expect(await uuidsOf([parent, agent])).toEqual(["p1", "a1"]);
});

test("sums coverage across every file and names the file an error came from", async () => {
  const parent = writeEvents("parent.jsonl", [userEvent("2026-08-06T10:00:00Z", "p1")]);
  const agent = join(dir, "agent.jsonl");
  writeFileSync(agent, "{ not json\n");

  const { events, errors, coverage } = await parseSessionTree([parent, agent]);

  expect(events).toHaveLength(1);
  expect(coverage.lines).toBe(2);
  expect(coverage.parseErrors).toBe(1);
  expect(errors[0]?.path).toBe(agent);
});

test("a single-file tree matches the single-file reader", async () => {
  const parent = writeEvents("parent.jsonl", [
    userEvent("2026-08-06T10:00:00Z", "p1"),
    userEvent("2026-08-06T11:00:00Z", "p2"),
  ]);

  const { events, coverage } = await parseSessionTree([parent]);
  expect(events).toHaveLength(2);
  expect(coverage).toEqual({ lines: 2, parseErrors: 0, unknownEvents: 0 });
});

test("an unreadable subagent file is skipped, not thrown, and is counted", async () => {
  const parent = writeEvents("parent.jsonl", [userEvent("2026-08-06T10:00:00Z", "p1")]);
  // Deleted between the scan and the read — the other cause `advance` tolerates
  // besides permissions, and the one that reproduces for every user: a missing
  // file is unreadable for root and on Windows too, where mode bits are not.
  const missing = join(dir, "agent.jsonl");

  const { events, errors, coverage } = await parseSessionTree([parent, missing]);

  // The readable half of the session still analyzes; one bad subagent
  // transcript must not cost the reader the whole session.
  expect(events.map((e) => (e as { uuid?: string }).uuid)).toEqual(["p1"]);
  expect(coverage.parseErrors).toBe(1);
  expect(errors[0]?.path).toBe(missing);
  expect(errors[0]?.error).toContain("unreadable file");
});

test.skipIf(!PERMISSIONS_ENFORCED)(
  "a subagent file denied by permissions is tolerated the same way",
  async () => {
    const parent = writeEvents("parent.jsonl", [userEvent("2026-08-06T10:00:00Z", "p1")]);
    const locked = writeEvents("agent.jsonl", [userEvent("2026-08-06T11:00:00Z", "a1", true)]);
    chmodSync(locked, 0o000);

    const { events, errors, coverage } = await parseSessionTree([parent, locked]);

    expect(events.map((e) => (e as { uuid?: string }).uuid)).toEqual(["p1"]);
    expect(coverage.parseErrors).toBe(1);
    expect(errors[0]?.path).toBe(locked);
    expect(errors[0]?.error).toContain("unreadable file");

    chmodSync(locked, 0o644);
  },
);

test("an unreadable parent still throws, since a missing session is real news", async () => {
  // The tolerance above is for subagent transcripts only. A parent that cannot
  // be read means the index is stale or the path is wrong — the web API turns
  // that into a 404 and the CLI reports it — so swallowing it would serve an
  // empty analysis as though the session were merely uneventful.
  const missing = join(dir, "parent.jsonl");
  const agent = writeEvents("agent.jsonl", [userEvent("2026-08-06T11:00:00Z", "a1", true)]);

  await expect(parseSessionTree([missing, agent])).rejects.toThrow();
});

test.skipIf(!PERMISSIONS_ENFORCED)("a parent denied by permissions throws too", async () => {
  const parent = writeEvents("parent.jsonl", [userEvent("2026-08-06T10:00:00Z", "p1")]);
  const agent = writeEvents("agent.jsonl", [userEvent("2026-08-06T11:00:00Z", "a1", true)]);
  chmodSync(parent, 0o000);

  await expect(parseSessionTree([parent, agent])).rejects.toThrow();

  chmodSync(parent, 0o644);
});

test("abandoning the stream mid-read terminates cleanly", async () => {
  // The shape of an aborted analysis. This covers the caller-visible contract
  // only — that `.return()` resolves and the generator is done. Whether the
  // child readers were closed is not observable from here (see the `finally`
  // in streamSessionTree); do not read this test as proving that.
  const parent = writeEvents("parent.jsonl", [
    userEvent("2026-08-06T10:00:00Z", "p1"),
    userEvent("2026-08-06T12:00:00Z", "p2"),
  ]);
  const agent = writeEvents("agent.jsonl", [userEvent("2026-08-06T11:00:00Z", "a1", true)]);

  const iter = streamSessionTree([parent, agent]);
  expect((await iter.next()).value).toMatchObject({ uuid: "p1" });
  await iter.return(undefined as never);
  expect((await iter.next()).done).toBe(true);
});

test("an empty tree yields nothing rather than throwing", async () => {
  const { events, coverage } = await parseSessionTree([]);
  expect(events).toEqual([]);
  expect(coverage).toEqual({ lines: 0, parseErrors: 0, unknownEvents: 0 });
});

test("streaming returns coverage as the generator's return value", async () => {
  const parent = writeEvents("parent.jsonl", [userEvent("2026-08-06T10:00:00Z", "p1")]);
  const agent = writeEvents("agent.jsonl", [userEvent("2026-08-06T11:00:00Z", "a1", true)]);

  const iter = streamSessionTree([parent, agent]);
  let count = 0;
  let next = await iter.next();
  while (!next.done) {
    count += 1;
    next = await iter.next();
  }
  expect(count).toBe(2);
  expect(next.value.lines).toBe(2);
});
