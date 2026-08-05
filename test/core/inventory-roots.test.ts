import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanInventories, scanInventory } from "../../src/core/inventory.ts";

let roots: string[];

function writeJson(path: string, body: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(body));
}

/** Install a skill (a dir carrying SKILL.md) under a root. */
function addSkill(root: string, name: string): void {
  mkdirSync(join(root, "skills", name), { recursive: true });
  writeFileSync(join(root, "skills", name, "SKILL.md"), "# skill");
}

function addAgent(root: string, name: string): void {
  mkdirSync(join(root, "agents"), { recursive: true });
  writeFileSync(join(root, "agents", `${name}.md`), "# agent");
}

beforeEach(() => {
  roots = ["a", "b"].map((n) => mkdtempSync(join(tmpdir(), `cc-inv-${n}-`)));
});

afterEach(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
    rmSync(`${root}.json`, { force: true });
  }
});

test("reads .claude.json from inside a relocated config dir", () => {
  const [root] = roots as [string];
  // What Claude Code writes when the dir was moved with CLAUDE_CONFIG_DIR —
  // the sibling `<dir>.json` of a default install does not exist here.
  writeJson(join(root, ".claude.json"), {
    mcpServers: { linear: {} },
    projects: { "/work/api": { mcpServers: { postgres: {} } } },
  });
  const inv = scanInventory(root);
  expect(inv.mcpServers.map((s) => s.name).sort()).toEqual(["linear", "postgres"]);
  expect(inv.mcpServers.find((s) => s.name === "linear")?.scope).toBe("global");
  expect(inv.mcpServers.find((s) => s.name === "postgres")?.projects).toBe(1);
});

test("still reads the sibling <dir>.json of a default install", () => {
  const [root] = roots as [string];
  writeJson(`${root}.json`, { mcpServers: { linear: {} } });
  expect(scanInventory(root).mcpServers.map((s) => s.name)).toEqual(["linear"]);
});

test("a root carrying both files does not double-count a project's servers", () => {
  const [root] = roots as [string];
  const config = { projects: { "/work/api": { mcpServers: { postgres: {} } } } };
  writeJson(`${root}.json`, config);
  writeJson(join(root, ".claude.json"), config);
  expect(scanInventory(root).mcpServers.find((s) => s.name === "postgres")?.projects).toBe(1);
});

test("a single root is scanned unchanged", () => {
  const [root] = roots as [string];
  addSkill(root, "deploy");
  const merged = scanInventories([root]);
  expect(merged).toEqual(scanInventory(root));
  expect(merged.claudeDirs).toEqual([root]);
});

test("several roots merge into one inventory that names them all", () => {
  const [a, b] = roots as [string, string];
  addSkill(a, "deploy");
  addSkill(b, "review");
  addAgent(b, "auditor");
  const inv = scanInventories([a, b]);
  expect(inv.claudeDir).toBe(a);
  expect(inv.claudeDirs).toEqual([a, b]);
  expect(inv.skills.map((s) => s.name)).toEqual(["deploy", "review"]);
  expect(inv.agents.map((s) => s.name)).toEqual(["auditor"]);
  expect(inv.present).toBe(true);
});

test("a same-named skill in two roots collapses to one entry", () => {
  const [a, b] = roots as [string, string];
  addSkill(a, "deploy");
  addSkill(b, "deploy");
  // Usage is recorded by name only, so two entries would report one of them
  // unused on evidence that cannot distinguish them.
  expect(scanInventories([a, b]).skills.map((s) => s.name)).toEqual(["deploy"]);
});

test("additive counts sum and the pinned model comes from the primary root", () => {
  const [a, b] = roots as [string, string];
  writeJson(join(a, "settings.json"), {
    model: "claude-opus-4",
    permissions: { allow: ["Read", "Write"], deny: ["Bash(rm:*)"] },
    hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command" }] }] },
  });
  writeJson(join(b, "settings.json"), {
    model: "claude-haiku-4-5",
    permissions: { allow: ["Edit"] },
    hooks: { PreToolUse: [{ matcher: "Read", hooks: [{ type: "command" }] }] },
  });
  const inv = scanInventories([a, b]);
  expect(inv.permissions).toEqual({ allow: 3, deny: 1, ask: 0 });
  expect(inv.hooks).toEqual([{ event: "PreToolUse", hooks: 2 }]);
  expect(inv.model).toBe("claude-opus-4");
});

test("an absent root shrinks the merge instead of failing it", () => {
  const [a] = roots as [string];
  addSkill(a, "deploy");
  const inv = scanInventories([a, "/nope/not/here"]);
  expect(inv.present).toBe(true);
  expect(inv.skills.map((s) => s.name)).toEqual(["deploy"]);
  expect(inv.claudeDirs).toEqual([a, "/nope/not/here"]);
});

test("a global server in one root wins the label over a project-scoped one in another", () => {
  const [a, b] = roots as [string, string];
  writeJson(join(a, ".claude.json"), { projects: { "/work": { mcpServers: { linear: {} } } } });
  writeJson(join(b, "settings.json"), { mcpServers: { linear: {} } });
  const linear = scanInventories([a, b]).mcpServers.find((s) => s.name === "linear");
  expect(linear?.scope).toBe("global");
  expect(linear?.projects).toBe(1);
});
