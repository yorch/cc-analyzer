/**
 * Read-only inventory of the Claude Code *setup*: skills, subagents, plugins,
 * MCP servers, hooks, and permission rules.
 *
 * Everything here is tolerant by construction — a missing dir, a malformed
 * JSON file, or an unfamiliar layout is skipped silently rather than thrown.
 * The setup is user-editable config that changes shape between Claude Code
 * versions, so a scan that throws would be a scan that breaks on upgrade.
 *
 * Scanning is confined to the configured Claude dir (`claudeDir()`, which
 * honours `CC_ANALYZER_CLAUDE_DIR`) plus its sibling `<claudeDir>.json` — the
 * `~/.claude.json` config file that carries global and per-project MCP servers.
 * Nothing here writes.
 *
 * `node:fs` (not `bun:*`) so the module stays importable from any Bun entry;
 * the pure shapes and the cross-referencing rules live in `setup-audit.ts`.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { claudeDir } from "./paths.ts";
import type {
  HookEntry,
  InventoryItem,
  McpServerEntry,
  PermissionRuleCounts,
  PluginEntry,
  SetupInventory,
} from "./setup-audit.ts";

export type { SetupInventory } from "./setup-audit.ts";

/** Depth cap for the plugin walk: real layouts nest at most repos/<owner>/<plugin>. */
const PLUGIN_SCAN_DEPTH = 3;
/** Hard cap on directories visited while hunting for plugins. */
const PLUGIN_SCAN_LIMIT = 500;

const SKIP_DIRS = new Set(["node_modules", ".git", "cache", ".cache"]);

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function readJson(path: string): Json | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return isObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function listDirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() || e.isSymbolicLink())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

function listFiles(dir: string, ext: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => !e.isDirectory() && e.name.endsWith(ext))
      .map((e) => e.name);
  } catch {
    return [];
  }
}

function exists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

/** Skill dir names under `<root>/skills` that actually carry a SKILL.md. */
function skillNames(root: string): string[] {
  const dir = join(root, "skills");
  return listDirs(dir).filter((name) => exists(join(dir, name, "SKILL.md")));
}

/** Subagent names under `<root>/agents` (file basename without `.md`). */
function agentNames(root: string): string[] {
  return listFiles(join(root, "agents"), ".md").map((f) => basename(f, ".md"));
}

/** String keys of a nested object field, or [] when it isn't one. */
function objectKeys(source: Json | undefined, field: string): string[] {
  const value = source?.[field];
  return isObject(value) ? Object.keys(value) : [];
}

function countArray(source: Json | undefined, field: string): number {
  const value = source?.[field];
  return Array.isArray(value) ? value.length : 0;
}

/* ——— settings.json ——————————————————————————————————————————————————— */

interface SettingsScan {
  permissions: PermissionRuleCounts;
  hooks: HookEntry[];
  model: string | null;
  mcpServers: string[];
}

/**
 * `hooks` maps an event name to an array of matcher groups, each carrying its
 * own `hooks` array. Older/hand-written settings sometimes put the hook objects
 * directly in the event array, so a group without a nested array counts as one.
 */
function scanHooks(settings: Json | undefined): HookEntry[] {
  const hooks = settings?.hooks;
  if (!isObject(hooks)) return [];
  const entries: HookEntry[] = [];
  for (const [event, value] of Object.entries(hooks)) {
    if (!Array.isArray(value)) continue;
    let count = 0;
    for (const group of value) {
      count += isObject(group) && Array.isArray(group.hooks) ? group.hooks.length : 1;
    }
    if (count > 0) entries.push({ event, hooks: count });
  }
  return entries.sort((a, b) => a.event.localeCompare(b.event));
}

function scanSettings(root: string): SettingsScan {
  const settings = readJson(join(root, "settings.json"));
  const permissions = isObject(settings?.permissions) ? settings.permissions : undefined;
  const model = typeof settings?.model === "string" ? settings.model : null;
  return {
    permissions: {
      allow: countArray(permissions, "allow"),
      deny: countArray(permissions, "deny"),
      ask: countArray(permissions, "ask"),
    },
    hooks: scanHooks(settings),
    model,
    mcpServers: objectKeys(settings, "mcpServers"),
  };
}

/* ——— MCP servers ————————————————————————————————————————————————————— */

/**
 * Merge server names from `settings.json` with the sibling `<claudeDir>.json`
 * (the `~/.claude.json` layout): its top-level `mcpServers` keys are global,
 * and each `projects.<path>.mcpServers` block is project-scoped. A name seen in
 * any global block wins the "global" label; the rest carry how many project
 * configs declare them.
 */
