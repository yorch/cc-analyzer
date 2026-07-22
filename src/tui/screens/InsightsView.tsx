import type { Database } from "bun:sqlite";
import { Box, Text } from "ink";
import { useMemo, useState } from "react";
import { formatUSD, truncate } from "../../cli/format.ts";
import {
  type CacheMetrics,
  cacheSummary,
  cacheVerdict,
  cacheWasteByProject,
  cacheWasteBySession,
  type ProjectCacheRow,
  type SessionCacheRow,
} from "../../core/stats.ts";
import { FilterableList } from "../components/FilterableList.tsx";
import { CachePreview } from "../components/previews.tsx";
import { MasterDetail, masterWidth } from "../shell/MasterDetail.tsx";
import { gutter, palette, role, selection, VERDICT_COLOR } from "../theme.ts";
import { type SortField, useSort } from "../useSort.ts";

const PROJECT_SORT: SortField<ProjectCacheRow>[] = [
  { key: "waste", label: "waste", value: (r) => r.waste },
  { key: "ratio", label: "ratio", value: (r) => r.ratio },
  { key: "write", label: "write$", value: (r) => r.writeCost },
  { key: "name", label: "name", value: (r) => r.projectPath ?? r.projectId },
];
const SESSION_SORT: SortField<SessionCacheRow>[] = [
  { key: "waste", label: "waste", value: (r) => r.waste },
  { key: "ratio", label: "ratio", value: (r) => r.ratio },
  { key: "write", label: "write$", value: (r) => r.writeCost },
  { key: "title", label: "title", value: (r) => r.title ?? r.sessionId ?? "" },
];

interface Props {
  db: Database;
  columns: number;
  pageSize: number;
  isActive: boolean;
  /** Open a session's full detail by id. */
  onOpenSession: (sessionId: string) => void;
  /** Called on esc from the top-level project list (focus the rail). */
  onBack: () => void;
}

/**
 * Cache-efficiency hit-list: projects ranked by un-amortized cache-write $,
 * drilling into a project's sessions. Self-contained two-level drill (like the
 * detail screen) so App only routes to it.
 */
export function InsightsView({ db, columns, pageSize, isActive, onOpenSession, onBack }: Props) {
  const summary = useMemo(() => cacheSummary(db), [db]);
  const projects = useMemo(() => cacheWasteByProject(db), [db]);
  const [drilled, setDrilled] = useState<ProjectCacheRow | null>(null);
  const sessions = useMemo(
    () => (drilled ? cacheWasteBySession(db, drilled.projectId) : []),
    [db, drilled],
  );

  const listSize = Math.max(3, pageSize - 1); // reserve the summary header line
  const wastePct =
    summary.totalCost > 0 ? Math.round((summary.waste / summary.totalCost) * 100) : 0;

  const header = (
    <Text color={role.muted}>
      cache: <Text color={role.body}>{formatUSD(summary.writeCost)}</Text> written ·{" "}
      <Text color={role.cost}>{formatUSD(summary.waste)}</Text> un-amortized · {wastePct}% of spend
    </Text>
  );

  if (drilled) {
    return (
      <Box flexDirection="column">
        {header}
        <CacheHitList
          key={`sessions-${drilled.projectId}`}
          items={sessions}
          columns={columns}
          pageSize={listSize}
          isActive={isActive}
          sortFields={SESSION_SORT}
          filterText={(s) => `${s.title ?? ""} ${s.sessionId ?? ""}`}
          label={(s) => s.title ?? s.sessionId ?? "(untitled)"}
          previewTitle={(s) => s.title ?? s.sessionId ?? "(untitled)"}
          previewHint="↵ open full session"
          onOpen={(s) => {
            if (s.sessionId) onOpenSession(s.sessionId);
          }}
          onBack={() => setDrilled(null)}
        />
      </Box>
    );
  }

  if (projects.length === 0) {
    return (
      <Box flexDirection="column">
        {header}
        <Box marginTop={1}>
          <Text color={role.muted}>No cache activity in the index.</Text>
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      {header}
      <CacheHitList
        key="projects"
        items={projects}
        columns={columns}
        pageSize={listSize}
        isActive={isActive}
        sortFields={PROJECT_SORT}
        filterText={(p) => p.projectPath ?? p.projectId}
        label={(p) => p.projectPath ?? p.projectId}
        previewTitle={(p) => p.projectPath ?? p.projectId}
        previewHint="↵ break down this project's sessions"
        onOpen={setDrilled}
        onBack={onBack}
      />
    </Box>
  );
}

/** Shared ranked-by-waste master list + cache preview, for projects or sessions. */
function CacheHitList<T extends CacheMetrics>({
  items,
  columns,
  pageSize,
  isActive,
  sortFields,
  filterText,
  label,
  previewTitle,
  previewHint,
  onOpen,
  onBack,
}: {
  items: T[];
  columns: number;
  pageSize: number;
  isActive: boolean;
  sortFields: SortField<T>[];
  filterText: (item: T) => string;
  label: (item: T) => string;
  previewTitle: (item: T) => string;
  previewHint: string;
  onOpen: (item: T) => void;
  onBack: () => void;
}) {
  const sort = useSort(sortFields);
  const rows = sort.sorted(items);
  const [highlighted, setHighlighted] = useState<T | undefined>(rows[0]);
  const nameW = Math.max(10, masterWidth(columns) - 22);

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
          filterText={filterText}
          renderItem={(r, sel) => (
            <Text {...selection(sel)}>
              {gutter(sel)}
              {formatUSD(r.waste).padStart(8)} {`${r.ratio.toFixed(1)}×`.padStart(6)}{" "}
              <Text color={sel ? palette.bg : VERDICT_COLOR[cacheVerdict(r.ratio)]}>●</Text>{" "}
              {truncate(label(r), nameW)}
            </Text>
          )}
        />
      }
      detail={
        <CachePreview
          title={highlighted ? previewTitle(highlighted) : ""}
          row={highlighted}
          hint={previewHint}
        />
      }
    />
  );
}
