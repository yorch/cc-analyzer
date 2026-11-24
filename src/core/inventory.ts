/**
 * Read-only inventory of the Claude Code *setup*: skills, subagents, plugins,
 * MCP servers, hooks, and permission rules.
 *
 * Everything here is tolerant by construction — a missing dir, a malformed
 * JSON file, or an unfamiliar layout is skipped silently rather than thrown.
 * The setup is user-editable config that changes shape between Claude Code
 * versions, so a scan that throws would be a scan that breaks on upgrade.
 *
 * `scanInventory()` reads one Claude root; `scanInventories()` reads every
 * configured one and folds them together. Scanning is confined to those dirs
 * plus each one's `.claude.json` — the config file carrying global and
 * per-project MCP servers, read both as the dir's sibling (`~/.claude.json`, a
 * default install) and from inside it (a dir relocated with
 * `CLAUDE_CONFIG_DIR`). Nothing here writes.
 *
 * `node:fs` (not `bun:*`) so the module stays importable from any Bun entry;
 * the pure shapes and the cross-referencing rules live in `setup-audit.ts`.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { claudeDir, claudeRoots } from "./claude-roots.ts";
import type {
  HookEntry,
  InventoryItem,
  McpServerEntry,
  PermissionRuleCounts,
  PluginEntry,
  SetupInventory,
} from "./setup-audit.ts";

export type { SetupInventory } from "./setup-audit.ts";

/** Depth cap for the plugin walk: real layouts nest at most cache/<marketplace>/<plugin>/<version>. */
const PLUGIN_SCAN_DEPTH = 4;
/** Hard cap on directories visited while hunting for plugins. */
const PLUGIN_SCAN_LIMIT = 500;

const SKIP_DIRS = new Set(["node_modules", ".git", ".cache"]);

type Json = Record<string, unknown>;

/** The two orderings every inventory list uses. Hoisted so the merge and the
 *  per-root scans cannot sort the same shape two different ways. */
const byName = <T extends { name: string }>(a: T, b: T): number => a.name.localeCompare(b.name);
const byEvent = <T extends { event: string }>(a: T, b: T): number => a.event.localeCompare(b.event);

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
  return entries.sort(byEvent);
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
 * Merge server names from `settings.json` with the root's `.claude.json`
 * (the `~/.claude.json` layout): its top-level `mcpServers` keys are global,
 * and each `projects.<path>.mcpServers` block is project-scoped. A name seen in
 * any global block wins the "global" label; the rest carry how many project
 * configs declare them.
 */
