import { useMemo } from "react";
import { labelProjects, projectDisplayName } from "../../../src/core/project-labels.ts";
import { EmptyNotice, ErrorNotice, LoadingNotice } from "../AsyncNotice.tsx";
import {
  api,
  cacheVerdict,
  type IndexedProject,
  type PortfolioDiagnostic,
  type ProjectCacheRow,
} from "../api.ts";
import { count, relTime, tokens, usd } from "../format.ts";
import { link, useHashParam } from "../router.ts";
import { SearchField } from "../SearchField.tsx";
import { SortTh } from "../SortTh.tsx";
import { useAsync } from "../useAsync.ts";
import { useProjects } from "../useProjects.ts";
import { type Accessors, useSort } from "../useSort.ts";

interface ProjectListRow {
  project: IndexedProject;
  /** Absent for a project with no cache-write activity at all — `/api/insights`
   *  only returns cache-active rows (`HAVING SUM(cache_write) > 0`). */
  cache: ProjectCacheRow | undefined;
  /** The portfolio findings scoped to this project (empty for most). */
  findings: PortfolioDiagnostic[];
}

const sortAccessors = (label: (row: ProjectListRow) => string): Accessors<ProjectListRow> => ({
  cost: (r) => r.project.cost,
  tokens: (r) => r.project.ioTokens + r.project.cacheTokens,
  sessions: (r) => r.project.sessions,
  activity: (r) => r.project.lastActivityMs,
  waste: (r) => r.cache?.waste ?? 0,
  findings: (r) => r.findings.length,
  project: label,
});

/**
 * The complete, unpaginated project list — what the Dashboard's "Top
 * projects" table (capped to 15 by cost, sourced from `/api/stats`) links out
 * to for "show me everything". Reuses the shared `useProjects()` cache for
 * identity/cost/tokens, and folds in `/api/insights`' cache-waste and
 * portfolio-diagnostic signals per project — both already single portfolio-
 * wide calls, so this stays one request each rather than one per row.
 */
export function Projects() {
  // Hooks run unconditionally, before either early return below — the table
  // computed here on possibly-empty fallback data during loading/error, same
  // pattern as Project.tsx and Dashboard.tsx.
  const projects = useProjects();
  const insights = useAsync(() => api.insights(), []);
  const [query, setQuery] = useHashParam<string>("q", "");

  const all = projects.data ?? [];
  const insightsProjects = insights.data?.projects;
  const insightsDiagnostics = insights.data?.diagnostics;
  // The join against /api/insights and the root-collision labelling only
  // depend on the two fetches, not on the search query — without this, every
  // keystroke in the filter box below rebuilt both Maps, re-ran labelProjects
  // over the full list, and re-derived every row from scratch.
  const { rows, projectLabel, multiRoot } = useMemo(() => {
    const cacheByProject = new Map((insightsProjects ?? []).map((p) => [p.projectId, p]));
    const findingsByProject = new Map<string, PortfolioDiagnostic[]>();
    for (const d of insightsDiagnostics ?? []) {
      if (!d.projectId) continue;
      const list = findingsByProject.get(d.projectId) ?? [];
      list.push(d);
      findingsByProject.set(d.projectId, list);
    }
    // Only worth naming when more than one Claude data dir is configured —
    // otherwise every project would carry the same redundant path.
    const { label, multiRoot: multi } = labelProjects(
      all,
      (p) => projectDisplayName(p.projectPath, p.projectId),
      (p) => p.claudeDir,
    );
    const built: ProjectListRow[] = all.map((project) => ({
      project,
      cache: cacheByProject.get(project.projectId),
      findings: findingsByProject.get(project.projectId) ?? [],
    }));
    return { rows: built, projectLabel: label, multiRoot: multi };
  }, [all, insightsProjects, insightsDiagnostics]);
  const q = query.toLowerCase();
  const filtered = q ? rows.filter((r) => projectLabel(r.project).toLowerCase().includes(q)) : rows;
  // Recently-active-first, distinct from the Dashboard's cost ranking — this
  // page's job is "find the project I was just in", not "find the priciest".
  const sort = useSort(
    filtered,
    sortAccessors((r) => projectLabel(r.project)),
    "activity",
  );
  const sorted = sort.sorted;

  if (projects.loading) return <LoadingNotice>Loading projects…</LoadingNotice>;
  if (projects.error)
    return (
      <ErrorNotice
        error={String(projects.error)}
        retry={projects.retry}
        label="Couldn’t load the project list."
      />
    );

  return (
    <>
      <header className="top">
        <h1>Projects</h1>
        <span className="muted">
          {sorted.length}
          {q ? `/${rows.length}` : ""} projects
        </span>
      </header>

      <SearchField
        label="Filter Projects"
        placeholder="Filter projects by path…"
        value={query}
        onChange={setQuery}
      />

      {insights.error && (
        <p className="muted">
          Cache-waste and finding columns are unavailable right now ({String(insights.error)}) — the
          rest of the list is unaffected.
        </p>
      )}

      <div className="tablewrap">
        <table>
          <thead>
            <tr>
              <SortTh label="Cost" col="cost" sort={sort} className="num" />
              <SortTh label="Tokens" col="tokens" sort={sort} className="num" />
              <SortTh label="Sessions" col="sessions" sort={sort} className="num" />
              <SortTh label="Last activity" col="activity" sort={sort} />
              <SortTh label="Cache waste" col="waste" sort={sort} className="num" />
              <SortTh label="Findings" col="findings" sort={sort} className="num" />
              <SortTh label="Project" col="project" sort={sort} />
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => (
              <tr key={r.project.projectId}>
                <td className="num">{usd(r.project.cost)}</td>
                <td className="num">{tokens(r.project.ioTokens, r.project.cacheTokens)}</td>
                <td className="num">{r.project.sessions}</td>
                <td className="muted">{relTime(r.project.lastActivityMs)}</td>
                <td className="num">
                  {r.cache ? (
                    <>
                      {usd(r.cache.waste)}{" "}
                      <span className={`verdict ${cacheVerdict(r.cache.ratio)}`}>
                        {r.cache.ratio.toFixed(1)}×
                      </span>
                    </>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
                <td className="num">
                  {r.findings.length > 0 ? (
                    <span title={r.findings.map((f) => f.title).join("\n")}>
                      {count(r.findings.length)}
                    </span>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
                <td>
                  <a href={link.project(r.project.projectId)}>{projectLabel(r.project)}</a>
                  {multiRoot && <span className="muted"> · {r.project.claudeDir}</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {sorted.length === 0 && <EmptyNotice>No projects match this filter.</EmptyNotice>}
    </>
  );
}
