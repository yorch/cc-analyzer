import type { Database } from "bun:sqlite";
import { Box, Text } from "ink";
import { useMemo, useState } from "react";
import type { PricingTable } from "../core/pricing.ts";
import {
  type IndexedProject,
  type IndexedSession,
  indexedSessionById,
  listAllSessions,
  listIndexedProjects,
  listIndexedSessions,
} from "../core/queries.ts";
import { DashboardScreen } from "./screens/DashboardScreen.tsx";
import { ProjectsScreen } from "./screens/ProjectsScreen.tsx";
import { SearchScreen } from "./screens/SearchScreen.tsx";
import { SessionDetailScreen } from "./screens/SessionDetailScreen.tsx";
import { SessionsScreen } from "./screens/SessionsScreen.tsx";

interface Props {
  db: Database;
  pricing: PricingTable;
}

type Nav =
  | { screen: "dashboard" }
  | { screen: "projects" }
  | { screen: "search" }
  | { screen: "sessions"; project: IndexedProject; sessions: IndexedSession[] }
  | { screen: "detail"; session: IndexedSession };

export function App({ db, pricing }: Props) {
  const projects = useMemo(() => listIndexedProjects(db), [db]);
  const allSessions = useMemo(() => listAllSessions(db), [db]);
  const [stack, setStack] = useState<Nav[]>([{ screen: "dashboard" }]);

  const push = (nav: Nav) => setStack((s) => [...s, nav]);
  const back = () => setStack((s) => (s.length > 1 ? s.slice(0, -1) : s));

  const openProjectSessions = (project: IndexedProject) =>
    push({ screen: "sessions", project, sessions: listIndexedSessions(db, project.projectId) });

  if (projects.length === 0) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text color="yellow">The index is empty.</Text>
        <Text>
          Run <Text color="cyan">cc-analyzer index</Text> first, then relaunch.
        </Text>
        <Text dimColor>Press ctrl-c to quit.</Text>
      </Box>
    );
  }

  const nav = stack[stack.length - 1] as Nav;

  return (
    <Box flexDirection="column" padding={1}>
      {nav.screen === "dashboard" && (
        <DashboardScreen
          db={db}
          isActive
          onBack={() => {}}
          onOpenProjects={() => push({ screen: "projects" })}
          onOpenSearch={() => push({ screen: "search" })}
          onOpenProject={(projectId) => {
            const project = projects.find((p) => p.projectId === projectId);
            if (project) openProjectSessions(project);
          }}
          onOpenSession={(sessionId) => {
            const session = indexedSessionById(db, sessionId);
            if (session) push({ screen: "detail", session });
          }}
        />
      )}
      {nav.screen === "projects" && (
        <ProjectsScreen projects={projects} isActive onBack={back} onOpen={openProjectSessions} />
      )}
      {nav.screen === "search" && (
        <SearchScreen
          sessions={allSessions}
          isActive
          onBack={back}
          onOpen={(session) => push({ screen: "detail", session })}
        />
      )}
      {nav.screen === "sessions" && (
        <SessionsScreen
          project={nav.project}
          sessions={nav.sessions}
          isActive
          onBack={back}
          onOpen={(session) => push({ screen: "detail", session })}
        />
      )}
      {nav.screen === "detail" && (
        <SessionDetailScreen session={nav.session} pricing={pricing} isActive onBack={back} />
      )}
    </Box>
  );
}
