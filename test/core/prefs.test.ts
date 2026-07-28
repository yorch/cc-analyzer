import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { prefsConfigPath } from "../../src/core/paths.ts";
import { getCostBasis, setCostBasis } from "../../src/core/prefs.ts";

let tmpDir: string;
let prevStateDir: string | undefined;

beforeEach(() => {
  prevStateDir = process.env.CC_ANALYZER_STATE_DIR;
  tmpDir = join("/tmp", `cc-analyzer-prefs-${process.pid}-${Date.now()}-${Math.random()}`);
  mkdirSync(tmpDir, { recursive: true });
  process.env.CC_ANALYZER_STATE_DIR = tmpDir;
});

afterEach(() => {
  if (prevStateDir === undefined) delete process.env.CC_ANALYZER_STATE_DIR;
  else process.env.CC_ANALYZER_STATE_DIR = prevStateDir;
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("getCostBasis", () => {
  test('defaults to "api" when prefs.json is missing', () => {
    expect(getCostBasis()).toBe("api");
  });

  test('defaults to "api" when prefs.json is corrupt', () => {
    writeFileSync(prefsConfigPath(), "{ not json");
    expect(getCostBasis()).toBe("api");
  });

  test('defaults to "api" for an unrecognized value', () => {
    writeFileSync(prefsConfigPath(), JSON.stringify({ costBasis: "yolo" }));
    expect(getCostBasis()).toBe("api");
  });
});

describe("setCostBasis / getCostBasis round-trip", () => {
  test("subscription persists and reads back", () => {
    setCostBasis("subscription");
    expect(getCostBasis()).toBe("subscription");
    const onDisk = JSON.parse(readFileSync(prefsConfigPath(), "utf8"));
    expect(onDisk.costBasis).toBe("subscription");
  });

  test("api persists and reads back", () => {
    setCostBasis("subscription");
    setCostBasis("api");
    expect(getCostBasis()).toBe("api");
  });
});

describe("prefs.json merge-tolerance", () => {
  test("setCostBasis preserves unknown existing keys", () => {
    writeFileSync(prefsConfigPath(), JSON.stringify({ someFuturePref: 42 }));
    setCostBasis("subscription");
    const onDisk = JSON.parse(readFileSync(prefsConfigPath(), "utf8"));
    expect(onDisk).toEqual({ someFuturePref: 42, costBasis: "subscription" });
  });
});
