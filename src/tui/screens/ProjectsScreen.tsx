import { Box, Text } from "ink";
import { formatCount, formatRelativeTime, formatUSD, truncate } from "../../cli/format.ts";
import type { IndexedProject } from "../../core/queries.ts";
import { SelectList } from "../components/SelectList.tsx";

interface Props {
  projects: IndexedProject[];
  onOpen: (project: IndexedProject) => void;
  isActive: boolean;
}

export function ProjectsScreen({ projects, onOpen, isActive }: Props) {
  return (
    <Box flexDirection="column">
      <Text bold color="cyan">
        Projects ({projects.length})
      </Text>
      <Box marginBottom={1}>
        <Text dimColor>cost · sessions · last active · path</Text>
      </Box>
      <SelectList
        items={projects}
        isActive={isActive}
        onSelect={onOpen}
        renderItem={(p, selected) => (
          <Text
            color={selected ? "black" : undefined}
            backgroundColor={selected ? "cyan" : undefined}
          >
            {formatUSD(p.cost).padStart(9)} {String(p.sessions).padStart(5)}
            {"  "}
            {formatRelativeTime(p.lastActivityMs).padEnd(10)}
            {"  "}
            {truncate(p.projectPath ?? p.projectId, 60)}
          </Text>
        )}
      />
      <Box marginTop={1}>
        <Text dimColor>↑/↓ move · enter open · q quit</Text>
      </Box>
      <Text> </Text>
      <Text dimColor>
        total {formatUSD(projects.reduce((s, p) => s + p.cost, 0))} across{" "}
        {formatCount(projects.reduce((s, p) => s + p.sessions, 0))} sessions
      </Text>
    </Box>
  );
}