function scanMcpServers(root: string, fromSettings: string[]): McpServerEntry[] {
  const global = new Set(fromSettings);
  const projectCounts = new Map<string, number>();

  // Two layouts, both read because either can be the live one: alongside the dir
  // (`~/.claude` → `~/.claude.json`, the default install), and inside it, which
  // is where Claude Code keeps the file when the dir was relocated with
  // `CLAUDE_CONFIG_DIR`. `readJson` is tolerant, so probing both costs nothing.
  const configs = [readJson(`${root}.json`), readJson(join(root, ".claude.json"))];
  for (const config of configs) {
    for (const name of objectKeys(config, "mcpServers")) global.add(name);
  }
  // Merged by project path first, so a root carrying both files doesn't count
  // the same project's servers twice.
  const projects: Json = Object.assign(
    {},
    ...configs.map((c) => (isObject(c?.projects) ? c.projects : {})),
  );
  for (const entry of Object.values(projects)) {
    if (!isObject(entry)) continue;
    for (const name of objectKeys(entry, "mcpServers")) {
      projectCounts.set(name, (projectCounts.get(name) ?? 0) + 1);
    }
  }

  const names = new Set([...global, ...projectCounts.keys()]);
  return [...names]
    .map((name) => ({
      name,
      scope: global.has(name) ? ("global" as const) : ("project" as const),
      projects: projectCounts.get(name) ?? 0,
    }))
    .sort(byName);
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

/**
 * MCP server names a plugin declares. Two layouts are in the wild and both are
 * best-effort: a `.mcp.json` at the plugin root (`{ "mcpServers": { … } }`, the
 * same shape as the project-level file), and an `mcpServers` field in the
 * manifest — either the inline object or a path to a JSON file relative to the
 * plugin dir. Anything else (or unreadable JSON) yields no names rather than an
 * error; a missed server is a false negative, which is the safe direction here.
 */
function pluginMcpServers(dir: string, manifest: Json | undefined): string[] {
  const names = new Set<string>(objectKeys(readJson(join(dir, ".mcp.json")), "mcpServers"));

  const declared = manifest?.mcpServers;
  if (isObject(declared)) {
    for (const name of Object.keys(declared)) names.add(name);
  } else if (typeof declared === "string" && declared.trim().length > 0) {
    for (const name of serverMapKeys(readJson(join(dir, declared.trim())))) names.add(name);
  }

  return [...names].sort();
}

/**
 * Server names out of a pointed-at JSON file, which may either nest them under
 * `mcpServers` or be the bare map itself.
 *
 * An `mcpServers` key is authoritative: its keys are the servers, even when it
 * is empty. Only a file *without* that key is read as a bare map, and then only
 * when it actually looks like one — every value an object carrying a
 * `command`/`url`/`type`, and no `$schema`-style metadata key. Otherwise a
 * `{ "$schema": …, "mcpServers": {} }` file would invent servers called
 * "$schema" and "mcpServers", and the plugin would then be accused of shipping
 * unused ones.
 */
function serverMapKeys(file: Json | undefined): string[] {
  if (!file) return [];
  if ("mcpServers" in file) return objectKeys(file, "mcpServers");
  const entries = Object.entries(file);
  const looksLikeServers =
    entries.length > 0 &&
    entries.every(
      ([key, value]) =>
        !key.startsWith("$") &&
        isObject(value) &&
        ("command" in value || "url" in value || "type" in value),
    );
  return looksLikeServers ? entries.map(([key]) => key) : [];
}

function pluginAt(dir: string): PluginEntry {
  const manifest = readJson(join(dir, ".claude-plugin", "plugin.json"));
  const declared = typeof manifest?.name === "string" ? manifest.name.trim() : "";
  return {
    name: declared.length > 0 ? declared : basename(dir),
    skills: skillNames(dir).sort(),
    agents: agentNames(dir).sort(),
    mcpServers: pluginMcpServers(dir, manifest),
  };
}

/**
 * Plugins Claude Code itself records as installed, from
 * `plugins/installed_plugins.json`. Current shape:
 * `{ version, plugins: { "name@marketplace": [{ scope, installPath, version }] } }`
 * (an entry may also be a bare object, or a list of names in older files).
 * Returns `undefined` when the file is absent or has no usable `plugins` map,
 * so callers fall back to walking the directory tree. Never throws.
 */
function installedPlugins(pluginsRoot: string): PluginEntry[] | undefined {
  const file = readJson(join(pluginsRoot, "installed_plugins.json"));
  const map = file?.plugins;
  if (!isObject(map)) return undefined;
  const out: PluginEntry[] = [];
  for (const [key, entry] of Object.entries(map)) {
    // "name@marketplace" → "name"; an entry's own fields are never names.
    const fallback = key.includes("@") ? key.slice(0, key.indexOf("@")) : key;
    if (fallback.length === 0) continue;
    const records = Array.isArray(entry) ? entry : [entry];
    let entryFound: PluginEntry | undefined;
    for (const rec of records) {
      const installPath =
        isObject(rec) && typeof rec.installPath === "string" ? rec.installPath : undefined;
      if (installPath && exists(installPath)) {
        const at = pluginAt(installPath);
        // Prefer the key's name over the directory name (a version dir like
        // "1.0.0" is not a plugin name); a manifest-declared name still wins.
        const manifest = readJson(join(installPath, ".claude-plugin", "plugin.json"));
        const declared = typeof manifest?.name === "string" && manifest.name.trim().length > 0;
        entryFound = declared ? at : { ...at, name: fallback };
        break;
      }
    }
    out.push(entryFound ?? { name: fallback, skills: [], agents: [], mcpServers: [] });
  }
  return out.sort(byName);
}

/**
 * Plugin discovery. `installed_plugins.json` is the authority for what is
 * *installed* when present: `plugins/marketplaces/*` holds cloned catalogs of
 * plugins that may never have been installed, and walking them would report
 * those as installed (and then as unused). Without that file the layout is
 * guessed by walking a few levels down for dirs that look like plugins
 * (`plugins/repos/<owner>/<plugin>`, `plugins/cache/<mk>/<plugin>/<version>`,
 * plugins directly under `plugins/`), then folding in names the older JSON
 * config files mention.
 */
function scanPlugins(root: string): PluginEntry[] {
  const pluginsRoot = join(root, "plugins");
  const installed = installedPlugins(pluginsRoot);
  if (installed) return installed;

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

  // Names the older config files know about, even when no dir was recognized.
  const config = readJson(join(pluginsRoot, "config.json"));
  if (config) {
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
          if (!found.has(name)) found.set(name, { name, skills: [], agents: [], mcpServers: [] });
        }
      }
    }
  }

  return [...found.values()].sort(byName);
}

