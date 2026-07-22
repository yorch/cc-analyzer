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
  // A non-numeric segment ("3-rc") parses to NaN; treat it as 0 so comparison
  // stays symmetric instead of NaN making a prerelease sort as newest.
  const num = (s: string): number => {
    const n = Number.parseInt(s, 10);
    return Number.isNaN(n) ? 0 : n;
  };
  const pa = normalizeVersion(a).split(".").map(num);
  const pb = normalizeVersion(b).split(".").map(num);
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

/** URL of the SHA256SUMS manifest for a release. */
export function checksumsUrl(version: string): string {
  return assetDownloadUrl(version, "SHA256SUMS");
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
  // Take the leading X.Y.Z core so a suffixed tag GitHub marked "latest"
  // (e.g. v0.5.1-1, a re-cut build) still resolves instead of hard-failing.
  const match = normalizeVersion(tag).match(/^\d+\.\d+\.\d+/);
  if (!match) {
    throw new Error(`could not parse a version from ${res.url}`);
  }
  return match[0];
}
