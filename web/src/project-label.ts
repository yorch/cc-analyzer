import { labelProjects, projectDisplayName } from "../../src/core/project-labels.ts";
import { shortPath } from "./format.ts";

export interface LabelledProjectRow {
  projectPath: string | null;
  projectId: string;
  projectAlias?: string | null;
  claudeDir: string;
}

/** The one labelling rule for a set of project rows: qualify a name with its
 *  Claude root only when another root holds a project of the same name. */
export const rootLabeller = <T extends LabelledProjectRow>(rows: readonly T[]) =>
  labelProjects(
    rows,
    (r) => projectDisplayName(r.projectPath, r.projectId, r.projectAlias),
    (r) => r.claudeDir,
  ).label;

/** Same rule over the abbreviated (`…/parent/name`) names the portfolio
 *  tables print; single-root output equals `shortPath(alias ?? path, id)`. */
export const shortRootLabeller = <T extends LabelledProjectRow>(rows: readonly T[]) =>
  labelProjects(
    rows,
    (r) => shortPath(r.projectAlias ?? r.projectPath, r.projectId),
    (r) => r.claudeDir,
  ).label;
