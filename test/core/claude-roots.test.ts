import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import {
  claudeDir,
  claudeRoots,
  decodeProjectLabel,
  projectIdParts,
  qualifyProjectId,
  rootSlug,
  setClaudeRootsOverride,
} from "../../src/core/claude-roots.ts";
import { type TempStateDir, tempStateDir } from "../helpers/claude-dir.ts";

// These suites drive roots explicitly, so both env tiers must start unset.
const ENV_KEYS = ["CC_ANALYZER_CLAUDE_DIR", "CLAUDE_CONFIG_DIR"] as const;

let saved: Record<string, string | undefined>;
let state: TempStateDir;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  // Every tier below the flag can read prefs.json, so give each test its own.
  state = tempStateDir("cc-roots-state");
  setClaudeRootsOverride(null);
});

afterEach(() => {
  setClaudeRootsOverride(null);
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k] as string;
  }
  state.cleanup();
});

function writePrefs(claudeDirs: string[]): void {
  writeFileSync(join(state.dir, "prefs.json"), JSON.stringify({ claudeDirs }));
}

describe("claudeRoots precedence", () => {
  test("defaults to ~/.claude", () => {
    const roots = claudeRoots();
    expect(roots).toHaveLength(1);
    expect(roots[0]?.path).toBe(join(homedir(), ".claude"));
    expect(roots[0]?.source).toBe("default");
    expect(roots[0]?.primary).toBe(true);
  });

  test("honours CLAUDE_CONFIG_DIR — the variable Claude Code itself reads", () => {
    process.env.CLAUDE_CONFIG_DIR = "/srv/claude";
    const roots = claudeRoots();
    expect(roots.map((r) => r.path)).toEqual(["/srv/claude"]);
    expect(roots[0]?.source).toBe("claude-code");
  });

  test("the persisted preference outranks CLAUDE_CONFIG_DIR", () => {
    process.env.CLAUDE_CONFIG_DIR = "/srv/claude";
    writePrefs(["/srv/mine"]);
    expect(claudeRoots().map((r) => r.path)).toEqual(["/srv/mine"]);
    expect(claudeRoots()[0]?.source).toBe("prefs");
  });

  test("CC_ANALYZER_CLAUDE_DIR outranks the preference", () => {
    writePrefs(["/srv/mine"]);
    process.env.CC_ANALYZER_CLAUDE_DIR = "/srv/env";
    expect(claudeRoots().map((r) => r.path)).toEqual(["/srv/env"]);
    expect(claudeRoots()[0]?.source).toBe("env");
  });

  test("the flag override outranks everything", () => {
    process.env.CC_ANALYZER_CLAUDE_DIR = "/srv/env";
    setClaudeRootsOverride(["/srv/flag"]);
    expect(claudeRoots().map((r) => r.path)).toEqual(["/srv/flag"]);
    expect(claudeRoots()[0]?.source).toBe("flag");
  });

  test("tiers are exclusive — a configured root never mixes ~/.claude back in", () => {
    writePrefs(["/srv/mine"]);
    expect(claudeRoots().map((r) => r.path)).not.toContain(join(homedir(), ".claude"));
  });

  test("reads a PATH-style list, only the first root is primary", () => {
    process.env.CC_ANALYZER_CLAUDE_DIR = ["/srv/a", "/srv/b", "/srv/c"].join(delimiter);
    const roots = claudeRoots();
    expect(roots.map((r) => r.path)).toEqual(["/srv/a", "/srv/b", "/srv/c"]);
    expect(roots.map((r) => r.primary)).toEqual([true, false, false]);
    expect(claudeDir()).toBe("/srv/a");
  });

  test("a tier that normalizes to nothing falls through instead of winning empty", () => {
    // ":" is non-empty but splits to no entries. Winning with an empty list
    // would leave `claudeDir()` with no primary root and throw.
    process.env.CC_ANALYZER_CLAUDE_DIR = delimiter;
    const roots = claudeRoots();
    expect(roots).toHaveLength(1);
    expect(roots[0]?.source).toBe("default");
    expect(() => claudeDir()).not.toThrow();
  });

  test("a trailing slash is the same root, not a second one", () => {
    // What shell tab-completion produces. Two entries would double every
    // project, every session, and every indexed row.
    process.env.CC_ANALYZER_CLAUDE_DIR = ["/srv/a", "/srv/a/"].join(delimiter);
    expect(claudeRoots().map((r) => r.path)).toEqual(["/srv/a"]);
  });

  test("redundant path segments normalize to one root", () => {
    process.env.CC_ANALYZER_CLAUDE_DIR = ["/srv/a", "/srv/b/../a", "/srv//a"].join(delimiter);
    expect(claudeRoots().map((r) => r.path)).toEqual(["/srv/a"]);
  });

  test("expands ~ and drops duplicates and blanks", () => {
    process.env.CC_ANALYZER_CLAUDE_DIR = ["~/data", "", "/srv/a", "/srv/a"].join(delimiter);
    expect(claudeRoots().map((r) => r.path)).toEqual([join(homedir(), "data"), "/srv/a"]);
  });
});

