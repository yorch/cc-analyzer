import { basename } from "node:path";

/**
 * Facts about how this process is running, shared by the subsystems that need
 * to re-invoke or replace the executable: `update.ts` (which overwrites the
 * binary in place) and `telemetry.ts` (which re-invokes it as a detached
 * beacon). Kept in its own module so neither has to import the other.
 */

/**
 * Whether this process is a `bun build --compile` standalone binary (as opposed
 * to running from source via `bun run`). Compiled binaries mount their bundled
 * code under the `$bunfs` virtual filesystem; `process.execPath` then points at
 * the standalone binary itself (the file self-update replaces, and the file the
 * telemetry poster re-invokes).
 */
export function isCompiledBinary(): boolean {
  if (import.meta.url.includes("$bunfs")) return true;
  // Fallback allowlist: only treat the process as our compiled binary when the
  // executable actually looks like one. A denylist ("not bun/node") would let a
  // renamed interpreter (bun-1.3, bun-profile…) be overwritten by self-update.
  const exe = basename(process.execPath).toLowerCase();
  return exe === "cc-analyzer" || exe.startsWith("cc-analyzer-") || exe === "cc-analyzer.exe";
}
