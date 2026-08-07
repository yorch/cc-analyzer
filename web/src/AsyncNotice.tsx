import { projectDisplayName } from "../../src/core/project-labels.ts";
import { ambiguousProjectCandidates, type IndexedProject } from "./api.ts";
import { link } from "./router.ts";

export function LoadingNotice({ children }: { children: string }) {
  return (
    <div className="loading" role="status" aria-live="polite">
      {children}
    </div>
  );
}

export function ErrorNotice({
  error,
  retry,
  label = "Couldn’t load this view.",
}: {
  error: string;
  retry: () => void;
  label?: string;
}) {
  return (
    <div className="notice error-notice" role="alert">
      <strong>{label}</strong>
      <span>{error}</span>
      <button type="button" onClick={retry}>
        Try Again
      </button>
    </div>
  );
}

export function EmptyNotice({ children }: { children: string }) {
  return (
    <p className="notice empty-notice" role="status">
      {children}
    </p>
  );
}

/**
 * Renders the server's project-id-ambiguity `409` (`projectParam` in
 * `src/web/api.ts`: a bare id/name matched more than one root-qualified
 * project) as a pick-one list instead of a bare "409" error. `projects` is
 * best-effort — when it hasn't loaded yet (or a candidate isn't in it for
 * some reason) the raw id still renders as a working link, just undecoded.
 */
export function AmbiguousProjectNotice({
  attempted,
  candidates,
  projects,
}: {
  attempted: string;
  candidates: string[];
  projects: IndexedProject[] | null;
}) {
  return (
    <div className="notice disambig-notice" role="alert">
      <strong>
        “{attempted}” matches {candidates.length} projects.
      </strong>
      <span className="muted">
        More than one configured Claude data directory holds a project by that name — pick one:
      </span>
      <ul className="disambig-list">
        {candidates.map((candidateId) => {
          const project = projects?.find((p) => p.projectId === candidateId);
          return (
            <li key={candidateId}>
              <a href={link.project(candidateId)}>
                {projectDisplayName(project?.projectPath ?? null, candidateId)}
              </a>
              {project && <span className="muted"> · {project.claudeDir}</span>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * The one place a project-scoped `useAsync` error becomes UI: the ambiguous-id
 * picker when the error is `projectParam`'s 409 candidate list, otherwise a
 * generic `ErrorNotice`+retry. Shared by every view that resolves an `:id`
 * through a route behind `projectParam` (`src/web/api.ts`) — a behavior tweak
 * here (e.g. a "go to Dashboard" link) now lands once, not once per page.
 */
export function ProjectFetchErrorNotice({
  attempted,
  error,
  errorCause,
  retry,
  projects,
  label,
}: {
  attempted: string;
  error: string;
  errorCause: unknown;
  retry: () => void;
  projects: IndexedProject[] | null;
  label: string;
}) {
  const candidates = ambiguousProjectCandidates(errorCause);
  if (candidates) {
    return (
      <AmbiguousProjectNotice attempted={attempted} candidates={candidates} projects={projects} />
    );
  }
  return <ErrorNotice error={error} retry={retry} label={label} />;
}
