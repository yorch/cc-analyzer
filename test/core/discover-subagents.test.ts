import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listSessionsIn, sessionTree } from "../../src/core/discover.ts";

let root: string;
let projectDir: string;

const PROJECT = { id: "p~proj", dir: "", root: "" };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cc-discover-"));
  projectDir = join(root, "projects", "-proj");
  mkdirSync(projectDir, { recursive: true });
  PROJECT.dir = projectDir;
  PROJECT.root = root;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Write a session's parent transcript. */
function writeSession(id: string, body = '{"type":"user"}\n'): void {
  writeFileSync(join(projectDir, `${id}.jsonl`), body);
}

/** Write one subagent transcript, optionally with its sibling meta file. */
function writeSubagent(sessionId: string, agentId: string, meta?: unknown): void {
  const dir = join(projectDir, sessionId, "subagents");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `agent-${agentId}.jsonl`), '{"type":"user","isSidechain":true}\n');
  if (meta !== undefined) {
    writeFileSync(join(dir, `agent-${agentId}.meta.json`), JSON.stringify(meta));
  }
}

/** The project's only session, failing loudly if discovery found none. */
async function onlySession() {
  const [session] = await listSessionsIn(PROJECT);
  if (!session) throw new Error("no session discovered");
  return session;
}

test("finds a session's subagent transcripts and its declared metadata", async () => {
  writeSession("s1");
  writeSubagent("s1", "aaa", { agentType: "general-purpose", spawnDepth: 1 });
  writeSubagent("s1", "bbb", { agentType: "code-reviewer", spawnDepth: 2 });

  const [session] = await listSessionsIn(PROJECT);

  expect(session?.subagentPaths).toHaveLength(2);
  expect(session?.agentMeta.get("aaa")).toEqual({
    agentType: "general-purpose",
    spawnDepth: 1,
  });
  expect(session?.agentMeta.get("bbb")?.agentType).toBe("code-reviewer");
});

test("sessionTree puts the parent first, then the subagents", async () => {
  writeSession("s1");
  writeSubagent("s1", "aaa");

  const session = await onlySession();
  const tree = sessionTree(session);

  expect(tree[0]).toBe(session.path);
  expect(tree).toHaveLength(2);
});

test("folds subagent size and mtime into the parent, so growth is noticed", async () => {
  writeSession("s1");
  const before = await onlySession();

  writeSubagent("s1", "aaa");
  // Backdate the parent so only the subagent could supply the newer mtime.
  const old = new Date(Date.now() - 60_000);
  utimesSync(join(projectDir, "s1.jsonl"), old, old);
  const after = await onlySession();

  expect(after.sizeBytes).toBeGreaterThan(before.sizeBytes);
  expect(after.mtimeMs).toBeGreaterThan(statSync(join(projectDir, "s1.jsonl")).mtimeMs);
});

test("a session with no subagents directory is unchanged", async () => {
  writeSession("s1");

  const session = await onlySession();

  expect(session.subagentPaths).toEqual([]);
  expect(session.agentMeta.size).toBe(0);
  expect(sessionTree(session)).toEqual([session.path]);
});

test("malformed meta json leaves the agent without metadata rather than throwing", async () => {
  writeSession("s1");
  const dir = join(projectDir, "s1", "subagents");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "agent-aaa.jsonl"), "{}\n");
  writeFileSync(join(dir, "agent-aaa.meta.json"), "{ not json");

  const [session] = await listSessionsIn(PROJECT);

  expect(session?.subagentPaths).toHaveLength(1);
  expect(session?.agentMeta.size).toBe(0);
});

test("meta with unexpected field types degrades to undefined fields", async () => {
  writeSession("s1");
  writeSubagent("s1", "aaa", { agentType: 42, spawnDepth: "deep" });

  const [session] = await listSessionsIn(PROJECT);

  expect(session?.agentMeta.get("aaa")).toEqual({
    agentType: undefined,
    spawnDepth: undefined,
  });
});

test("non-jsonl files in subagents are ignored", async () => {
  writeSession("s1");
  writeSubagent("s1", "aaa", { agentType: "general-purpose" });
  writeFileSync(join(projectDir, "s1", "subagents", "agent-aaa.forked-skill.json"), "{}");

  const [session] = await listSessionsIn(PROJECT);

  expect(session?.subagentPaths).toHaveLength(1);
});
