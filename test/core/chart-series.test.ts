import { describe, expect, test } from "bun:test";
import { analyzeSession } from "../../src/core/analyze.ts";
import {
  buildBurnSeries,
  buildContextSeries,
  buildTurnSeries,
  dedupeCompactions,
  isOwnCompaction,
  pctOfLimit,
  summarizeCompactions,
} from "../../src/core/chart-series.ts";
import type { SessionEvent } from "../../src/core/events.ts";
import { samplePricing as pricing } from "../helpers/pricing.ts";

const ts = (s: number) => `2026-07-01T10:00:${String(s).padStart(2, "0")}.000Z`;

function assistant(
  id: string,
  second: number,
  usage: Record<string, number>,
  opts: { sidechain?: boolean } = {},
): SessionEvent {
  return {
    type: "assistant",
    uuid: id,
    isSidechain: opts.sidechain === true,
    timestamp: ts(second),
    message: {
      id: `msg_${id}`,
      role: "assistant",
      model: "claude-opus-4-7",
      stop_reason: "end_turn",
      content: [{ type: "text", text: "ok" }],
      usage,
    },
  } as unknown as SessionEvent;
}

const prompt = (id: string, second: number, text: string): SessionEvent =>
  ({
    type: "user",
    uuid: id,
    timestamp: ts(second),
    message: { role: "user", content: text },
  }) as unknown as SessionEvent;

/** Two turns; call b runs on a sidechain; a compaction lands between c and d. */
const events: SessionEvent[] = [
  prompt("u1", 0, "first"),
  assistant("a", 5, { input_tokens: 100, output_tokens: 10 }),
  assistant("b", 6, { input_tokens: 999, output_tokens: 5 }, { sidechain: true }),
  assistant("c", 10, { input_tokens: 50, output_tokens: 10, cache_read_input_tokens: 200 }),
  {
    type: "system",
    subtype: "compact_boundary",
    timestamp: ts(12),
    compactMetadata: { trigger: "auto", preTokens: 260 },
  } as unknown as SessionEvent,
  prompt("u2", 14, "second"),
  assistant("d", 15, { input_tokens: 30, output_tokens: 10, cache_creation_input_tokens: 40 }),
];

const analysis = analyzeSession(events, pricing);

describe("buildContextSeries", () => {
  test("charts main-chain calls only, with prompt-side context tokens", () => {
    const s = buildContextSeries(analysis);
    // a, c, d — the sidechain call b runs in its own context window.
    expect(s.points).toHaveLength(3);
    expect(s.points.map((p) => p.contextTokens)).toEqual([100, 250, 70]);
    expect(s.points.map((p) => p.turnIndex)).toEqual([0, 0, 1]);
    expect(s.points[1]?.cachedTokens).toBe(200);
    expect(s.peakTokens).toBe(250);
  });

  test("maps compactions onto the first call at-or-after their timestamp", () => {
    const s = buildContextSeries(analysis);
    expect(s.markers).toHaveLength(1);
    expect(s.markers[0]?.pos).toBe(2); // call d is the first post-compaction call
    expect(s.markers[0]?.compaction.trigger).toBe("auto");
    expect(s.markers[0]?.compaction.preTokens).toBe(260);
  });

  test("a compaction after the last call maps to the series length", () => {
    const tail = analyzeSession(
      [
        prompt("u1", 0, "only"),
        assistant("a", 5, { input_tokens: 10, output_tokens: 1 }),
        {
          type: "system",
          subtype: "compact_boundary",
          timestamp: ts(30),
          compactMetadata: { trigger: "manual", preTokens: 11 },
        } as unknown as SessionEvent,
      ],
      pricing,
    );
    const s = buildContextSeries(tail);
    expect(s.markers[0]?.pos).toBe(1);
  });

  test("a subagent compaction is counted but never marked on the main chart", () => {
    const withSide = {
      ...analysis,
      compactions: [{ timestamp: ts(12), trigger: "auto", isSidechain: true }],
    };
    const s = buildContextSeries(withSide);
    expect(s.points).toHaveLength(3);
    expect(s.markers).toEqual([]);
  });

  test("empty for an aggregate-only analysis", () => {
    const s = buildContextSeries({ ...analysis, turns: [] });
    expect(s.points).toEqual([]);
    expect(s.markers).toEqual([]);
  });
});

describe("summarizeCompactions", () => {
  test("splits own/sidechain/inherited and buckets triggers, unknown included", () => {
    const b = summarizeCompactions([
      { timestamp: ts(1), trigger: "auto" },
      { timestamp: ts(2), trigger: "manual" },
      { timestamp: ts(3) }, // legacy summary-only record: trigger unknown
      { timestamp: ts(4), trigger: "auto", isSidechain: true },
      { timestamp: ts(5), inherited: true },
    ]);
    expect(b.own).toHaveLength(3);
    expect(b.triggers).toEqual({ auto: 1, manual: 1, unknown: 1 });
    expect(b.sidechain).toBe(1);
    expect(b.inherited).toBe(1);
    expect([...b.own, { isSidechain: true }, { inherited: true }].filter(isOwnCompaction)).toEqual(
      b.own,
    );
  });
});

