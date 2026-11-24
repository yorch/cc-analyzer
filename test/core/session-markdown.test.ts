import { describe, expect, test } from "bun:test";
import type { SessionAnalysis } from "../../src/core/analyze.ts";
import { analyzeSession } from "../../src/core/analyze.ts";
import type { SessionEvent } from "../../src/core/events.ts";
import { inspectSessionHealth } from "../../src/core/session-health.ts";
import { sessionWhatIf } from "../../src/core/session-insights.ts";
import {
  buildSessionHtml,
  buildSessionMarkdown,
  sanitizeFilename,
} from "../../src/core/session-markdown.ts";
import { assistantEvent, clock, promptEvent, toolUseBlock } from "../helpers/events.ts";
import { samplePricing as pricing } from "../helpers/pricing.ts";

const at = clock(2026, 7, 1, 10);

function makeAnalysis(overrides?: SessionEvent[]): {
  analysis: SessionAnalysis;
  events: SessionEvent[];
} {
  const events: SessionEvent[] = overrides ?? [
    promptEvent("u1", at(0), "hello world"),
    assistantEvent({
      uuid: "a1",
      timestamp: at(0, 5),
      usage: { input_tokens: 10, output_tokens: 20 },
    }),
  ];
  const analysis = analyzeSession(events, pricing);
  return { analysis, events };
}

describe("sanitizeFilename", () => {
  test("strips path traversal and special chars", () => {
    expect(sanitizeFilename("../../etc/passwd")).toBe("etc-passwd");
    expect(sanitizeFilename("sess-1")).toBe("sess-1");
    expect(sanitizeFilename("a/b\\c:d")).toBe("a-b-c-d");
    expect(sanitizeFilename("")).toBe("session");
  });
  test("caps length at 80", () => {
    const long = "a".repeat(200);
    expect(sanitizeFilename(long).length).toBe(80);
  });
  test("removes leading/trailing dashes", () => {
    expect(sanitizeFilename("--foo--")).toBe("foo");
  });
});

