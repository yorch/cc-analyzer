import { describe, expect, test } from "bun:test";
import {
  findingLabeller,
  projectMatches,
  rootLabeller,
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
  const r = row("/mnt/work/.claude", "/home/u/code/app");
  test("matches the root tag even when the label is bare", () => {
    expect(projectMatches("work", r, "…/code/app")).toBe(true);
    expect(projectMatches("nothing", r, "…/code/app")).toBe(false);
  });
  test("matches the displayed label and is case-insensitive; empty matches all", () => {
    expect(projectMatches("APP [WORK", r, "…/code/app [work/.claude]")).toBe(true);
    expect(projectMatches("  ", r, "x")).toBe(true);
  });
});
