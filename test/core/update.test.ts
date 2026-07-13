import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type DownloadProgress,
  isCompiledBinary,
  pumpStream,
  swapBinary,
} from "../../src/core/update.ts";

/** A stream that emits `chunks` in order and closes. */
function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(c) {
      for (const ch of chunks) c.enqueue(ch);
      c.close();
    },
  });
}

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

describe("pumpStream", () => {
  test("writes every chunk in order and returns the total bytes", async () => {
    const written: number[] = [];
    const total = await pumpStream(
      streamOf([new Uint8Array([1, 2, 3]), new Uint8Array([4, 5])]),
      (chunk) => {
        written.push(...chunk);
      },
      { stallMs: 1000 },
    );
    expect(written).toEqual([1, 2, 3, 4, 5]);
    expect(total).toBe(5);
  });

  test("reports cumulative progress with the supplied total", async () => {
    const seen: DownloadProgress[] = [];
    await pumpStream(streamOf([new Uint8Array(2), new Uint8Array(3)]), () => {}, {
      stallMs: 1000,
      total: 5,
      onProgress: (p) => seen.push(p),
    });
    expect(seen).toEqual([
      { received: 2, total: 5 },
      { received: 5, total: 5 },
    ]);
  });

  test("aborts with a stall error when no chunk arrives within stallMs", async () => {
    // Emits one chunk, then never enqueues or closes → the next read hangs.
    const stalling = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array([1]));
      },
    });
    await expect(pumpStream(stalling, () => {}, { stallMs: 40 })).rejects.toThrow(/stalled/);
  });
});

describe("isCompiledBinary", () => {
  test("is false when running under the bun test runner (from source)", () => {
    // The suite runs via `bun test`, i.e. from source — not a compiled binary.
    expect(isCompiledBinary()).toBe(false);
  });
});
