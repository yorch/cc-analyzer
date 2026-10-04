import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeSession } from "../../src/core/analyze.ts";
import type { SessionInfo } from "../../src/core/discover.ts";
import { toSessionRow } from "../../src/core/indexer.ts";
import { parseSessionFile } from "../../src/core/parser.ts";
import {
  normalizeAliasPath,
  projectAliasId,
  readProjectAliases,
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
});
