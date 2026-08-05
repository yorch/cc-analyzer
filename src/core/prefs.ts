import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { CostBasis } from "./cost-framing.ts";
import { prefsConfigPath } from "./paths.ts";

/**
 * Small, general cc-analyzer preferences — same persistence pattern as
 * `telemetry.ts`: a tolerant JSON file in the tool's own state dir, never
 * `~/.claude`. One preference lives here today (`costBasis`); the shape is a
 * plain record so a future preference can be added without migrating this
 * one.
 */

interface PrefsConfig {
  costBasis?: CostBasis;
  claudeDirs?: string[];
  [key: string]: unknown;
}

function readConfig(): PrefsConfig {
  try {
    return JSON.parse(readFileSync(prefsConfigPath(), "utf8")) as PrefsConfig;
  } catch {
    return {};
  }
}

function writeConfig(cfg: PrefsConfig): void {
  try {
    mkdirSync(dirname(prefsConfigPath()), { recursive: true });
    writeFileSync(prefsConfigPath(), JSON.stringify(cfg, null, 2));
  } catch {
    // Best-effort: a read-only state dir just means the setting isn't persisted.
  }
}

/** Current cost-basis preference. Defaults to "api" (dollars read as a bill)
 *  when unset or unreadable — the correct default for API-key users, and the
 *  neutral "est. cost (API rates)" headline wording covers everyone else. */
export function getCostBasis(): CostBasis {
  return readConfig().costBasis === "subscription" ? "subscription" : "api";
}

/** Persist the cost-basis preference (`cc-analyzer cost-basis api|subscription`).
 *  Merge-tolerant: preserves any other keys already in prefs.json. */
export function setCostBasis(basis: CostBasis): void {
  writeConfig({ ...readConfig(), costBasis: basis });
}

/**
 * Claude data directories persisted by `cc-analyzer claude-dir`. Empty means
 * unset — resolution then falls through to `CLAUDE_CONFIG_DIR` and `~/.claude`.
 *
 * `paths.ts` reads this key with its own tolerant reader (it cannot import this
 * module without a cycle); this is the typed read/write the CLI command uses.
 */
export function getClaudeDirs(): string[] {
  const dirs = readConfig().claudeDirs;
  if (!Array.isArray(dirs)) return [];
  return dirs.filter((p): p is string => typeof p === "string" && p.trim().length > 0);
}

/** Persist the Claude data directories. An empty list clears the preference. */
export function setClaudeDirs(dirs: string[]): void {
  const cfg = { ...readConfig() };
  if (dirs.length === 0) delete cfg.claudeDirs;
  else cfg.claudeDirs = dirs;
  writeConfig(cfg);
}
