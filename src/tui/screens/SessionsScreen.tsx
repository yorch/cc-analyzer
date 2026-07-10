import { Box, Text } from "ink";
import { formatRelativeTime, formatUSD, truncate } from "../../cli/format.ts";
import type { IndexedProject, IndexedSession } from "../../core/queries.ts";
import { FilterableList } from "../components/FilterableList.tsx";

interface Props {
  project: IndexedProject;
  sessions: IndexedSession[];
  onOpen: (session: IndexedSession) => void;
  onBack: () => void;
  isActive: boolean;
}

export function SessionsScreen({ project, sessions, onOpen, onBack, isActive }: Props) {
  return (
    <Box flexDirection="column">
      <Text bold color="cyan">
        {truncate(project.projectPath ?? project.projectId, 70)}
      </Text>
      <Box marginBottom={1}>
        <Text dimColor>{sessions.length} sessions · cost · modified · title</Text>
      </Box>
      <FilterableList
        items={sessions}
        isActive={isActive}
        onSelect={onOpen}
        onBack={onBack}
        filterText={(s) => `${s.title ?? ""} ${s.sessionId ?? ""}`}
        renderItem={(s, selected) => (
          <Text
            color={selected ? "black" : undefined}
            backgroundColor={selected ? "cyan" : undefined}
          >
            {formatUSD(s.cost).padStart(9)}
            {s.costEstimated ? "~" : " "} {formatRelativeTime(s.mtimeMs).padEnd(10)}
            {"  "}
            {truncate(s.title ?? s.sessionId ?? "(untitled)", 55)}
          </Text>
        )}
      />
      <Box marginTop={1}>
        <Text dimColor>type filter · ↑/↓ move · enter open · esc back · ctrl-c quit</Text>
      </Box>
    </Box>
  );
}
