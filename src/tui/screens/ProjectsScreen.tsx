import { Box, Text } from "ink";
import {
  formatCount,
  formatRelativeTime,
  formatTokens,
  formatUSD,
  truncate,
} from "../../cli/format.ts";
import type { IndexedProject } from "../../core/queries.ts";
import { FilterableList } from "../components/FilterableList.tsx";
import { Footer, ScreenHeader } from "../components/ui.tsx";
import { type SortField, useSort } from "../useSort.ts";

interface Props {
  projects: IndexedProject[];
  onOpen: (project: IndexedProject) => void;
  onBack: () => void;
  isActive: boolean;
}

const SORT_FIELDS: SortField<IndexedProject>[] = [
  { key: "recent", label: "recent", value: (p) => p.lastActivityMs },
  { key: "cost", label: "cost", value: (p) => p.cost },
  { key: "tokens", label: "tokens", value: (p) => p.ioTokens + p.cacheTokens },
  { key: "sessions", label: "sessions", value: (p) => p.sessions },
  { key: "name", label: "name", value: (p) => p.projectPath ?? p.projectId },
];

export function ProjectsScreen({ projects, onOpen, onBack, isActive }: Props) {
  const sort = useSort(SORT_FIELDS);
  const rows = sort.sorted(projects);
  return (
    <Box flexDirection="column">
      <ScreenHeader
        title={`Projects (${projects.length}) · ${formatUSD(
          projects.reduce((s, p) => s + p.cost, 0),
        )} · ${formatCount(projects.reduce((s, p) => s + p.sessions, 0))} sessions`}
        subtitle="cost · tokens · sessions · last active · path"
      />
      <FilterableList
        items={rows}
        isActive={isActive}
        onSelect={onOpen}
        onBack={onBack}
        sortLabel={sort.label}
        onCycleSort={sort.cycle}
        onReverseSort={sort.reverse}
        filterText={(p) => p.projectPath ?? p.projectId}
        renderItem={(p, selected) => (
          <Text
            color={selected ? "black" : undefined}
            backgroundColor={selected ? "cyan" : undefined}
          >
            {formatUSD(p.cost).padStart(9)} {formatTokens(p.ioTokens, p.cacheTokens).padStart(18)}{" "}
            {String(p.sessions).padStart(5)}
            {"  "}
            {formatRelativeTime(p.lastActivityMs).padEnd(10)}
            {"  "}
            {truncate(p.projectPath ?? p.projectId, 48)}
          </Text>
        )}
      />
      <Footer hints="type filter · tab sort · ↑/↓ move · enter open" />
    </Box>
  );
}
