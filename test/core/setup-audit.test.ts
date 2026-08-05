import { describe, expect, test } from "bun:test";
import {
  buildPluginUsage,
  buildSetupAudit,
  daysBetween,
  ERROR_PRONE_MIN_INVOCATIONS,
  type InventoryItem,
  mcpServerFromTool,
  type PluginEntry,
  type SetupInventory,
  type SetupUsage,
  STALE_SKILL_DAYS,
} from "../../src/core/setup-audit.ts";
import type { NameUsageRow, SkillUsageRow, ToolUsageRow } from "../../src/core/stats-types.ts";

const TODAY = "2026-07-28";

function inventory(over: Partial<SetupInventory> = {}): SetupInventory {
  return {
    claudeDirs: ["/tmp/claude"],
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
    attributedTurns: 0,
    attributedCost: 0,
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
const plugin = (over: Partial<PluginEntry> & { name: string }): PluginEntry => ({
  skills: [],
  agents: [],
  mcpServers: [],
  ...over,
});
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
      plugins: [plugin({ name: "toolkit", skills: ["deploy"] })],
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

  test("a user skill shadowing a plugin's copy reports the finding once", () => {
    // One observed bare row, two installed skills of that name. It belongs to
    // the user's own skill (the plugin's copy is shadowed for bare
    // invocations), so exactly one error-prone finding is reported — and the
    // plugin, having claimed none of it, stays eligible for `unused-plugin`.
    const inv = inventory({
      skills: [user("deploy"), { name: "deploy", source: "plugin:toolkit" }],
      plugins: [plugin({ name: "toolkit", skills: ["deploy"] })],
    });
    const audit = buildSetupAudit(
      inv,
      usage({
        skills: [skillRow({ name: "deploy", invocations: ERROR_PRONE_MIN_INVOCATIONS, errors: 3 })],
      }),
      TODAY,
    );
    expect(codes(audit.findings)).toEqual(["error-prone-skill", "unused-plugin"]);
    expect(audit.findings[0]?.evidence).toContain("3 of 5 invocations");
    expect(audit.findings[1]?.subject).toBe("toolkit");
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
      plugins: [plugin({ name: "toolkit", skills: ["deploy"] })],
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
    // The plugin's own unused skill rolls into one `unused-plugin` finding; the
    // user's skill and subagent still report individually.
    expect(new Set(codes(audit.findings).slice(2))).toEqual(
      new Set(["unused-skill", "unused-agent", "unused-plugin"]),
    );
  });
});

