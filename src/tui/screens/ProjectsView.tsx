import type { Database } from "bun:sqlite";
import { Text } from "ink";
import { useMemo, useState } from "react";
import { formatUSD, truncate } from "../../cli/format.ts";
import { labelProjects, projectDisplayName } from "../../core/project-labels.ts";
import type { IndexedProject } from "../../core/queries.ts";
import { projectPreviewStats } from "../../core/stats.ts";
import { FilterableList } from "../components/FilterableList.tsx";
import { ProjectPreview } from "../components/previews.tsx";
import { MasterDetail, masterWidth } from "../shell/MasterDetail.tsx";
import { gutter, selection } from "../theme.ts";
import { type SortField, useSort } from "../useSort.ts";

/** Sort/filter fields; `name` is built per-render against the qualified label
 * (see `labelProjects` below) so a `[root]`-suffixed name sorts and filters
 * exactly as displayed rather than by its unqualified path. */
function sortFields(label: (p: IndexedProject) => string): SortField<IndexedProject>[] {
  return [
    { key: "recent", label: "recent", value: (p) => p.lastActivityMs },
    { key: "cost", label: "cost", value: (p) => p.cost },
    { key: "tokens", label: "tokens", value: (p) => p.ioTokens + p.cacheTokens },
    { key: "sessions", label: "sessions", value: (p) => p.sessions },
    { key: "name", label: "name", value: label },
  ];
}

interface Props {
  projects: IndexedProject[];
  db: Database;
  columns: number;
  pageSize?: number;
  isActive: boolean;
  onOpen: (project: IndexedProject) => void;
  onBack: () => void;
}

/** Projects list (master) driving a live project preview (detail). */
export function ProjectsView({ projects, db, columns, pageSize, isActive, onOpen, onBack }: Props) {
  // Two Claude roots can each hold a project for the same working directory, so
  // the labels would be byte-identical. The shared labeller qualifies only the
  // ones that actually collide.
  const { label } = useMemo(
    () =>
      labelProjects(
        projects,
        (p) => projectDisplayName(p.projectPath, p.projectId),
        (p) => p.claudeDir,
      ),
    [projects],
  );
  const sort = useSort(useMemo(() => sortFields(label), [label]));
  const rows = sort.sorted(projects);
  const [highlighted, setHighlighted] = useState<IndexedProject | undefined>(rows[0]);
  // Data acquisition stays at the screen boundary: the preview receives plain
  // props. Keyed on the stable projectId string (not the row object) so a
  // future parent that recreates project rows can't defeat the memo.
  const highlightedId = highlighted?.projectId;
  const previewStats = useMemo(
    () => (highlightedId ? projectPreviewStats(db, highlightedId) : undefined),
    [db, highlightedId],
  );
  // Master rows are a lean index (cost + name); full stats live in the preview.
  const nameW = Math.max(10, masterWidth(columns) - 15);

  return (
    <MasterDetail
      columns={columns}
      master={
        <FilterableList
          items={rows}
          isActive={isActive}
          pageSize={pageSize}
          onSelect={onOpen}
          onBack={onBack}
          onHighlight={setHighlighted}
          sortLabel={sort.label}
          onCycleSort={sort.cycle}
          onReverseSort={sort.reverse}
          filterText={label}
          renderItem={(p, sel) => (
            <Text {...selection(sel)}>
              {gutter(sel)}
              {formatUSD(p.cost).padStart(9)} {truncate(label(p), nameW)}
            </Text>
          )}
        />
      }
      detail={<ProjectPreview project={highlighted} stats={previewStats} />}
    />
  );
}
