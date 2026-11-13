import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { rootSlug } from "../../src/core/claude-roots.ts";
import { openDb } from "../../src/core/db.ts";
import { inspectIndexStatus } from "../../src/core/index-status.ts";
import { reindex } from "../../src/core/indexer.ts";
import { setArchivePath } from "../../src/core/prefs.ts";
import { type TempStateDir, tempStateDir } from "../helpers/claude-dir.ts";
import { samplePricing } from "../helpers/pricing.ts";

/**
 * A SEEDED, deterministic fuzz of the cross-file usage ledger. Each scenario
 * keeps up to four copies of one session (the live tree and three archive
 * machines), mutates them at random (grow, fork, truncate, delete the parent or
 * the subagents/ directory, copy files across), injects failures (an
 * unreadable parent transcript, an unmounted live root) while indexing, and
 * checks after every index run and after settling:
 *
 *  (a) once settled, `SUM(api_calls)` equals the distinct message ids on disk;
 *  (b) `--check` predicts the deletions exactly, and the files `index` analyzes
 *      exactly when no file is unreadable;
 *  (c) a run after settling does no work and leaves no re-analysis debt;
 *  (d) at EVERY step `SUM(api_calls)` equals the ledger's size (no call counted
 *      twice) and never exceeds the ids ever written;
 *  (e) a run may be a `--rebuild` (about 20% of the runs): it re-derives the
 *      ledger from scratch, and (a)-(d) must still hold once settled.
 *
 * Tolerated on purpose (they are properties of the design, not defects):
 *  - While a file is unreadable its analysis fails and its old row keeps
 *    counting, so the total may be short of the ids on disk: (a) is only
 *    asserted once everything is readable and mounted again.
 *  - While a parent is unreadable `--check` lists it as pending work although
 *    the run cannot do it, so (b) is `indexed <= predicted` for those runs.
 *  - While the live root is unmounted its retained row stands in for the
 *    session and hides the archive copy's unique calls (a documented
 *    under-count); the ledger-size comparison in (d) is skipped for those runs.
 *  - An unreadable SUBAGENT file degrades silently (the row is written without
 *    it and is stat-fresh), which no re-analysis could notice: the fuzz only
 *    makes parent transcripts unreadable.
 *  - A `--rebuild` while a file is unreadable leaves that file's old row (its
 *    analysis failed) beside other copies that re-claimed its calls in the
 *    cleared ledger, so until the file reads again `SUM(api_calls)` may exceed
 *    the ledger and the ids written; the session is owed a re-analysis
 *    (`reanalyze_keys`) and the next run that CAN read the file settles it. (d)
 *    is therefore suspended from such a rebuild until the next settle, and a
 *    rebuild's own `--check` prediction is not compared (it re-indexes
 *    everything and prunes nothing it did not already plan to).
 *  - Settling may take up to two heal runs (freed claims are re-analyzed on the
 *    next run), asserted as "at most 4 runs".
 *
 * No wall-clock dependence: file mtimes come from a counter, the RNG is seeded,
 * and totals do not depend on which concurrent analysis claims a shared call.
 */
const FIXTURE = readFileSync(
  fileURLToPath(new URL("../fixtures/sample-session.jsonl", import.meta.url)),
  "utf8",
).split("\n");
const ASSIST = FIXTURE[3] as string;
const USER = FIXTURE[0] as string;
const PROJECT = "-Users-dev-proj";
const SESSION = "11111111-1111-4111-8111-111111111111";
const MACHINES = [
  "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
];
const SUBS = ["agent-a.jsonl", "agent-b.jsonl", "agent-c.jsonl"];
const SCENARIOS = 60;
const BASE_SEED = 20260713;

interface Copy {
  parent: string[] | null;
  subs: Map<string, string[]>;
}

