/**
 * Project identity and naming: how a stored project id is read, displayed, and
 * resolved from something a human typed.
 *
 * Every stored id is root-qualified — `<rootSlug>~<encodedName>`, uniformly,
 * including the primary root's. That makes the id a permanent fact about a
 * directory rather than one that depends on which root currently sorts first,
 * which is what lets the whole query layer aggregate across roots with no
 * scoping clause. The cost is that a raw id is not something to show a person
 * or to expect one to type, so this module owns both directions: `decodeProjectLabel`
 * / `projectDisplayName` for output, `resolveProjectRef` for input.
 *
 * Bun-free (like `stats-types.ts` and `cost-framing.ts`) so the CLI, the TUI,
 * and the web SPA share one set of rules. `rootSlug` itself lives in
 * `claude-roots.ts` because hashing is Bun-side; nothing here needs to compute
 * a slug, only to recognize one.
 */

const segments = (path: string): string[] => path.split(/[\\/]/).filter(Boolean);

/**
 * Separator between a root slug and an encoded project directory name.
 *
 * `~` because it is URL-path-safe (ids travel in `/api/projects/:id`) and the
 * encoding of a working directory never produces one: every `/` and `.` becomes
 * `-`. A directory whose *name* contains `~` is still possible, which is why
 * `projectIdParts` checks the prefix shape rather than just splitting.
 */
export const PROJECT_ID_SEPARATOR = "~";

/** A root slug is exactly 8 lowercase hex characters (see `rootSlug`). */
const SLUG_PATTERN = /^[0-9a-f]{8}$/;

/**
 * Split a project id into its root slug and encoded directory name.
 *
 * `slug` is null for an unqualified reference — either a legacy id or a bare
 * name a human typed. The prefix counts as a slug only if it looks like one, so
 * a working directory containing `~` (`/tmp/my~proj` → `-tmp-my~proj`) is not
 * mistaken for a qualified id.
 */
export function projectIdParts(id: string): { slug: string | null; dirName: string } {
  const at = id.indexOf(PROJECT_ID_SEPARATOR);
  if (at === -1) return { slug: null, dirName: id };
  const slug = id.slice(0, at);
  if (!SLUG_PATTERN.test(slug)) return { slug: null, dirName: id };
  return { slug, dirName: id.slice(at + 1) };
}

/**
 * Best-effort, human-readable label for a project id.
 *
 * The encoding replaces both `/` and `.` with `-`, so it is NOT reversible.
 * Prefer the `cwd` read from a session's events as the authoritative path; use
 * this only as a fallback. The root slug is stripped first — it is storage
 * identity, never something to show.
 */
export function decodeProjectLabel(id: string): string {
  const { dirName } = projectIdParts(id);
  const withSlashes = dirName.replace(/-/g, "/");
  return withSlashes.startsWith("/") ? withSlashes : `/${withSlashes}`;
}

/**
 * The name to show for a project row: its authoritative path when the index
 * has one, otherwise the decoded id. The single fallback rule, so no surface
 * ever prints a raw `<slug>~<name>` at a person.
 */
export function projectDisplayName(
  projectPath: string | null | undefined,
  projectId: string,
): string {
  return projectPath ?? decodeProjectLabel(projectId);
}

/** What a user-supplied project reference resolved to. */
export type ProjectRefMatch =
  | { status: "found"; id: string }
  | { status: "ambiguous"; candidates: string[] }
  | { status: "unknown" };

/**
 * Resolve something a human (or an old bookmark) supplied against the ids that
 * actually exist.
 *
 * A fully qualified id matches exactly. A bare name matches every root holding
 * that project: exactly one is resolved, several are reported as ambiguous
 * rather than silently picking one — which is the whole reason storage identity
 * stopped being positional. Ids are compared case-sensitively; they come from
 * the filesystem.
 */
export function resolveProjectRef(ref: string, knownIds: readonly string[]): ProjectRefMatch {
  if (knownIds.includes(ref)) return { status: "found", id: ref };
  const { slug, dirName } = projectIdParts(ref);
  // A qualified ref that missed the exact check names a root we don't have.
  if (slug !== null) return { status: "unknown" };
  const candidates = knownIds.filter((id) => projectIdParts(id).dirName === dirName);
  if (candidates.length === 1) return { status: "found", id: candidates[0] as string };
  if (candidates.length > 1) return { status: "ambiguous", candidates };
  return { status: "unknown" };
}

/**
 * A short tag naming one root among `all`, without `node:path` so this stays
 * browser-importable.
 *
 * The shortest trailing path segments that tell it apart from the others —
 * because the common case is `~/.claude` beside `/mnt/work/.claude`, where the
 * last segment alone is `.claude` for both and would disambiguate nothing.
 */
export function rootTag(root: string, all: readonly string[] = [root]): string {
  const own = segments(root);
  if (own.length === 0) return root;
  const others = all.filter((p) => p !== root).map(segments);
  for (let take = 1; take <= own.length; take++) {
    const tail = own.slice(-take);
    const clashes = others.some(
      (o) => o.length >= take && o.slice(-take).join("/") === tail.join("/"),
    );
    if (!clashes) return tail.join("/");
  }
  return own.join("/");
}

export interface ProjectLabelling<T> {
  /** Whether the rows span more than one Claude root. */
  multiRoot: boolean;
  /**
   * The row's display label, suffixed with its root's tag only when that label
   * is ambiguous. Surfaces with room for a column (the CLI table) should render
   * the full root path in its own column instead and use the bare label; those
   * without (TUI list, web cards) use this.
   */
  label: (row: T) => string;
}

/**
 * Decide how to name a set of project rows.
 *
 * Only labels that actually collide across roots are qualified, so the common
 * single-root list stays uncluttered.
 */
export function labelProjects<T>(
  rows: readonly T[],
  label: (row: T) => string,
  root: (row: T) => string,
): ProjectLabelling<T> {
  const rootsByLabel = new Map<string, Set<string>>();
  const roots = new Set<string>();
  for (const row of rows) {
    const name = label(row);
    roots.add(root(row));
    const seen = rootsByLabel.get(name) ?? new Set<string>();
    seen.add(root(row));
    rootsByLabel.set(name, seen);
  }
  const multiRoot = roots.size > 1;
  // Tags are computed against the whole root set, so two roots that end in the
  // same directory name (`~/.claude` and `/mnt/work/.claude`) still get tags
  // that differ.
  const all = [...roots];
  return {
    multiRoot,
    label: (row) => {
      const name = label(row);
      if (!multiRoot) return name;
      return (rootsByLabel.get(name)?.size ?? 0) > 1
        ? `${name} [${rootTag(root(row), all)}]`
        : name;
    },
  };
}
