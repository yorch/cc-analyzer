import { describe, expect, test } from "bun:test";
import { analyzeSession, type SessionAnalysis } from "../../src/core/analyze.ts";
import { burstAttributionNote } from "../../src/core/chart-series.ts";
import type { AgentMeta } from "../../src/core/events.ts";
import { assistantEvent, clock, toolUseBlock } from "../helpers/events.ts";
import { samplePricing } from "../helpers/pricing.ts";

type Events = Parameters<typeof analyzeSession>[0];

const at = clock(2026, 1, 1, 12);

const prompt = (uuid: string, min: number, text: string) => ({
  type: "user",
  uuid,
  timestamp: at(min),
  message: { content: text },
});

/** A main-chain assistant line, optionally spawning subagents. */
const main = (id: string, min: number, content?: unknown[]) =>
  assistantEvent({
    uuid: `a-${id}`,
    timestamp: at(min),
    requestId: `req-${id}`,
    messageId: `msg-${id}`,
    content,
  });

/**
 * An assistant line from a `subagents/agent-<agentId>.jsonl` transcript: the
 * layout stamps `agentId` on every event, so no parentUuid walk is needed.
 */
const agentCall = (agentId: string, id: string, min: number) => ({
  ...(assistantEvent({
    uuid: `a-${id}`,
    timestamp: at(min),
    isSidechain: true,
    requestId: `req-${id}`,
    messageId: `msg-${id}`,
  }) as Record<string, unknown>),
  agentId,
});

/** A sidechain root/call under the older inline layout (no agentId). */
const sideRoot = (uuid: string, min: number, text: string) => ({
  type: "user",
  uuid,
  timestamp: at(min),
  isSidechain: true,
  message: { content: text },
});
const sideCall = (uuid: string, min: number, parentUuid: string) =>
  assistantEvent({
    uuid,
    timestamp: at(min),
    parentUuid,
    isSidechain: true,
    requestId: `req-${uuid}`,
    messageId: `msg-${uuid}`,
  });

function analyze(events: unknown[], agentMeta?: Map<string, AgentMeta>): SessionAnalysis {
  return analyzeSession(events as Events, samplePricing, { agentMeta });
}

const meta = (entries: Record<string, AgentMeta>) => new Map(Object.entries(entries));

