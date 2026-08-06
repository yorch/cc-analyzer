import { homedir } from "node:os";
import { delimiter, join, normalize, resolve } from "node:path";
import { getClaudeDirs } from "./prefs.ts";
import { PROJECT_ID_SEPARATOR } from "./project-labels.ts";

/**
 * Which Claude Code data directories cc-analyzer reads, and how a project is
 * identified across them.
 *
 * Claude Code itself can be relocated with `CLAUDE_CONFIG_DIR`, and a user may
 * legitimately keep more than one data directory (a work profile and a personal
 * one, or several machines' data synced into one folder). So the Claude side is
 * a *list* of roots; `claudeDir()` is the primary one, kept for the many call
 * sites that only need a single directory.
 *
 * This lives apart from `paths.ts` because resolution does I/O and carries
 * process state, while `paths.ts` is pure location algebra: keeping them
 * together would force this module's dependency on `prefs.ts` (which reads
 * `paths.ts` for its own location) into a cycle.
 */

/** Where a resolved root came from — surfaced so an empty portfolio explains itself. */
export type ClaudeRootSource = "flag" | "env" | "prefs" | "claude-code" | "default";

export interface ClaudeRoot {
  /** Absolute path to a Claude Code data directory. */
  path: string;
  /** Short, order-independent, stable identifier for `path` (see `rootSlug`). */
  slug: string;
  /** Which resolution tier produced it. */
  source: ClaudeRootSource;
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

/**
 * Expand a leading `~`, then make the path absolute.
 *
 * The single authority on what a root path string means: resolution normalizes
 * with it on read, and `cc-analyzer claude-dir` normalizes with it on write, so
 * a stored path and a resolved one cannot disagree.
 */
export function expandPath(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return "";
  const tilde =
    trimmed === "~"
      ? homedir()
      : trimmed.startsWith("~/") || trimmed.startsWith("~\\")
        ? join(homedir(), trimmed.slice(2))
        : trimmed;
  // `normalize` + `resolve` collapse `.`/`..`, duplicate separators, and the
  // trailing slash that shell tab-completion adds. Without it `~/.claude/` and
  // `~/.claude` are two distinct strings, so the dedupe below misses them and
  // every project under that root is discovered — and indexed — twice.
  return resolve(normalize(tilde));
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
    // Hash once per root here, not once per project in the discovery loops.
    roots.push({ path, slug: rootSlug(path), source });
  }
  return roots;
}

function resolveTiers(tiers: [string[], ClaudeRootSource][]): ClaudeRoot[] {
  // A tier only wins if it normalizes to at least one usable path. A value that
  // is non-empty but yields nothing (`CC_ANALYZER_CLAUDE_DIR=":"`) must fall
  // through rather than win with an empty list — every caller, `claudeDir()`
  // included, relies on there always being a primary root.
  for (const [raw, source] of tiers) {
    const roots = normalizeRoots(raw, source);
    if (roots.length > 0) return roots;
  }
  // Unreachable: the default tier is a literal absolute path.
  return normalizeRoots([join(homedir(), ".claude")], "default");
}

/** The two tiers that are transient — scoped to one invocation, not persisted. */
const transientTiers = (): [string[], ClaudeRootSource][] => [
  [flagRoots ?? [], "flag"],
  [splitRootList(process.env.CC_ANALYZER_CLAUDE_DIR ?? ""), "env"],
];

/** The tiers that outlive this process: the pref, Claude Code's own var, the default. */
const persistentTiers = (): [string[], ClaudeRootSource][] => [
  [getClaudeDirs(), "prefs"],
  [splitRootList(process.env.CLAUDE_CONFIG_DIR ?? ""), "claude-code"],
  [[join(homedir(), ".claude")], "default"],
];

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
 *
 * This reads the filesystem (tier 3), so callers that need roots more than once
 * should resolve once and pass the list down rather than calling repeatedly —
 * which is why the `discover.ts` entry points all take it as a defaulted
 * parameter.
 */
export function claudeRoots(): ClaudeRoot[] {
  return resolveTiers([...transientTiers(), ...persistentTiers()]);
}

/**
 * What would be in effect ignoring the one-invocation tiers.
 *
 * `cc-analyzer claude-dir add` appends to this rather than to `claudeRoots()`:
 * appending to a `--claude-dir=` or `CC_ANALYZER_CLAUDE_DIR` root would bake a
 * directory the user scoped to a single command into `prefs.json` permanently.
 */
export function persistentClaudeRoots(): ClaudeRoot[] {
  return resolveTiers(persistentTiers());
}

/** Root of the Claude Code data directory (the primary one; default `~/.claude`). */
export function claudeDir(): string {
  // claudeRoots() always yields at least one entry (see its tier loop).
  return (claudeRoots()[0] as ClaudeRoot).path;
}

/** Directory holding one subdirectory per project, for a given root. */
export function projectsDirOf(root: string): string {
  return join(root, "projects");
}

/* ——— Project identity across roots ——————————————————————————————————— */

/**
 * Short, order-independent, stable identifier for a root path.
 *
 * Called once per root by `normalizeRoots`, which stores the result on
 * `ClaudeRoot.slug` — the discovery loops read that field rather than re-hashing
 * an unchanging path per project.
 */
export function rootSlug(rootPath: string): string {
  return new Bun.CryptoHasher("sha256").update(rootPath).digest("hex").slice(0, 8);
}

/**
 * The globally unique project id for an encoded directory name under `root`.
 *
 * **Every** root qualifies, including the first one. An id that depended on
 * which root currently sorts first would silently change meaning when the
 * configured list is reordered — a stored id, a bookmarked `/api/projects/:id`,
 * or a scripted `sessions <id>` would resolve against a different root rather
 * than failing. Uniform qualification makes the id a fact about a directory,
 * which is what lets `GROUP BY project_id` aggregate across roots with no
 * scoping clause anywhere in the query layer.
 *
 * Raw ids are storage identity only: see `projectDisplayName` for output and
 * `resolveProjectRef` for accepting what a human types.
 */
export function qualifyProjectId(root: ClaudeRoot, dirName: string): string {
  return `${root.slug}${PROJECT_ID_SEPARATOR}${dirName}`;
}
