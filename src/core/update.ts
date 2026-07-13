import { chmodSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { expectedHash, fileSha256, parseChecksums } from "./checksum.ts";
import {
  assetDownloadUrl,
  assetName,
  checksumsUrl,
  compareVersions,
  fetchLatestVersion,
} from "./release.ts";
import { VERSION } from "./version.ts";

/**
 * Whether this process is a `bun build --compile` standalone binary (as opposed
 * to running from source via `bun run`). Compiled binaries mount their bundled
 * code under the `$bunfs` virtual filesystem; `process.execPath` then points at
 * the standalone binary itself (the file we replace on self-update).
 */
export function isCompiledBinary(): boolean {
  if (import.meta.url.includes("$bunfs")) return true;
  const exe = basename(process.execPath).toLowerCase();
  return exe !== "bun" && exe !== "bun.exe" && exe !== "node" && exe !== "node.exe";
}

export interface UpdateResult {
  status: "updated" | "up-to-date" | "delegated" | "unsupported";
  from: string;
  to?: string;
  message: string;
}

/** Atomically replace the binary at `targetPath` with the file at `tmpPath`. */
export function swapBinary(targetPath: string, tmpPath: string): void {
  chmodSync(tmpPath, 0o755);
  // rename is atomic when tmpPath and targetPath are on the same filesystem,
  // and the running executable can be replaced this way on macOS/Linux.
  renameSync(tmpPath, targetPath);
}

async function downloadTo(url: string, dest: string): Promise<void> {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`download failed (HTTP ${res.status}) for ${url}`);
  await Bun.write(dest, res);
}

/**
 * Verify a downloaded file against the release's SHA256SUMS. Best-effort:
 * silently returns when the manifest is absent (pre-checksum releases), the
 * asset is unlisted, or the manifest can't be fetched — but throws on a real
 * hash mismatch so a corrupted or tampered download is never installed.
 */
async function verifyChecksum(file: string, version: string, asset: string): Promise<void> {
  let manifest: string;
  try {
    const res = await fetch(checksumsUrl(version), { redirect: "follow" });
    if (!res.ok) return;
    manifest = await res.text();
  } catch {
    return;
  }
  const expected = expectedHash(parseChecksums(manifest), asset);
  if (!expected) return;
  const actual = await fileSha256(file);
  if (actual !== expected) {
    throw new Error(`checksum mismatch for ${asset} (expected ${expected}, got ${actual})`);
  }
}

/** Download the latest release binary and replace the running one in place. */
export async function performUpdate(): Promise<UpdateResult> {
  const current = VERSION;
  const latest = await fetchLatestVersion();

  if (compareVersions(latest, current) <= 0) {
    return { status: "up-to-date", from: current, message: `Already up to date (v${current}).` };
  }

  if (process.platform === "win32") {
    return {
      status: "delegated",
      from: current,
      to: latest,
      message:
        `v${latest} is available. On Windows, update by re-running the installer:\n` +
        `  irm https://yorch.github.io/cc-analyzer/install.ps1 | iex`,
    };
  }

  if (!isCompiledBinary()) {
    return {
      status: "unsupported",
      from: current,
      to: latest,
      message:
        `v${latest} is available, but this is running from source, not an installed binary.\n` +
        `Update your checkout with 'git pull', or reinstall the binary.`,
    };
  }

  const asset = assetName(process.platform, process.arch);
  if (!asset) {
    return {
      status: "unsupported",
      from: current,
      to: latest,
      message: `v${latest} is available, but ${process.platform}/${process.arch} has no published binary.`,
    };
  }

  const target = process.execPath;
  const tmp = join(dirname(target), `.cc-analyzer.update.${process.pid}`);
  try {
    await downloadTo(assetDownloadUrl(latest, asset), tmp);
    await verifyChecksum(tmp, latest, asset);
    swapBinary(target, tmp);
  } catch (err) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // best-effort cleanup
    }
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EACCES" || code === "EPERM") {
      throw new Error(
        `permission denied writing ${target}.\n` +
          `Re-run the installer, or reinstall to a writable dir with CC_ANALYZER_INSTALL_DIR.`,
      );
    }
    throw err;
  }

  return {
    status: "updated",
    from: current,
    to: latest,
    message: `Updated ${current} → ${latest}.`,
  };
}
