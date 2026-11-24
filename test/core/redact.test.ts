import { describe, expect, test } from "bun:test";
import { analyzeSession, type SessionAnalysis } from "../../src/core/analyze.ts";
import { parseSessionText } from "../../src/core/parser.ts";
import {
  buildSessionJsonPayload,
  REDACT_KEPT_RECORD_KEYS,
  REDACT_KEPT_STRING_KEYS,
  REDACTED,
  redactAggregate,
  redactAnalysis,
  TRANSCRIPT_MAX_BODY_CHARS,
  TRANSCRIPT_MAX_ITEMS,
} from "../../src/core/redact.ts";
import { buildSessionHtml, buildSessionMarkdown } from "../../src/core/session-markdown.ts";
import type { TranscriptItem } from "../../src/core/transcript.ts";
import { samplePricing as pricing } from "../helpers/pricing.ts";

const CANARY = "CANARY";
type TurnStepLike = SessionAnalysis["turns"][number]["apiCalls"][number]["steps"][number];

async function baseAnalysis(): Promise<SessionAnalysis> {
  const text = await Bun.file(new URL("../fixtures/sample-session.jsonl", import.meta.url)).text();
  const parsed = parseSessionText(text);
  const a = analyzeSession(parsed.events, pricing, { coverage: parsed.coverage });
  // Populate every free-text field the fixture leaves empty.
  a.title = "a title";
  a.projectPath = "/p/proj";
  a.gitBranches = ["feat/x"];
  a.filesTouched = ["/p/proj/a.ts", "/p/proj/b.ts"];
  a.rereadFiles = ["/p/proj/a.ts"];
  a.bashCommands = { git: 2 };
  a.bashErrors = { git: 1 };
  a.commandHeads = { "git status": 2 };
  a.commandHeadErrors = { "git status": 1 };
  a.skills = { "my-skill": 2 };
  a.skillErrors = { "my-skill": 1 };
  a.skillTurnCosts = { "my-skill": { turns: 1, cost: 0.5 } };
  a.subagents = ["Explore"];
  a.sidechainBursts = [
    { subagentType: "Explore", agentId: "agent-1", apiCalls: 1, cost: 1, tokens: a.totals.tokens },
  ];
  a.compactions = [{ timestamp: "2026-07-01T10:00:00.000Z", uuid: "c1", trigger: "auto" }];
  return a;
}

/**
 * Canarize values only for keys the redactor does not know are safe, plus all
 * record keys — so the test exercises the "unknown string field" default.
 */
function canarizeValues(v: unknown): unknown {
  if (typeof v === "string") return `${v}${CANARY}`;
  if (Array.isArray(v)) return v.map(canarizeValues);
  if (typeof v === "object" && v !== null) {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, canarizeValues(x)]));
  }
  return v;
}

interface Hit {
  path: string;
  key: string;
  kind: "value" | "key";
  parentKey: string;
}

function findCanaries(v: unknown, key = "", parentKey = "", path = "$", hits: Hit[] = []): Hit[] {
  if (typeof v === "string") {
    if (v.includes(CANARY)) hits.push({ path, key, kind: "value", parentKey });
  } else if (Array.isArray(v)) {
    for (const [i, x] of v.entries()) findCanaries(x, key, parentKey, `${path}[${i}]`, hits);
  } else if (typeof v === "object" && v !== null) {
    for (const [k, x] of Object.entries(v)) {
      if (k.includes(CANARY))
        hits.push({ path: `${path}.${k}`, key: k, kind: "key", parentKey: key });
      findCanaries(x, k, key, `${path}.${k}`, hits);
    }
  }
  return hits;
}

