import { describe, expect, test } from "bun:test";
import {
  buildSetupAudit,
  daysBetween,
  ERROR_PRONE_MIN_INVOCATIONS,
  type InventoryItem,
  mcpServerFromTool,
  type SetupInventory,
  type SetupUsage,
  STALE_SKILL_DAYS,
} from "../../src/core/setup-audit.ts";
import type { NameUsageRow, SkillUsageRow, ToolUsageRow } from "../../src/core/stats-types.ts";

const TODAY = "2026-07-28";

function inventory(over: Partial<SetupInventory> = {}): SetupInventory {
  return {
    claudeDir: "/tmp/claude",
    present: true,
    skills: [],
    agents: [],
    plugins: [],
    mcpServers: [],
    hooks: [],
    permissions: { allow: 0, deny: 0, ask: 0 },
    model: null,
    ...over,
  };
}

function usage(over: Partial<SetupUsage> = {}): SetupUsage {
  return { skills: [], subagents: [], tools: [], ...over };
}

function skillRow(over: Partial<SkillUsageRow> & { name: string }): SkillUsageRow {
  const invocations = over.invocations ?? 1;
  const errors = over.errors ?? 0;
  return {
    invocations,
    sessions: 1,
    projects: 1,
    errors,
    errorRate: invocations > 0 ? errors / invocations : 0,
    firstUsed: TODAY,
    lastUsed: TODAY,
    totalCost: 0,
    avgCostPerSession: 0,
    daily: [],
    ...over,
  };
}

const agentRow = (name: string): NameUsageRow => ({ name, sessions: 1 });
const toolRow = (tool: string): ToolUsageRow => ({
  tool,
  uses: 1,
  errors: 0,
  errorRate: 0,
  sessions: 1,
});

const user = (name: string): InventoryItem => ({ name, source: "user" });
const codes = (findings: { code: string }[]): string[] => findings.map((f) => f.code);

describe("helpers", () => {
  test("mcpServerFromTool pulls the server out of an mcp tool name", () => {
    expect(mcpServerFromTool("mcp__github__list_issues")).toBe("github");
    expect(mcpServerFromTool("mcp__github")).toBe("github");
    expect(mcpServerFromTool("Bash")).toBeNull();
    expect(mcpServerFromTool("mcp__")).toBeNull();
  });

  test("daysBetween counts whole days and tolerates junk", () => {
    expect(daysBetween("2026-07-01", "2026-07-28")).toBe(27);
    expect(daysBetween("not-a-day", TODAY)).toBeNull();
  });
});

describe("unused-skill", () => {
  test("fires for an installed skill with no matching invocation", () => {
    const audit = buildSetupAudit(inventory({ skills: [user("tidy")] }), usage(), TODAY);
    expect(codes(audit.findings)).toEqual(["unused-skill"]);
    expect(audit.findings[0]?.subject).toBe("tidy");
    expect(audit.findings[0]?.evidence).toContain("your ~/.claude dir");
  });

  test("stays quiet when the skill was invoked", () => {
    const audit = buildSetupAudit(
      inventory({ skills: [user("tidy")] }),
      usage({ skills: [skillRow({ name: "tidy" })] }),
      TODAY,
    );
    expect(audit.findings).toEqual([]);
  });

  test("a plugin skill matches its qualified invocation name", () => {
    const inv = inventory({
      skills: [{ name: "deploy", source: "plugin:toolkit" }],
      plugins: [{ name: "toolkit", skills: ["deploy"], agents: [] }],
    });
    const qualified = buildSetupAudit(
      inv,
      usage({ skills: [skillRow({ name: "toolkit:deploy" })] }),
      TODAY,
    );
    expect(qualified.findings).toEqual([]);
    // The bare form is accepted too — a loose match is a false negative, which
    // beats accusing a used skill of being unused.
    const bare = buildSetupAudit(inv, usage({ skills: [skillRow({ name: "deploy" })] }), TODAY);
    expect(bare.findings).toEqual([]);
  });
});

describe("unused-agent", () => {
  test("fires for an installed subagent never dispatched, and not otherwise", () => {
    const inv = inventory({ agents: [user("reviewer")] });
    expect(codes(buildSetupAudit(inv, usage(), TODAY).findings)).toEqual(["unused-agent"]);
    expect(
      buildSetupAudit(inv, usage({ subagents: [agentRow("reviewer")] }), TODAY).findings,
    ).toEqual([]);
  });
});

describe("unused-mcp-server", () => {
  test("fires as a warning when no mcp__<server>__* tool call was observed", () => {
    const inv = inventory({ mcpServers: [{ name: "github", scope: "global", projects: 0 }] });
    const audit = buildSetupAudit(inv, usage({ tools: [toolRow("Bash")] }), TODAY);
    expect(codes(audit.findings)).toEqual(["unused-mcp-server"]);
    expect(audit.findings[0]?.severity).toBe("warning");
    expect(audit.findings[0]?.evidence).toContain("configured globally");
  });

  test("stays quiet once any of the server's tools was used", () => {
    const inv = inventory({ mcpServers: [{ name: "github", scope: "project", projects: 2 }] });
    const audit = buildSetupAudit(
      inv,
      usage({ tools: [toolRow("mcp__github__list_issues")] }),
      TODAY,
    );
    expect(audit.findings).toEqual([]);
  });

  test("names the project scope when the server is not global", () => {
    const inv = inventory({ mcpServers: [{ name: "linear", scope: "project", projects: 2 }] });
    const audit = buildSetupAudit(inv, usage(), TODAY);
    expect(audit.findings[0]?.evidence).toContain("configured in 2 projects");
  });
});

