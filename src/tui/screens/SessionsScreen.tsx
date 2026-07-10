import { Box, Text } from "ink";
import { formatRelativeTime, formatUSD, truncate } from "../../cli/format.ts";
import type { IndexedProject, IndexedSession } from "../../core/queries.ts";
import { SelectList } from "../components/SelectList.tsx";

interface Props {
  project: IndexedProject;
  sessions: IndexedSession[];
  onOpen: (session: IndexedSession) => void;
  isActive: boolean;
}

export function SessionsScreen({ project, sessions, onOpen, isActive }: Props) {
  return (
    <Box flexDirection="column">
      <Text bold color="cyan">
        {truncate(project.projectPath ?? project.projectId, 70)}
      </Text>
      <Box marginBottom={1}>
        <Text dimColor>{sessions.length} sessions · cost · modified · title</Text>
      </Box>
      <SelectList
        items={sessions}
        isActive={isActive}
        onSelect={onOpen}
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
        <Text dimColor>↑/↓ move · enter open · esc back · q quit</Text>
      </Box>
    </Box>
  );
}
