/**
 * Setup audit: cross-reference what is *installed* under the Claude config dir
 * with what the indexed sessions actually *used*.
 *
 * The scanner that produces a `SetupInventory` lives in `inventory.ts` (it
 * touches the filesystem). This module is the pure half — shapes plus the
 * cross-referencing rules — so it stays bun-free and the web SPA can import
 * the same types the server serves.
 *
 * Findings follow the `session-diagnostics.ts` house style: a stable code, a
 * severity, the observed evidence, and a suggested next action. Every
 * threshold is documented beside the rule that uses it.
 */

import { pct } from "./format-shared.ts";
import type { NameUsageRow, SkillUsageRow, ToolUsageRow } from "./stats-types.ts";

/* ——— Inventory shapes ——————————————————————————————————————————————— */

/** Where an installed item came from: the user's own dir, or a plugin. */
export type InventorySource = "user" | `plugin:${string}`;

/** One installed skill or subagent, with the source that ships it. */
export interface InventoryItem {
  name: string;
  source: InventorySource;
}

/** Global servers are configured for every project; project ones are scoped. */
export type McpServerScope = "global" | "project";

export interface McpServerEntry {
  name: string;
  scope: McpServerScope;
  /** How many per-project configs declare it (0 for a purely global server). */
  projects: number;
}

/**
 * An installed plugin and the skills/agents/MCP servers it ships, when
 * discoverable. `mcpServers` holds the server *names* the plugin declares (its
 * own `.mcp.json`, or a `mcpServers` field in its manifest). They are
 * deliberately **not** folded into `SetupInventory.mcpServers`, which describes
 * what the *user* configured: a plugin's servers only exist while the plugin is
 * enabled, and merging them would silently change the `unused-mcp-server`
 * findings and the inventory counts.
 */
export interface PluginEntry {
  name: string;
  skills: string[];
  agents: string[];
  mcpServers: string[];
}

/** A settings.json hook event carrying at least one hook. */
export interface HookEntry {
  event: string;
  hooks: number;
}

export interface PermissionRuleCounts {
  allow: number;
  deny: number;
  ask: number;
}

/** Everything `scanInventory()` could read out of the Claude config dir. */
export interface SetupInventory {
  /** The primary dir that was scanned (absolute). */
  claudeDir: string;
  /** Every scanned dir, primary first — one entry unless several roots are configured. */
  claudeDirs: string[];
  /** False when no scanned dir exists — every list is then empty by default. */
  present: boolean;
  skills: InventoryItem[];
  agents: InventoryItem[];
  plugins: PluginEntry[];
  mcpServers: McpServerEntry[];
  hooks: HookEntry[];
  permissions: PermissionRuleCounts;
  /** `model` pinned in settings.json, if any. */
  model: string | null;
}

/** The observed-usage side of the audit — straight off `analyticsRollup()`. */
export interface SetupUsage {
  skills: SkillUsageRow[];
  subagents: NameUsageRow[];
  tools: ToolUsageRow[];
}

/** Flat counts for the one-line inventory summary each surface renders. */
export interface SetupInventoryCounts {
  skills: number;
  agents: number;
  plugins: number;
  mcpServers: number;
  mcpGlobal: number;
  mcpProject: number;
  hookEvents: number;
  hooks: number;
  permissionAllow: number;
  permissionDeny: number;
  permissionAsk: number;
}

/* ——— Findings ——————————————————————————————————————————————————————— */

export type SetupAuditCode =
  | "unused-skill"
  | "unused-agent"
  | "unused-mcp-server"
  | "unused-plugin"
  | "error-prone-skill"
  | "stale-skill"
  | "missing-but-used";

export type SetupAuditSeverity = "info" | "warning";

export interface SetupAuditFinding {
  code: SetupAuditCode;
  severity: SetupAuditSeverity;
  title: string;
  evidence: string;
  action: string;
  /** The item the finding is about (skill / agent / server name, or a kind). */
  subject: string;
}