describe("subagent attribution via the per-session subagents/ layout", () => {
  test("names a burst from its .meta.json rather than by matching prompts", () => {
    const a = analyze(
      [
        prompt("u1", 0, "go"),
        main("1", 1, [toolUseBlock("t1", "Task", { subagent_type: "wrong-guess", prompt: "x" })]),
        agentCall("aaa", "s1", 2),
        agentCall("aaa", "s2", 3),
      ],
      meta({ aaa: { agentType: "general-purpose", spawnDepth: 1 } }),
    );

    expect(a.sidechainBursts).toHaveLength(1);
    const [burst] = a.sidechainBursts;
    expect(burst?.agentId).toBe("aaa");
    expect(burst?.subagentType).toBe("general-purpose");
    expect(burst?.spawnDepth).toBe(1);
  });

  test("a nested agent gets its own burst, not its spawner's", () => {
    const a = analyze(
      [
        prompt("u1", 0, "go"),
        main("1", 1),
        agentCall("parent", "s1", 2),
        agentCall("child", "s2", 3),
      ],
      meta({
        parent: { agentType: "general-purpose", spawnDepth: 1 },
        child: { agentType: "code-reviewer", spawnDepth: 2 },
      }),
    );

    expect(a.sidechainBursts).toHaveLength(2);
    expect(a.sidechainBursts.map((b) => b.spawnDepth)).toEqual([1, 2]);
    expect(a.sidechainBursts.map((b) => b.subagentType)).toEqual([
      "general-purpose",
      "code-reviewer",
    ]);
  });

  test("an agent with no readable meta keeps exact identity but stays unnamed", () => {
    const a = analyze([prompt("u1", 0, "go"), main("1", 1), agentCall("aaa", "s1", 2)]);

    expect(a.sidechainBursts[0]?.agentId).toBe("aaa");
    expect(a.sidechainBursts[0]?.subagentType).toBeUndefined();
  });

  test("subagent calls count toward the session's sidechain split", () => {
    const a = analyze([
      prompt("u1", 0, "go"),
      main("1", 1),
      agentCall("aaa", "s1", 2),
      agentCall("aaa", "s2", 3),
    ]);

    expect(a.totals.apiCalls).toBe(3);
    expect(a.totals.sidechainApiCalls).toBe(2);
    expect(a.totals.sidechainCost).toBeGreaterThan(0);
    const burstCost = a.sidechainBursts.reduce((s, b) => s + b.cost, 0);
    expect(burstCost).toBeCloseTo(a.totals.sidechainCost, 10);
  });

  test("a subagent call bills to the turn that was open when it happened", () => {
    const a = analyze([
      prompt("u1", 0, "first"),
      main("1", 1),
      agentCall("aaa", "s1", 2),
      prompt("u2", 10, "second"),
      main("2", 11),
    ]);

    // The burst belongs to turn 0 — appending subagent files instead of merging
    // by timestamp would push it onto the final turn.
    expect(a.sidechainBursts[0]?.turnIndex).toBe(0);
  });

  test("exact and prompt-matched bursts coexist without tripping the zip fallback", () => {
    const a = analyze(
      [
        prompt("u1", 0, "go"),
        main("1", 1, [
          toolUseBlock("t1", "Task", { subagent_type: "explorer", prompt: "find the config" }),
        ]),
        // One agent from the new layout…
        agentCall("aaa", "s1", 2),
        // …and one burst from the older inline layout, named by its prompt.
        sideRoot("sr", 3, "find the config"),
        sideCall("s2", 4, "sr"),
      ],
      meta({ aaa: { agentType: "general-purpose" } }),
    );

    expect(a.sidechainBursts).toHaveLength(2);
    const byId = new Map(a.sidechainBursts.map((b) => [b.agentId ?? "inline", b.subagentType]));
    expect(byId.get("aaa")).toBe("general-purpose");
    expect(byId.get("inline")).toBe("explorer");
  });

  test("a burst table always carries a note explaining how it was named", () => {
    // About a quarter of real subagent transcripts ship no .meta.json (Claude
    // Code's own compaction agents among them), so "nothing named" is common,
    // and an unexplained table of (unmatched) rows reads as a defect.
    const unnamed = analyze([prompt("u1", 0, "go"), main("1", 1), agentCall("aaa", "s1", 2)]);
    expect(burstAttributionNote(unnamed.sidechainBursts)).toContain("no type metadata");

    const named = analyze(
      [prompt("u1", 0, "go"), main("1", 1), agentCall("aaa", "s1", 2)],
      meta({ aaa: { agentType: "general-purpose" } }),
    );
    expect(burstAttributionNote(named.sidechainBursts)).toContain("own metadata");

    // Nothing to caveat when there are no bursts at all.
    expect(burstAttributionNote([])).toBeUndefined();
  });

  test("the inline layout is unaffected when no agentId is present", () => {
    const events = [
      prompt("u1", 0, "go"),
      main("1", 1, [toolUseBlock("t1", "Task", { subagent_type: "digger", prompt: "dig here" })]),
      sideRoot("sr", 2, "dig here"),
      sideCall("s1", 3, "sr"),
    ];

    // Passing a meta map for an unrelated agent must not change the outcome.
    const withMeta = analyze(events, meta({ zzz: { agentType: "irrelevant" } }));
    const without = analyze(events);

    expect(without.sidechainBursts[0]?.subagentType).toBe("digger");
    expect(without.sidechainBursts[0]?.agentId).toBeUndefined();
    expect(withMeta.sidechainBursts).toEqual(without.sidechainBursts);
  });
});
