import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setClaudeRootsOverride } from "../../src/core/claude-roots.ts";
import { openDb } from "../../src/core/db.ts";
import { reindex } from "../../src/core/indexer.ts";
import { type TempStateDir, tempStateDir } from "../helpers/claude-dir.ts";
import { samplePricing } from "../helpers/pricing.ts";

let root: string;
let projectDir: string;
let state: TempStateDir;
let db: Database;
let savedClaude: string | undefined;

const SESSION = "s1";

/** One main-chain assistant call, plus the prompt that opened its turn. */
function seedSession(): void {
  const lines = [
    { type: "user", uuid: "u1", timestamp: "2026-08-06T10:00:00Z", message: { content: "go" } },
    {
      type: "assistant",
      uuid: "a1",
      timestamp: "2026-08-06T10:01:00Z",
      requestId: "req-a1",
      message: {
        id: "msg-a1",
        role: "assistant",
        model: "claude-opus-4-7",
        content: [{ type: "text", text: "ok" }],
        usage: { input_tokens: 10, output_tokens: 20 },
      },
    },
  ];
  writeFileSync(
    join(projectDir, `${SESSION}.jsonl`),
    `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`,
  );
}

/** One subagent transcript carrying a single sidechain call. */
function seedSubagent(agentId: string, minute: string): void {
  const dir = join(projectDir, SESSION, "subagents");
  mkdirSync(dir, { recursive: true });
  const line = {
    type: "assistant",
    uuid: `sa-${agentId}`,
    timestamp: `2026-08-06T10:${minute}:00Z`,
    isSidechain: true,
    agentId,
    requestId: `req-${agentId}`,
    message: {
      id: `msg-${agentId}`,
      role: "assistant",
      model: "claude-opus-4-7",
      content: [{ type: "text", text: "sub" }],
      usage: { input_tokens: 5, output_tokens: 7 },
    },
  };
  writeFileSync(join(dir, `agent-${agentId}.jsonl`), `${JSON.stringify(line)}\n`);
  writeFileSync(
    join(dir, `agent-${agentId}.meta.json`),
    JSON.stringify({ agentType: "general-purpose", spawnDepth: 1 }),
  );
}

function sessionRow(): { api_calls: number; sidechain_calls: number; cost_total: number } {
  return db
    .query("SELECT api_calls, sidechain_calls, cost_total FROM sessions")
    .get() as ReturnType<typeof sessionRow>;
}

const run = () => {
  setClaudeRootsOverride([root]);
  return reindex(db, { pricing: samplePricing, concurrency: 2 });
};

beforeEach(() => {
  savedClaude = process.env.CC_ANALYZER_CLAUDE_DIR;
  delete process.env.CC_ANALYZER_CLAUDE_DIR;
  root = mkdtempSync(join(tmpdir(), "cc-idx-sub-"));
  projectDir = join(root, "projects", "-Users-me-proj");
  mkdirSync(projectDir, { recursive: true });
  state = tempStateDir("cc-idx-sub-state");
  seedSession();
  db = openDb(join(state.dir, "index.db"));
});

afterEach(() => {
  db.close();
  setClaudeRootsOverride(null);
  if (savedClaude === undefined) delete process.env.CC_ANALYZER_CLAUDE_DIR;
  else process.env.CC_ANALYZER_CLAUDE_DIR = savedClaude;
  state.cleanup();
  rmSync(root, { recursive: true, force: true });
});

test("indexes subagent calls into the parent session's row", async () => {
  seedSubagent("aaa", "02");
  await run();

  const row = sessionRow();
  expect(row.api_calls).toBe(2);
  expect(row.sidechain_calls).toBe(1);
});

test("subagent transcripts do not become sessions of their own", async () => {
  seedSubagent("aaa", "02");
  const result = await run();

  expect(result.indexed).toBe(1);
  expect(db.query("SELECT COUNT(*) AS n FROM sessions").get()).toEqual({ n: 1 });
});

test("a new subagent file re-indexes the parent even though the parent is untouched", async () => {
  await run();
  const before = sessionRow();
  expect(before.sidechain_calls).toBe(0);

  // Only the subagent appears; backdate the parent so its own (size, mtime)
  // are unchanged and the folded metadata is the only thing that moved.
  seedSubagent("aaa", "02");
  const old = new Date(Date.parse("2026-08-06T10:01:00Z"));
  utimesSync(join(projectDir, `${SESSION}.jsonl`), old, old);

  const result = await run();
  expect(result.indexed).toBe(1);
  expect(sessionRow().sidechain_calls).toBe(1);
});

test("a session with no subagents indexes exactly as before", async () => {
  await run();

  const row = sessionRow();
  expect(row.api_calls).toBe(1);
  expect(row.sidechain_calls).toBe(0);
  expect(row.cost_total).toBeGreaterThan(0);
});

test("each subagent call is counted once across the tree", async () => {
  seedSubagent("aaa", "02");
  seedSubagent("bbb", "03");
  await run();

  expect(sessionRow().sidechain_calls).toBe(2);

  // A second scan must not re-count anything into the row.
  await run();
  expect(sessionRow().sidechain_calls).toBe(2);
});