export interface SetupAudit {
  inventory: SetupInventory;
  counts: SetupInventoryCounts;
  /** Per-plugin usage rollup, most expensive first (`buildPluginUsage`). */
  plugins: PluginUsageRow[];
  findings: SetupAuditFinding[];
  /** The day (YYYY-MM-DD) staleness was measured against. */
  today: string;
}

/**
 * What one installed plugin actually did, rolled up from its shipped
 * components. Costs are the same **turn-scoped** attribution the per-skill rows
 * carry, so `SKILL_COST_CAVEAT` applies verbatim wherever this renders.
 */
export interface PluginUsageRow {
  plugin: string;
  skillsShipped: number;
  skillsUsed: number;
  agentsShipped: number;
  agentsUsed: number;
  /** MCP servers the plugin declares, and how many were observed in tool calls. */
  mcpServers: number;
  mcpServersUsed: number;
  /**
   * Skill invocations across its skills. Both observed name forms of one skill
   * (bare `fmt` and qualified `toolkit:fmt`) are distinct rows in the index —
   * they are summed here, so one plugin skill logged under both forms
   * contributes both counts to a single plugin row. A bare row is only summed
   * when it unambiguously belongs to this plugin (see the attribution rule
   * above `buildPluginUsage`), so `skillsUsed` can be non-zero while this is 0.
   */
  invocations: number;
  /** Σ sessions across its subagents — an upper bound, since one session can
   *  dispatch two of them and the rollup only carries per-name counts. */
  agentSessions: number;
  /** Σ over its skills of the turn-scoped attribution (turns and their cost). */
  attributedTurns: number;
  attributedCost: number;
  /** Latest day (YYYY-MM-DD) any of its skills ran, or null if never/undated. */
  lastUsed: string | null;
}

/**
 * A skill that has not run in a month is very likely forgotten rather than
 * seasonal: 30 days covers a normal work cycle, and anything shorter would
 * flag skills that are legitimately used once a month.
 */
export const STALE_SKILL_DAYS = 30;

/**
 * One in four invocations failing is well past flaky, and requiring five
 * invocations keeps a single bad run out of two from being called error-prone.
 */
export const ERROR_PRONE_RATE = 0.25;
export const ERROR_PRONE_MIN_INVOCATIONS = 5;

/** Mandatory caveat: carry this to every surface that renders the audit. */
export const SETUP_AUDIT_CAVEAT =
  "Machine-local and historical: the index covers sessions that may predate the current setup, " +
  "and project-scoped skills, subagents, and MCP servers live outside the Claude config dir.";

/* ——— Name matching ——————————————————————————————————————————————————
 * Session-observed names are best-effort matched against installed ones:
 *  - a user skill is invoked bare (`review`);
 *  - a plugin skill is invoked qualified (`my-plugin:review`), but Claude Code
 *    versions and configs differ on whether the prefix is present.
 *
 * `attribute()` below is the ONE classifier every question here goes through —
 * "was this used?" and "whose numbers are these?" are the same match asked at
 * two strictnesses, so they cannot drift apart. Both sides of the match are
 * normalized once (`matchTarget` / `observedName`) because every caller runs
 * installed items × observed rows.
 */

