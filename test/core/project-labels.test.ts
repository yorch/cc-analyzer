import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  decodeProjectLabel,
  labelProjects,
  projectDisplayName,
  projectIdParts,
  resolveProjectRef,
  rootTag,
} from "../../src/core/project-labels.ts";

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

  test("extends the tag until it actually distinguishes the roots", () => {
    // The common multi-profile shape: both end in `.claude`, so one segment
    // disambiguates nothing — which would defeat the point of the tag.
    const all = ["/Users/me/.claude", "/mnt/work/.claude"];
    expect(rootTag("/Users/me/.claude", all)).toBe("me/.claude");
    expect(rootTag("/mnt/work/.claude", all)).toBe("work/.claude");
  });

  test("stays short when one segment is already unique", () => {
    const all = ["/Users/me/work", "/Users/me/personal"];
    expect(rootTag("/Users/me/work", all)).toBe("work");
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

  test("colliding labels under same-named roots still get distinct tags", () => {
    const rows = [
      { name: "/shared", root: "/Users/me/.claude" },
      { name: "/shared", root: "/mnt/work/.claude" },
    ];
    const out = rows.map(label(rows).label);
    expect(out[0]).not.toBe(out[1]);
    expect(out).toEqual(["/shared [me/.claude]", "/shared [work/.claude]"]);
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

describe("resolveProjectRef", () => {
  const ids = ["aaaaaaaa~-Users-me-proj", "bbbbbbbb~-Users-me-proj", "aaaaaaaa~-Users-me-solo"];

  test("a full id matches exactly", () => {
    expect(resolveProjectRef("bbbbbbbb~-Users-me-proj", ids)).toEqual({
      status: "found",
      id: "bbbbbbbb~-Users-me-proj",
    });
  });

  test("a bare name resolves when only one root holds it", () => {
    // The leniency that makes uniform qualification liveable: nobody types a hash.
    expect(resolveProjectRef("-Users-me-solo", ids)).toEqual({
      status: "found",
      id: "aaaaaaaa~-Users-me-solo",
    });
  });

  test("a bare name held by two roots is ambiguous, never silently picked", () => {
    const out = resolveProjectRef("-Users-me-proj", ids);
    expect(out.status).toBe("ambiguous");
    expect(out.status === "ambiguous" && out.candidates).toEqual([
      "aaaaaaaa~-Users-me-proj",
      "bbbbbbbb~-Users-me-proj",
    ]);
  });

  test("a qualified id naming a root we do not have is unknown, not a bare match", () => {
    // It must not fall back to matching the name half — the user named a root.
    expect(resolveProjectRef("cccccccc~-Users-me-solo", ids)).toEqual({ status: "unknown" });
  });

  test("an unknown name is unknown", () => {
    expect(resolveProjectRef("-nope", ids)).toEqual({ status: "unknown" });
  });

  test("an id whose `~` is not a slug is treated as a bare name", () => {
    const withTilde = ["aaaaaaaa~-tmp-my~proj"];
    expect(resolveProjectRef("-tmp-my~proj", withTilde)).toEqual({
      status: "found",
      id: "aaaaaaaa~-tmp-my~proj",
    });
  });
});

describe("rootTag in the CLI's column", () => {
  test("roots sharing a long prefix still differ (truncating full paths would not)", () => {
    // The documented synced-machines case: `truncate(root, 40)` keeps the head,
    // so both render identically and the column disambiguates nothing.
    const all = [
      "/mnt/backups/machine-a/home/me/.claude",
      "/mnt/backups/machine-b/home/me/.claude",
    ];
    const tags = all.map((r) => rootTag(r, all));
    expect(tags[0]).not.toBe(tags[1]);
    expect(tags[0]).toContain("machine-a");
    expect(tags[1]).toContain("machine-b");
  });
});

describe("projectDisplayName", () => {
  test("prefers the authoritative path", () => {
    expect(projectDisplayName("/Users/me/proj", "aaaaaaaa~-Users-me-proj")).toBe("/Users/me/proj");
  });

  test("falls back to the decoded id with the slug stripped", () => {
    // A raw `<slug>~<name>` must never reach a person.
    expect(projectDisplayName(null, "aaaaaaaa~-Users-me-proj")).toBe("/Users/me/proj");
    expect(projectDisplayName(undefined, "aaaaaaaa~-Users-me-proj")).toBe("/Users/me/proj");
  });
});

describe("id algebra", () => {
  test("round-trips a qualified id", () => {
    expect(projectIdParts("deadbeef~-a-b")).toEqual({ slug: "deadbeef", dirName: "-a-b" });
  });

  test("decodes both qualified and bare ids to the same label", () => {
    expect(decodeProjectLabel("deadbeef~-Users-me-proj")).toBe("/Users/me/proj");
    expect(decodeProjectLabel("-Users-me-proj")).toBe("/Users/me/proj");
  });
});

/**
 * A source guard, in the spirit of the `CORRECTION_PATTERN_SOURCE` pinning test:
 * it fails on a *shape* of code rather than on a behaviour.
 *
 * Two shipped defects put a raw `<rootSlug>~<encodedName>` in a page heading,
 * both written as `projectPath ?? id`. Since ids became uniformly qualified,
 * any such fallback shows a hash to a person. `projectDisplayName()` exists
 * precisely so there is one rule; this makes forgetting it a test failure
 * rather than something a reviewer has to notice.
 *
 * The rule: a `projectPath ??` fallback may only default to a *literal*
 * (a string, `null`, `undefined`) — never to an expression that could be an id.
 * Anything richer belongs in `projectDisplayName`.
 */
describe("source guard · no raw project id as a display fallback", () => {
  const repo = fileURLToPath(new URL("../../", import.meta.url));
  const roots = [join(repo, "src"), join(repo, "web", "src")];
  const CODE = new Set([".ts", ".tsx"]);
  // The helper that *implements* the rule necessarily contains the pattern.
  const EXEMPT = new Set(["src/core/project-labels.ts"]);
  const LITERAL = /^("|'|`|null\b|undefined\b)/;

  function sourceFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) out.push(...sourceFiles(full));
      else if (CODE.has(extname(entry.name))) out.push(full);
    }
    return out;
  }

  test("every `projectPath ??` defaults to a literal, not to an id", () => {
    const offenders: string[] = [];
    for (const root of roots) {
      for (const file of sourceFiles(root)) {
        const rel = relative(repo, file).replaceAll("\\", "/");
        if (EXEMPT.has(rel)) continue;
        readFileSync(file, "utf8")
          .split("\n")
          .forEach((line, i) => {
            const at = line.indexOf("projectPath ??");
            if (at === -1) return;
            const rhs = line.slice(at + "projectPath ??".length).trim();
            if (!LITERAL.test(rhs)) offenders.push(`${rel}:${i + 1}  ${line.trim()}`);
          });
      }
    }
    expect(
      offenders,
      `Use projectDisplayName(path, id) — a project id is storage identity and ` +
        `must never be shown:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  test("the guard actually rejects the shape that shipped twice", () => {
    // Guard the guard: a rule that cannot fail is not a rule.
    expect(LITERAL.test("id")).toBe(false);
    expect(LITERAL.test("p.projectId")).toBe(false);
    expect(LITERAL.test('"—"')).toBe(true);
    expect(LITERAL.test("null,")).toBe(true);
    expect(LITERAL.test("undefined }")).toBe(true);
  });
});
