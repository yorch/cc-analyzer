import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { DEFAULT_ANALYSIS_MODEL, isValidModel } from "./claude-handoff.ts";
import type { CostBasis } from "./cost-framing.ts";
import { archiveMachineIdPath, prefsConfigPath } from "./paths.ts";

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
  analysisModel?: string;
  archivePath?: string;
  archiveDuringIndex?: boolean;
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

/** Persisted default model for "Analyze with Claude Code" (the web dropdown and
 *  the TUI remember the last pick). Falls back to `DEFAULT_ANALYSIS_MODEL` when
 *  unset or when a stored value fails validation. The CLI `--model` flag
 *  overrides this per-invocation. */
export function getAnalysisModel(): string {
  const model = readConfig().analysisModel;
  return typeof model === "string" && isValidModel(model) ? model : DEFAULT_ANALYSIS_MODEL;
}

/** Persist the analysis model default. Merge-tolerant, like `setCostBasis`. */
export function setAnalysisModel(model: string): void {
  writeConfig({ ...readConfig(), analysisModel: model });
}

/**
 * Claude data directories persisted by `cc-analyzer claude-dir`. Empty means
 * unset — resolution then falls through to `CLAUDE_CONFIG_DIR` and `~/.claude`.
 *
 * `claude-roots.ts` calls this at resolution time — it imports this module,
 * which is why root resolution lives there rather than in `paths.ts` (this
 * module reads `paths.ts` for its own location, so the two would cycle).
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

/** Configured local Git repository used for raw transcript backups. */
export function getArchivePath(): string | undefined {
  const path = readConfig().archivePath;
  return typeof path === "string" && path.trim() ? path : undefined;
}

/** Set or clear the raw session archive repository path. */
export function setArchivePath(path: string | undefined): void {
  const cfg = { ...readConfig() };
  if (path) cfg.archivePath = path;
  else delete cfg.archivePath;
  writeConfig(cfg);
}

/** Whether ordinary index refreshes also snapshot and commit current sessions. */
export function getArchiveDuringIndex(): boolean {
  return readConfig().archiveDuringIndex === true;
}

export function setArchiveDuringIndex(enabled: boolean): void {
  const cfg = { ...readConfig() };
  cfg.archiveDuringIndex = enabled;
  writeConfig(cfg);
}

/** Stable per-installation identity so multiple computers get separate archive paths. */
export function getArchiveMachineId(): string {
  const path = archiveMachineIdPath();
  try {
    const existing = readFileSync(path, "utf8").trim();
    if (/^[0-9a-f-]{36}$/.test(existing)) return existing;
  } catch {
    // Create lazily below.
  }
  const id = randomUUID();
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${id}\n`, { flag: "wx" });
    return id;
  } catch {
    try {
      return readFileSync(path, "utf8").trim();
    } catch {
      return id;
    }
  }
}
