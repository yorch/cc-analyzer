/**
 * SHA-256 checksum handling for release binaries.
 *
 * Releases publish a `SHA256SUMS` manifest in the standard `sha256sum` format
 * (`<hex>  <filename>`, optionally `*filename` in binary mode). Verification is
 * best-effort: it protects against corrupted downloads and partial tampering,
 * but the manifest is served from the same release, so it is not a substitute
 * for signing.
 */

/** Parse a `sha256sum`-format manifest into a map of filename → lowercase hex. */
export function parseChecksums(text: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of text.split("\n")) {
    const match = line.trim().match(/^([0-9a-fA-F]{64})\s+\*?(.+)$/);
    if (!match) continue;
    const [, hash, name] = match;
    if (hash && name) map.set(name.trim(), hash.toLowerCase());
  }
  return map;
}

/** The expected hash for an asset, or undefined when it is not listed. */
export function expectedHash(sums: Map<string, string>, asset: string): string | undefined {
  return sums.get(asset);
}

/** Lowercase hex SHA-256 digest of a file's contents. */
export async function fileSha256(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(await Bun.file(path).arrayBuffer());
  return hasher.digest("hex");
}
