import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
