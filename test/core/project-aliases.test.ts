import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeSession } from "../../src/core/analyze.ts";
import type { SessionInfo } from "../../src/core/discover.ts";
import { toSessionRow } from "../../src/core/indexer.ts";
import { parseSessionFile } from "../../src/core/parser.ts";
import {
  type AliasSource,
  effectiveAliasMap,
  MAX_ALIAS_UPDATED_AT,
  mergeAliasSources,
  normalizeAliasPath,
  projectAliasId,
  readAliasSources,
  readProjectAliases,
  writeMachineAliases,
  writeProjectAliases,
} from "../../src/core/project-aliases.ts";
import { projectDisplayName } from "../../src/core/project-labels.ts";
import { samplePricing } from "../helpers/pricing.ts";

const temp = async () => mkdtemp(join("/tmp", `cc-analyzer-project-aliases-${process.pid}-`));

describe("project aliases", () => {
  test("normalizes POSIX, Windows, and UNC working-directory paths", () => {
    expect(normalizeAliasPath(" /Users/alice/work/../app/ ")).toBe("/Users/alice/app");
    expect(normalizeAliasPath("C:\\Users\\alice\\app\\")).toBe("C:/Users/alice/app");
    expect(normalizeAliasPath("\\\\server\\share\\app")).toBe("//server/share/app");
  });

  test("round-trips stable path mappings and computes one deterministic alias id", async () => {
    const dir = await temp();
    try {
      const aliases = new Map([
        ["/Users/alice/app", "Acme App"],
        ["D:/work/app", "Acme App"],
      ]);
      await writeProjectAliases(aliases, dir);
      const loaded = await readProjectAliases(dir);
      expect([...loaded.byPath]).toEqual([...aliases]);
      expect(projectAliasId("Acme App")).toBe(projectAliasId("Acme App"));
      expect(projectAliasId("Acme App")).not.toBe(projectAliasId("Other App"));
      expect(await readFile(join(dir, "project-aliases.json"), "utf8")).toContain('"version": 1');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("indexes an aliased project under a stable shared id and display label", async () => {
    const fixture = fileURLToPath(new URL("../fixtures/sample-session.jsonl", import.meta.url));
    const { events } = await parseSessionFile(fixture);
    const analysis = analyzeSession(events, samplePricing);
    const info = {
      id: "session-1",
      projectId: "machine~project",
      path: "/archive/session-1.jsonl",
      root: "/archive",
      sizeBytes: 1,
      mtimeMs: 1,
      subagentPaths: [],
      parentExists: true,
      agentMeta: new Map(),
    } satisfies SessionInfo;
    const row = toSessionRow(analysis, info, 1, new Map([["/Users/dev/proj", "Shared App"]]));
    expect(row.project_id).toBe(projectAliasId("Shared App"));
    expect(row.project_alias).toBe("Shared App");
    expect(projectDisplayName(row.project_path, row.project_id, row.project_alias)).toBe(
      "Shared App",
    );
  });

  test("missing alias file means no mappings; malformed files fail loudly", async () => {
    const dir = await temp();
    try {
      await mkdir(dir, { recursive: true });
      expect((await readProjectAliases(dir)).byPath.size).toBe(0);
      await Bun.write(join(dir, "project-aliases.json"), '{"version":2,"aliases":{}}');
      await expect(readProjectAliases(dir)).rejects.toThrow("Invalid");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("legacy version 1 file stays readable and normalized", async () => {
    const dir = await temp();
    try {
      await Bun.write(
        join(dir, "project-aliases.json"),
        '{"version":1,"aliases":{"/a/b/":"Legacy"}}',
      );
      expect([...(await readProjectAliases(dir)).byPath]).toEqual([["/a/b", "Legacy"]]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const src = (
  machineId: string | undefined,
  entries: Record<string, { label?: string; updatedAt: number }>,
): AliasSource => ({ machineId, entries: new Map(Object.entries(entries)) });

describe("alias merge (last writer wins per path)", () => {
  test("latest updatedAt wins; tombstones obey the same rule", () => {
    const sources = [
      src(A, {
        "/p/one": { label: "Old", updatedAt: 10 },
        "/p/two": { label: "Was", updatedAt: 10 },
        "/p/three": { updatedAt: 10 },
      }),
      src(B, {
        "/p/one": { label: "New", updatedAt: 20 },
        "/p/two": { updatedAt: 20 },
        "/p/three": { label: "Back", updatedAt: 20 },
      }),
    ];
    expect([...effectiveAliasMap(sources)].sort()).toEqual([
      ["/p/one", "New"],
      ["/p/three", "Back"],
    ]);
  });

  test("a newer entry from the LOWER machine id beats an older one from the greater id", () => {
    const map = effectiveAliasMap([
      src(A, { "/p": { label: "Newer from A", updatedAt: 9 } }),
      src(B, { "/p": { label: "Older from B", updatedAt: 8 } }),
    ]);
    expect(map.get("/p")).toBe("Newer from A");
  });

  test("a tombstone newer than the label removes it", () => {
    const map = effectiveAliasMap([
      src(A, { "/p": { label: "X", updatedAt: 5 } }),
      src(B, { "/p": { updatedAt: 6 } }),
    ]);
    expect(map.size).toBe(0);
  });

  test("legacy (updatedAt 0) loses to any per-machine entry, even a tie at 0", () => {
    const legacy = src(undefined, { "/p": { label: "Legacy", updatedAt: 0 } });
    expect(
      effectiveAliasMap([legacy, src(A, { "/p": { label: "Mine", updatedAt: 1 } })]).get("/p"),
    ).toBe("Mine");
    expect(
      effectiveAliasMap([legacy, src(A, { "/p": { label: "Tie", updatedAt: 0 } })]).get("/p"),
    ).toBe("Tie");
    expect(effectiveAliasMap([legacy]).get("/p")).toBe("Legacy");
    expect(effectiveAliasMap([legacy, src(A, { "/p": { updatedAt: 1 } })]).has("/p")).toBe(false);
  });

  test("ties break toward the greater machine id", () => {
    const a = src(A, { "/p": { label: "From A", updatedAt: 7 } });
    const b = src(B, { "/p": { label: "From B", updatedAt: 7 } });
    expect(effectiveAliasMap([a, b]).get("/p")).toBe("From B");
    expect(effectiveAliasMap([b, a]).get("/p")).toBe("From B");
    expect(mergeAliasSources([a, b]).get("/p")?.machineId).toBe(B);
  });

  test("paths are normalized across files before comparing", () => {
    const map = effectiveAliasMap([
      src(A, { "/p/x/": { label: "A", updatedAt: 1 } }),
      src(B, { "/p/y/../x": { label: "B", updatedAt: 2 } }),
    ]);
    expect([...map]).toEqual([["/p/x", "B"]]);
  });

  test("is independent of input order", () => {
    const sources = [
      src(undefined, { "/p": { label: "L", updatedAt: 0 }, "/q": { label: "Q", updatedAt: 0 } }),
      src(A, { "/p": { label: "A", updatedAt: 3 }, "/q": { updatedAt: 3 } }),
      src(B, { "/p": { label: "B", updatedAt: 3 }, "/r": { label: "R", updatedAt: 1 } }),
    ];
    const expected = [...effectiveAliasMap(sources)];
    for (let i = 0; i < 20; i++) {
      const shuffled = [...sources].sort(() => Math.random() - 0.5);
      expect([...effectiveAliasMap(shuffled)]).toEqual(expected);
    }
    expect(expected.sort()).toEqual([
      ["/p", "B"],
      ["/r", "R"],
    ]);
  });
});

describe("alias files are read strictly", () => {
  const legacyBad: [string, string][] = [
    ["invalid JSON", "{nope"],
    ["wrong version", '{"version":2,"aliases":{}}'],
    ["bad key", '{"version":1,"aliases":{"relative/path":"X"}}'],
    ["bad entry", '{"version":1,"aliases":{"/a":42}}'],
  ];
  const machineBad: [string, string][] = [
    ["invalid JSON", "{nope"],
    ["wrong version", '{"version":1,"aliases":{}}'],
    ["bad key", '{"version":2,"aliases":{"relative":{"label":"X","updatedAt":1}}}'],
    ["entry not an object", '{"version":2,"aliases":{"/a":"X"}}'],
    ["entry without label or tombstone", '{"version":2,"aliases":{"/a":{"updatedAt":1}}}'],
    ["entry without updatedAt", '{"version":2,"aliases":{"/a":{"label":"X"}}}'],
    ["negative updatedAt", '{"version":2,"aliases":{"/a":{"label":"X","updatedAt":-1}}}'],
    ["fractional updatedAt", '{"version":2,"aliases":{"/a":{"label":"X","updatedAt":1.5}}}'],
    ["string updatedAt", '{"version":2,"aliases":{"/a":{"label":"X","updatedAt":"1"}}}'],
    [
      "updatedAt above the ceiling",
      `{"version":2,"aliases":{"/a":{"label":"X","updatedAt":${MAX_ALIAS_UPDATED_AT + 1}}}}`,
    ],
    [
      "both label and removed",
      '{"version":2,"aliases":{"/a":{"label":"X","removed":true,"updatedAt":1}}}',
    ],
  ];

  for (const [name, body] of legacyBad) {
    test(`legacy file: ${name} throws naming the file`, async () => {
      const dir = await temp();
      try {
        await Bun.write(join(dir, "project-aliases.json"), body);
        await expect(readProjectAliases(dir)).rejects.toThrow(join(dir, "project-aliases.json"));
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  }

  for (const [name, body] of machineBad) {
    test(`per-machine file: ${name} throws naming the file`, async () => {
      const dir = await temp();
      try {
        const file = join(dir, "machines", A, "project-aliases.json");
        await Bun.write(file, body);
        await expect(readProjectAliases(dir)).rejects.toThrow(file);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  }

  test("an updatedAt of exactly the ceiling is accepted", async () => {
    const dir = await temp();
    try {
      await Bun.write(
        join(dir, "machines", A, "project-aliases.json"),
        `{"version":2,"aliases":{"/a":{"label":"Top","updatedAt":${MAX_ALIAS_UPDATED_AT}}}}`,
      );
      expect([...(await readProjectAliases(dir)).byPath]).toEqual([["/a", "Top"]]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("errors name the owning machine and how to recover", async () => {
    const dir = await temp();
    try {
      await Bun.write(join(dir, "machines", B, "project-aliases.json"), "{nope");
      const err = await readProjectAliases(dir).catch((e) => e as Error);
      expect((err as Error).message).toContain(`machine ${B}`);
      expect((err as Error).message).toContain("checkout --");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("in-file duplicates of one normalized path with equal updatedAt: the later entry wins", async () => {
    const dir = await temp();
    try {
      await Bun.write(
        join(dir, "machines", A, "project-aliases.json"),
        '{"version":2,"aliases":{"/a/b":{"label":"First","updatedAt":5},"/a/./b/":{"label":"Second","updatedAt":5}}}',
      );
      expect([...(await readProjectAliases(dir)).byPath]).toEqual([["/a/b", "Second"]]);
      // A strictly greater updatedAt still wins regardless of position.
      await Bun.write(
        join(dir, "machines", A, "project-aliases.json"),
        '{"version":2,"aliases":{"/a/b":{"label":"First","updatedAt":6},"/a/./b/":{"label":"Second","updatedAt":5}}}',
      );
      expect([...(await readProjectAliases(dir)).byPath]).toEqual([["/a/b", "First"]]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a failed write leaves no temp file behind", async () => {
    const dir = await temp();
    try {
      // A non-empty directory at the target path makes the rename throw.
      const target = join(dir, "machines", A, "project-aliases.json");
      await mkdir(join(target, "blocker"), { recursive: true });
      await expect(
        writeMachineAliases(new Map([["/a", { label: "X", updatedAt: 1 }]]), A, dir),
      ).rejects.toThrow();
      expect((await readdir(join(dir, "machines", A))).filter((f) => f.endsWith(".tmp"))).toEqual(
        [],
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("missing files are fine; non-machine directories are ignored", async () => {
    const dir = await temp();
    try {
      await mkdir(join(dir, "machines", A), { recursive: true });
      await Bun.write(join(dir, "machines", "not-a-machine", "project-aliases.json"), "{nope");
      await Bun.write(
        join(dir, "machines", B, "project-aliases.json"),
        '{"version":2,"aliases":{"/a":{"label":"Ok","updatedAt":1},"/b":{"removed":true,"updatedAt":2}}}',
      );
      expect([...(await readProjectAliases(dir)).byPath]).toEqual([["/a", "Ok"]]);
      expect((await readAliasSources(dir)).map((s) => s.machineId)).toEqual([B]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
