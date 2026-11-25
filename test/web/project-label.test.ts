import { describe, expect, test } from "bun:test";
import {
  findingLabeller,
  projectMatches,
  rootLabeller,
  rootText,
  shortRootLabeller,
} from "../../web/src/project-label.ts";

const row = (
  claudeDir: string,
  projectPath: string | null,
  projectAlias: string | null = null,
) => ({
  claudeDir,
  projectPath,
  projectAlias,
  projectId: "p",
});

describe("shortRootLabeller", () => {
  test("single root: labels equal the abbreviated display name", () => {
    const rows = [
      row("/a/.claude", "/home/u/code/app"),
      row("/a/.claude", "/x"),
      row("/a/.claude", null, "mine"),
    ];
    const label = shortRootLabeller(rows);
    expect(label(rows.at(0) as (typeof rows)[number])).toBe("…/code/app");
    expect(label(rows.at(1) as (typeof rows)[number])).toBe("/x");
    expect(label(rows.at(2) as (typeof rows)[number])).toBe("mine");
  });

  test("two roots, same project: colliding labels get a [root] tag", () => {
    const rows = [
      row("/home/u/.claude", "/home/u/code/app"),
      row("/mnt/work/.claude", "/home/u/code/app"),
      row("/home/u/.claude", "/home/u/code/solo"),
    ];
    const label = shortRootLabeller(rows);
    expect(label(rows.at(0) as (typeof rows)[number])).toBe("…/code/app [u/.claude]");
    expect(label(rows.at(1) as (typeof rows)[number])).toBe("…/code/app [work/.claude]");
    expect(label(rows.at(2) as (typeof rows)[number])).toBe("…/code/solo");
  });
});

describe("rootLabeller", () => {
  test("uses the full path and tags only collisions", () => {
    const rows = [row("/r1/.claude", "/p/app"), row("/r2/.claude", "/p/app")];
    const label = rootLabeller(rows);
    expect(label(rows.at(0) as (typeof rows)[number])).toContain("/p/app [");
  });
});

describe("findingLabeller", () => {
  const f = (claudeDir: string | undefined) => ({
    projectId: "p",
    projectPath: "/work/app",
    claudeDir,
  });

  test("same name under two roots gets [root] tags", () => {
    const a = f("/home/u/rootA");
    const b = f("/home/u/rootB");
    const label = findingLabeller([a, b]);
    expect(label(a)).toBe("/work/app [rootA]");
    expect(label(b)).toBe("/work/app [rootB]");
  });

  test("single root and unscoped findings stay bare", () => {
    const a = f("/home/u/rootA");
    const u = f(undefined);
    const label = findingLabeller([a, u]);
    expect(label(a)).toBe("/work/app");
    expect(label(u)).toBe("/work/app");
  });
});

describe("labellers with `known` (the full project list)", () => {
  const home = row("/home/u/.claude", "/home/u/code/app");
  const work = row("/mnt/work/.claude", "/home/u/code/app");

  test("a lone survivor still tags against a twin cut from the rendered list", () => {
    expect(shortRootLabeller([home])(home)).toBe("…/code/app");
    expect(shortRootLabeller([home], [home, work])(home)).toBe("…/code/app [u/.claude]");
    expect(rootLabeller([work], [home, work])(work)).toBe("/home/u/code/app [work/.claude]");
  });

  test("absent or null known (still loading) keeps rows-only behavior", () => {
    expect(rootLabeller([home], null)(home)).toBe("/home/u/code/app");
    expect(rootLabeller([home], undefined)(home)).toBe("/home/u/code/app");
  });

  test("findingLabeller tags a lone finding against known projects", () => {
    const f = { projectId: "p", projectPath: "/home/u/code/app", claudeDir: "/home/u/.claude" };
    expect(findingLabeller([f])(f)).toBe("/home/u/code/app");
    expect(findingLabeller([f], [home, work])(f)).toBe("/home/u/code/app [u/.claude]");
  });

  test("an alias group spanning roots ('') never gets a tag", () => {
    const group = row("", null, "shared");
    expect(rootLabeller([group], [home, work])(group)).toBe("shared");
  });
});

describe("shortRootLabeller raw-id fallback", () => {
  test("a NULL path decodes the id instead of leaking <slug>~<name>", () => {
    const r = { ...row("/a/.claude", null), projectId: "0123abcd~-p-app" };
    const label = shortRootLabeller([r])(r);
    expect(label).not.toContain("~");
    expect(label).toBe("/p/app");
  });
});

describe("projectMatches", () => {
  const home = {
    ...row("/home/u/.claude", "/home/u/code/app"),
    projectId: "3f2a9c1b~-home-u-code-app",
  };
  const work = {
    ...row("/mnt/work/.claude", "/home/u/code/app"),
    projectId: "0e4d7a55~-home-u-code-app",
  };
  const other = {
    ...row("/home/u/.claude", "/home/u/code/zed"),
    projectId: "3f2a9c1b~-home-u-code-zed",
  };
  const rows = [home, work, other];
  const label = rootLabeller(rows);
  const hits = (q: string) => rows.filter((r) => projectMatches(q, r, label(r)));

  test("typing 'claude' does not match every row — only rows whose visible label carries it", () => {
    // the untagged `zed` row is out even though its raw root path contains '.claude'
    expect(hits("claude")).toEqual([home, work]);
    const lone = row("/a/.claude", "/p/solo");
    expect(projectMatches("claude", lone, rootLabeller([lone])(lone))).toBe(false);
  });
  test("hex fragments of the id's root slug do not match", () => {
    expect(hits("3f")).toEqual([]);
    expect(hits("0e4d")).toEqual([]);
  });
  test("the visible root tag finds only the tagged row", () => {
    expect(label(work)).toBe("/home/u/code/app [work/.claude]");
    expect(hits("work")).toEqual([work]);
    // the bare same-named twin shows its tag too, and the untagged row stays out
    expect(hits("[u/.claude]")).toEqual([home]);
  });
  test("matches label, path and alias, case-insensitively; empty matches all", () => {
    expect(hits("CODE/ZED")).toEqual([other]);
    const aliased = row("/a/.claude", "/x/y", "My Alias");
    expect(projectMatches("my ali", aliased, "My Alias")).toBe(true);
    expect(projectMatches("/x/y", aliased, "My Alias")).toBe(true);
    expect(projectMatches("  ", home, "x")).toBe(true);
  });
});

describe("rootText", () => {
  test("an alias group spanning roots reads 'several roots', never blank", () => {
    expect(rootText("")).toBe("several roots");
    expect(rootText("/mnt/work/.claude")).toBe("/mnt/work/.claude");
  });
});
