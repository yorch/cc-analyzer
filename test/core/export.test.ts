import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "../../src/core/db.ts";
import {
  csvEscape,
  exportBundle,
  parseFormats,
  parseScope,
  writeCsv,
} from "../../src/core/export.ts";
import { reindex } from "../../src/core/indexer.ts";
import { tempClaudeDir, tempStateDir } from "../helpers/claude-dir.ts";
import { samplePricing as pricing } from "../helpers/pricing.ts";

const fixture = fileURLToPath(new URL("../fixtures/sample-session.jsonl", import.meta.url));
const CANARY = "CANARYPROMPT";

let claude: ReturnType<typeof tempClaudeDir>;
let state: ReturnType<typeof tempStateDir>;
let out: string;
let db: Database;
let projectId = "";

function walk(dir: string): string[] {
  const files: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) files.push(...walk(p));
    else files.push(p);
  }
  return files;
}

beforeAll(async () => {
  claude = tempClaudeDir("cc-analyzer-export");
  state = tempStateDir("cc-analyzer-export-state");
  out = mkdtempSync(join(tmpdir(), "cc-analyzer-export-out-"));
  const base = (await Bun.file(fixture).text())
    .replace("Add a hello function", `${CANARY} add a hello function`)
    .replaceAll("main", "CANARYBRANCH");
  const distinct = (n: number) =>
    base
      .replaceAll('"msg_', `"s${n}-msg_`)
      .replaceAll('"req-', `"s${n}-req-`)
      .replaceAll("sess-1", `sess-${n}`);
  mkdirSync(join(claude.dir, "projects", "proj-a"), { recursive: true });
  mkdirSync(join(claude.dir, "projects", "proj-b"), { recursive: true });
  writeFileSync(join(claude.dir, "projects", "proj-a", "sess-1.jsonl"), distinct(1));
  writeFileSync(join(claude.dir, "projects", "proj-a", "sess-2.jsonl"), distinct(2));
  writeFileSync(join(claude.dir, "projects", "proj-b", "sess-3.jsonl"), distinct(3));
  db = openDb(":memory:");
  await reindex(db, { pricing });
  projectId = (
    db.query("SELECT project_id FROM sessions WHERE path LIKE '%proj-a%' LIMIT 1").get() as {
      project_id: string;
    }
  ).project_id;
});

afterAll(() => {
  db.close();
  rmSync(out, { recursive: true, force: true });
  claude.cleanup();
  state.cleanup();
});

describe("parseScope", () => {
  test("defaults to portfolio", () => {
    expect(parseScope([])).toEqual({ kind: "portfolio" });
    expect(parseScope(["--format", "json"])).toEqual({ kind: "portfolio" });
  });
  test("project / session, spaced and = forms", () => {
    expect(parseScope(["--project", "p"])).toEqual({ kind: "project", projectId: "p" });
    expect(parseScope(["--project=p"])).toEqual({ kind: "project", projectId: "p" });
    expect(parseScope(["--session", "abc"])).toEqual({ kind: "session", idOrPath: "abc" });
    expect(parseScope(["--session=abc"])).toEqual({ kind: "session", idOrPath: "abc" });
  });
  test("mutually exclusive", () => {
    expect(() => parseScope(["--project", "p", "--session", "s"])).toThrow(/mutually exclusive/);
  });
  test("valueless or flag-shaped values are errors, never the whole portfolio", () => {
    for (const args of [
      ["--project"],
      ["--session"],
      ["--project="],
      ["--session="],
      ["--project", "--format", "json"],
      ["--session", "--redact"],
      ["--project=--redact"],
    ]) {
      expect(() => parseScope(args)).toThrow(/needs a value/);
    }
  });
  test("positional path becomes a session", () => {
    expect(parseScope(["export", "/a/b.jsonl"])).toEqual({
      kind: "session",
      idOrPath: "/a/b.jsonl",
    });
    expect(parseScope(["--format", "json,csv"])).toEqual({ kind: "portfolio" });
  });
});

describe("parseFormats", () => {
  test("default json, aliases, all", () => {
    expect([...parseFormats()]).toEqual(["json"]);
    expect([...parseFormats("json, CSV,markdown")].sort()).toEqual(["csv", "json", "md"]);
    expect(parseFormats("all").size).toBe(4);
  });
  test("rejects unknown and empty", () => {
    expect(() => parseFormats("pdf")).toThrow(/unknown format/);
    expect(() => parseFormats(",")).toThrow(/needs a value/);
  });
});

