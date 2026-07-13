import { Text } from "ink";
import { useState } from "react";
import { formatRelativeTime, formatUSD, truncate } from "../../cli/format.ts";
import type { IndexedSession, SessionWithProject } from "../../core/queries.ts";
import { FilterableList } from "../components/FilterableList.tsx";
import { SessionPreview } from "../components/previews.tsx";
import { MasterDetail, masterWidth } from "../shell/MasterDetail.tsx";
import { gutter, selection } from "../theme.ts";
import { type SortField, useSort } from "../useSort.ts";

const SORT_FIELDS: SortField<IndexedSession>[] = [
  { key: "recent", label: "recent", value: (s) => s.mtimeMs },
  { key: "cost", label: "cost", value: (s) => s.cost },
  { key: "tokens", label: "tokens", value: (s) => s.ioTokens + s.cacheTokens },
  { key: "title", label: "title", value: (s) => s.title ?? s.sessionId ?? "" },
];

interface Props<T extends IndexedSession> {
  sessions: T[];
  columns: number;
  pageSize?: number;
  isActive: boolean;
  onOpen: (session: T) => void;
  onBack: () => void;
  /** Show the owning project path in the row and filter (all-sessions view). */
  showProject?: boolean;
}

/** Sessions list (master) driving a live session preview (detail). Shared by
 * the all-sessions rail view and a single project's drilled-in session list. */
export function SessionListView<T extends IndexedSession>({
  sessions,
  columns,
  pageSize,
  isActive,
  onOpen,
  onBack,
  showProject = false,
}: Props<T>) {
  const sort = useSort(SORT_FIELDS as SortField<T>[]);
  const rows = sort.sorted(sessions);
  const [highlighted, setHighlighted] = useState<T | undefined>(rows[0]);
  // Project (when relevant) stays searchable but shows in the preview, not the
  // row, so the lean master row fits without wrapping.
  const projectOf = (s: T): string =>
    showProject && "projectPath" in s ? ((s as SessionWithProject).projectPath ?? "") : "";
  const titleW = Math.max(8, masterWidth(columns) - 24);

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
          filterText={(s) => `${s.title ?? ""} ${s.sessionId ?? ""} ${projectOf(s)}`}
          renderItem={(s, sel) => (
            <Text {...selection(sel)}>
              {gutter(sel)}
              {formatUSD(s.cost).padStart(9)}
              {s.costEstimated ? "~" : " "}
              {formatRelativeTime(s.mtimeMs).padEnd(8)}{" "}
              {truncate(s.title ?? s.sessionId ?? "(untitled)", titleW)}
            </Text>
          )}
        />
      }
      detail={<SessionPreview session={highlighted} />}
    />
  );
}
