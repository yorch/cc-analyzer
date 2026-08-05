import { describe, expect, test } from "bun:test";
import { labelProjects, rootTag } from "../../src/core/project-labels.ts";

interface Row {
  name: string;
  root: string;
}
const label = (rows: Row[]) =>
  labelProjects(
    rows,
    (r) => r.name,
    (r) => r.root,
  );

describe("rootTag", () => {
  test("takes the last path segment", () => {
    expect(rootTag("/home/me/.claude")).toBe(".claude");
    expect(rootTag("/home/me/work/")).toBe("work");
  });

  test("handles Windows separators", () => {
    expect(rootTag("C:\\Users\\me\\.claude")).toBe(".claude");
  });

  test("falls back to the whole string when there is no segment", () => {
    expect(rootTag("/")).toBe("/");
  });
});

describe("labelProjects", () => {
  test("a single root leaves every label untouched", () => {
    const rows = [
      { name: "/a", root: "/r1" },
      { name: "/b", root: "/r1" },
    ];
    const { multiRoot, label: f } = label(rows);
    expect(multiRoot).toBe(false);
    expect(rows.map(f)).toEqual(["/a", "/b"]);
  });

  test("qualifies only the labels that actually collide across roots", () => {
    const rows = [
      { name: "/shared", root: "/home/work" },
      { name: "/shared", root: "/home/personal" },
      { name: "/unique", root: "/home/work" },
    ];
    const { multiRoot, label: f } = label(rows);
    expect(multiRoot).toBe(true);
    // The colliding pair is disambiguated; the unambiguous one stays clean.
    expect(rows.map(f)).toEqual(["/shared [work]", "/shared [personal]", "/unique"]);
  });

  test("the same label twice under ONE root is not a collision", () => {
    // Same root means same project — nothing to disambiguate.
    const rows = [
      { name: "/dup", root: "/home/work" },
      { name: "/dup", root: "/home/work" },
      { name: "/other", root: "/home/personal" },
    ];
    const { multiRoot, label: f } = label(rows);
    expect(multiRoot).toBe(true);
    expect(rows.map(f)).toEqual(["/dup", "/dup", "/other"]);
  });

  test("an empty list is not multi-root", () => {
    expect(label([]).multiRoot).toBe(false);
  });
});
