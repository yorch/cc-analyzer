import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "../../src/core/db.ts";
import { reindex } from "../../src/core/indexer.ts";
import { setClaudeRootsOverride } from "../../src/core/paths.ts";
import { samplePricing } from "../helpers/pricing.ts";

const FIXTURE = fileURLToPath(new URL("../fixtures/sample-session.jsonl", import.meta.url));

let work: string;
let personal: string;
let state: string;
let db: Database;
let savedClaude: string | undefined;
let savedState: string | undefined;

/** Seed a root with one project holding one session. */
function seedRoot(root: string, sessionName: string): void {
  const dir = join(root, "projects", "-Users-me-proj");
  mkdirSync(dir, { recursive: true });
  cpSync(FIXTURE, join(dir, `${sessionName}.jsonl`));
}

function rows(): { path: string; claude_dir: string; project_id: string }[] {
  return db.query("SELECT path, claude_dir, project_id FROM sessions ORDER BY path").all() as {
    path: string;
    claude_dir: string;
    project_id: string;
  }[];
}

const run = (...roots: string[]) => {
  setClaudeRootsOverride(roots);
  return reindex(db, { pricing: samplePricing, concurrency: 2 });
};

beforeEach(() => {
  savedClaude = process.env.CC_ANALYZER_CLAUDE_DIR;
  savedState = process.env.CC_ANALYZER_STATE_DIR;
  delete process.env.CC_ANALYZER_CLAUDE_DIR;
  work = mkdtempSync(join(tmpdir(), "cc-idx-work-"));
  personal = mkdtempSync(join(tmpdir(), "cc-idx-personal-"));
  state = mkdtempSync(join(tmpdir(), "cc-idx-state-"));
  process.env.CC_ANALYZER_STATE_DIR = state;
  seedRoot(work, "w1");
  seedRoot(personal, "p1");
  db = openDb(join(state, "index.db"));
});

afterEach(() => {
  db.close();
  setClaudeRootsOverride(null);
  if (savedClaude === undefined) delete process.env.CC_ANALYZER_CLAUDE_DIR;
  else process.env.CC_ANALYZER_CLAUDE_DIR = savedClaude;
  if (savedState === undefined) delete process.env.CC_ANALYZER_STATE_DIR;
  else process.env.CC_ANALYZER_STATE_DIR = savedState;
  for (const dir of [work, personal, state]) rmSync(dir, { recursive: true, force: true });
});

test("indexes every root and keeps same-named projects apart", async () => {
  const result = await run(work, personal);
  expect(result.indexed).toBe(2);
  const indexed = rows();
  expect(new Set(indexed.map((r) => r.claude_dir))).toEqual(new Set([work, personal]));
  // The collision this whole scheme exists to prevent: one encoded name, two projects.
  expect(new Set(indexed.map((r) => r.project_id)).size).toBe(2);
  // The primary root's ids stay bare, so nothing a single-root user had re-keys.
  expect(indexed.some((r) => r.project_id === "-Users-me-proj")).toBe(true);
});

test("a configured root that cannot be read keeps its rows", async () => {
  await run(work, personal);
  const away = `${personal}-away`;
  renameSync(personal, away);
  try {
    const result = await run(work, personal);
    expect(result.deleted).toBe(0);
    expect(rows()).toHaveLength(2);
  } finally {
    renameSync(away, personal);
  }
});

test("a de-configured root loses its rows", async () => {
  await run(work, personal);
  const result = await run(work);
  expect(result.deleted).toBe(1);
  expect(rows().map((r) => r.claude_dir)).toEqual([work]);
});

test("a deleted session file is still pruned from a readable root", async () => {
  await run(work, personal);
  rmSync(join(personal, "projects", "-Users-me-proj", "p1.jsonl"));
  const result = await run(work, personal);
  expect(result.deleted).toBe(1);
  expect(rows()).toHaveLength(1);
});

test("changing the primary root re-keys ids without re-parsing", async () => {
  await run(work, personal);
  const before = rows();
  const workId = before.find((r) => r.claude_dir === work)?.project_id;
  expect(workId).toBe("-Users-me-proj");

  // Flip the order: `personal` becomes primary and takes the bare id.
  const result = await run(personal, work);
  expect(result.indexed).toBe(0); // re-stamped, not re-parsed
  expect(result.skipped).toBe(2);

  const after = rows();
  expect(after.find((r) => r.claude_dir === personal)?.project_id).toBe("-Users-me-proj");
  expect(after.find((r) => r.claude_dir === work)?.project_id).not.toBe("-Users-me-proj");
  expect(new Set(after.map((r) => r.project_id)).size).toBe(2);
});

test("index --check does not report an unreadable root's rows as deleted", async () => {
  const { inspectIndexStatus } = await import("../../src/core/index-status.ts");
  await run(work, personal);
  const away = `${personal}-away`;
  renameSync(personal, away);
  try {
    setClaudeRootsOverride([work, personal]);
    expect((await inspectIndexStatus(db)).deleted).toBe(0);
    // De-configuring it, by contrast, is a real deletion.
    setClaudeRootsOverride([work]);
    expect((await inspectIndexStatus(db)).deleted).toBe(1);
  } finally {
    renameSync(away, personal);
  }
});

test("an empty root contributes nothing and breaks nothing", async () => {
  const empty = mkdtempSync(join(tmpdir(), "cc-idx-empty-"));
  writeFileSync(join(empty, "settings.json"), "{}");
  try {
    const result = await run(work, empty);
    expect(result.indexed).toBe(1);
    expect(rows()).toHaveLength(1);
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});
