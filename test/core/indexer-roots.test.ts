import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setClaudeRootsOverride } from "../../src/core/claude-roots.ts";
import { openDb } from "../../src/core/db.ts";
import { reindex } from "../../src/core/indexer.ts";
import { type TempStateDir, tempStateDir } from "../helpers/claude-dir.ts";
import { samplePricing } from "../helpers/pricing.ts";

const FIXTURE = fileURLToPath(new URL("../fixtures/sample-session.jsonl", import.meta.url));

let work: string;
let personal: string;
let state: TempStateDir;
let db: Database;
let savedClaude: string | undefined;

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
  delete process.env.CC_ANALYZER_CLAUDE_DIR;
  work = mkdtempSync(join(tmpdir(), "cc-idx-work-"));
  personal = mkdtempSync(join(tmpdir(), "cc-idx-personal-"));
  state = tempStateDir("cc-idx-state");
  seedRoot(work, "w1");
  seedRoot(personal, "p1");
  db = openDb(join(state.dir, "index.db"));
});

afterEach(() => {
  db.close();
  setClaudeRootsOverride(null);
  if (savedClaude === undefined) delete process.env.CC_ANALYZER_CLAUDE_DIR;
  else process.env.CC_ANALYZER_CLAUDE_DIR = savedClaude;
  state.cleanup();
  for (const dir of [work, personal]) rmSync(dir, { recursive: true, force: true });
});

test("indexes every root and keeps same-named projects apart", async () => {
  const result = await run(work, personal);
  expect(result.indexed).toBe(2);
  const indexed = rows();
  expect(new Set(indexed.map((r) => r.claude_dir))).toEqual(new Set([work, personal]));
  // The collision this whole scheme exists to prevent: one encoded name, two projects.
  expect(new Set(indexed.map((r) => r.project_id)).size).toBe(2);
  // Every id is root-qualified, including the first root's — identity is a
  // fact about a directory, not about which root currently sorts first.
  expect(indexed.every((r) => /^[0-9a-f]{8}~-Users-me-proj$/.test(r.project_id))).toBe(true);
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

test("reordering the configured roots does not change any id", async () => {
  await run(work, personal);
  const before = new Map(rows().map((r) => [r.claude_dir, r.project_id]));

  // Under the old positional scheme this re-keyed both projects and needed a
  // re-stamp pass. An id now depends only on its root's path, so reordering is
  // a no-op — which is what keeps a stored id, a bookmarked URL, or a scripted
  // `sessions <id>` meaning the same project it did yesterday.
  const result = await run(personal, work);
  expect(result.indexed).toBe(0);
  expect(result.skipped).toBe(2);

  const after = new Map(rows().map((r) => [r.claude_dir, r.project_id]));
  expect(after).toEqual(before);
  expect(new Set(after.values()).size).toBe(2);
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
