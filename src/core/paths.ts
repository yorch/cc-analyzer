import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";

/**
 * Filesystem locations used by cc-analyzer.
 *
 * The tool is read-only with respect to the Claude Code data directory; all of
 * its own state lives under the state dir. Locations are overridable via env
 * vars for testing.
 *
 * Claude Code itself can be relocated with `CLAUDE_CONFIG_DIR`, and a user may
 * legitimately keep more than one data directory (a work profile and a personal
 * one, or several machines' data synced into one folder). So the Claude side is
 * a *list* of roots, resolved by `claudeRoots()`; `claudeDir()` is the primary
 * one, kept for the many call sites that only need a single directory.
 */

/** Where a resolved root came from — surfaced so an empty portfolio explains itself. */
export type ClaudeRootSource = "flag" | "env" | "prefs" | "claude-code" | "default";

export interface ClaudeRoot {
  /** Absolute path to a Claude Code data directory. */
  path: string;
  /** Which resolution tier produced it. */
  source: ClaudeRootSource;
  /**
   * The one root whose project ids stay unqualified. Adding a second root must
   * not re-key the first one's ids, so "primary" is the first resolved root and
   * nothing else depends on list length.
   */
  primary: boolean;
}

/** Set by the CLI's `--claude-dir=` flag, ahead of every other tier. */
let flagRoots: string[] | null = null;

/**
 * Override the resolved roots for this process (the `--claude-dir=` flag).
 * Kept as module state rather than an env write so `claudeRoots()` can report
 * `source: "flag"` and explain itself accurately. Pass `null` to clear.
 */
export function setClaudeRootsOverride(paths: string[] | null): void {
  flagRoots = paths && paths.length > 0 ? paths : null;
}

/** Expand a leading `~`, then make the path absolute. */
function expandPath(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === "~") return homedir();
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    return join(homedir(), trimmed.slice(2));
  }
  return isAbsolute(trimmed) ? trimmed : resolve(trimmed);
}

