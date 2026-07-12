import { describe, expect, test } from "bun:test";
import {
  assetDownloadUrl,
  assetName,
  compareVersions,
  normalizeVersion,
} from "../../src/core/release.ts";

describe("normalizeVersion", () => {
  test("strips leading v and whitespace", () => {
    expect(normalizeVersion("v1.2.3")).toBe("1.2.3");
    expect(normalizeVersion("  v0.2.0\n")).toBe("0.2.0");
    expect(normalizeVersion("0.2.0")).toBe("0.2.0");
  });
});

describe("compareVersions", () => {
  test("orders by numeric segments", () => {
    expect(compareVersions("0.2.0", "0.1.9")).toBe(1);
    expect(compareVersions("0.1.0", "0.2.0")).toBe(-1);
    expect(compareVersions("1.0.0", "0.9.9")).toBe(1);
  });
  test("treats equal versions as 0, ignoring a v prefix", () => {
    expect(compareVersions("v0.2.0", "0.2.0")).toBe(0);
  });
  test("handles differing segment counts", () => {
    expect(compareVersions("1.2", "1.2.0")).toBe(0);
    expect(compareVersions("1.2.1", "1.2")).toBe(1);
  });
});

describe("assetName", () => {
  test("maps macOS and Linux arch names to release assets", () => {
    expect(assetName("darwin", "arm64")).toBe("cc-analyzer-darwin-arm64");
    expect(assetName("darwin", "x64")).toBe("cc-analyzer-darwin-x64");
    expect(assetName("linux", "x64")).toBe("cc-analyzer-linux-x64");
    expect(assetName("linux", "arm64")).toBe("cc-analyzer-linux-arm64");
  });
  test("always uses the x64 exe on Windows", () => {
    expect(assetName("win32", "x64")).toBe("cc-analyzer-windows-x64.exe");
    expect(assetName("win32", "arm64")).toBe("cc-analyzer-windows-x64.exe");
  });
  test("returns undefined for unsupported platform/arch", () => {
    expect(assetName("freebsd", "x64")).toBeUndefined();
    expect(assetName("linux", "ia32")).toBeUndefined();
  });
});

describe("assetDownloadUrl", () => {
  test("builds a versioned release download URL", () => {
    expect(assetDownloadUrl("0.3.0", "cc-analyzer-linux-x64")).toBe(
      "https://github.com/yorch/cc-analyzer/releases/download/v0.3.0/cc-analyzer-linux-x64",
    );
    // accepts a v-prefixed version without doubling the v
    expect(assetDownloadUrl("v0.3.0", "a")).toBe(
      "https://github.com/yorch/cc-analyzer/releases/download/v0.3.0/a",
    );
  });
});