describe("error-prone-skill", () => {
  test("fires at the threshold (25% of at least 5 invocations)", () => {
    const audit = buildSetupAudit(
      inventory({ skills: [user("flaky")] }),
      usage({
        skills: [skillRow({ name: "flaky", invocations: ERROR_PRONE_MIN_INVOCATIONS, errors: 2 })],
      }),
      TODAY,
    );
    expect(codes(audit.findings)).toContain("error-prone-skill");
    expect(audit.findings[0]?.evidence).toContain("2 of 5 invocations");
  });

  test("does not fire below the invocation floor or below the rate", () => {
    const tooFew = buildSetupAudit(
      inventory({ skills: [user("flaky")] }),
      usage({ skills: [skillRow({ name: "flaky", invocations: 4, errors: 4 })] }),
      TODAY,
    );
    expect(codes(tooFew.findings)).not.toContain("error-prone-skill");

    const tooClean = buildSetupAudit(
      inventory({ skills: [user("flaky")] }),
      usage({ skills: [skillRow({ name: "flaky", invocations: 10, errors: 2 })] }),
      TODAY,
    );
    expect(codes(tooClean.findings)).not.toContain("error-prone-skill");
  });
});

describe("stale-skill", () => {
  test("fires exactly at the 30-day boundary and not a day earlier", () => {
    const stale = buildSetupAudit(
      inventory({ skills: [user("tidy")] }),
      usage({ skills: [skillRow({ name: "tidy", lastUsed: "2026-06-28" })] }),
      TODAY,
    );
    expect(daysBetween("2026-06-28", TODAY)).toBe(STALE_SKILL_DAYS);
    expect(codes(stale.findings)).toEqual(["stale-skill"]);

    const fresh = buildSetupAudit(
      inventory({ skills: [user("tidy")] }),
      usage({ skills: [skillRow({ name: "tidy", lastUsed: "2026-06-29" })] }),
      TODAY,
    );
    expect(fresh.findings).toEqual([]);
  });

  test("an undated skill row is never called stale", () => {
    const audit = buildSetupAudit(
      inventory({ skills: [user("tidy")] }),
      usage({ skills: [skillRow({ name: "tidy", firstUsed: null, lastUsed: null })] }),
      TODAY,
    );
    expect(audit.findings).toEqual([]);
  });
});

describe("missing-but-used", () => {
  test("reports skills and subagents observed but not installed", () => {
    const audit = buildSetupAudit(
      inventory(),
      usage({
        skills: [skillRow({ name: "pdf", invocations: 4 })],
        subagents: [agentRow("general-purpose")],
      }),
      TODAY,
    );
    expect(codes(audit.findings)).toEqual(["missing-but-used", "missing-but-used"]);
    expect(audit.findings[0]?.subject).toBe("skills");
    expect(audit.findings[0]?.evidence).toContain("pdf (4)");
    expect(audit.findings[1]?.subject).toBe("subagents");
  });

  test("stays quiet when there is no Claude dir to compare against", () => {
    const audit = buildSetupAudit(
      inventory({ present: false }),
      usage({ skills: [skillRow({ name: "pdf" })] }),
      TODAY,
    );
    expect(audit.findings).toEqual([]);
  });
});

describe("audit assembly", () => {
  test("counts the inventory and sorts warnings first", () => {
    const inv = inventory({
      skills: [user("tidy"), { name: "deploy", source: "plugin:toolkit" }],
      agents: [user("reviewer")],
      plugins: [{ name: "toolkit", skills: ["deploy"], agents: [] }],
      mcpServers: [
        { name: "github", scope: "global", projects: 0 },
        { name: "linear", scope: "project", projects: 2 },
      ],
      hooks: [{ event: "PreToolUse", hooks: 2 }],
      permissions: { allow: 3, deny: 1, ask: 0 },
      model: "claude-opus-4",
    });
    const audit = buildSetupAudit(inv, usage(), TODAY);

    expect(audit.today).toBe(TODAY);
    expect(audit.counts).toEqual({
      skills: 2,
      agents: 1,
      plugins: 1,
      mcpServers: 2,
      mcpGlobal: 1,
      mcpProject: 1,
      hookEvents: 1,
      hooks: 2,
      permissionAllow: 3,
      permissionDeny: 1,
      permissionAsk: 0,
    });
    // Two unused MCP servers (warnings) come before the info-level findings.
    expect(audit.findings.slice(0, 2).every((f) => f.severity === "warning")).toBe(true);
    expect(codes(audit.findings).slice(0, 2)).toEqual(["unused-mcp-server", "unused-mcp-server"]);
    expect(new Set(codes(audit.findings).slice(2))).toEqual(
      new Set(["unused-skill", "unused-agent"]),
    );
  });
});
