/**
 * Naming projects when several Claude roots are configured.
 *
 * Two roots can each hold a project for the *same* working directory — that is
 * exactly the collision root-qualified ids exist to preserve — so their human
 * labels are byte-identical and a list would show two indistinguishable rows.
 *
 * Bun-free (like `stats-types.ts` and `cost-framing.ts`) so the CLI, the TUI,
 * and the web SPA all import this one decision rather than each re-deriving
 * "am I multi-root?" from whatever rows it happens to be holding.
 */

const segments = (path: string): string[] => path.split(/[\\/]/).filter(Boolean);

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