const norm = (name: string): string => name.trim().replace(/^\//, "").toLowerCase();

const bareName = (name: string): string => {
  const n = norm(name);
  const i = n.lastIndexOf(":");
  return i === -1 ? n : n.slice(i + 1);
};

/** The plugin that ships an item, or null for a user-installed one. */
export function sourcePlugin(source: InventorySource): string | null {
  return source.startsWith("plugin:") ? source.slice("plugin:".length) : null;
}

/** An installed item reduced to what matching needs, normalized once. */
interface MatchTarget {
  /** Normalized name of the plugin shipping it; null for a user-installed item. */
  plugin: string | null;
  /** Its normalized, unqualified name. */
  bare: string;
}

const target = (plugin: string | null, name: string): MatchTarget => ({
  plugin: plugin === null ? null : norm(plugin),
  bare: bareName(name),
});

const matchTarget = (item: InventoryItem): MatchTarget =>
  target(sourcePlugin(item.source), item.name);

/** An observed usage row's name, normalized once. */
interface ObservedName {
  /** The plugin prefix when the name is qualified (`toolkit:fmt`), else null. */
  prefix: string | null;
  /** The name after the last `:`. */
  bare: string;
}

function observedName(name: string): ObservedName {
  const n = norm(name);
  const cut = n.lastIndexOf(":");
  return cut === -1
    ? { prefix: null, bare: n }
    : { prefix: n.slice(0, cut), bare: n.slice(cut + 1) };
}

/** An observed row paired with its normalized name — hoisted out of the loops. */
interface Observed<T> {
  name: ObservedName;
  row: T;
}

const observeAll = <T extends { name: string }>(rows: T[]): Observed<T>[] =>
  rows.map((row) => ({ name: observedName(row.name), row }));

/** Server name out of an `mcp__<server>__<tool>` tool name, if it is one. */
export function mcpServerFromTool(tool: string): string | null {
  if (!tool.startsWith("mcp__")) return null;
  const rest = tool.slice("mcp__".length);
  const cut = rest.indexOf("__");
  const server = cut === -1 ? rest : rest.slice(0, cut);
  return server.length > 0 ? server : null;
}

/* ——— Date helper (pure; "today" is always passed in) ————————————————— */

function dayToMs(day: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return null;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(ms) ? null : ms;
}

/** Whole days from `from` to `to` (both YYYY-MM-DD), or null if unparseable. */
export function daysBetween(from: string, to: string): number | null {
  const a = dayToMs(from);
  const b = dayToMs(to);
  if (a === null || b === null) return null;
  return Math.round((b - a) / 86_400_000);
}

/* ——— The audit ——————————————————————————————————————————————————————— */

export function inventoryCounts(inventory: SetupInventory): SetupInventoryCounts {
  return {
    skills: inventory.skills.length,
    agents: inventory.agents.length,
    plugins: inventory.plugins.length,
    mcpServers: inventory.mcpServers.length,
    mcpGlobal: inventory.mcpServers.filter((s) => s.scope === "global").length,
    mcpProject: inventory.mcpServers.filter((s) => s.scope === "project").length,
    hookEvents: inventory.hooks.length,
    hooks: inventory.hooks.reduce((sum, h) => sum + h.hooks, 0),
    permissionAllow: inventory.permissions.allow,
    permissionDeny: inventory.permissions.deny,
    permissionAsk: inventory.permissions.ask,
  };
}

const sourceLabel = (source: InventorySource): string => {
  const plugin = sourcePlugin(source);
  return plugin ? `plugin ${plugin}` : "your ~/.claude dir";
};

/**
 * Aggregate of the observed skill rows one installed skill matched. `used` is
 * the loose answer (any attribution but "none"), the numbers are the strict one
 * (rows this item owns) — the two strictnesses of the attribution rule below.
 */
interface SkillMatch {
  used: boolean;
  invocations: number;
  errors: number;
  lastUsed: string | null;
  attributedTurns: number;
  attributedCost: number;
}

function matchSkill(
  item: MatchTarget,
  rows: Observed<SkillUsageRow>[],
  owners: Map<string, Set<string>>,
  userNames: Set<string>,
): SkillMatch {
  const m: SkillMatch = {
    used: false,
    invocations: 0,
    errors: 0,
    lastUsed: null,
    attributedTurns: 0,
    attributedCost: 0,
  };
  for (const { name, row } of rows) {
    const claim = attribute(name, item, owners, userNames);
    if (claim === "none") continue;
    if (row.invocations > 0) m.used = true;
    if (claim !== "owned") continue;
    m.invocations += row.invocations;
    m.errors += row.errors;
    m.attributedTurns += row.attributedTurns;
    m.attributedCost += row.attributedCost;
    if (row.lastUsed && (!m.lastUsed || row.lastUsed > m.lastUsed)) m.lastUsed = row.lastUsed;
  }
  return m;
}

function namesLine(names: string[], limit = 5): string {
  const shown = names.slice(0, limit).join(", ");
  const extra = names.length - limit;
  return extra > 0 ? `${shown}, and ${extra} more` : shown;
}

/* ——— Attribution ———————————————————————————————————————————————————
 *
 * ATTRIBUTION RULE — usedness is loose, numbers are strict.
 *
 * Every consumer asks the same question of the same classifier and only varies
 * the strictness it accepts: "was this used?" takes anything but `"none"` (a
 * loose match keeps us quiet, which is the failure mode this module prefers),
 * while "how many invocations / dollars are this item's?" takes only `"owned"`.
 * There a loose match is not silence but invention — the same bare `deploy` row
 * would be summed into every plugin shipping a `deploy` skill, and a user's own
 * `deploy` skill would have its cost claimed by a plugin. The cases:
 *
 * 0. User-installed item — trivially its own owner: nothing shadows a skill the
 *    user installed themselves, and a qualified observation of the same bare
 *    name stays a (loose, false-negative-safe) match for it.
 * 1. Qualified row (`toolkit:deploy`) against a plugin item — the prefix names
 *    its owner. Counts for that plugin, as usedness and in every number.
 * 2. Bare row (`deploy`), shipped by exactly one plugin and by no user-installed
 *    skill of that name — unambiguous. Counts fully, same as (1).
 * 3. Bare row shipped by two or more plugins — one of them really did run it,
 *    so it counts toward *usedness* for each candidate (accusing them all of
 *    being unused would be a guaranteed false accusation) but toward the
 *    numbers of none.
 * 4. Bare row whose name is also a user-installed skill — the user's own skill
 *    shadows the plugin's copy for bare invocations, so the plugin gets neither
 *    the numbers nor the usedness (the user's item, by (0), owns it), and stays
 *    eligible for `unused-plugin`.
 */

/** How much of one observed row belongs to a given installed item. */
type Attribution = "owned" | "shared" | "none";

/** Bare names of the items the user installed themselves (not via a plugin). */
function userBareNames(items: InventoryItem[]): Set<string> {
  return new Set(items.filter((i) => sourcePlugin(i.source) === null).map((i) => bareName(i.name)));
}

/** Which plugins ship each bare name — the ambiguity check behind rule (3). */
function ownersByBareName(
  plugins: PluginEntry[],
  ships: (plugin: PluginEntry) => string[],
): Map<string, Set<string>> {
  const owners = new Map<string, Set<string>>();
  for (const plugin of plugins) {
    for (const name of ships(plugin)) {
      const key = bareName(name);
      const set = owners.get(key) ?? new Set<string>();
      set.add(plugin.name);
      owners.set(key, set);
    }
  }
  return owners;
}

/**
 * Classify one observed usage row against one installed item — the single name
 * matcher in this module. `owners`/`userNames` describe the *inventory* the
 * item lives in (which plugins ship each bare name, which bare names the user
 * installed themselves); they are what makes cases (2)–(4) decidable.
 */
function attribute(
  observed: ObservedName,
  item: MatchTarget,
  owners: Map<string, Set<string>>,
  userNames: Set<string>,
): Attribution {
  if (observed.bare !== item.bare) return "none";
  if (item.plugin === null) return "owned"; // (0) the user's own item
  // (1) Qualified: nothing to guess — it names its plugin or it is not ours.
  if (observed.prefix !== null) return observed.prefix === item.plugin ? "owned" : "none";
  if (userNames.has(observed.bare)) return "none"; // (4) shadowed by a user item
  return (owners.get(observed.bare)?.size ?? 0) === 1 ? "owned" : "shared"; // (2) / (3)
}

/**
 * Roll observed usage and turn-scoped cost up to the plugin level.
 *
 * The per-skill/per-agent rollups answer "which skill is expensive?"; this one
 * answers "what is this plugin doing for me, and what does it cost?" — under
 * the attribution rule documented above, so a plugin skill invoked under both
 * its qualified and its bare name still sums into one row while an ambiguous
 * bare name inflates nobody's numbers.
 *
 * Costs are turn-scoped attribution summed across the plugin's skills, so they
 * inherit `SKILL_COST_CAVEAT` (a turn invoking several skills counts its full
 * cost toward each). Sorted most expensive first, then by invocations.
 */
export function buildPluginUsage(
  inventory: SetupInventory,
  usage: SetupUsage,
  /** The observed MCP servers, when the caller already derived them (the audit
   * needs the same set for its `unused-mcp-server` rule). Optional so the
   * function stays callable with two arguments. */
  observedServers?: Set<string>,
): PluginUsageRow[] {
  const usedServers = observedServers ?? observedMcpServers(usage.tools);
  const userSkills = userBareNames(inventory.skills);
  const userAgents = userBareNames(inventory.agents);
  const skillOwners = ownersByBareName(inventory.plugins, (p) => p.skills);
  const agentOwners = ownersByBareName(inventory.plugins, (p) => p.agents);
  const observedSkills = observeAll(usage.skills);
  const observedAgents = observeAll(usage.subagents);

  const rows = inventory.plugins.map((plugin) => {
    let invocations = 0;
    let skillsUsed = 0;
    let attributedTurns = 0;
    let attributedCost = 0;
    let lastUsed: string | null = null;
    for (const name of plugin.skills) {
      const match = matchSkill(target(plugin.name, name), observedSkills, skillOwners, userSkills);
      if (match.used) skillsUsed += 1;
      invocations += match.invocations;
      attributedTurns += match.attributedTurns;
      attributedCost += match.attributedCost;
      if (match.lastUsed && (!lastUsed || match.lastUsed > lastUsed)) lastUsed = match.lastUsed;
    }

    let agentsUsed = 0;
    let agentSessions = 0;
    for (const name of plugin.agents) {
      const item = target(plugin.name, name);
      let used = false;
      for (const { name: observed, row } of observedAgents) {
        const claim = attribute(observed, item, agentOwners, userAgents);
        if (claim === "none") continue;
        used = true;
        if (claim === "owned") agentSessions += row.sessions;
      }
      if (used) agentsUsed += 1;
    }

    const mcpServersUsed = plugin.mcpServers.filter((name) =>
      usedServers.has(name.toLowerCase()),
    ).length;

    return {
      plugin: plugin.name,
      skillsShipped: plugin.skills.length,
      skillsUsed,
      agentsShipped: plugin.agents.length,
      agentsUsed,
      mcpServers: plugin.mcpServers.length,
      mcpServersUsed,
      invocations,
      agentSessions,
      attributedTurns,
      attributedCost,
      lastUsed,
    };
  });

  return rows.sort(
    (a, b) =>
      b.attributedCost - a.attributedCost ||
      b.invocations - a.invocations ||
      a.plugin.localeCompare(b.plugin),
  );
}

/**
 * Plugins whose every discoverable component went unused. A plugin with nothing
 * discoverable (no skills, no agents, no servers — e.g. one known only by name
 * from the plugin config, or a commands-only plugin) is *not* included: "all
 * zero of its components are unused" is vacuously true and would be a false
 * accusation, and this module prefers false negatives.
 */
function deadPlugins(rows: PluginUsageRow[]): Map<string, PluginUsageRow> {
  const dead = new Map<string, PluginUsageRow>();
  for (const row of rows) {
    const ships = row.skillsShipped + row.agentsShipped + row.mcpServers;
    // The three *usedness* counters, and only those: they are the loose,
    // false-negative-safe answer to "was anything of this plugin used?", and
    // they already subsume the strict numbers (an owned row is a used one).
    // An ambiguous bare name (case 3 above) counts as used for every candidate
    // plugin while being summed into none, so this stays quiet about it.
    const used = row.skillsUsed + row.agentsUsed + row.mcpServersUsed;
    if (ships > 0 && used === 0) dead.set(row.plugin, row);
  }
  return dead;
}

function observedMcpServers(tools: ToolUsageRow[]): Set<string> {
  return new Set(
    tools.flatMap((row) => {
      const server = mcpServerFromTool(row.tool);
      return server ? [server.toLowerCase()] : [];
    }),
  );
}

function shipsLine(row: PluginUsageRow): string {
  const parts: string[] = [];
  if (row.skillsShipped > 0) {
    parts.push(`${row.skillsShipped} ${row.skillsShipped === 1 ? "skill" : "skills"}`);
  }
  if (row.agentsShipped > 0) {
    parts.push(`${row.agentsShipped} ${row.agentsShipped === 1 ? "subagent" : "subagents"}`);
  }
  if (row.mcpServers > 0) {
    parts.push(`${row.mcpServers} MCP ${row.mcpServers === 1 ? "server" : "servers"}`);
  }
  return parts.join(", ");
}

/**
 * Cross-reference an inventory with observed usage.
 *
 * `today` (YYYY-MM-DD) is a parameter, never `Date.now()`, so the rules stay
 * pure and testable — the caller supplies the local day.
 */
export function buildSetupAudit(
  inventory: SetupInventory,
  usage: SetupUsage,
  today: string,
): SetupAudit {
  const findings: SetupAuditFinding[] = [];
  // Derived once and shared with the plugin rollup — both ask the same question
  // ("which MCP servers actually appear in the sessions?") of the same rows.
  const usedServers = observedMcpServers(usage.tools);
  const plugins = buildPluginUsage(inventory, usage, usedServers);
  // The same normalized inputs `buildPluginUsage` matches with — every question
  // below goes through `attribute()`, so findings and numbers agree by
  // construction.
  const userSkills = userBareNames(inventory.skills);
  const userAgents = userBareNames(inventory.agents);
  const skillOwners = ownersByBareName(inventory.plugins, (p) => p.skills);
  const agentOwners = ownersByBareName(inventory.plugins, (p) => p.agents);
  const observedSkills = observeAll(usage.skills);
  const observedAgents = observeAll(usage.subagents);
  // One finding per dead plugin, not one per component: a plugin whose every
  // component is unused reports `unused-plugin`, and its skills/agents skip
  // their own `unused-skill`/`unused-agent` findings below.
  const dead = deadPlugins(plugins);
  const isDead = (item: InventoryItem): boolean => {
    const plugin = sourcePlugin(item.source);
    return plugin !== null && dead.has(plugin);
  };

  for (const skill of inventory.skills) {
    const match = matchSkill(matchTarget(skill), observedSkills, skillOwners, userSkills);

    if (!match.used) {
      if (isDead(skill)) continue;
      findings.push({
        code: "unused-skill",
        severity: "info",
        title: `Skill "${skill.name}" has never been invoked`,
        evidence: `Installed from ${sourceLabel(skill.source)}; no Skill invocation in the indexed sessions matches it.`,
        action:
          "Retire it if it no longer earns its keep — an unused skill is one more thing to keep current.",
        subject: skill.name,
      });
      continue;
    }

    const rate = match.errors / match.invocations;
    if (match.invocations >= ERROR_PRONE_MIN_INVOCATIONS && rate >= ERROR_PRONE_RATE) {
      findings.push({
        code: "error-prone-skill",
        severity: "warning",
        title: `Skill "${skill.name}" fails often`,
        evidence: `${match.errors} of ${match.invocations} invocations returned an error (${pct(rate)}).`,
        action:
          "Read the failing invocations: usually the skill's instructions drifted from the scripts or paths it assumes.",
        subject: skill.name,
      });
    }

    const age = match.lastUsed ? daysBetween(match.lastUsed, today) : null;
    if (match.lastUsed && age !== null && age >= STALE_SKILL_DAYS) {
      findings.push({
        code: "stale-skill",
        severity: "info",
        title: `Skill "${skill.name}" has gone quiet`,
        evidence: `${match.invocations} invocations, last on ${match.lastUsed} — ${age} days before ${today}.`,
        action:
          "Keep it if the work is seasonal; otherwise retire it with the rest of the clutter.",
        subject: skill.name,
      });
    }
  }

  for (const agent of inventory.agents) {
    const item = matchTarget(agent);
    const used = observedAgents.some(
      ({ name }) => attribute(name, item, agentOwners, userAgents) !== "none",
    );
    if (used || isDead(agent)) continue;
    findings.push({
      code: "unused-agent",
      severity: "info",
      title: `Subagent "${agent.name}" has never been dispatched`,
      evidence: `Installed from ${sourceLabel(agent.source)}; no Task/Agent call in the indexed sessions names it.`,
      action:
        "Subagent definitions are cheap to keep, but a stale one will eventually be dispatched with stale instructions.",
      subject: agent.name,
    });
  }

  for (const row of dead.values()) {
    findings.push({
      code: "unused-plugin",
      severity: "info",
      title: `Plugin "${row.plugin}" appears unused`,
      evidence: `It ships ${shipsLine(row)}; none of that appears in the indexed sessions.`,
      action:
        "Uninstall it if you have forgotten it — a plugin's skills and MCP schemas ride along in context whether or not you use them.",
      subject: row.plugin,
    });
  }

  for (const server of inventory.mcpServers) {
    if (usedServers.has(server.name.toLowerCase())) continue;
    const scope =
      server.scope === "global"
        ? "configured globally"
        : `configured in ${server.projects} ${server.projects === 1 ? "project" : "projects"}`;
    findings.push({
      code: "unused-mcp-server",
      severity: "warning",
      title: `MCP server "${server.name}" is configured but unused`,
      evidence: `${scope}; no mcp__${server.name}__* tool call appears in the indexed sessions.`,
      action:
        "Its tool schemas are re-sent with every turn — that is context tax on every prompt. Disable it where it isn't needed.",
      subject: server.name,
    });
  }

  // "Used but not installed" is only meaningful when there is an inventory to
  // compare against: with no config dir every observed name would be missing.
  if (inventory.present) {
    const skillTargets = inventory.skills.map(matchTarget);
    const agentTargets = inventory.agents.map(matchTarget);
    const missingSkills = observedSkills
      .filter(({ row }) => row.invocations > 0)
      .filter(
        ({ name }) =>
          !skillTargets.some((item) => attribute(name, item, skillOwners, userSkills) !== "none"),
      )
      .map(({ row }) => row)
      .sort((a, b) => b.invocations - a.invocations);
    if (missingSkills.length > 0) {
      findings.push({
        code: "missing-but-used",
        severity: "info",
        title: `${missingSkills.length} used ${missingSkills.length === 1 ? "skill is" : "skills are"} not in the current inventory`,
        evidence: `Invoked in sessions but not installed under ${inventory.claudeDir}: ${namesLine(
          missingSkills.map((row) => `${row.name} (${row.invocations})`),
        )}.`,
        action:
          "Usually nothing to do: they may be project-scoped (a repo's .claude/skills), shipped by a plugin under another name, or since removed.",
        subject: "skills",
      });
    }

    const missingAgents = observedAgents
      .filter(
        ({ name }) =>
          !agentTargets.some((item) => attribute(name, item, agentOwners, userAgents) !== "none"),
      )
      .map(({ row }) => row)
      .sort((a, b) => b.sessions - a.sessions);
    if (missingAgents.length > 0) {
      findings.push({
        code: "missing-but-used",
        severity: "info",
        title: `${missingAgents.length} dispatched ${missingAgents.length === 1 ? "subagent is" : "subagents are"} not in the current inventory`,
        evidence: `Dispatched in sessions but not defined under ${inventory.claudeDir}: ${namesLine(
          missingAgents.map((row) => `${row.name} (${row.sessions})`),
        )}.`,
        action:
          "Built-in subagents (for example general-purpose) always land here; the rest may be project-scoped, plugin-provided, or since removed.",
        subject: "subagents",
      });
    }
  }

  // Warnings first, insertion order preserved within a severity.
  const rank = (f: SetupAuditFinding): number => (f.severity === "warning" ? 0 : 1);
  findings.sort((a, b) => rank(a) - rank(b));

  return { inventory, counts: inventoryCounts(inventory), plugins, findings, today };
}
