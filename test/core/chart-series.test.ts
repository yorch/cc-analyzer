import { describe, expect, test } from "bun:test";
import { analyzeSession } from "../../src/core/analyze.ts";
import {
  buildBurnSeries,
  buildCacheSeries,
  buildContextSeries,
  buildGapMarkers,
  buildTurnSeries,
  dedupeCompactions,
  isOwnCompaction,
  modelMixRows,
  pctOfLimit,
  projectHeadroom,
  summarizeCompactions,
} from "../../src/core/chart-series.ts";
import type { SessionEvent } from "../../src/core/events.ts";
import { assistantEvent, clock, promptEvent } from "../helpers/events.ts";
import { samplePricing as pricing } from "../helpers/pricing.ts";

const day = clock(2026, 7, 1, 10);
const ts = (s: number) => day(0, s);

const assistant = (
  id: string,
  second: number,
  usage: Record<string, number>,
  opts: { sidechain?: boolean } = {},
): SessionEvent =>
  assistantEvent({
    uuid: id,
    timestamp: ts(second),
    isSidechain: opts.sidechain === true,
    stopReason: "end_turn",
    usage,
  });

const prompt = (id: string, second: number, text: string): SessionEvent =>
  promptEvent(id, ts(second), text);

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

describe("compaction reclaim annotation", () => {
  test("reclaimed = preTokens minus the first post-compaction call's context", () => {
    const s = buildContextSeries(analysis);
    // preTokens 260, call d's context is 70 → 190 reclaimed.
    expect(s.markers[0]?.reclaimed).toBe(190);
  });

  test("undefined when the compaction closed the session (no call after)", () => {
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
    expect(buildContextSeries(tail).markers[0]?.reclaimed).toBeUndefined();
  });
});

describe("buildCacheSeries", () => {
  test("splits cached vs fresh per call and weights the session hit rate", () => {
    const s = buildCacheSeries(buildContextSeries(analysis));
    expect(s.points).toHaveLength(3);
    expect(s.points.map((p) => p.cached)).toEqual([0, 200, 0]);
    expect(s.points.map((p) => p.fresh)).toEqual([100, 50, 70]);
    expect(s.points[1]?.hitPct).toBe(80);
    // Token-weighted: 200 cached of 420 context.
    expect(s.hitPct).toBe(48);
    expect(s.coldCalls).toBe(2);
  });
});

describe("projectHeadroom", () => {
  const growing = analyzeSession(
    [
      prompt("u1", 0, "p"),
      assistant("a", 5, { input_tokens: 10_000, output_tokens: 1 }),
      assistant("b", 6, { input_tokens: 20_000, output_tokens: 1 }),
      assistant("c", 7, { input_tokens: 30_000, output_tokens: 1 }),
    ],
    pricing,
  );

  test("extrapolates calls-to-limit from the open segment's growth", () => {
    const h = projectHeadroom(buildContextSeries(growing));
    expect(h?.perCallTokens).toBe(10_000);
    // (200k − 30k) / 10k per call.
    expect(h?.callsToLimit).toBe(17);
  });

  test("undefined for flat context, short segments, or an unknown limit", () => {
    const flat = analyzeSession(
      [
        prompt("u1", 0, "p"),
        assistant("a", 5, { input_tokens: 100, output_tokens: 1 }),
        assistant("b", 6, { input_tokens: 100, output_tokens: 1 }),
        assistant("c", 7, { input_tokens: 100, output_tokens: 1 }),
      ],
      pricing,
    );
    expect(projectHeadroom(buildContextSeries(flat))).toBeUndefined();
    expect(projectHeadroom(buildContextSeries(analysis))).toBeUndefined(); // 3 calls, but segment after the marker is 1
    const noLimit = { ...buildContextSeries(growing), contextLimit: undefined };
    expect(projectHeadroom(noLimit)).toBeUndefined();
  });
});

describe("buildGapMarkers", () => {
  test("marks gaps above the threshold, positioned on the call after", () => {
    const burn = buildBurnSeries(analysis);
    // Calls at +5s, +6s, +10s, +15s: with a 3-second threshold the 4s and 5s
    // gaps mark positions 2 and 3.
    expect(buildGapMarkers(burn, 3_000)).toEqual([
      { pos: 2, durationMs: 4_000 },
      { pos: 3, durationMs: 5_000 },
    ]);
    // Under the real 5-minute threshold this session has no idle gaps.
    expect(buildGapMarkers(burn)).toEqual([]);
  });

  test("uses the shared 5-minute idle threshold by default", () => {
    const idle = analyzeSession(
      [
        prompt("u1", 0, "p"),
        assistant("a", 5, { input_tokens: 1, output_tokens: 1 }),
        assistant("b", 900, { input_tokens: 1, output_tokens: 1 }), // +15 min
      ],
      pricing,
    );
    const gaps = buildGapMarkers(buildBurnSeries(idle));
    expect(gaps).toHaveLength(1);
    expect(gaps[0]?.pos).toBe(1);
    expect(gaps[0]?.durationMs).toBe(895_000);
  });
});

describe("buildTurnSeries · composition, activity, and signal flags", () => {
  test("cost categories sum to the turn's total and step kinds are counted", () => {
    const s = buildTurnSeries(analysis);
    for (const t of s) {
      expect(t.costInput + t.costOutput + t.costCacheWrite + t.costCacheRead).toBeCloseTo(
        t.cost,
        10,
      );
    }
    // u1 at +0s through the compact boundary at +12s (any event in the open
    // turn extends its wall span, same as Turn.endTime).
    expect(s[0]?.wallMs).toBe(12_000);
  });

  test("carries tool activity, errors, and per-turn signal flags", () => {
    const withTools = analyzeSession(
      [
        prompt("u1", 0, "run it"),
        assistantEvent({
          uuid: "a",
          timestamp: ts(5),
          content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "bun test" } }],
        }),
        {
          type: "user",
          uuid: "r1",
          timestamp: ts(6),
          message: {
            content: [{ type: "tool_result", tool_use_id: "t1", is_error: true, content: "boom" }],
          },
        } as unknown as SessionEvent,
        prompt("u2", 20, "no, run only the unit tests"),
        assistantEvent({ uuid: "b", timestamp: ts(25) }),
      ],
      pricing,
    );
    const s = buildTurnSeries(withTools);
    expect(s[0]?.kindCounts.run).toBe(1);
    expect(s[0]?.toolErrors).toBe(1);
    expect(s[0]?.testFailures).toBe(1);
    expect(s[0]?.correction).toBe(false);
    expect(s[1]?.correction).toBe(true);
  });
});

describe("modelMixRows", () => {
  test("ranks the session's models by cost with shares summing to 1", () => {
    const mixed = analyzeSession(
      [
        prompt("u1", 0, "p"),
        assistantEvent({
          uuid: "a",
          timestamp: ts(5),
          model: "claude-opus-4-7",
          usage: { input_tokens: 1000, output_tokens: 100 },
        }),
        assistantEvent({
          uuid: "b",
          timestamp: ts(6),
          model: "claude-sonnet-4-5",
          usage: { input_tokens: 10, output_tokens: 1 },
        }),
      ],
      pricing,
    );
    const rows = modelMixRows(mixed);
    expect(rows.map((r) => r.model)).toEqual(["claude-opus-4-7", "claude-sonnet-4-5"]);
    expect(rows.reduce((s, r) => s + r.share, 0)).toBeCloseTo(1, 10);
    expect(rows[0]?.apiCalls).toBe(1);
  });
});
