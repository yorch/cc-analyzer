import { Box, Text } from "ink";
import { formatRelativeTime, formatTokens, formatUSD, truncate } from "../../cli/format.ts";
import type { IndexedProject, IndexedSession } from "../../core/queries.ts";
import { FilterableList } from "../components/FilterableList.tsx";
import { type SortField, useSort } from "../useSort.ts";

interface Props {
  project: IndexedProject;
  sessions: IndexedSession[];
  onOpen: (session: IndexedSession) => void;
  onBack: () => void;
  isActive: boolean;
}

const SORT_FIELDS: SortField<IndexedSession>[] = [
  { key: "recent", label: "recent", value: (s) => s.mtimeMs },
  { key: "cost", label: "cost", value: (s) => s.cost },
  { key: "tokens", label: "tokens", value: (s) => s.ioTokens + s.cacheTokens },
  { key: "title", label: "title", value: (s) => s.title ?? s.sessionId ?? "" },
];

export function SessionsScreen({ project, sessions, onOpen, onBack, isActive }: Props) {
  const sort = useSort(SORT_FIELDS);
  const rows = sort.sorted(sessions);
  return (
    <Box flexDirection="column">
      <Text bold color="cyan">
        {truncate(project.projectPath ?? project.projectId, 70)}
      </Text>
      <Box marginBottom={1}>
        <Text dimColor>{sessions.length} sessions · cost · tokens · modified · title</Text>
      </Box>
      <FilterableList
        items={rows}
        isActive={isActive}
        onSelect={onOpen}
        onBack={onBack}
        sortLabel={sort.label}
        onCycleSort={sort.cycle}
        onReverseSort={sort.reverse}
        filterText={(s) => `${s.title ?? ""} ${s.sessionId ?? ""}`}
        renderItem={(s, selected) => (
          <Text
            color={selected ? "black" : undefined}
            backgroundColor={selected ? "cyan" : undefined}
          >
            {formatUSD(s.cost).padStart(9)}
            {s.costEstimated ? "~" : " "}
            {formatTokens(s.ioTokens, s.cacheTokens).padStart(18)}{" "}
            {formatRelativeTime(s.mtimeMs).padEnd(10)}
            {"  "}
            {truncate(s.title ?? s.sessionId ?? "(untitled)", 42)}
          </Text>
        )}
      />
      <Box marginTop={1}>
        <Text dimColor>type filter · ↑/↓ move · enter open · esc back · ctrl-c quit</Text>
      </Box>
    </Box>
  );
}
