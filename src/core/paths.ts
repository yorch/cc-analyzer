import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Filesystem locations used by cc-analyzer.
 *
 * The tool is read-only with respect to `~/.claude`; all of its own state lives
 * under the config dir. Locations are overridable via env vars for testing.
 */

/** Root of the Claude Code data directory (default `~/.claude`). */
export function claudeDir(): string {
  return process.env.CC_ANALYZER_CLAUDE_DIR ?? join(homedir(), ".claude");
}

/** Directory holding one subdirectory per project. */
export function projectsDir(): string {
  return join(claudeDir(), "projects");
}

/** cc-analyzer's own state directory (index db, pricing cache, config). */
export function stateDir(): string {
  if (process.env.CC_ANALYZER_STATE_DIR) return process.env.CC_ANALYZER_STATE_DIR;
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), ".config");
  return join(base, "cc-analyzer");
}

export const indexDbPath = (): string => join(stateDir(), "index.db");
export const pricingCachePath = (): string => join(stateDir(), "pricing.json");

/**
 * Best-effort, human-readable label for an encoded project directory name.
 *
 * The encoding replaces both `/` and `.` with `-`, so it is NOT reversible.
 * Prefer the `cwd` field read from a session's events as the authoritative
 * path; use this only as a fallback label when no session has been read yet.
 */
export function decodeProjectLabel(dirName: string): string {
  const withSlashes = dirName.replace(/-/g, "/");
  return withSlashes.startsWith("/") ? withSlashes : `/${withSlashes}`;
}