describe("project id qualification", () => {
  // Built the way `claudeRoots()` builds them — the slug is stored on the root,
  // not recomputed per project.
  const primary = {
    path: "/srv/a",
    slug: rootSlug("/srv/a"),
    source: "env" as const,
    primary: true,
  };
  const secondary = {
    path: "/srv/b",
    slug: rootSlug("/srv/b"),
    source: "env" as const,
    primary: false,
  };

  test("the primary root's ids are unqualified, so existing ids never re-key", () => {
    expect(qualifyProjectId(primary, "-Users-me-proj")).toBe("-Users-me-proj");
  });

  test("a non-primary root's ids carry its slug, so identical names stay distinct", () => {
    const id = qualifyProjectId(secondary, "-Users-me-proj");
    expect(id).not.toBe("-Users-me-proj");
    expect(id).toBe(`${rootSlug("/srv/b")}~-Users-me-proj`);
  });

  test("the slug is stable and path-derived, not positional", () => {
    expect(rootSlug("/srv/b")).toBe(rootSlug("/srv/b"));
    expect(rootSlug("/srv/b")).not.toBe(rootSlug("/srv/c"));
  });

  test("round-trips back to the encoded directory name", () => {
    const id = qualifyProjectId(secondary, "-Users-me-proj");
    expect(projectIdParts(id)).toEqual({ slug: rootSlug("/srv/b"), dirName: "-Users-me-proj" });
    expect(projectIdParts("-Users-me-proj")).toEqual({ slug: null, dirName: "-Users-me-proj" });
  });

  test("a `~` in the working directory is not mistaken for a root slug", () => {
    // /tmp/my~proj encodes to -tmp-my~proj. Splitting on the first `~` would
    // decode the label as "/proj" and resolve to a root slug matching nothing,
    // so `sessions <id>` would find nothing for a project `projects` just listed.
    expect(projectIdParts("-tmp-my~proj")).toEqual({ slug: null, dirName: "-tmp-my~proj" });
    expect(decodeProjectLabel("-tmp-my~proj")).toBe("/tmp/my~proj");
  });

  test("only an 8-hex prefix counts as a slug", () => {
    expect(projectIdParts("deadbeef~-a").slug).toBe("deadbeef");
    expect(projectIdParts("DEADBEEF~-a").slug).toBeNull(); // uppercase
    expect(projectIdParts("deadbee~-a").slug).toBeNull(); // 7 chars
    expect(projectIdParts("deadbeef0~-a").slug).toBeNull(); // 9 chars
  });

  test("labels decode from the directory-name half of a qualified id", () => {
    expect(decodeProjectLabel(qualifyProjectId(secondary, "-Users-me-proj"))).toBe(
      "/Users/me/proj",
    );
    expect(decodeProjectLabel("-Users-me-proj")).toBe("/Users/me/proj");
  });
});

describe("discovery across roots", () => {
  let dirs: string[];

  beforeEach(() => {
    dirs = ["a", "b"].map((n) => mkdtempSync(join(tmpdir(), `cc-roots-${n}-`)));
    // The collision case: the same encoded project name under both roots.
    for (const dir of dirs) {
      mkdirSync(join(dir, "projects", "-Users-me-proj"), { recursive: true });
      writeFileSync(join(dir, "projects", "-Users-me-proj", "s.jsonl"), "");
    }
    process.env.CC_ANALYZER_CLAUDE_DIR = dirs.join(delimiter);
  });

  afterEach(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  test("same-named projects under two roots stay separate, each tagged with its root", async () => {
    const { listProjects } = await import("../../src/core/discover.ts");
    const projects = await listProjects();
    expect(projects).toHaveLength(2);
    expect(new Set(projects.map((p) => p.id)).size).toBe(2);
    expect(new Set(projects.map((p) => p.root))).toEqual(new Set(dirs));
    // Both still decode to the same human label — that is the point of the id.
    expect(projects.map((p) => p.label)).toEqual(["/Users/me/proj", "/Users/me/proj"]);
  });

  test("a qualified id resolves back to its own root's sessions", async () => {
    const { listProjects, listSessions } = await import("../../src/core/discover.ts");
    for (const project of await listProjects()) {
      const sessions = await listSessions(project.id);
      expect(sessions).toHaveLength(1);
      expect(sessions[0]?.root).toBe(project.root);
      expect(sessions[0]?.path.startsWith(project.root)).toBe(true);
    }
  });

  test("scanRoots reports an unreadable root rather than dropping it", async () => {
    const { scanRoots } = await import("../../src/core/discover.ts");
    process.env.CC_ANALYZER_CLAUDE_DIR = [dirs[0], "/nope/not/here"].join(delimiter);
    const scans = await scanRoots();
    expect(scans.map((s) => s.readable)).toEqual([true, false]);
  });
});
