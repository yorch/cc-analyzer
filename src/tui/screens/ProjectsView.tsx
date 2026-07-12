import { Text } from "ink";
import { useState } from "react";
import { formatUSD, truncate } from "../../cli/format.ts";
import type { IndexedProject } from "../../core/queries.ts";
import { FilterableList } from "../components/FilterableList.tsx";
import { ProjectPreview } from "../components/previews.tsx";
import { MasterDetail, masterWidth } from "../shell/MasterDetail.tsx";
import { gutter, selection } from "../theme.ts";
import { type SortField, useSort } from "../useSort.ts";

const SORT_FIELDS: SortField<IndexedProject>[] = [
  { key: "recent", label: "recent", value: (p) => p.lastActivityMs },
  { key: "cost", label: "cost", value: (p) => p.cost },
  { key: "tokens", label: "tokens", value: (p) => p.ioTokens + p.cacheTokens },
  { key: "sessions", label: "sessions", value: (p) => p.sessions },
  { key: "name", label: "name", value: (p) => p.projectPath ?? p.projectId },
];

interface Props {
  projects: IndexedProject[];
  columns: number;
  isActive: boolean;
  onOpen: (project: IndexedProject) => void;
  onBack: () => void;
}

/** Projects list (master) driving a live project preview (detail). */
export function ProjectsView({ projects, columns, isActive, onOpen, onBack }: Props) {
  const sort = useSort(SORT_FIELDS);
  const rows = sort.sorted(projects);
  const [highlighted, setHighlighted] = useState<IndexedProject | undefined>(rows[0]);
  // Master rows are a lean index (cost + name); full stats live in the preview.
  const nameW = Math.max(10, masterWidth(columns) - 15);

  return (
    <MasterDetail
      columns={columns}
      master={
        <FilterableList
          items={rows}
          isActive={isActive}
          onSelect={onOpen}
          onBack={onBack}
          onHighlight={setHighlighted}
          sortLabel={sort.label}
          onCycleSort={sort.cycle}
          onReverseSort={sort.reverse}
          filterText={(p) => p.projectPath ?? p.projectId}
          renderItem={(p, sel) => (
            <Text {...selection(sel)}>
              {gutter(sel)}
              {formatUSD(p.cost).padStart(9)} {truncate(p.projectPath ?? p.projectId, nameW)}
            </Text>
          )}
        />
      }
      detail={<ProjectPreview project={highlighted} />}
    />
  );
}