describe("buildPluginUsage", () => {
  const toolkit = plugin({ name: "toolkit", skills: ["fmt"], agents: ["shipper"] });
  const pluginItem = (name: string): InventoryItem => ({ name, source: "plugin:toolkit" });

  test("an inventory with no plugins rolls up to nothing", () => {
    expect(buildPluginUsage(inventory(), usage())).toEqual([]);
  });

  test("sums both observed name forms of one plugin skill into one row", () => {
    // `fmt` and `toolkit:fmt` are distinct rows in the index — the same skill
    // logged under two name forms. Both are summed into the single plugin row.
    const rows = buildPluginUsage(
      inventory({ skills: [pluginItem("fmt")], plugins: [toolkit] }),
      usage({
        skills: [
          skillRow({
            name: "fmt",
            invocations: 3,
            attributedTurns: 2,
            attributedCost: 1,
            lastUsed: "2026-07-01",
          }),
          skillRow({
            name: "toolkit:fmt",
            invocations: 4,
            attributedTurns: 3,
            attributedCost: 2.5,
            lastUsed: "2026-07-20",
          }),
        ],
      }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      plugin: "toolkit",
      skillsShipped: 1,
      skillsUsed: 1,
      invocations: 7,
      attributedTurns: 5,
      attributedCost: 3.5,
      // The latest day across every matched row, not the first one seen.
      lastUsed: "2026-07-20",
    });
  });

  test("counts agent sessions and MCP servers the plugin ships", () => {
    const inv = inventory({
      plugins: [plugin({ name: "toolkit", agents: ["shipper", "idle"], mcpServers: ["deployer"] })],
    });
    const rows = buildPluginUsage(
      inv,
      usage({
        subagents: [{ name: "shipper", sessions: 4 }],
        tools: [toolRow("mcp__Deployer__go")],
      }),
    );
    expect(rows[0]).toMatchObject({
      agentsShipped: 2,
      agentsUsed: 1,
      agentSessions: 4,
      mcpServers: 1,
      mcpServersUsed: 1,
    });
  });

  test("a bare row shipped by two plugins inflates neither's numbers", () => {
    // Only one of them actually ran `fmt`, and the row cannot say which. Both
    // count it as *used* (calling both unused would be a certain false
    // accusation), neither claims the invocations or the dollars.
    const inv = inventory({
      skills: [
        { name: "fmt", source: "plugin:toolkit" },
        { name: "fmt", source: "plugin:tidy" },
      ],
      plugins: [
        plugin({ name: "toolkit", skills: ["fmt"] }),
        plugin({ name: "tidy", skills: ["fmt"] }),
      ],
    });
    const rows = buildPluginUsage(
      inv,
      usage({ skills: [skillRow({ name: "fmt", invocations: 6, attributedCost: 4 })] }),
    );
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row).toMatchObject({ skillsUsed: 1, invocations: 0, attributedCost: 0 });
      expect(row.lastUsed).toBeNull();
    }
    // And neither is accused of being unused.
    const audit = buildSetupAudit(inv, usage({ skills: [skillRow({ name: "fmt" })] }), TODAY);
    expect(codes(audit.findings)).toEqual([]);
  });

  test("a user skill of the same name shadows the plugin's copy", () => {
    // A bare `fmt` invocation resolves to the user's own skill, so the plugin
    // claims none of it — and stays eligible for `unused-plugin`.
    const inv = inventory({
      skills: [user("fmt"), { name: "fmt", source: "plugin:toolkit" }],
      plugins: [plugin({ name: "toolkit", skills: ["fmt"] })],
    });
    const observed = usage({
      skills: [skillRow({ name: "fmt", invocations: 5, attributedTurns: 4, attributedCost: 8 })],
    });
    expect(buildPluginUsage(inv, observed)[0]).toMatchObject({
      plugin: "toolkit",
      skillsUsed: 0,
      invocations: 0,
      attributedTurns: 0,
      attributedCost: 0,
    });
    expect(codes(buildSetupAudit(inv, observed, TODAY).findings)).toEqual(["unused-plugin"]);
  });

  test("a qualified row always attributes to the plugin it names", () => {
    const inv = inventory({
      plugins: [
        plugin({ name: "toolkit", skills: ["fmt"] }),
        plugin({ name: "tidy", skills: ["fmt"] }),
      ],
    });
    const rows = buildPluginUsage(
      inv,
      usage({ skills: [skillRow({ name: "toolkit:fmt", invocations: 6, attributedCost: 4 })] }),
    );
    expect(rows.find((r) => r.plugin === "toolkit")).toMatchObject({
      invocations: 6,
      attributedCost: 4,
      skillsUsed: 1,
    });
    expect(rows.find((r) => r.plugin === "tidy")).toMatchObject({
      invocations: 0,
      attributedCost: 0,
      skillsUsed: 0,
    });
  });

  test("an unambiguous bare row attributes in full", () => {
    const rows = buildPluginUsage(
      inventory({ plugins: [plugin({ name: "toolkit", skills: ["fmt"] })] }),
      usage({
        skills: [skillRow({ name: "fmt", invocations: 6, attributedTurns: 3, attributedCost: 4 })],
      }),
    );
    expect(rows[0]).toMatchObject({
      invocations: 6,
      attributedTurns: 3,
      attributedCost: 4,
      skillsUsed: 1,
      lastUsed: TODAY,
    });
  });

  test("subagent sessions follow the same attribution rule", () => {
    const inv = inventory({
      plugins: [
        plugin({ name: "toolkit", agents: ["shipper"] }),
        plugin({ name: "tidy", agents: ["shipper"] }),
      ],
    });
    const rows = buildPluginUsage(inv, usage({ subagents: [{ name: "shipper", sessions: 4 }] }));
    for (const row of rows) expect(row).toMatchObject({ agentsUsed: 1, agentSessions: 0 });
    const qualified = buildPluginUsage(
      inv,
      usage({ subagents: [{ name: "toolkit:shipper", sessions: 4 }] }),
    );
    expect(qualified.find((r) => r.plugin === "toolkit")).toMatchObject({ agentSessions: 4 });
    expect(qualified.find((r) => r.plugin === "tidy")).toMatchObject({ agentSessions: 0 });
  });

  test("sorts by attributed cost, then invocations", () => {
    const inv = inventory({
      plugins: [
        plugin({ name: "cheap", skills: ["a"] }),
        plugin({ name: "pricey", skills: ["b"] }),
        plugin({ name: "busy", skills: ["c"] }),
      ],
    });
    const rows = buildPluginUsage(
      inv,
      usage({
        skills: [
          skillRow({ name: "a", invocations: 1, attributedCost: 0 }),
          skillRow({ name: "b", invocations: 1, attributedCost: 9 }),
          skillRow({ name: "c", invocations: 50, attributedCost: 0 }),
        ],
      }),
    );
    expect(rows.map((r) => r.plugin)).toEqual(["pricey", "busy", "cheap"]);
  });
});

describe("unused-plugin", () => {
  const dead = plugin({ name: "toolkit", skills: ["deploy"], agents: ["shipper"] });
  const deadInventory = inventory({
    skills: [{ name: "deploy", source: "plugin:toolkit" }],
    agents: [{ name: "shipper", source: "plugin:toolkit" }],
    plugins: [dead],
  });

  test("fires once and suppresses the per-component findings", () => {
    const audit = buildSetupAudit(deadInventory, usage(), TODAY);
    expect(codes(audit.findings)).toEqual(["unused-plugin"]);
    expect(audit.findings[0]?.subject).toBe("toolkit");
    expect(audit.findings[0]?.severity).toBe("info");
    expect(audit.findings[0]?.evidence).toContain("1 skill, 1 subagent");
  });

  test("partial usage keeps the per-component findings instead", () => {
    const audit = buildSetupAudit(
      deadInventory,
      usage({ skills: [skillRow({ name: "toolkit:deploy" })] }),
      TODAY,
    );
    expect(codes(audit.findings)).toEqual(["unused-agent"]);
  });

  test("a plugin with nothing discoverable is never called unused", () => {
    const audit = buildSetupAudit(
      inventory({ plugins: [plugin({ name: "opaque" })] }),
      usage(),
      TODAY,
    );
    expect(codes(audit.findings)).toEqual([]);
  });

  test("the audit carries the per-plugin rollup alongside its findings", () => {
    const audit = buildSetupAudit(deadInventory, usage(), TODAY);
    expect(audit.plugins).toEqual([
      {
        plugin: "toolkit",
        skillsShipped: 1,
        skillsUsed: 0,
        agentsShipped: 1,
        agentsUsed: 0,
        mcpServers: 0,
        mcpServersUsed: 0,
        invocations: 0,
        agentSessions: 0,
        attributedTurns: 0,
        attributedCost: 0,
        lastUsed: null,
      },
    ]);
  });
});