function scanMcpServers(root: string, fromSettings: string[]): McpServerEntry[] {
  const global = new Set(fromSettings);
  const projectCounts = new Map<string, number>();

  const config = readJson(`${root}.json`);
  for (const name of objectKeys(config, "mcpServers")) global.add(name);
  const projects = config?.projects;
  if (isObject(projects)) {
    for (const entry of Object.values(projects)) {
      if (!isObject(entry)) continue;
      for (const name of objectKeys(entry, "mcpServers")) {
        projectCounts.set(name, (projectCounts.get(name) ?? 0) + 1);
      }
    }
  }

  const names = new Set([...global, ...projectCounts.keys()]);
  return [...names]
    .map((name) => ({
      name,
      scope: global.has(name) ? ("global" as const) : ("project" as const),
      projects: projectCounts.get(name) ?? 0,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/* ——— Plugins ————————————————————————————————————————————————————————— */

/** A dir is a plugin when it declares itself, or ships skills/agents/commands. */
function looksLikePlugin(dir: string): boolean {
  return (
    exists(join(dir, ".claude-plugin", "plugin.json")) ||
    exists(join(dir, "skills")) ||
    exists(join(dir, "agents")) ||
    exists(join(dir, "commands"))
  );
}

function pluginAt(dir: string): PluginEntry {
  const manifest = readJson(join(dir, ".claude-plugin", "plugin.json"));
  const declared = typeof manifest?.name === "string" ? manifest.name.trim() : "";
  return {
    name: declared.length > 0 ? declared : basename(dir),
    skills: skillNames(dir).sort(),
    agents: agentNames(dir).sort(),
  };
}

/**
 * Best-effort plugin discovery. The on-disk layout has changed across Claude
 * Code versions (`plugins/repos/<owner>/<plugin>`, `plugins/marketplaces/...`,
 * or plugins sitting directly under `plugins/`), so instead of hard-coding one
 * shape this walks a few levels down and takes every dir that looks like a
 * plugin, then folds in any names the JSON config files mention.
 */
function scanPlugins(root: string): PluginEntry[] {
  const pluginsRoot = join(root, "plugins");
  const found = new Map<string, PluginEntry>();
  let visited = 0;

  const walk = (dir: string, depth: number): void => {
    if (depth > PLUGIN_SCAN_DEPTH || visited >= PLUGIN_SCAN_LIMIT) return;
    for (const name of listDirs(dir)) {
      if (SKIP_DIRS.has(name) || visited >= PLUGIN_SCAN_LIMIT) continue;
      visited += 1;
      const child = join(dir, name);
      if (looksLikePlugin(child)) {
        const entry = pluginAt(child);
        if (!found.has(entry.name)) found.set(entry.name, entry);
        continue; // A plugin's own subdirs are its contents, not more plugins.
      }
      walk(child, depth + 1);
    }
  };
  walk(pluginsRoot, 1);

  // Names the config files know about, even when no dir was recognized.
  for (const file of ["config.json", "installed_plugins.json"]) {
    const config = readJson(join(pluginsRoot, file));
    if (!config) continue;
    for (const field of ["installedPlugins", "plugins", "repositories"]) {
      const value = config[field];
      if (!isObject(value)) continue;
      for (const [key, entry] of Object.entries(value)) {
        const names = Array.isArray(entry)
          ? entry.filter((n): n is string => typeof n === "string")
          : isObject(entry)
            ? Object.keys(entry)
            : [key];
        for (const name of names) {
          if (!found.has(name)) found.set(name, { name, skills: [], agents: [] });
        }
      }
    }
  }

  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/* ——— The scan ———————————————————————————————————————————————————————— */

function emptyInventory(root: string, present: boolean): SetupInventory {
  return {
    claudeDir: root,
    present,
    skills: [],
    agents: [],
    plugins: [],
    mcpServers: [],
    hooks: [],
    permissions: { allow: 0, deny: 0, ask: 0 },
    model: null,
  };
}

/**
 * Scan the configured Claude dir for installed skills, subagents, plugins, MCP
 * servers, hooks, and permission rules. Never throws: an absent dir yields an
 * empty inventory flagged `present: false`.
 */
export function scanInventory(root: string = claudeDir()): SetupInventory {
  if (!exists(root)) return emptyInventory(root, false);

  const settings = scanSettings(root);
  const plugins = scanPlugins(root);

  const skills: InventoryItem[] = skillNames(root).map((name) => ({ name, source: "user" }));
  const agents: InventoryItem[] = agentNames(root).map((name) => ({ name, source: "user" }));
  for (const plugin of plugins) {
    const source = `plugin:${plugin.name}` as const;
    for (const name of plugin.skills) skills.push({ name, source });
    for (const name of plugin.agents) agents.push({ name, source });
  }

  return {
    claudeDir: root,
    present: true,
    skills: skills.sort((a, b) => a.name.localeCompare(b.name)),
    agents: agents.sort((a, b) => a.name.localeCompare(b.name)),
    plugins,
    mcpServers: scanMcpServers(root, settings.mcpServers),
    hooks: settings.hooks,
    permissions: settings.permissions,
    model: settings.model,
  };
}
