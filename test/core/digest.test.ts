import { describe, expect, test } from "bun:test";
import {
  buildDigestMarkdown,
  digestDelta,
  digestDuration,
  digestMoney,
  formatDigestDelta,
  isDayString,
  isEmptyPeriod,
  lastCompleteWeek,
  periodDays,
  priorPeriod,
  type WeeklyDigest,
  weekPeriod,
} from "../../src/core/digest.ts";
import { CORRECTION_CAVEAT, SKILL_COST_CAVEAT } from "../../src/core/stats-types.ts";

describe("digest period resolution", () => {
  test("defaults to the last COMPLETE ISO week from a mid-week today", () => {
    // 2026-07-15 is a Wednesday; its week starts Mon 2026-07-13, so the last
    // finished week is the one before it.
    expect(lastCompleteWeek("2026-07-15")).toEqual({ start: "2026-07-06", end: "2026-07-12" });
  });

  test("never returns the running week, whatever weekday today is", () => {
    for (const today of ["2026-07-13", "2026-07-14", "2026-07-18", "2026-07-19"]) {
      const p = lastCompleteWeek(today);
      expect(p).toEqual({ start: "2026-07-06", end: "2026-07-12" });
      expect(p.end < today).toBe(true);
    }
  });

  test("weekPeriod takes the whole Mon–Sun week containing any day", () => {
    const monday = weekPeriod("2026-07-06");
    expect(monday).toEqual({ start: "2026-07-06", end: "2026-07-12" });
    // Any other day inside the week resolves to the same period.
    expect(weekPeriod("2026-07-09")).toEqual(monday);
    expect(weekPeriod("2026-07-12")).toEqual(monday); // Sunday
  });

  test("prior period is the equally long span immediately before", () => {
    const p = { start: "2026-07-06", end: "2026-07-12" };
    expect(periodDays(p)).toBe(7);
    expect(priorPeriod(p)).toEqual({ start: "2026-06-29", end: "2026-07-05" });
    // Non-weekly spans shift by their own length, not by a hard-coded 7.
    expect(priorPeriod({ start: "2026-07-10", end: "2026-07-12" })).toEqual({
      start: "2026-07-07",
      end: "2026-07-09",
    });
  });

  test("isDayString accepts real calendar days only", () => {
    expect(isDayString("2026-07-06")).toBe(true);
    expect(isDayString("2026-02-30")).toBe(false);
    expect(isDayString("2026-7-6")).toBe(false);
    expect(isDayString("last monday")).toBe(false);
    expect(isDayString("")).toBe(false);
  });
});

describe("digest delta math", () => {
  test("carries absolute and relative change", () => {
    expect(digestDelta(12, 10)).toEqual({ current: 12, prior: 10, absolute: 2, share: 0.2 });
    expect(digestDelta(5, 10)).toEqual({ current: 5, prior: 10, absolute: -5, share: -0.5 });
  });

  test("share is null when the prior period was empty — no percentage exists", () => {
    const d = digestDelta(42, 0);
    expect(d.share).toBeNull();
    expect(d.absolute).toBe(42);
    // …and both directions of "nothing happened" stay safe.
    expect(digestDelta(0, 0)).toEqual({ current: 0, prior: 0, absolute: 0, share: null });
  });

  test("renders as an amount plus a signed percentage", () => {
    expect(formatDigestDelta(digestDelta(12.4, 10.5), digestMoney)).toBe("+$1.90 (+18%)");
    expect(formatDigestDelta(digestDelta(5, 10), digestMoney)).toBe("-$5.00 (-50%)");
    // No baseline → "new" instead of a division by zero.
    expect(formatDigestDelta(digestDelta(3, 0), digestMoney)).toBe("+$3.00 (new)");
    expect(formatDigestDelta(digestDelta(7, 7), (n) => String(n))).toBe("no change");
  });

  test("durations render compactly in both directions", () => {
    expect(digestDuration(45_000)).toBe("45s");
    expect(digestDuration(1000 * 60 * 95)).toBe("1h 35m");
    expect(digestDuration(-1000 * 60 * 10)).toBe("-10m");
  });
});

