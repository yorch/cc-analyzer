import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
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
  archiveMachineLabel?: string;
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

/** Human label for this computer in the archive; display-only, defaults to the hostname. */
export function getArchiveMachineLabel(): string {
  const label = readConfig().archiveMachineLabel;
  return typeof label === "string" && label.trim() ? label.trim() : hostname();
}

/** Set or clear (undefined) the archive machine label. */
export function setArchiveMachineLabel(label: string | undefined): void {
  const cfg = { ...readConfig() };
  const value = label?.trim();
  if (value) cfg.archiveMachineLabel = value;
  else delete cfg.archiveMachineLabel;
  writeConfig(cfg);
}

export const ARCHIVE_MACHINE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The persisted machine id when the local state file holds a valid one. */
export function readStoredArchiveMachineId(): string | undefined {
  try {
    const existing = readFileSync(archiveMachineIdPath(), "utf8").trim();
    return ARCHIVE_MACHINE_ID_PATTERN.test(existing) ? existing : undefined;
  } catch {
    return undefined;
  }
}

/** Persist an explicit machine id (adopting an identity found in the archive). */
export function setArchiveMachineId(id: string): void {
  const path = archiveMachineIdPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${id}\n`);
}
