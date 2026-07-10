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

interface Props {
  projects: IndexedProject[];
  onOpen: (project: IndexedProject) => void;
  onBack: () => void;
  isActive: boolean;
}

export function ProjectsScreen({ projects, onOpen, onBack, isActive }: Props) {
  return (
    <Box flexDirection="column">
      <Text bold color="cyan">
        Projects ({projects.length}) · {formatUSD(projects.reduce((s, p) => s + p.cost, 0))} ·{" "}
        {formatCount(projects.reduce((s, p) => s + p.sessions, 0))} sessions
      </Text>
      <Box marginBottom={1}>
        <Text dimColor>cost · tokens · sessions · last active · path</Text>
      </Box>
      <FilterableList
        items={projects}
        isActive={isActive}
        onSelect={onOpen}
        onBack={onBack}
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
      <Box marginTop={1}>
        <Text dimColor>type filter · ↑/↓ move · enter open · ctrl-c quit</Text>
      </Box>
    </Box>
  );
}
