import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
  analyzeSession,
  analyzeSessionStream,
  type SessionAnalysis,
} from "../../src/core/analyze.ts";
import { openDb } from "../../src/core/db.ts";
import { contextTax } from "../../src/core/stats.ts";
import { assistantEvent, clock, promptEvent } from "../helpers/events.ts";
import { samplePricing as pricing } from "../helpers/pricing.ts";
import { insertSession } from "../helpers/sessions.ts";

type Events = Parameters<typeof analyzeSession>[0];

const at = clock(2026, 1, 1, 12);

/** An assistant line with an explicit prompt-side usage mix. */
function assistant(opts: {
  id: string;
  min: number;
  sidechain?: boolean;
  input?: number;
  cacheRead?: number;
  write5m?: number;
  write1h?: number;
}) {
  return assistantEvent({
    uuid: `a-${opts.id}`,
    timestamp: at(opts.min),
    isSidechain: opts.sidechain,
    requestId: `req-${opts.id}`,
    messageId: `msg-${opts.id}`,
    stopReason: null,
    usage: {
      input_tokens: opts.input ?? 0,
      output_tokens: 500,
      cache_read_input_tokens: opts.cacheRead ?? 0,
      cache_creation: {
        ephemeral_5m_input_tokens: opts.write5m ?? 0,
        ephemeral_1h_input_tokens: opts.write1h ?? 0,
      },
    },
  });
}

const prompt = promptEvent("u1", at(0), "hi");

const analyze = (events: unknown[]): SessionAnalysis => analyzeSession(events as Events, pricing);

describe("firstPromptTokens", () => {
  test("sums all four prompt-side categories of the first main-chain call", () => {
    const a = analyze([
      prompt,
      assistant({ id: "1", min: 1, input: 100, cacheRead: 20_000, write5m: 3000, write1h: 500 }),
      // A later, much bigger call must not move the baseline.
      assistant({ id: "2", min: 2, input: 900_000 }),
    ]);
    // Output tokens are deliberately excluded — this is the prompt side only.
    expect(a.firstPromptTokens).toBe(100 + 20_000 + 3000 + 500);
  });

  test("skips a sidechain call that precedes the first main-chain call", () => {
    const a = analyze([
      prompt,
      // Subagents run in their own context window — not this session's tax.
      assistant({ id: "sub", min: 1, sidechain: true, input: 999_999 }),
      assistant({ id: "1", min: 2, input: 12_345 }),
    ]);
    expect(a.firstPromptTokens).toBe(12_345);
  });

  test("takes the de-duplicated call, not a streamed continuation line", () => {
    const first = assistant({ id: "1", min: 1, input: 7000, cacheRead: 1000 });
    // Same message id + requestId: one API response logged as two lines. The
    // repeated usage must neither be re-read nor double-counted.
    const continuation = assistant({ id: "1", min: 1, input: 7000, cacheRead: 1000 });
    const a = analyze([prompt, first, continuation]);
    expect(a.totals.apiCalls).toBe(1);
    expect(a.firstPromptTokens).toBe(8000);
  });

  test("is undefined when the session has no main-chain API call", () => {
    expect(analyze([prompt]).firstPromptTokens).toBeUndefined();
    expect(
      analyze([prompt, assistant({ id: "s", min: 1, sidechain: true, input: 500 })])
        .firstPromptTokens,
    ).toBeUndefined();
  });

  test("is populated in aggregate mode (detail: false), like the indexer runs it", async () => {
    const events = [
      prompt,
      assistant({ id: "1", min: 1, input: 40, cacheRead: 9000, write5m: 960 }),
    ];
    async function* stream() {
      for (const e of events) yield e as Events[number];
    }
    const a = await analyzeSessionStream(stream(), pricing, { detail: false });
    expect(a.turns).toHaveLength(0); // aggregate mode really is on
    expect(a.firstPromptTokens).toBe(10_000);
  });
});

/** Seed one session row carrying a context-tax baseline. */
function seed(db: Database, path: string, project: string, baseline: number | null): void {
  insertSession(db, {
    path,
    project_id: project,
    project_path: `/p/${project}`,
    first_prompt_tokens: baseline,
  });
}

describe("contextTax", () => {
  test("takes per-project percentiles and ranks by median", () => {
    const db = openDb(":memory:");
    // heavy: 10k, 20k, 90k → median 20k, p90 76k, avg 40k
    seed(db, "h1", "heavy", 10_000);
    seed(db, "h2", "heavy", 20_000);
    seed(db, "h3", "heavy", 90_000);
    // light: 4k, 6k → median 5k
    seed(db, "l1", "light", 4000);
    seed(db, "l2", "light", 6000);

    const tax = contextTax(db);
    expect(tax.byProject.map((p) => p.projectId)).toEqual(["heavy", "light"]);

    const heavy = tax.byProject[0];
    expect(heavy?.sessions).toBe(3);
    expect(heavy?.medianTokens).toBe(20_000);
    expect(heavy?.avgTokens).toBeCloseTo(40_000, 6);
    // Linear interpolation between 20k and 90k at p90: 20k + 0.8 × 70k.
    expect(heavy?.p90Tokens).toBeCloseTo(76_000, 6);
    expect(tax.byProject[1]?.medianTokens).toBe(5000);

    // Portfolio: 4k, 6k, 10k, 20k, 90k → median 10k.
    expect(tax.summary.sessions).toBe(5);
    expect(tax.summary.medianTokens).toBe(10_000);
    db.close();
  });

  test("excludes sessions with no baseline rather than treating them as zero", () => {
    const db = openDb(":memory:");
    seed(db, "a", "p", 30_000);
    seed(db, "b", "p", null); // no main-chain API call
    const tax = contextTax(db);
    expect(tax.summary.sessions).toBe(1);
    expect(tax.summary.medianTokens).toBe(30_000);
    expect(tax.byProject[0]?.sessions).toBe(1);
    db.close();
  });

  test("scopes to one project and reports an empty summary when nothing is indexed", () => {
    const db = openDb(":memory:");
    seed(db, "a", "one", 1000);
    seed(db, "b", "two", 2000);
    expect(contextTax(db, "two").byProject.map((p) => p.projectId)).toEqual(["two"]);
    expect(contextTax(db, "missing")).toEqual({
      summary: { sessions: 0, medianTokens: 0, p90Tokens: 0 },
      byProject: [],
    });
    db.close();
  });
});
