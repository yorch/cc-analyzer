import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isCompiledBinary, swapBinary } from "../../src/core/update.ts";

describe("swapBinary", () => {
  test("replaces the target file atomically and marks it executable", () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-swap-"));
    try {
      const target = join(dir, "cc-analyzer");
      const tmp = join(dir, ".cc-analyzer.update.tmp");
      writeFileSync(target, "OLD");
      writeFileSync(tmp, "NEW");

      swapBinary(target, tmp);

      expect(readFileSync(target, "utf8")).toBe("NEW");
      // the temp file was consumed by the rename
      expect(() => statSync(tmp)).toThrow();
      // owner-executable bit is set
      expect(statSync(target).mode & 0o100).toBe(0o100);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("isCompiledBinary", () => {
  test("is false when running under the bun test runner (from source)", () => {
    // The suite runs via `bun test`, i.e. from source — not a compiled binary.
    expect(isCompiledBinary()).toBe(false);
  });
});
