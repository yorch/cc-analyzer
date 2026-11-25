import { type KnownLabel, projectDisplayName } from "../core/project-labels.ts";

/** The naming fields of one indexed project (`KnownProject` in queries.ts,
 *  restated structurally so renderers never import the database layer). */
export interface KnownProjectFields {
  projectId: string;
  projectAlias: string | null;
  projectPath: string | null;
  /** '' = alias group spanning several roots. */
  claudeDir: string;
}

/**
 * Map every indexed project to the (label, root) pair `labelProjects` takes as
 * `known`, so a LIMIT-ed list still tags a project whose same-named twin in
 * another root was cut. The label is the full display name — the same base the
 * CLI/TUI labellers use.
 */
export function knownLabelPairs(projects: readonly KnownProjectFields[]): KnownLabel[] {
  return projects.map((p) => ({
    label: projectDisplayName(p.projectPath, p.projectId, p.projectAlias),
    root: p.claudeDir,
  }));
}