describe("buildBurnSeries", () => {
  test("accumulates every call in timestamp order, splitting sidechain spend", () => {
    const s = buildBurnSeries(analysis);
    expect(s).toHaveLength(4);
    // Timestamp order interleaves the sidechain call between a and c.
    expect(s.map((p) => p.isSidechain)).toEqual([false, true, false, false]);
    const last = s[s.length - 1];
    expect(last?.cost).toBeCloseTo(analysis.totals.cost.total, 10);
    expect(last?.sidechainCost).toBeCloseTo(analysis.totals.sidechainCost, 10);
    // Cumulative cost is monotone.
    for (let i = 1; i < s.length; i++) {
      expect((s[i]?.cost ?? 0) >= (s[i - 1]?.cost ?? 0)).toBe(true);
    }
  });

  test("a timestamp-less call keeps its stored position", () => {
    // Middle call loses its timestamp (tolerant parser keeps such events):
    // it must stay anchored after its predecessor, not jump to the front.
    const noTs = analyzeSession(
      [
        prompt("u1", 0, "p"),
        assistant("a", 5, { input_tokens: 1, output_tokens: 1 }),
        {
          ...(assistant("b", 6, { input_tokens: 2, output_tokens: 2 }) as Record<string, unknown>),
          timestamp: undefined,
        } as unknown as SessionEvent,
        assistant("c", 10, { input_tokens: 3, output_tokens: 3 }),
      ],
      pricing,
    );
    const s = buildBurnSeries(noTs);
    // Order stays a, b, c — the untimed b sits between a and c (per-call
    // costs rise with token counts, so order is observable through them).
    expect(s.map((p) => p.ms !== undefined)).toEqual([true, false, true]);
    expect((s[0]?.callCost ?? 0) < (s[1]?.callCost ?? 0)).toBe(true);
    expect((s[1]?.callCost ?? 0) < (s[2]?.callCost ?? 0)).toBe(true);
  });
});

describe("buildTurnSeries", () => {
  test("one bar-shaped point per turn", () => {
    const s = buildTurnSeries(analysis);
    expect(s).toHaveLength(2);
    expect(s[0]?.apiCalls).toBe(3); // a, sidechain b, c
    expect(s[0]?.mainApiCalls).toBe(2);
    expect(s[0]?.prompt).toBe("first");
    expect(s[1]?.cost).toBeCloseTo(analysis.turns[1]?.cost.total ?? -1, 10);
  });
});

describe("dedupeCompactions / pctOfLimit", () => {
  test("dedupes across a shared seen-set; uuid-less records always pass", () => {
    const seen = new Set<string>();
    const rowA = dedupeCompactions(
      [{ uuid: "x", trigger: "auto" }, { uuid: "y", isSidechain: true }, { trigger: "manual" }],
      seen,
    );
    expect(rowA).toHaveLength(3);
    // A copied row: both uuid'd records (own AND sidechain) drop, uuid-less stays.
    const rowB = dedupeCompactions(
      [{ uuid: "x", trigger: "auto" }, { uuid: "y", isSidechain: true }, { trigger: "manual" }],
      seen,
    );
    expect(rowB).toEqual([{ trigger: "manual" }]);
  });

  test("pctOfLimit rounds to whole percent", () => {
    expect(pctOfLimit(158_100, 200_000)).toBe(79);
    expect(pctOfLimit(210_000, 200_000)).toBe(105);
  });
});

describe("buildContextSeries · context limit sanity", () => {
  test("drops a limit the peak wildly exceeds (wrong-window heuristic match)", () => {
    // flatPricing says 200k, but this session peaked at 750k prompt-side —
    // a bigger-window variant priced by the family heuristic. No limit line.
    const big = analyzeSession(
      [prompt("u1", 0, "p"), assistant("a", 5, { input_tokens: 750_000, output_tokens: 10 })],
      pricing,
    );
    const s = buildContextSeries(big);
    expect(s.peakTokens).toBe(750_000);
    expect(s.contextLimit).toBeUndefined();
  });

  test("keeps the limit under slight overshoot (the overflowing call itself)", () => {
    const slight = analyzeSession(
      [prompt("u1", 0, "p"), assistant("a", 5, { input_tokens: 205_000, output_tokens: 10 })],
      pricing,
    );
    expect(buildContextSeries(slight).contextLimit).toBe(200_000);
  });
});
