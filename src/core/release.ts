/**
 * Talking to the GitHub Releases for cc-analyzer.
 *
 * The latest version is discovered by following the `/releases/latest` redirect
 * and reading the tag from the final URL — no API token and no rate limit, the
 * same trick the install scripts use.
 */

const REPO = "yorch/cc-analyzer";
export const LATEST_RELEASE_URL = `https://github.com/${REPO}/releases/latest`;

/** Strip a leading `v` and surrounding whitespace from a version/tag string. */
export function normalizeVersion(v: string): string {
  return v.trim().replace(/^v/, "");
}

/** Compare two dotted versions numerically. Returns -1, 0, or 1 (a vs b). */
export function compareVersions(a: string, b: string): number {
  const pa = normalizeVersion(a).split(".").map(Number);
  const pb = normalizeVersion(b).split(".").map(Number);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** Release asset name for a platform/arch, or undefined if unsupported. */
export function assetName(platform: NodeJS.Platform, arch: string): string | undefined {
  // Only an x64 Windows binary is published (it runs on ARM64 via emulation).
  if (platform === "win32") return "cc-analyzer-windows-x64.exe";
  const os = platform === "darwin" ? "darwin" : platform === "linux" ? "linux" : undefined;
  const a = arch === "arm64" ? "arm64" : arch === "x64" ? "x64" : undefined;
  if (!os || !a) return undefined;
  return `cc-analyzer-${os}-${a}`;
}

/** Direct download URL for a release asset at a specific version. */
export function assetDownloadUrl(version: string, asset: string): string {
  return `https://github.com/${REPO}/releases/download/v${normalizeVersion(version)}/${asset}`;
}

/**
 * Resolve the latest published version (e.g. "0.3.0") by following the
 * releases/latest redirect. Throws on network error, timeout, or an
 * unparseable tag. The default timeout is generous for user-invoked `update`;
 * the passive background check passes a short timeout of its own.
 */
export async function fetchLatestVersion(timeoutMs = 10000): Promise<string> {
  const res = await fetch(LATEST_RELEASE_URL, {
    method: "HEAD",
    redirect: "follow",
    signal: AbortSignal.timeout(timeoutMs),
  });
  const tag = res.url.split("/").pop() ?? "";
  const version = normalizeVersion(tag);
  if (!/^\d+\.\d+\.\d+/.test(version)) {
    throw new Error(`could not parse a version from ${res.url}`);
  }
  return version;
}
