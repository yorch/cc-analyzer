import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { claudeRoots } from "../../src/core/claude-roots.ts";
import { openDb } from "../../src/core/db.ts";
import {
  expandHome,
  lookupSession,
  sessionIdFromPath,
  stripQuotes,
} from "../../src/tui/sessionLookup.ts";
import { tempClaudeDir } from "../helpers/claude-dir.ts";

const fixture = fileURLToPath(new URL("../fixtures/sample-session.jsonl", import.meta.url));
let claude: ReturnType<typeof tempClaudeDir>;
let file: string;
const db = openDb(":memory:");

beforeAll(async () => {
  claude = tempClaudeDir("cc-analyzer-lookup");
  mkdirSync(join(claude.dir, "projects", "proj-a"), { recursive: true });
  file = join(claude.dir, "projects", "proj-a", "disk-only.jsonl");
  writeFileSync(file, await Bun.file(fixture).text());
});
afterAll(() => claude.cleanup());

describe("session lookup helpers", () => {
  test("stripQuotes removes one matching pair", () => {
    expect(stripQuotes(' "C:\\a b\\x.jsonl" ')).toBe("C:\\a b\\x.jsonl");
    expect(stripQuotes("'/a/x.jsonl'")).toBe("/a/x.jsonl");
    expect(stripQuotes("'mismatch\"")).toBe("'mismatch\"");
  });
  test("expandHome handles ~, ~/ and ~\\", () => {
    expect(expandHome("~", "/h")).toBe("/h");
    expect(expandHome("~/x.jsonl", "/h")).toBe("/h/x.jsonl");
    expect(expandHome("~\\x.jsonl", "C:\\h")).toBe("C:\\h\\x.jsonl");
    expect(expandHome("a~b", "/h")).toBe("a~b");
  });
  test("sessionIdFromPath splits on both separators", () => {
    expect(sessionIdFromPath("C:\\u\\p\\abc.jsonl")).toBe("abc");
    expect(sessionIdFromPath("/u/p/abc.jsonl")).toBe("abc");
  });
});

describe("lookupSession", () => {
  test("bare id resolves from disk across roots (not indexed)", async () => {
    const r = await lookupSession(db, "disk-only", { roots: async () => claudeRoots() });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.session.path).toBe(file);
  });
  test("quoted path resolves; ~ is expanded before the probe", async () => {
    const ok = await lookupSession(db, `'${file}'`);
    expect(ok.ok).toBe(true);
    const home = join(claude.dir, "projects");
    const tilde = await lookupSession(db, `"~/proj-a/disk-only.jsonl"`, { home });
    expect(tilde.ok).toBe(true);
  });
  test("distinguishes failure reasons", async () => {
    const roots = async () => claudeRoots();
    const nope = await lookupSession(db, "nope", { roots });
    expect(!nope.ok && nope.reason).toBe("not-found");
    const notJsonl = await lookupSession(db, "/etc/passwd");
    expect(!notJsonl.ok && notJsonl.reason).toBe("not-jsonl");
    const missing = await lookupSession(db, join(claude.dir, "gone.jsonl"));
    expect(!missing.ok && missing.reason).toBe("not-found");
    const empty = await lookupSession(db, '""');
    expect(!empty.ok && empty.reason).toBe("empty");
  });
});