/** A digest with one of everything, so the markdown assertions have content. */
function sampleDigest(overrides: Partial<WeeklyDigest> = {}): WeeklyDigest {
  return {
    period: { start: "2026-07-06", end: "2026-07-12" },
    prior: { start: "2026-06-29", end: "2026-07-05" },
    today: "2026-07-15",
    headline: {
      cost: digestDelta(12.4, 10.5),
      sessions: digestDelta(9, 7),
      activeMs: digestDelta(3_600_000, 1_800_000),
      ioTokens: digestDelta(120_000, 90_000),
      cacheTokens: digestDelta(3_000_000, 2_000_000),
    },
    projects: [
      {
        projectId: "p1",
        projectPath: "/p/one",
        cost: 9,
        sessions: 5,
        delta: digestDelta(9, 6),
      },
    ],
    models: [{ model: "claude-opus-4-7", calls: 40, cost: 12.4, priorCost: 10.5 }],
    cache: { writeCost: 4, readCost: 2, waste: 1.5, totalCost: 12.4 },
    reliability: {
      toolCalls: 120,
      toolErrors: 6,
      toolErrorRate: 0.05,
      testRuns: 8,
      testFailures: 3,
      retries: 2,
      worstTestFailStreak: 3,
      redundantReads: 4,
      correctionTurns: 2,
      interruptionTurns: 1,
      turns: 20,
      correctionShare: 0.1,
    },
    skills: [{ name: "tidy", invocations: 4, attributedTurns: 3, attributedCost: 2.25 }],
    insights: [
      {
        code: "cache-leaky",
        severity: "warning",
        title: "Cache writes are not amortizing",
        evidence: "$4.00 written, $1.50 never read back",
        action: "Keep sessions focused so cached context is reused.",
      },
    ],
    costBasis: "api",
    ...overrides,
  };
}

describe("buildDigestMarkdown", () => {
  const md = buildDigestMarkdown(sampleDigest());

  test("opens with an H2 naming the period and states the comparison", () => {
    expect(md.split("\n")[0]).toBe("## Claude Code weekly digest — 2026-07-06 → 2026-07-12");
    expect(md).toContain("Compared with 2026-06-29 → 2026-07-05.");
  });

  test("has every section header", () => {
    for (const header of [
      "### Summary",
      "### Top projects",
      "### Models",
      "### Cache",
      "### Reliability",
      "### Skills",
      "### Insights (current state, whole portfolio)",
    ]) {
      expect(md).toContain(header);
    }
  });

  test("renders deltas with their sign and percentage", () => {
    expect(md).toContain("+$1.90 (+18%)");
    expect(md).toContain("| Sessions | 9 | 7 | +2 (+29%) |");
  });

  test("carries the shared caveats verbatim where their numbers appear", () => {
    expect(md).toContain(SKILL_COST_CAVEAT);
    expect(md).toContain(CORRECTION_CAVEAT);
    // Scoping honesty travels with the report, not just the docs.
    expect(md).toContain("Sessions are attributed to their start day");
    expect(md).toContain("Insights above are current state");
  });

  test("prints the cost-framing sentence only for a subscription basis", () => {
    expect(md).not.toContain("API-equivalent value");
    const sub = buildDigestMarkdown(sampleDigest({ costBasis: "subscription" }));
    expect(sub).toContain("API-equivalent value");
  });

  test("contains no ANSI escapes — it is meant to be pasted, not printed", () => {
    expect(md).not.toContain("\u001B");
  });

  test("a zero-session period is reported, not treated as an error", () => {
    const empty = sampleDigest({
      headline: {
        cost: digestDelta(0, 10.5),
        sessions: digestDelta(0, 7),
        activeMs: digestDelta(0, 1_800_000),
        ioTokens: digestDelta(0, 90_000),
        cacheTokens: digestDelta(0, 2_000_000),
      },
      projects: [],
      models: [],
      skills: [],
    });
    expect(isEmptyPeriod(empty)).toBe(true);
    const text = buildDigestMarkdown(empty);
    expect(text).toContain("No sessions in this period.");
    // The prior week still gets reported so the line isn't a dead end…
    expect(text).toContain("The prior period had 7 sessions and $10.50 of usage.");
    // …but the period-scoped tables are skipped entirely.
    expect(text).not.toContain("### Summary");
    // Current-state insights still render — they don't depend on the period.
    expect(text).toContain("### Insights (current state, whole portfolio)");
    expect(text).toContain("Cache writes are not amortizing");
  });

  test("says so explicitly when no insight rule fired", () => {
    expect(buildDigestMarkdown(sampleDigest({ insights: [] }))).toContain(
      "No findings — the portfolio looks healthy by every rule.",
    );
  });
});
