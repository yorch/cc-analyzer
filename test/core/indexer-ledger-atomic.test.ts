import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, rmSync, utimesSync } from "node:fs";
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
let state: TempStateDir;
let db: Database;
let savedClaude: string | undefined;

function seed(root: string, mtimeSec: number): string {
  const dir = join(root, "projects", "-Users-me-proj");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "sess.jsonl");
  cpSync(FIXTURE, file);
  utimesSync(file, mtimeSec, mtimeSec);
  return file;
}

beforeEach(() => {
  savedClaude = process.env.CC_ANALYZER_CLAUDE_DIR;
  work = mkdtempSync(join(tmpdir(), "cc-ledger-atomic-"));
  state = tempStateDir("cc-ledger-atomic-state");
  db = openDb(":memory:");
});

afterEach(() => {
  setClaudeRootsOverride(null);
  if (savedClaude === undefined) delete process.env.CC_ANALYZER_CLAUDE_DIR;
  else process.env.CC_ANALYZER_CLAUDE_DIR = savedClaude;
  db.close();
  state.cleanup();
  rmSync(work, { recursive: true, force: true });
});

const ledgerSize = () =>
  (db.query("SELECT COUNT(*) AS n FROM usage_keys").get() as { n: number }).n;

test("an interrupted --rebuild leaves the ledger intact (DELETE is inside the transaction)", async () => {
  const root = join(work, "a");
  seed(root, 1_000);
  setClaudeRootsOverride([root]);
  await reindex(db, { pricing: samplePricing, concurrency: 1 });
  const before = ledgerSize();
  expect(before).toBeGreaterThan(0);

  const failing = new Proxy(db, {
    get(target, prop) {
      if (prop === "query") {
        return (sql: string) => {
          if (sql.startsWith("INSERT OR REPLACE INTO meta")) throw new Error("interrupted");
          return target.query(sql);
        };
      }
      const v = Reflect.get(target, prop);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  await expect(
    reindex(failing, { pricing: samplePricing, concurrency: 1, rebuild: true }),
  ).rejects.toThrow("interrupted");
  expect(ledgerSize()).toBe(before);
});

test("a failed analysis releases its claims and owes its siblings a re-analysis", async () => {
  const a = join(work, "a");
  const b = join(work, "b");
  seed(a, 1_000); // older: analyzed (and failing) first
  seed(b, 2_000);
  setClaudeRootsOverride([a, b]);
  let first = true;
  const flaky = new Proxy(samplePricing, {
    get(target, prop, recv) {
      if (first && typeof prop === "string" && prop.startsWith("claude")) {
        first = false;
        throw new Error("boom");
      }
      return Reflect.get(target, prop, recv);
    },
  });
  await reindex(db, { pricing: flaky, concurrency: 1 });
  const rows = db.query("SELECT path, api_calls FROM sessions").all() as {
    path: string;
    api_calls: number;
  }[];
  // Exactly one row survived and it counted the calls (claims were released).
  expect(rows).toHaveLength(1);
  expect(rows[0]?.api_calls).toBeGreaterThan(0);
  // The failed file's session is owed a re-analysis.
  expect((db.query("SELECT COUNT(*) AS n FROM reanalyze_keys").get() as { n: number }).n).toBe(1);

  // Next run (healthy): both copies index; total calls are single-counted.
  await reindex(db, { pricing: samplePricing, concurrency: 1 });
  const total = db.query("SELECT SUM(api_calls) AS n FROM sessions").get() as { n: number };
  const keys = ledgerSize();
  expect(total.n).toBe(keys);
});