function rngFrom(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let temp: string;
let state: TempStateDir;
const hurt: string[] = [];
let away: { from: string; to: string } | undefined;

beforeEach(() => {
  temp = mkdtempSync(join(tmpdir(), "cc-ledger-fuzz-"));
  state = tempStateDir("cc-ledger-fuzz-state");
});

afterEach(() => {
  // Undo every injected failure first, whatever the test did.
  if (away && existsSync(away.to)) renameSync(away.to, away.from);
  away = undefined;
  for (const p of hurt.splice(0)) {
    try {
      chmodSync(p, 0o644);
    } catch {}
  }
  state.cleanup();
  rmSync(temp, { recursive: true, force: true });
});

const skipAsRoot = process.getuid?.() === 0;

test.skipIf(skipAsRoot)(
  `ledger fuzz: ${SCENARIOS} seeded scenarios keep the totals honest through failures`,
  async () => {
    let runs = 0;
    for (let i = 0; i < SCENARIOS; i++) {
      const seed = BASE_SEED + i;
      const rnd = rngFrom(seed);
      const pick = <T>(a: T[]): T => a[Math.floor(rnd() * a.length)] as T;
      const dir = mkdtempSync(join(temp, "s-"));
      const root = join(dir, "claude");
      const live = { path: root, slug: rootSlug(root), source: "default" as const };
      const repo = join(dir, "archive");
      mkdirSync(repo, { recursive: true });
      setArchivePath(repo);
      const db = openDb(join(dir, "index.db"));
      const fail: string[] = [];
      const log: string[] = [];
      try {
        let nextId = 0;
        let clock = 1_700_000_000;
        const line = (side: boolean) => {
          const n = nextId++;
          const ts = new Date(Date.UTC(2026, 6, 1, 10, 0, 0) + n * 1000).toISOString();
          return ASSIST.replace('"msg_2"', `"m${n}"`)
            .replace('"req-2"', `"r${n}"`)
            .replace('"uuid":"a2"', `"uuid":"a${n}"`)
            .replace(/"timestamp":"[^"]+"/, `"timestamp":"${ts}"`)
            .replace('"isSidechain":false', `"isSidechain":${side}`);
        };
        const dirOf = (c: number) =>
          c === 0
            ? join(root, "projects", PROJECT)
            : join(
                repo,
                "machines",
                MACHINES[c - 1] as string,
                "roots",
                live.slug,
                "projects",
                PROJECT,
              );
        const parentOf = (c: number) => join(dirOf(c), `${SESSION}.jsonl`);
        const subOf = (c: number, n: string) => join(dirOf(c), SESSION, "subagents", n);
        const copies: (Copy | null)[] = [null, null, null, null];
        const ensure = (c: number): Copy => {
          copies[c] ??= { parent: null, subs: new Map() };
          return copies[c] as Copy;
        };
        const everIds = new Set<string>();
        const note = (ls: string[]) => {
          for (const l of ls) {
            const m = /"id":"(m\d+)"/.exec(l);
            if (m) everIds.add(m[1] as string);
          }
        };
        const write = () => {
          for (let c = 0; c < 4; c++) {
            const cp = copies[c];
            const want = new Map<string, string>();
            if (cp?.parent) want.set(parentOf(c), cp.parent.map((l) => `${l}\n`).join(""));
            for (const [n, ls] of cp?.subs ?? []) {
              want.set(subOf(c, n), ls.map((l) => `${l}\n`).join(""));
            }
            for (const p of [parentOf(c), ...SUBS.map((n) => subOf(c, n))]) {
              if (!want.has(p) && existsSync(p)) rmSync(p);
            }
            for (const [p, text] of want) {
              if (existsSync(p) && readFileSync(p, "utf8") === text) continue;
              mkdirSync(dirname(p), { recursive: true });
              writeFileSync(p, text);
              const t = clock++;
              utimesSync(p, t, t);
            }
          }
        };
        const truth = () => {
          const ids = new Set<string>();
          for (const cp of copies) {
            if (!cp) continue;
            for (const l of [...(cp.parent ?? []), ...[...cp.subs.values()].flat()]) {
              const m = /"id":"(m\d+)"/.exec(l);
              if (m) ids.add(m[1] as string);
            }
          }
          return ids.size;
        };
        const total = () =>
          (db.query("SELECT COALESCE(SUM(api_calls), 0) AS n FROM sessions").get() as { n: number })
            .n;
        const ledger = () =>
          (db.query("SELECT COUNT(*) AS n FROM usage_keys").get() as { n: number }).n;
        const debt = () =>
          (db.query("SELECT COUNT(*) AS n FROM reanalyze_keys").get() as { n: number }).n;

        // Set by a rebuild that ran with an unreadable file; cleared once settled.
        let inflated = false;
        const step = async (
          tag: string,
          unreadable: boolean,
          unmounted: boolean,
          allowRebuild = true,
        ) => {
          const before = await inspectIndexStatus(db, Date.now(), [live]);
          const rebuild = allowRebuild && rnd() < 0.2;
          if (rebuild) log.push("rebuild");
          if (rebuild && unreadable) inflated = true;
          const r = await reindex(db, {
            pricing: samplePricing,
            roots: [live],
            concurrency: 1 + Math.floor(rnd() * 6),
            rebuild,
          });
          runs++;
          const predicted = before.added + before.changed;
          if (!rebuild) {
            if (r.deleted !== before.deleted)
              fail.push(`${tag}: --check deleted ${before.deleted}, got ${r.deleted}`);
            if (unreadable ? r.indexed > predicted : r.indexed !== predicted) {
              fail.push(`${tag}: --check predicted ${predicted}, indexed ${r.indexed}`);
            }
          }
          if (inflated) return;
          if (!unmounted && total() !== ledger()) {
            fail.push(`${tag}: counted ${total()} calls but the ledger holds ${ledger()}`);
          }
          if (total() > everIds.size)
            fail.push(`${tag}: ${total()} calls > ${everIds.size} ever written`);
        };
        const settle = async (tag: string) => {
          for (let n = 1; n <= 4; n++) {
            const st = await inspectIndexStatus(db, Date.now(), [live]);
            if (st.added + st.changed + st.deleted === 0) {
              if (debt() !== 0) fail.push(`${tag}: settled with ${debt()} debt keys left`);
              const z = await reindex(db, {
                pricing: samplePricing,
                roots: [live],
                concurrency: 3,
              });
              runs++;
              if (z.indexed !== 0 || z.deleted !== 0)
                fail.push(`${tag}: a settled index still did work`);
              if (total() !== truth())
                fail.push(`${tag}: settled at ${total()} calls, disk has ${truth()}`);
              if (total() !== ledger())
                fail.push(`${tag}: settled with ${total()} calls, ledger ${ledger()}`);
              inflated = false;
              return;
            }
            // Settling runs are plain incremental runs: the point is that they converge.
            await step(`${tag}.settle${n}`, false, false, false);
          }
          fail.push(`${tag}: did not settle in 4 runs`);
        };

        ensure(0).parent = [USER, line(false), line(false)];
        note(copies[0]?.parent ?? []);
        const rounds = 4 + Math.floor(rnd() * 4);
        for (let round = 0; round < rounds && fail.length === 0; round++) {
          for (let k = 1 + Math.floor(rnd() * 3); k > 0; k--) {
            const op = Math.floor(rnd() * 8);
            const c = Math.floor(rnd() * 4);
            const o = Math.floor(rnd() * 4);
            const cp = copies[c];
            if (op === 0) {
              const x = ensure(c);
              x.parent ??= [USER];
              for (let q = 1 + Math.floor(rnd() * 2); q > 0; q--) x.parent.push(line(false));
              note(x.parent);
              log.push(`append ${c}`);
            } else if (op === 1) {
              const src = copies[o];
              if (!src || o === c) continue;
              const x = ensure(c);
              const full = rnd() < 0.6;
              if (src.parent) {
                x.parent = src.parent.slice(
                  0,
                  full ? undefined : Math.max(1, Math.floor(src.parent.length * rnd())),
                );
              }
              for (const [n, ls] of src.subs) {
                x.subs.set(n, full ? [...ls] : ls.slice(0, Math.floor(ls.length * rnd())));
              }
              log.push(`sync ${o}->${c}`);
            } else if (op === 2 && cp?.parent) {
              cp.parent = cp.parent.slice(0, Math.floor(cp.parent.length * rnd()));
              log.push(`truncate ${c}`);
            } else if (op === 3) {
              const x = ensure(c);
              const n = pick(SUBS);
              const ls = x.subs.get(n) ?? [];
              ls.push(line(true));
              note(ls);
              x.subs.set(n, ls);
              log.push(`sub+ ${c}`);
            } else if (op === 4 && cp) {
              cp.subs.clear();
              log.push(`subdel ${c}`);
            } else if (op === 5 && cp) {
              cp.parent = null;
              log.push(`pardel ${c}`);
            } else if (op === 6) {
              copies[c] = null;
              log.push(`del ${c}`);
            } else if (op === 7) {
              const src = copies[o];
              if (!src || o === c || src.subs.size === 0) continue;
              const n = pick([...src.subs.keys()]);
              ensure(c).subs.set(n, [...(src.subs.get(n) ?? [])]);
              log.push(`subcopy ${o}->${c}`);
            }
          }
          write();

          // Failure injection for this round's index runs only.
          const parents = [0, 1, 2, 3].map(parentOf).filter((p) => existsSync(p));
          const victims: string[] = [];
          if (rnd() < 0.35) {
            for (let q = 1 + Math.floor(rnd() * 2); q > 0 && parents.length; q--) {
              victims.push(parents.splice(Math.floor(rnd() * parents.length), 1)[0] as string);
            }
          }
          const unmount = rnd() < 0.12;
          log.push(`round ${round}: unreadable ${victims.length} unmount ${unmount}`);
          try {
            for (const p of victims) {
              chmodSync(p, 0o000);
              hurt.push(p);
            }
            if (unmount && existsSync(join(root, "projects"))) {
              away = { from: join(root, "projects"), to: join(root, "projects.away") };
              renameSync(away.from, away.to);
            }
            for (let r = 1 + Math.floor(rnd() * 2); r > 0; r--) {
              await step(`round ${round}`, victims.length > 0, unmount);
            }
          } finally {
            if (away && existsSync(away.to)) renameSync(away.to, away.from);
            away = undefined;
            for (const p of hurt.splice(0)) {
              try {
                chmodSync(p, 0o644);
              } catch {}
            }
          }
          if (rnd() < 0.5 || round === rounds - 1) await settle(`round ${round}`);
        }
      } finally {
        db.close();
      }
      if (fail.length > 0) {
        throw new Error(
          `scenario ${i} (seed ${seed}) failed:\n  ${fail.join("\n  ")}\n  ops: ${log.join(" | ")}`,
        );
      }
    }
    expect(runs).toBeGreaterThan(SCENARIOS);
  },
  120_000,
);
