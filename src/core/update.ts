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
  // Fallback allowlist: only treat the process as our compiled binary when the
  // executable actually looks like one. A denylist ("not bun/node") would let a
  // renamed interpreter (bun-1.3, bun-profile…) be overwritten by self-update.
  const exe = basename(process.execPath).toLowerCase();
  return exe === "cc-analyzer" || exe.startsWith("cc-analyzer-") || exe === "cc-analyzer.exe";
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

export interface DownloadProgress {
  /** Bytes written so far. */
  received: number;
  /** Total bytes from Content-Length, or undefined if the server omitted it. */
  total?: number;
}

/** Reject if `p` doesn't settle within `ms`, naming the failure a stall. */
function withStall<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`download stalled (no data for ${Math.round(ms / 1000)}s)`)),
      ms,
    );
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/**
 * Pump a byte stream into `write`, reporting progress per chunk and aborting if
 * no chunk arrives within `stallMs` (reset on every chunk, so a slow-but-moving
 * download is never killed — only a true stall). Pure over its inputs (stream +
 * callbacks), so it's unit-testable without a network or filesystem. Returns the
 * total bytes pumped.
 */
export async function pumpStream(
  stream: ReadableStream<Uint8Array>,
  write: (chunk: Uint8Array) => void | Promise<void>,
  opts: { stallMs: number; total?: number; onProgress?: (p: DownloadProgress) => void },
): Promise<number> {
  const reader = stream.getReader();
  let received = 0;
  try {
    while (true) {
      let step: Awaited<ReturnType<typeof reader.read>>;
      try {
        step = await withStall(reader.read(), opts.stallMs);
      } catch (err) {
        await reader.cancel().catch(() => {});
        throw err;
      }
      if (step.done) break;
      await write(step.value);
      received += step.value.length;
      opts.onProgress?.({ received, total: opts.total });
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // already released (e.g. after cancel)
    }
  }
  return received;
}

/** No data for this long mid-download → treat as a stall and abort. */
const DOWNLOAD_STALL_MS = 30_000;
/** Cap on establishing the connection and receiving response headers. */
const CONNECT_TIMEOUT_MS = 30_000;

async function downloadTo(
  url: string,
  dest: string,
  onProgress?: (p: DownloadProgress) => void,
): Promise<void> {
  // Bound only the connect/headers phase with the signal; the body is guarded by
  // pumpStream's per-chunk stall timer so a slow-but-progressing download lives.
  const ctrl = new AbortController();
  const connectTimer = setTimeout(() => ctrl.abort(), CONNECT_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, { redirect: "follow", signal: ctrl.signal });
  } finally {
    clearTimeout(connectTimer);
  }
  if (!res.ok) throw new Error(`download failed (HTTP ${res.status}) for ${url}`);
  if (!res.body) {
    await Bun.write(dest, res);
    return;
  }
  const total = Number(res.headers.get("content-length")) || undefined;
  const sink = Bun.file(dest).writer();
  let received = 0;
  try {
    // Awaiting the sink write applies backpressure and surfaces write errors
    // (e.g. disk full) as a clean failure instead of an unhandled rejection.
    received = await pumpStream(
      res.body,
      async (chunk) => {
        await sink.write(chunk);
      },
      {
        stallMs: DOWNLOAD_STALL_MS,
        total,
        onProgress,
      },
    );
  } finally {
    await sink.end();
  }
  // A stream that ends cleanly but early would otherwise install a truncated binary.
  if (total !== undefined && received !== total) {
    throw new Error(`incomplete download: got ${received} of ${total} bytes for ${url}`);
  }
}

/**
 * Verify a downloaded file against the release's SHA256SUMS. Every release
 * ships a manifest, so verification is required: an unreachable or incomplete
 * manifest aborts the update rather than silently installing an unverified
 * binary — an attacker who can tamper with the asset can usually also make the
 * manifest fetch fail, so failing open would defeat the check entirely.
 */
async function verifyChecksum(file: string, version: string, asset: string): Promise<void> {
  let manifest: string;
  try {
    const res = await fetch(checksumsUrl(version), {
      redirect: "follow",
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    manifest = await res.text();
  } catch (err) {
    throw new Error(
      `could not fetch SHA256SUMS to verify the download (${String(err)}); aborting update. ` +
        `Retry, or download the release manually from GitHub.`,
    );
  }
  const expected = expectedHash(parseChecksums(manifest), asset);
  if (!expected) {
    throw new Error(`SHA256SUMS for v${version} has no entry for ${asset}; aborting update.`);
  }
  const actual = await fileSha256(file);
  if (actual !== expected) {
    throw new Error(`checksum mismatch for ${asset} (expected ${expected}, got ${actual})`);
  }
}

/** Download the latest release binary and replace the running one in place.
 * `onProgress` is invoked per chunk during the download for a progress display. */
export async function performUpdate(
  onProgress?: (p: DownloadProgress) => void,
): Promise<UpdateResult> {
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
  // pid uniquely identifies the single writer (one update per process); the
  // catch block below removes this file on any failure.
  const tmp = join(dirname(target), `.cc-analyzer.update.${process.pid}`);
  try {
    await downloadTo(assetDownloadUrl(latest, asset), tmp, onProgress);
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
