import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scanInventory } from "../../src/core/inventory.ts";
import { tempClaudeDir } from "../helpers/claude-dir.ts";

let claude: ReturnType<typeof tempClaudeDir> | undefined;

/** A temp Claude dir plus its sibling `<dir>.json`, both cleaned up after. */
function fakeClaudeDir(): string {
  claude = tempClaudeDir("cc-analyzer-inventory");
  return claude.dir;
}

afterEach(() => {
  if (claude) {
    rmSync(`${claude.dir}.json`, { force: true });
    claude.cleanup();
    claude = undefined;
  }
});

const write = (path: string, body: string): void => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, body);
};

function seed(dir: string): void {
  write(
    join(dir, "settings.json"),
    JSON.stringify({
      model: "claude-opus-4",
      permissions: { allow: ["Bash(ls:*)", "Read", "Write"], deny: ["Bash(rm:*)"] },
      hooks: {
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command" }, { type: "command" }] }],
        Stop: [],
      },
      mcpServers: { "local-fs": { command: "fs" } },
    }),
  );
  write(join(dir, "skills", "tidy", "SKILL.md"), "# tidy\n");
  // A skill dir without a SKILL.md is not an installed skill.
  write(join(dir, "skills", "draft", "notes.md"), "wip\n");
  write(join(dir, "agents", "reviewer.md"), "# reviewer\n");
  // Only .md files under agents/ count.
  write(join(dir, "agents", "README.txt"), "ignore me\n");

  const plugin = join(dir, "plugins", "repos", "acme", "toolkit");
  write(join(plugin, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "toolkit" }));
  write(join(plugin, "skills", "deploy", "SKILL.md"), "# deploy\n");
  write(join(plugin, "agents", "shipper.md"), "# shipper\n");
  // A plugin's own MCP servers live in a root .mcp.json, not the user's config.
  write(join(plugin, ".mcp.json"), JSON.stringify({ mcpServers: { deployer: { command: "d" } } }));
  // Malformed plugin config must be skipped, not thrown on.
  write(join(dir, "plugins", "config.json"), "{ not json");

  write(
    `${dir}.json`,
    JSON.stringify({
      mcpServers: { github: { command: "gh-mcp" } },
      projects: {
        "/work/a": { mcpServers: { linear: {} } },
        "/work/b": { mcpServers: { linear: {} } },
      },
    }),
  );
}