describe("redactAnalysis", () => {
  test("canary: no string survives outside the explicit allowlists", async () => {
    const canaried = canarizeValues(await baseAnalysis()) as SessionAnalysis;
    const redacted = redactAnalysis(canaried);
    const hits = findCanaries(redacted);
    const illegal = hits.filter((h) => !REDACT_KEPT_STRING_KEYS.has(h.key));
    expect(illegal).toEqual([]);
    // sanity: the allowlist is exercised (model ids etc. do survive)
    expect(hits.length).toBeGreaterThan(0);
    // and the heavy hitters are gone
    const json = JSON.stringify(redacted);
    for (const leak of ["feat/x", "a.ts", "my-skill", "a title", "hello.ts", "hello function"]) {
      expect(json).not.toContain(leak);
    }
  });

  test("canary: record keys survive only in identifier-keyed records", async () => {
    const a = await baseAnalysis();
    // Canarize the KEYS of every record-typed field (structural keys stay intact).
    const recordFields = [
      "models",
      "tools",
      "toolErrors",
      "skills",
      "skillErrors",
      "skillTurnCosts",
      "stopReasons",
      "permissionModes",
      "bashCommands",
      "bashErrors",
      "commandHeads",
      "commandHeadErrors",
      "retriesByTool",
    ] as const;
    const rec = a as unknown as Record<string, Record<string, unknown>>;
    for (const f of recordFields) {
      rec[f] = Object.fromEntries(Object.entries(rec[f] ?? {}).map(([k, v]) => [k + CANARY, v]));
    }
    const out = redactAnalysis(a);
    const hits = findCanaries(out).filter((h) => h.kind === "key");
    expect(hits.length).toBeGreaterThan(0);
    for (const h of hits) expect(REDACT_KEPT_RECORD_KEYS.has(h.parentKey)).toBe(true);
    expect(out.bashCommands).toEqual({});
    expect(out.commandHeads).toEqual({});
    expect(Object.keys(out.skills)).toEqual(["skill-1"]);
    expect(Object.keys(out.skillTurnCosts)).toEqual(["skill-1"]);
  });

  test("keeps numeric metrics, tool names, model ids, timestamps; blanks text", async () => {
    const a = await baseAnalysis();
    const r = redactAnalysis(a);
    expect(r.totals).toEqual(a.totals);
    expect(r.tools).toEqual(a.tools);
    expect(Object.keys(r.models)).toEqual(Object.keys(a.models));
    expect(r.startTime).toBe(a.startTime);
    expect(r.title).toBe(REDACTED);
    expect(r.projectPath).toBe(REDACTED);
    expect(r.gitBranches).toEqual([REDACTED]);
    expect(r.filesTouched).toHaveLength(2);
    expect(r.filesTouched.every((f) => f === REDACTED)).toBe(true);
    expect(r.skills).toEqual({ "skill-1": 2 });
    expect(r.turns.length).toBe(a.turns.length);
    for (const t of r.turns) {
      expect(t.prompt).toBe(REDACTED);
      for (const c of t.apiCalls) {
        for (const s of c.steps) {
          expect(s.summary).toBe(REDACTED);
          expect(s.detail).toBeUndefined();
          if (s.resultHint !== undefined) expect(s.resultHint).toBe(REDACTED);
        }
      }
    }
    const steps = r.turns.flatMap((t) => t.apiCalls.flatMap((c) => c.steps));
    expect(steps.length).toBeGreaterThan(0);
    expect(steps.some((s) => s.tool === "Write")).toBe(true);
  });

  test("does not mutate its input", async () => {
    const a = await baseAnalysis();
    const before = JSON.stringify(a);
    redactAnalysis(a);
    expect(JSON.stringify(a)).toBe(before);
  });
});

describe("redactAggregate", () => {
  test("keeps numbers and dates, blanks other strings", () => {
    const out = redactAggregate({
      summary: { firstDay: "2026-07-01", cost: 3 },
      byProject: [{ project: "/home/me/secret", cost: 1 }],
      byModel: [{ model: "claude-opus-4-7", cost: 2 }],
    });
    expect(out.summary).toEqual({ firstDay: "2026-07-01", cost: 3 });
    expect(out.byProject[0]?.project).toBe(REDACTED);
    expect(out.byModel[0]?.model).toBe("claude-opus-4-7");
  });
});

