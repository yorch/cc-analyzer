import { describe, expect, test } from "bun:test";
import { findingLabeller, rootLabeller, shortRootLabeller } from "../../web/src/project-label.ts";

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