describe("csv", () => {
  test("csvEscape quotes commas, quotes, newlines", () => {
    expect(csvEscape("plain")).toBe("plain");
    expect(csvEscape("a,b")).toBe('"a,b"');
    expect(csvEscape('say "hi"')).toBe('"say ""hi"""');
    expect(csvEscape("l1\nl2")).toBe('"l1\nl2"');
    expect(csvEscape("l1\r\nl2")).toBe('"l1\r\nl2"');
    expect(csvEscape(undefined)).toBe("");
  });
  test("csvEscape neutralizes formula injection but leaves plain numbers", () => {
    expect(csvEscape("=SUM(A1)")).toBe(`"'=SUM(A1)"`);
    expect(csvEscape("@cmd")).toBe(`"'@cmd"`);
    expect(csvEscape("-1.5")).toBe("-1.5");
    expect(csvEscape("-cmd")).toBe(`"'-cmd"`);
  });
  test("writeCsv writes header + rows with trailing newline", () => {
    const p = join(out, "t.csv");
    writeCsv(p, ["a", "b"], [["1", "x,y"]]);
    expect(readFileSync(p, "utf-8")).toBe('a,b\n1,"x,y"\n');
  });
});

describe("exportBundle", () => {
  const base = {
    formats: new Set(["json", "csv", "md", "html"] as const),
    redact: false,
    split: false,
    includeTranscript: true,
  };

  test("portfolio scope writes portfolio.json, sessions.json and per-session files", async () => {
    const dir = join(out, "portfolio");
    const res = await exportBundle(db, pricing, {
      ...base,
      formats: new Set(base.formats),
      scope: { kind: "portfolio" },
      outDir: dir,
    });
    expect(res.sessions).toBe(3);
    expect(res.skipped).toBe(0);
    for (const f of [
      "manifest.json",
      "portfolio.json",
      "sessions.json",
      "csv/sessions.csv",
      "csv/turns.csv",
      "csv/models.csv",
    ]) {
      expect(existsSync(join(dir, f))).toBe(true);
    }
    expect(readdirSync(join(dir, "sessions"))).toHaveLength(3);
    expect(readdirSync(join(dir, "markdown"))).toHaveLength(3);
    expect(readdirSync(join(dir, "html"))).toHaveLength(3);
    const sessionJson = JSON.parse(readFileSync(join(dir, "sessions", "sess-1.json"), "utf-8"));
    expect(sessionJson.parseErrors).toBe(0);
    expect(JSON.stringify(sessionJson)).toContain(CANARY);
  });

  test("project scope covers only that project", async () => {
    const dir = join(out, "project");
    const res = await exportBundle(db, pricing, {
      ...base,
      formats: new Set(["json", "csv"]),
      scope: { kind: "project", projectId },
      outDir: dir,
    });
    expect(res.sessions).toBe(2);
    expect(existsSync(join(dir, "project.json"))).toBe(true);
    expect(readdirSync(join(dir, "sessions"))).toHaveLength(2);
  });

  test("session scope exports only that session, not portfolio stats", async () => {
    const dir = join(out, "session");
    const res = await exportBundle(db, pricing, {
      ...base,
      formats: new Set(["json"]),
      scope: { kind: "session", idOrPath: "sess-1" },
      outDir: dir,
    });
    expect(res.sessions).toBe(1);
    expect(existsSync(join(dir, "portfolio.json"))).toBe(false);
    expect(existsSync(join(dir, "sessions", "sess-1.json"))).toBe(true);
  });

  test("unknown session errors; path outside Claude roots is refused", async () => {
    await expect(
      exportBundle(db, pricing, {
        ...base,
        scope: { kind: "session", idOrPath: "nope" },
        outDir: join(out, "x1"),
      }),
    ).rejects.toThrow(/not found/);
    await expect(
      exportBundle(db, pricing, {
        ...base,
        scope: { kind: "session", idOrPath: "/etc/passwd" },
        outDir: join(out, "x2"),
      }),
    ).rejects.toThrow(/not under a configured Claude root/);
  });

  test("--out with traversal is refused", async () => {
    await expect(
      exportBundle(db, pricing, { ...base, scope: { kind: "portfolio" }, outDir: "a/../b" }),
    ).rejects.toThrow(/traversal/);
  });

  test("--split: private/ keeps text, shareable/ contains no prompt, branch or path text", async () => {
    const dir = join(out, "split");
    await exportBundle(db, pricing, {
      ...base,
      formats: new Set(base.formats),
      split: true,
      scope: { kind: "portfolio" },
      outDir: dir,
    });
    const priv = walk(join(dir, "private"))
      .map((f) => readFileSync(f, "utf-8"))
      .join("\n");
    expect(priv).toContain(CANARY);
    const shareableFiles = walk(join(dir, "shareable"));
    expect(shareableFiles.length).toBeGreaterThan(5);
    for (const f of shareableFiles) {
      const text = readFileSync(f, "utf-8");
      for (const leak of [CANARY, "CANARYBRANCH", "hello.ts", "hello function", claude.dir]) {
        expect({ f, leak, found: text.includes(leak) }).toEqual({ f, leak, found: false });
      }
    }
    const sharedSession = JSON.parse(
      readFileSync(join(dir, "shareable", "sessions", "sess-1.json"), "utf-8"),
    );
    expect(sharedSession.title).toBe("[redacted]");
    expect(sharedSession.transcript.every((t: { body: string }) => t.body === "[redacted]")).toBe(
      true,
    );
    expect(sharedSession.totals.cost.total).toBeGreaterThan(0);
  });
});