/** Split a `PATH`-style list (`:` on posix, `;` on Windows) into entries. */
export function splitRootList(raw: string): string[] {
  return raw
    .split(delimiter)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

function normalizeRoots(raw: string[], source: ClaudeRootSource): ClaudeRoot[] {
  const seen = new Set<string>();
  const roots: ClaudeRoot[] = [];
  for (const entry of raw) {
    const path = expandPath(entry);
    if (path.length === 0 || seen.has(path)) continue;
    seen.add(path);
    roots.push({ path, source, primary: roots.length === 0 });
  }
  return roots;
}

/**
 * Roots persisted by `cc-analyzer claude-dir`.
 *
 * Read here with a local, tolerant reader rather than through `prefs.ts`:
 * `prefs.ts` imports this module for `prefsConfigPath()`, so calling back into
 * it would make the two circular. `prefs.ts` owns the typed read/write the CLI
 * command uses; this is the resolution-time read.
 */
function prefsRoots(): string[] {
  try {
    const cfg = JSON.parse(readFileSync(prefsConfigPath(), "utf8")) as {
      claudeDirs?: unknown;
    };
    if (!Array.isArray(cfg.claudeDirs)) return [];
    return cfg.claudeDirs.filter((p): p is string => typeof p === "string" && p.trim().length > 0);
  } catch {
    return [];
  }
}

/**
 * Every configured Claude Code data directory, primary first.
 *
 * Tiers are **exclusive**, not merged — the first one that yields anything
 * wins, so a user who points cc-analyzer somewhere never gets the default
 * `~/.claude` silently mixed back in:
 *
 * 1. `--claude-dir=<path>` (repeatable)
 * 2. `CC_ANALYZER_CLAUDE_DIR` (a `PATH`-style list; the test/CI escape hatch)
 * 3. `claudeDirs` in `prefs.json` (`cc-analyzer claude-dir add <path>`)
 * 4. `CLAUDE_CONFIG_DIR` — what Claude Code itself honours, so a relocated
 *    install works with no cc-analyzer configuration at all
 * 5. `~/.claude`
 *
 * The pref sits above `CLAUDE_CONFIG_DIR` on the principle that a directory the
 * user named to *this* tool beats one inherited from another.
 */
export function claudeRoots(): ClaudeRoot[] {
  if (flagRoots) return normalizeRoots(flagRoots, "flag");

  const env = process.env.CC_ANALYZER_CLAUDE_DIR;
  if (env && env.trim().length > 0) return normalizeRoots(splitRootList(env), "env");

  const prefs = prefsRoots();
  if (prefs.length > 0) return normalizeRoots(prefs, "prefs");

  const claudeCode = process.env.CLAUDE_CONFIG_DIR;
  if (claudeCode && claudeCode.trim().length > 0) {
    return normalizeRoots(splitRootList(claudeCode), "claude-code");
  }

  return normalizeRoots([join(homedir(), ".claude")], "default");
}

/** The primary Claude root — the one whose project ids stay unqualified. */
export function primaryClaudeRoot(): ClaudeRoot {
  // normalizeRoots always yields at least one entry for the default tier.
  return claudeRoots()[0] as ClaudeRoot;
}

/** Root of the Claude Code data directory (the primary one; default `~/.claude`). */
export function claudeDir(): string {
  return primaryClaudeRoot().path;
}

/** Directory holding one subdirectory per project, for a given root. */
export function projectsDirOf(root: string): string {
  return join(root, "projects");
}

/** Directory holding one subdirectory per project, under the primary root. */
export function projectsDir(): string {
  return projectsDirOf(claudeDir());
}

/* ——— Project identity across roots ——————————————————————————————————— */

/**
 * Separator between a root slug and an encoded project directory name.
 *
 * `~` because it is URL-path-safe (project ids travel in `/api/projects/:id`)
 * and cannot appear in an encoded project name: the encoding maps every `/` and
 * `.` of the working directory to `-`, and no other character survives it.
 */
export const PROJECT_ID_SEPARATOR = "~";

/** Short, order-independent, stable identifier for a root path. */
export function rootSlug(rootPath: string): string {
  return createHash("sha256").update(rootPath).digest("hex").slice(0, 8);
}

/**
 * The globally unique project id for an encoded directory name under `root`.
 *
 * Two roots can each hold a project for the *same* working directory, and the
 * encoded name would be byte-identical — so every `GROUP BY project_id` would
 * silently merge two different projects. Qualifying the id at index time makes
 * the column unique again, which is what lets the whole query layer aggregate
 * across roots without a single scoping clause.
 *
 * The primary root stays unqualified so single-root users (and anyone adding a
 * second root later) keep the ids they already have.
 */
export function qualifyProjectId(root: ClaudeRoot, dirName: string): string {
  return root.primary ? dirName : `${rootSlug(root.path)}${PROJECT_ID_SEPARATOR}${dirName}`;
}

/** Split a project id back into its optional root slug and encoded name. */
export function projectIdParts(id: string): { slug: string | null; dirName: string } {
  const at = id.indexOf(PROJECT_ID_SEPARATOR);
  if (at === -1) return { slug: null, dirName: id };
  return { slug: id.slice(0, at), dirName: id.slice(at + 1) };
}

/* ——— cc-analyzer's own state ————————————————————————————————————————— */

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

/**
 * Best-effort, human-readable label for an encoded project directory name.
 *
 * The encoding replaces both `/` and `.` with `-`, so it is NOT reversible.
 * Prefer the `cwd` field read from a session's events as the authoritative
 * path; use this only as a fallback label when no session has been read yet.
 * A root-qualified id is decoded from its directory-name half.
 */
export function decodeProjectLabel(dirName: string): string {
  const { dirName: bare } = projectIdParts(dirName);
  const withSlashes = bare.replace(/-/g, "/");
  return withSlashes.startsWith("/") ? withSlashes : `/${withSlashes}`;
}