describe("scanInventory", () => {
  test("reads skills, agents, plugins, servers, hooks, and permissions", () => {
    const dir = fakeClaudeDir();
    seed(dir);
    const inv = scanInventory();

    expect(inv.present).toBe(true);
    expect(inv.claudeDirs[0]).toBe(dir);
    expect(inv.model).toBe("claude-opus-4");
    expect(inv.permissions).toEqual({ allow: 3, deny: 1, ask: 0 });
    // An event with no hooks is not a configured hook.
    expect(inv.hooks).toEqual([{ event: "PreToolUse", hooks: 2 }]);

    expect(inv.skills).toEqual([
      { name: "deploy", source: "plugin:toolkit" },
      { name: "tidy", source: "user" },
    ]);
    expect(inv.agents).toEqual([
      { name: "reviewer", source: "user" },
      { name: "shipper", source: "plugin:toolkit" },
    ]);
    expect(inv.plugins).toEqual([
      { name: "toolkit", skills: ["deploy"], agents: ["shipper"], mcpServers: ["deployer"] },
    ]);
    // A plugin's servers are recorded against the plugin, never merged into the
    // user-configured server list.
    expect(inv.mcpServers.map((s) => s.name)).not.toContain("deployer");
  });

  test("reads plugin MCP servers declared in the manifest, inline or by path", () => {
    const dir = fakeClaudeDir();
    const inline = join(dir, "plugins", "inline");
    write(
      join(inline, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: "inline", mcpServers: { alpha: {} } }),
    );
    const pointed = join(dir, "plugins", "pointed");
    write(
      join(pointed, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: "pointed", mcpServers: "servers.json" }),
    );
    write(join(pointed, "servers.json"), JSON.stringify({ mcpServers: { beta: {} } }));
    // A dir only counts as a plugin when it declares itself or ships content.
    write(join(inline, "commands", "go.md"), "# go\n");
    write(join(pointed, "commands", "go.md"), "# go\n");

    const plugins = scanInventory().plugins;
    expect(plugins.find((p) => p.name === "inline")?.mcpServers).toEqual(["alpha"]);
    expect(plugins.find((p) => p.name === "pointed")?.mcpServers).toEqual(["beta"]);
  });

  test("a pointed-at file's mcpServers key is authoritative, even when empty", () => {
    // Regression: an `{ $schema, mcpServers: {} }` file used to fall back to
    // the file's own top-level keys, inventing servers named "$schema" and
    // "mcpServers" — and with them a false unused-plugin accusation.
    const dir = fakeClaudeDir();
    const plugin = join(dir, "plugins", "schema-only");
    write(
      join(plugin, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: "schema-only", mcpServers: "servers.json" }),
    );
    write(
      join(plugin, "servers.json"),
      JSON.stringify({ $schema: "https://example.com/s.json", mcpServers: {} }),
    );
    expect(scanInventory().plugins[0]?.mcpServers).toEqual([]);
  });

  test("a pointed-at file that IS the server map still works", () => {
    const dir = fakeClaudeDir();
    const plugin = join(dir, "plugins", "bare-map");
    write(
      join(plugin, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: "bare-map", mcpServers: "servers.json" }),
    );
    write(
      join(plugin, "servers.json"),
      JSON.stringify({ alpha: { command: "a" }, beta: { url: "http://b" } }),
    );
    expect(scanInventory().plugins[0]?.mcpServers).toEqual(["alpha", "beta"]);
  });

  test("a pointed-at file that looks like anything else yields no servers", () => {
    const dir = fakeClaudeDir();
    const plugin = join(dir, "plugins", "junk");
    write(
      join(plugin, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: "junk", mcpServers: "servers.json" }),
    );
    write(join(plugin, "servers.json"), JSON.stringify({ version: 2, notes: "wip" }));
    expect(scanInventory().plugins[0]?.mcpServers).toEqual([]);
  });

  test("an unreadable plugin MCP declaration yields no servers instead of throwing", () => {
    const dir = fakeClaudeDir();
    const plugin = join(dir, "plugins", "broken");
    write(join(plugin, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "broken" }));
    write(join(plugin, ".mcp.json"), "{{ not json");
    expect(scanInventory().plugins).toEqual([
      { name: "broken", skills: [], agents: [], mcpServers: [] },
    ]);
  });

  describe("plugin layouts (fixtures from Claude Code's documented shapes)", () => {
    const mkPlugin = (path: string, name: string, skill: string): void => {
      write(join(path, ".claude-plugin", "plugin.json"), JSON.stringify({ name }));
      write(join(path, "skills", skill, "SKILL.md"), "---\nname: x\n---\n");
    };

    test("installed_plugins.json installPath is the authority; cloned marketplaces are not installed", () => {
      const dir = fakeClaudeDir();
      const installPath = join(dir, "plugins", "cache", "acme-mk", "fmt", "1.2.0");
      mkPlugin(installPath, "fmt", "format");
      // Cloned catalog entry that was never installed.
      mkPlugin(join(dir, "plugins", "marketplaces", "acme-mk", "plugins", "unused"), "unused", "u");
      write(
        join(dir, "plugins", "installed_plugins.json"),
        JSON.stringify({
          version: 2,
          plugins: {
            "fmt@acme-mk": [{ scope: "user", installPath, version: "1.2.0" }],
            "gone@acme-mk": [{ scope: "user", installPath: join(dir, "nope"), version: "1" }],
          },
        }),
      );
      const names = scanInventory().plugins.map((p) => p.name);
      expect(names).toEqual(["fmt", "gone"]);
      expect(scanInventory().plugins[0]?.skills).toEqual(["format"]);
    });

    test("object-shaped entries never invent plugins named after their fields", () => {
      const dir = fakeClaudeDir();
      write(
        join(dir, "plugins", "installed_plugins.json"),
        JSON.stringify({ plugins: { "solo@mk": { scope: "user", installPath: "/missing" } } }),
      );
      expect(scanInventory().plugins.map((p) => p.name)).toEqual(["solo"]);
    });

    test("without installed_plugins.json, plugins under cache/ are still discovered", () => {
      const dir = fakeClaudeDir();
      mkPlugin(join(dir, "plugins", "cache", "mk", "fmt", "1.0.0"), "fmt", "format");
      expect(scanInventory().plugins.map((p) => p.name)).toEqual(["fmt"]);
    });

    test("fallback walk names cache plugins by their dir and keeps only the newest version", () => {
      const dir = fakeClaudeDir();
      const noManifest = (path: string, skill: string): void =>
        write(join(path, "skills", skill, "SKILL.md"), "---\nname: x\n---\n");
      noManifest(join(dir, "plugins", "cache", "mk", "fmt", "1.9.0"), "old");
      noManifest(join(dir, "plugins", "cache", "mk", "fmt", "1.10.0"), "new");
      noManifest(join(dir, "plugins", "cache", "mk", "fmt", "1.2.0"), "older");
      mkPlugin(join(dir, "plugins", "cache", "mk", "dir-name", "2.0.0"), "declared", "d");
      const plugins = scanInventory().plugins;
      expect(plugins.map((p) => p.name)).toEqual(["declared", "fmt"]);
      expect(plugins.find((p) => p.name === "fmt")?.skills).toEqual(["new"]);
    });

    test("malformed installed_plugins.json falls back to the directory walk", () => {
      const dir = fakeClaudeDir();
      write(join(dir, "plugins", "installed_plugins.json"), "{ nope");
      mkPlugin(join(dir, "plugins", "repos", "acme", "tool"), "tool", "t");
      expect(scanInventory().plugins.map((p) => p.name)).toEqual(["tool"]);
    });
  });

  test("merges MCP servers from settings.json and the sibling config file", () => {
    const dir = fakeClaudeDir();
    seed(dir);
    expect(scanInventory().mcpServers).toEqual([
      { name: "github", scope: "global", projects: 0 },
      { name: "linear", scope: "project", projects: 2 },
      { name: "local-fs", scope: "global", projects: 0 },
    ]);
  });

  test("a missing Claude dir yields an empty inventory instead of throwing", () => {
    const dir = fakeClaudeDir();
    rmSync(dir, { recursive: true, force: true });
    const inv = scanInventory();
    expect(inv.present).toBe(false);
    expect(inv.skills).toEqual([]);
    expect(inv.agents).toEqual([]);
    expect(inv.plugins).toEqual([]);
    expect(inv.mcpServers).toEqual([]);
    expect(inv.hooks).toEqual([]);
    expect(inv.permissions).toEqual({ allow: 0, deny: 0, ask: 0 });
    expect(inv.model).toBeNull();
  });

  test("malformed JSON anywhere is skipped, not thrown", () => {
    const dir = fakeClaudeDir();
    write(join(dir, "settings.json"), "{{ broken");
    write(`${dir}.json`, "also broken");
    write(join(dir, "skills", "tidy", "SKILL.md"), "# tidy\n");
    const inv = scanInventory();
    expect(inv.present).toBe(true);
    expect(inv.permissions).toEqual({ allow: 0, deny: 0, ask: 0 });
    expect(inv.mcpServers).toEqual([]);
    expect(inv.skills).toEqual([{ name: "tidy", source: "user" }]);
  });

  test("an explicit root overrides the configured Claude dir", () => {
    const dir = fakeClaudeDir();
    seed(dir);
    expect(scanInventory(join(dir, "nope")).present).toBe(false);
  });
});
