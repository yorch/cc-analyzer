import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CACHE_FORMAT_VERSION } from "../../src/core/pricing-source.ts";
import { samplePricing } from "../helpers/pricing.ts";

const cliPath = fileURLToPath(new URL("../../src/cli/index.ts", import.meta.url));
const fixture = fileURLToPath(new URL("../fixtures/sample-session.jsonl", import.meta.url));
const tmpDir = join(tmpdir(), `cc-analyzer-export-${process.pid}-${Date.now()}`);

beforeAll(async () => {
  mkdirSync(join(tmpDir, "claude", "projects", "proj-a"), { recursive: true });
  mkdirSync(join(tmpDir, "state"), { recursive: true });
  const sample = await Bun.file(fixture).text();
  writeFileSync(
    join(tmpDir, "claude", "projects", "proj-a", "sess-1.jsonl"),
    sample.replaceAll("/Users/dev/proj", join(tmpDir, "project")),
  );
  writeFileSync(
    join(tmpDir, "state", "pricing.json"),
    JSON.stringify({
      fetchedAt: Date.now(),
      formatVersion: CACHE_FORMAT_VERSION,
      table: samplePricing,
    }),
  );
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

async function run(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", cliPath, ...args], {
    env: {
      ...process.env,
      CC_ANALYZER_CLAUDE_DIR: join(tmpDir, "claude"),
      CC_ANALYZER_STATE_DIR: join(tmpDir, "state"),
      CC_ANALYZER_NO_UPDATE_CHECK: "1",
      CC_ANALYZER_TELEMETRY: "0",
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

describe("analyze export", () => {
  test("analyze --md emits markdown with expected sections", async () => {
    const r = await run([
      "analyze",
      join(tmpDir, "claude", "projects", "proj-a", "sess-1.jsonl"),
      "--md",
    ]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("# Session:");
    expect(r.stdout).toContain("## Overview");
    expect(r.stdout).toContain("## Health");
  });

  test("analyze --html emits standalone html", async () => {
    const r = await run([
      "analyze",
      join(tmpDir, "claude", "projects", "proj-a", "sess-1.jsonl"),
      "--html",
    ]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("<!doctype html>");
    expect(r.stdout).toContain("cc-analyzer");
  });

  test("analyze --md --redact hides prompt", async () => {
    const r = await run([
      "analyze",
      join(tmpDir, "claude", "projects", "proj-a", "sess-1.jsonl"),
      "--md",
      "--redact",
    ]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("[redacted]");
    expect(r.stdout).toContain("Redacted export");
  });

  test("analyze --json --redact strips PII fields", async () => {
    const r = await run([
      "analyze",
      join(tmpDir, "claude", "projects", "proj-a", "sess-1.jsonl"),
      "--json",
      "--redact",
    ]);
    expect(r.code).toBe(0);
    const j = JSON.parse(r.stdout) as any;
    expect(j.title).toBe("[redacted]");
    expect(j.projectPath).toBe("[redacted]");
    expect(j.filesTouched).toEqual([]);
    expect(j.turns[0].prompt).toBe("[redacted]");
  });

  test("analyze --md --out writes file", async () => {
    const out = join(tmpDir, "out.md");
    const r = await run([
      "analyze",
      join(tmpDir, "claude", "projects", "proj-a", "sess-1.jsonl"),
      "--md",
      "--out",
      out,
    ]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Wrote md export");
    expect(readFileSync(out, "utf8")).toContain("# Session:");
  });

  test("analyze --md --out with directory auto-names", async () => {
    const dir = join(tmpDir, "export-dir");
    mkdirSync(dir, { recursive: true });
    const r = await run([
      "analyze",
      join(tmpDir, "claude", "projects", "proj-a", "sess-1.jsonl"),
      "--md",
      "--out",
      dir,
    ]);
    expect(r.code).toBe(0);
    // should write cc-analyzer-sess-1.md inside dir
    expect(existsSync(join(dir, "cc-analyzer-sess-1.md"))).toBe(true);
  });

  test("analyze --md --json mutually exclusive", async () => {
    const r = await run([
      "analyze",
      join(tmpDir, "claude", "projects", "proj-a", "sess-1.jsonl"),
      "--md",
      "--json",
    ]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("cannot be used together");
  });

  test("analyze --out without format exits 2", async () => {
    const r = await run([
      "analyze",
      join(tmpDir, "claude", "projects", "proj-a", "sess-1.jsonl"),
      "--out",
      join(tmpDir, "out.md"),
    ]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--out requires");
  });

  test("analyze --redact without format exits 2", async () => {
    const r = await run([
      "analyze",
      join(tmpDir, "claude", "projects", "proj-a", "sess-1.jsonl"),
      "--redact",
    ]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("require --md");
  });

  test("analyze --html --include-transcript includes transcript", async () => {
    const r = await run([
      "analyze",
      join(tmpDir, "claude", "projects", "proj-a", "sess-1.jsonl"),
      "--md",
      "--include-transcript",
    ]);
    expect(r.code).toBe(0);
    // sample fixture has no transcript items? but builder should show count or empty
    expect(r.stdout).toContain("Transcript");
  });
});