/* ——— The scan ———————————————————————————————————————————————————————— */

function emptyInventory(root: string, present: boolean): SetupInventory {
  return {
    claudeDirs: [root],
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
 * Scan every configured Claude root and fold the results into one inventory.
 *
 * This is what the audit surfaces call: with a single root it is exactly
 * `scanInventory()`, and with several it merges them (see `mergeInventories`).
 */
export function scanInventories(
  roots: string[] = claudeRoots().map((r) => r.path),
): SetupInventory {
  // Merging one inventory is a no-op by construction, so there is no special
  // case here — the single-root path is the same code as the multi-root one.
  return mergeInventories(roots.map((root) => scanInventory(root)));
}

/**
 * Fold several roots' inventories into one.
 *
 * Observed usage is keyed by name only — the index records that a `deploy`
 * skill ran, never which root's copy — so same-named items from two roots must
 * collapse into one entry or the audit would report one of them unused on the
 * strength of evidence it cannot attribute. Counts that *are* additive (hooks,
 * permission rules) sum; the pinned model is the primary root's, since that is
 * the one whose settings.json Claude Code would have read first.
 */
function mergeInventories(parts: SetupInventory[]): SetupInventory {
  const skills = new Map<string, InventoryItem>();
  const agents = new Map<string, InventoryItem>();
  const plugins = new Map<string, PluginEntry>();
  const mcp = new Map<string, McpServerEntry>();
  const hooks = new Map<string, number>();
  const permissions: PermissionRuleCounts = { allow: 0, deny: 0, ask: 0 };

  for (const part of parts) {
    for (const item of part.skills) skills.set(`${item.source} ${item.name}`, item);
    for (const item of part.agents) agents.set(`${item.source} ${item.name}`, item);
    for (const plugin of part.plugins) {
      // Union its components rather than last-wins: a plugin installed under two
      // roots may ship a different subset from each, and dropping one root's
      // list would make `unused-plugin` fire for a plugin whose used components
      // came from the other.
      const prev = plugins.get(plugin.name);
      plugins.set(
        plugin.name,
        prev
          ? {
              name: plugin.name,
              skills: [...new Set([...prev.skills, ...plugin.skills])].sort(),
              agents: [...new Set([...prev.agents, ...plugin.agents])].sort(),
              mcpServers: [...new Set([...prev.mcpServers, ...plugin.mcpServers])].sort(),
            }
          : plugin,
      );
    }
    for (const server of part.mcpServers) {
      const prev = mcp.get(server.name);
      mcp.set(server.name, {
        name: server.name,
        // Global anywhere wins the label, matching the single-root rule.
        scope: prev?.scope === "global" || server.scope === "global" ? "global" : "project",
        projects: (prev?.projects ?? 0) + server.projects,
      });
    }
    for (const hook of part.hooks) hooks.set(hook.event, (hooks.get(hook.event) ?? 0) + hook.hooks);
    permissions.allow += part.permissions.allow;
    permissions.deny += part.permissions.deny;
    permissions.ask += part.permissions.ask;
  }

  return {
    claudeDirs: parts.flatMap((p) => p.claudeDirs),
    present: parts.some((p) => p.present),
    skills: [...skills.values()].sort(byName),
    agents: [...agents.values()].sort(byName),
    plugins: [...plugins.values()].sort(byName),
    mcpServers: [...mcp.values()].sort(byName),
    hooks: [...hooks.entries()].map(([event, count]) => ({ event, hooks: count })).sort(byEvent),
    permissions,
    // The primary root's pin, not the first root that happens to have one:
    // that is the settings.json Claude Code would read first, and reporting a
    // secondary root's model would misdescribe the setup.
    model: parts[0]?.model ?? null,
  };
}

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
    claudeDirs: [root],
    present: true,
    skills: skills.sort(byName),
    agents: agents.sort(byName),
    plugins,
    mcpServers: scanMcpServers(root, settings.mcpServers),
    hooks: settings.hooks,
    permissions: settings.permissions,
    model: settings.model,
  };
}
