import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectedHash, fileSha256, parseChecksums } from "../../src/core/checksum.ts";

const H1 = "a".repeat(64);
const H2 = "b".repeat(64);

describe("parseChecksums", () => {
  test("parses standard two-space and binary-mode (*) entries", () => {
    const sums = parseChecksums(`${H1}  cc-analyzer-linux-x64\n${H2} *cc-analyzer-darwin-arm64\n`);
    expect(sums.get("cc-analyzer-linux-x64")).toBe(H1);
    expect(sums.get("cc-analyzer-darwin-arm64")).toBe(H2);
    expect(sums.size).toBe(2);
  });
  test("lowercases the hash and ignores blank or malformed lines", () => {
    const sums = parseChecksums(`${"A".repeat(64)}  file\n\nnot a checksum line\n`);
    expect(sums.get("file")).toBe("a".repeat(64));
    expect(sums.size).toBe(1);
  });
});

describe("expectedHash", () => {
  test("returns the hash for a listed asset, undefined otherwise", () => {
    const sums = parseChecksums(`${H1}  cc-analyzer-linux-x64\n`);
    expect(expectedHash(sums, "cc-analyzer-linux-x64")).toBe(H1);
    expect(expectedHash(sums, "cc-analyzer-windows-x64.exe")).toBeUndefined();
  });
});

describe("fileSha256", () => {
  test("computes the SHA-256 of file contents", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-sum-"));
    try {
      const file = join(dir, "data");
      writeFileSync(file, "abc");
      // Well-known SHA-256 of "abc".
      expect(await fileSha256(file)).toBe(
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
