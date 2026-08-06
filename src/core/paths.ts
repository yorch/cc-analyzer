import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Where cc-analyzer keeps its own state.
 *
 * The tool is read-only with respect to the Claude Code data directories; all
 * of its own state lives under the state dir, overridable via env var for
 * testing. Which Claude directories are read — and how a project is identified
 * across them — lives in `claude-roots.ts`, which does I/O and therefore
 * depends on `prefs.ts`, which depends on this module for its own location.
 */

/** cc-analyzer's own state directory (index db, pricing cache, config). */
export function stateDir(): string {
  if (process.env.CC_ANALYZER_STATE_DIR) return process.env.CC_ANALYZER_STATE_DIR;
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), ".config");
  return join(base, "cc-analyzer");
}

export const indexDbPath = (): string => join(stateDir(), "index.db");
export const pricingCachePath = (): string => join(stateDir(), "pricing.json");
export const updateCachePath = (): string => join(stateDir(), "update-check.json");
export const telemetryConfigPath = (): string => join(stateDir(), "telemetry.json");
export const prefsConfigPath = (): string => join(stateDir(), "prefs.json");