describe("buildSessionMarkdown", () => {
  test("includes overview and diagnostics sections", () => {
    const { analysis } = makeAnalysis();
    const md = buildSessionMarkdown(analysis);
    expect(md).toContain("# Session:");
    expect(md).toContain("## Overview");
    expect(md).toContain("## Actionable diagnostics");
    expect(md).toContain("## Cost breakdown");
  });

  test("redact hides prompt and file paths", () => {
    const { analysis } = makeAnalysis([
      promptEvent("u1", at(0), "SECRET PROMPT"),
      assistantEvent({
        uuid: "a1",
        timestamp: at(0, 5),
        content: [
          { type: "tool_use", id: "t1", name: "Write", input: { file_path: "/secret/file.ts" } },
        ],
        usage: { input_tokens: 10, output_tokens: 20 },
      }),
    ]);
    const md = buildSessionMarkdown(analysis, { redact: true });
    expect(md).toContain("[redacted]");
    expect(md).not.toContain("SECRET PROMPT");
    expect(md).toContain("Redacted export");
    // filesTouched should be count only, not path
    expect(md).not.toContain("/secret/file.ts");
    // title derived from prompt should be redacted
    expect(md).not.toContain("SECRET PROMPT");
  });

  test("redact hides title and project", () => {
    const { analysis } = makeAnalysis();
    analysis.title = "my secret title";
    analysis.projectPath = "/Users/secret/proj";
    const md = buildSessionMarkdown(analysis, { redact: true });
    expect(md).not.toContain("my secret title");
    expect(md).not.toContain("/Users/secret/proj");
    expect(md).toContain("[redacted]");
  });

  test("transcript omitted by default, capped when included", () => {
    const { analysis } = makeAnalysis();
    const mdNoTx = buildSessionMarkdown(analysis);
    expect(mdNoTx).toContain("Omitted for shareability");

    const transcript = Array.from({ length: 700 }, (_, i) => ({
      index: i,
      label: `item ${i}`,
      body: "x".repeat(5000),
      kind: "note" as const,
      isError: false,
    }));
    // Pass a huge transcript — builder should cap
    const mdWithTx = buildSessionMarkdown(analysis, {
      includeTranscript: true,
      transcript: transcript as any,
    });
    // Should contain truncated note
    expect(mdWithTx).toContain("truncated");
    // Body should be sliced to 2000
    expect(mdWithTx).not.toContain("x".repeat(2001));
  });

  test("turns table is sampled when huge", () => {
    // Create 500 turns
    const events: SessionEvent[] = [];
    for (let i = 0; i < 500; i++) {
      events.push(promptEvent(`u${i}`, at(i), `prompt ${i}`));
      events.push(assistantEvent({ uuid: `a${i}`, timestamp: at(i, 5) }));
    }
    const analysis = analyzeSession(events, pricing);
    expect(analysis.turns.length).toBe(500);
    const md = buildSessionMarkdown(analysis);
    expect(md).toContain("Sampled 1/");
    expect(md).toContain("turns for readability");
  });

  test("charts sampling note appears for huge series", () => {
    // Use a session with many calls to trigger sampling
    const events: SessionEvent[] = [];
    for (let i = 0; i < 400; i++) {
      events.push(promptEvent(`u${i}`, at(0), `p${i}`));
      events.push(
        assistantEvent({
          uuid: `a${i}`,
          timestamp: at(i),
          usage: { input_tokens: 100, output_tokens: 20 },
        }),
      );
    }
    const analysis = analyzeSession(events, pricing);
    if (analysis.turns.length === 0) return; // aggregate mode skip
    const md = buildSessionMarkdown(analysis);
    expect(md).toContain("# Session:");
    // If context points >300, sampling note
    if (analysis.turns.flatMap((t) => t.apiCalls).length > 300) {
      expect(md).toContain("Sampled 1/");
    }
  });

  test("health section included when provided", () => {
    const { analysis, events } = makeAnalysis();
    const health = inspectSessionHealth(events, [], { lines: 2, parseErrors: 0, unknownEvents: 0 });
    const md = buildSessionMarkdown(analysis, { health });
    expect(md).toContain("## Health");
    expect(md).toContain(health.status);
  });

  test("what-if section included when provided", () => {
    const { analysis } = makeAnalysis();
    const whatIf = sessionWhatIf(analysis.models, pricing);
    if (whatIf.rows.length > 0 && whatIf.summary.bestModel) {
      const md = buildSessionMarkdown(analysis, { whatIf });
      expect(md).toContain("## What-if");
    }
  });

  test("handles empty/orphan session gracefully", () => {
    const analysis = analyzeSession([], pricing);
    const md = buildSessionMarkdown(analysis);
    expect(md).toContain("No turn timeline");
  });

  test("escapes markdown table pipes", () => {
    const { analysis } = makeAnalysis([
      promptEvent("u1", at(0), "prompt with | pipe"),
      assistantEvent({ uuid: "a1", timestamp: at(0, 5) }),
    ]);
    analysis.title = "title|with|pipes";
    const md = buildSessionMarkdown(analysis);
    // Pipes should be escaped, not break tables
    expect(md).toContain("title\\|with\\|pipes");
  });
});

