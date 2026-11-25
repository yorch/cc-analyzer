import {
  type KnownLabel,
  labelProjects,
  projectDisplayName,
  SEVERAL_ROOTS_LABEL,
} from "../../src/core/project-labels.ts";
import { shortPath } from "./format.ts";

export interface LabelledProjectRow {
  projectPath: string | null;
  projectId: string;
  projectAlias?: string | null;
  claudeDir: string;
}

/** The naming fields every portfolio project row carries. */
export type KnownProjectRow = LabelledProjectRow;

const toKnown = (
  projects: readonly KnownProjectRow[] | null | undefined,
  base: (r: KnownProjectRow) => string,
): KnownLabel[] => (projects ?? []).map((r) => ({ label: base(r), root: r.claudeDir }));

const fullBase = (r: KnownProjectRow) =>
  projectDisplayName(r.projectPath, r.projectId, r.projectAlias);

// Abbreviated base label. A NULL path falls back to the decoded id — never the
// raw stored `<slug>~<name>` id — and is abbreviated like any other path.
const shortBase = (r: KnownProjectRow) =>
  shortPath(projectDisplayName(r.projectPath, r.projectId, r.projectAlias));

/** The one labelling rule for a set of project rows: qualify a name with its
 *  Claude root only when another root holds a project of the same name.
 *  `known` is the whole project list (e.g. `useProjects().data`): its pairs
 *  count toward collisions without being rendered, so a LIMIT-ed list still
 *  tags a project whose twin was cut. Absent (still loading) = rows only. */
export const rootLabeller = <T extends LabelledProjectRow>(
  rows: readonly T[],
  known?: readonly KnownProjectRow[] | null,
) => labelProjects(rows, fullBase, (r) => r.claudeDir, toKnown(known, fullBase)).label;

/** Same rule over the abbreviated (`…/parent/name`) names the portfolio
 *  tables print; single-root output equals `shortPath(alias ?? path, id)`
 *  whenever a path or alias exists. */
export const shortRootLabeller = <T extends LabelledProjectRow>(
  rows: readonly T[],
  known?: readonly KnownProjectRow[] | null,
) => labelProjects(rows, shortBase, (r) => r.claudeDir, toKnown(known, shortBase)).label;

/** The portfolio's (label, root) pairs in the full-name form `buildDigestMarkdown`
 *  takes as `known` — the one mapping the digest card's visible labels and its
 *  copied markdown share, so they cannot disagree about the "claude dir" column.
 *  Absent (still loading) = undefined: judge by the rendered rows only. */
export const digestKnownLabels = (
  known: readonly KnownProjectRow[] | null | undefined,
): KnownLabel[] | undefined => (known ? toKnown(known, fullBase) : undefined);

/** The Claude root as shown beside a project: its path, or "several roots" for
 *  an alias group that spans roots (`claudeDir === ''`) — never a blank. */
export const rootText = (claudeDir: string): string =>
  claudeDir === "" ? SEVERAL_ROOTS_LABEL : claudeDir;

/** Does a project row match a filter-box query? Matches the displayed label
 *  (which carries a `[root]` tag when the root disambiguates it), the path and
 *  the alias — case-insensitive. Deliberately NOT the raw id or `claudeDir`:
 *  every root path contains `.claude`, and ids embed an 8-hex root slug, so
 *  matching them makes `claude` or `3f` hit every row. A root is findable only
 *  through the tag the user can actually see. */
export const projectMatches = (query: string, row: LabelledProjectRow, label: string): boolean => {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [label, row.projectPath, row.projectAlias].some((v) =>
    (v ?? "").toLowerCase().includes(q),
  );
};

/** Labels for portfolio findings: a finding's `claudeDir` is optional (unscoped
 *  or older findings carry none), so only root-carrying findings take part in
 *  the collision check; the rest keep the bare name. Pass the whole finding
 *  set, not a filtered subset, so suffixes never flip while filtering. */
export const findingLabeller = (
  findings: readonly {
    projectId?: string;
    projectPath?: string;
    projectAlias?: string | null;
    claudeDir?: string;
  }[],
  known?: readonly KnownProjectRow[] | null,
) => {
  type F = (typeof findings)[number];
  const name = (d: F) => projectDisplayName(d.projectPath, d.projectId ?? "", d.projectAlias);
  const scoped = findings.filter((d) => d.projectId && d.claudeDir !== undefined);
  const labelled = labelProjects(scoped, name, (d) => d.claudeDir ?? "", toKnown(known, fullBase));
  return (d: F): string => (d.claudeDir !== undefined ? labelled.label(d) : name(d));
};