describe("buildSessionJsonPayload", () => {
  const items: TranscriptItem[] = Array.from({ length: TRANSCRIPT_MAX_ITEMS + 5 }, (_, i) => ({
    index: i,
    turnIndex: 0,
    role: "user",
    kind: "prompt",
    label: "You",
    body: "x".repeat(TRANSCRIPT_MAX_BODY_CHARS + 50) + CANARY,
  }));

  test("always carries parseErrors; transcript capped and optional", async () => {
    const a = await baseAnalysis();
    const plain = buildSessionJsonPayload(a, { parseErrors: 3 });
    expect(plain.parseErrors).toBe(3);
    expect(plain.transcript).toBeUndefined();
    expect(buildSessionJsonPayload(a, {}).parseErrors).toBe(0);
    const withT = buildSessionJsonPayload(a, {
      includeTranscript: true,
      transcript: items,
    }) as { transcript: TranscriptItem[] };
    expect(withT.transcript).toHaveLength(TRANSCRIPT_MAX_ITEMS);
    expect(withT.transcript[0]?.body).toHaveLength(TRANSCRIPT_MAX_BODY_CHARS);
  });

  test("redact: payload carries no analysis or transcript text", async () => {
    const a = canarizeValues(await baseAnalysis()) as SessionAnalysis;
    const p = buildSessionJsonPayload(a, {
      redact: true,
      includeTranscript: true,
      transcript: items,
      parseErrors: 1,
    }) as { transcript: TranscriptItem[] };
    const illegal = findCanaries(p).filter((h) => !REDACT_KEPT_STRING_KEYS.has(h.key));
    expect(illegal).toEqual([]);
    expect(p.transcript.every((t) => t.body === REDACTED)).toBe(true);
  });

  test("redact does not touch the original analysis", async () => {
    const a = await baseAnalysis();
    buildSessionJsonPayload(a, { redact: true });
    expect(a.title).toBe("a title");
  });
});

describe("user-authored config names", () => {
  const MCP = "acme-payroll-db";
  const AGENT = "acme-secret-agent";
  const BOGUS = "bogus-trigger-acme-xyz";

  async function leaky(): Promise<SessionAnalysis> {
    const a = await baseAnalysis();
    const tool = `mcp__${MCP}__query`;
    a.tools = { ...a.tools, [tool]: 3 };
    a.toolErrors = { ...a.toolErrors, [tool]: 1 };
    a.retriesByTool = { ...a.retriesByTool, [tool]: 1 };
    const t0 = a.turns[0];
    if (t0) {
      t0.toolCounts = { ...t0.toolCounts, [tool]: 2 };
      t0.apiCalls[0]?.steps.push({
        kind: "tool",
        tool,
        label: tool,
      } as unknown as TurnStepLike);
    }
    a.subagents = ["Explore", AGENT];
    a.sidechainBursts = [
      { subagentType: AGENT, agentId: "a1", apiCalls: 1, cost: 1, tokens: a.totals.tokens },
      { subagentType: "Explore", agentId: "a2", apiCalls: 1, cost: 1, tokens: a.totals.tokens },
    ];
    a.compactions = [{ timestamp: "2026-07-01T10:00:00.000Z", uuid: "c1", trigger: BOGUS }];
    a.stopReasons = { end_turn: 1, [BOGUS]: 1 };
    a.permissionModes = { default: 1, [BOGUS]: 1 };
    a.versions = ["2.1.0", BOGUS];
    return a;
  }

  test("none survive in JSON, markdown or HTML; stable aliases; allowlisted enums kept", async () => {
    const a = await leaky();
    const r = redactAnalysis(a);
    expect(r.tools["mcp__mcp-server-1__query"]).toBe(3);
    expect(r.toolErrors["mcp__mcp-server-1__query"]).toBe(1);
    expect(r.turns[0]?.toolCounts["mcp__mcp-server-1__query"]).toBe(2);
    expect(r.subagents).toEqual(["Explore", "agent-1"]);
    expect(r.sidechainBursts.map((b) => b.subagentType)).toEqual(["agent-1", "Explore"]);
    expect(r.compactions[0]?.trigger).toBe(REDACTED);
    expect(Object.keys(r.stopReasons).sort()).toEqual([REDACTED, "end_turn"].sort());
    expect(Object.keys(r.permissionModes).sort()).toEqual([REDACTED, "default"].sort());
    expect(r.versions).toEqual(["2.1.0", REDACTED]);
    const outputs = [
      JSON.stringify(buildSessionJsonPayload(a, { redact: true })),
      buildSessionMarkdown(a, { redact: true }),
      buildSessionHtml(a, { redact: true }),
    ];
    for (const out of outputs) {
      for (const leak of [MCP, AGENT, BOGUS]) expect(out).not.toContain(leak);
    }
  });

  test("built-in agent types and auto trigger survive", async () => {
    const a = await baseAnalysis();
    const r = redactAnalysis(a);
    expect(r.subagents).toEqual(["Explore"]);
    expect(r.compactions[0]?.trigger).toBe("auto");
  });
});