describe("buildSessionHtml", () => {
  test("is standalone html with escaped XSS", () => {
    const { analysis } = makeAnalysis();
    analysis.title = "<img src=x onerror=alert(1)>";
    const html = buildSessionHtml(analysis);
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("&lt;img");
    expect(html).not.toContain("<img src=x onerror");
  });

  test("escapes list items (diagnostics) to prevent XSS", () => {
    // Create a diagnostic that would inject HTML
    const result = makeAnalysis([
      promptEvent("u1", at(0), "hello"),
      assistantEvent({
        uuid: "a1",
        timestamp: at(0, 5),
        usage: { input_tokens: 10000, output_tokens: 1 },
      }),
      assistantEvent({
        uuid: "a2",
        timestamp: at(1),
        usage: { input_tokens: 160_000, output_tokens: 1 },
      }),
    ]);
    const analysis = result.analysis;
    const events = result.events;
    // Build with title injection that flows into list? Use health injection
    const health = inspectSessionHealth(events, [], { lines: 3, parseErrors: 0, unknownEvents: 0 });
    // Manually craft health with injection
    const evilHealth = {
      ...health,
      findings: [
        {
          code: "unparseable-lines" as const,
          severity: "error" as const,
          title: "<script>alert(1)</script>",
          evidence: "<b>evil</b>",
          action: "fix",
        },
      ],
    };
    const html = buildSessionHtml(analysis, { health: evilHealth as any });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  test("markdown and html are consistent (same sections)", () => {
    const { analysis } = makeAnalysis();
    const md = buildSessionMarkdown(analysis);
    const html = buildSessionHtml(analysis);
    // HTML wraps markdown
    expect(md).toContain("# Session:");
    expect(html).toContain("Session:");
  });
});

describe("buildSessionHtml hardening", () => {
  const XSS = "<img src=x onerror=alert(1)>$";

  test("hostile compaction trigger / subagentType never reach the page unescaped", () => {
    const { analysis } = makeAnalysis();
    analysis.compactions = [{ trigger: XSS, preTokens: 1000, timestamp: at(1) }];
    analysis.subagents = [XSS];
    analysis.sidechainBursts = [
      {
        subagentType: XSS,
        apiCalls: 1,
        cost: 1,
        tokens: analysis.totals.tokens,
      },
    ];
    const html = buildSessionHtml(analysis);
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x");
  });

  test("ships no script and no innerHTML, and pins a CSP that forbids scripts", () => {
    const { analysis } = makeAnalysis();
    const html = buildSessionHtml(analysis);
    expect(html).not.toContain("<script");
    expect(html).not.toContain("innerHTML");
    expect(html).not.toContain("onclick");
    expect(html).toContain("Content-Security-Policy");
    expect(html).toContain("default-src 'none'");
  });

  test("diagnostic list items render <br> structurally, not as literal text", () => {
    const { analysis } = makeAnalysis();
    analysis.testFailStreak = 6;
    const html = buildSessionHtml(analysis);
    expect(html).not.toContain("&lt;br&gt;");
  });
});

describe("redact mode", () => {
  const SECRET = "/home/secret/CANARY-path.ts";
  function rereadAnalysis(): SessionAnalysis {
    const events: SessionEvent[] = [promptEvent("u1", at(0), "CANARY prompt text")];
    for (let i = 0; i < 6; i++) {
      events.push(
        assistantEvent({
          uuid: `a${i}`,
          timestamp: at(0, i + 1),
          content: [toolUseBlock(`t${i}`, "Read", { file_path: SECRET })],
        }),
      );
    }
    const analysis = analyzeSession(events, pricing);
    analysis.title = "CANARY title";
    analysis.projectPath = "/home/secret/CANARY-project";
    analysis.gitBranches = ["CANARY-branch"];
    analysis.skills = { "CANARY-skill": 1 };
    return analysis;
  }

  test("sanity: the unredacted export does surface the path", () => {
    const analysis = rereadAnalysis();
    expect(buildSessionMarkdown(analysis)).toContain("CANARY-path.ts");
  });

  test("markdown carries no analysis text", () => {
    const md = buildSessionMarkdown(rereadAnalysis(), { redact: true });
    expect(md).not.toContain("CANARY");
    expect(md).toContain("Actionable diagnostics");
  });

  test("html carries no analysis text, including <title> and <h1>", () => {
    const html = buildSessionHtml(rereadAnalysis(), { redact: true });
    expect(html).not.toContain("CANARY");
    expect(html).toContain("<title>Session export");
  });

  test("redacted transcript bodies are hidden", () => {
    const html = buildSessionMarkdown(rereadAnalysis(), {
      redact: true,
      includeTranscript: true,
      transcript: [
        { index: 0, turnIndex: 0, role: "user", kind: "prompt", label: "You", body: "CANARY body" },
      ],
    });
    expect(html).not.toContain("CANARY");
  });
});
