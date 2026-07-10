import type { Database } from "bun:sqlite";
import { Box, Text, useApp, useInput } from "ink";
import { useMemo, useState } from "react";
import type { PricingTable } from "../core/pricing.ts";
import {
  type IndexedProject,
  type IndexedSession,
  listIndexedProjects,
  listIndexedSessions,
} from "../core/queries.ts";
import { ProjectsScreen } from "./screens/ProjectsScreen.tsx";
import { SessionDetailScreen } from "./screens/SessionDetailScreen.tsx";
import { SessionsScreen } from "./screens/SessionsScreen.tsx";

interface Props {
  db: Database;
  pricing: PricingTable;
}

type Nav =
  | { screen: "projects" }
  | { screen: "sessions"; project: IndexedProject; sessions: IndexedSession[] }
  | {
      screen: "detail";
      project: IndexedProject;
      sessions: IndexedSession[];
      session: IndexedSession;
    };

export function App({ db, pricing }: Props) {
  const { exit } = useApp();
  const projects = useMemo(() => listIndexedProjects(db), [db]);
  const [nav, setNav] = useState<Nav>({ screen: "projects" });

  useInput((input, key) => {
    if (input === "q") exit();
    else if (key.escape || key.backspace || input === "h") {
      setNav((n) => {
        if (n.screen === "detail")
          return { screen: "sessions", project: n.project, sessions: n.sessions };
        if (n.screen === "sessions") return { screen: "projects" };
        return n;
      });
    }
  });

  if (projects.length === 0) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text color="yellow">The index is empty.</Text>
        <Text>
          Run <Text color="cyan">cc-analyzer index</Text> first, then relaunch.
        </Text>
        <Text dimColor>Press q to quit.</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" padding={1}>
      {nav.screen === "projects" && (
        <ProjectsScreen
          projects={projects}
          isActive
          onOpen={(project) =>
            setNav({
              screen: "sessions",
              project,
              sessions: listIndexedSessions(db, project.projectId),
            })
          }
        />
      )}
      {nav.screen === "sessions" && (
        <SessionsScreen
          project={nav.project}
          sessions={nav.sessions}
          isActive
          onOpen={(session) =>
            setNav({ screen: "detail", project: nav.project, sessions: nav.sessions, session })
          }
        />
      )}
      {nav.screen === "detail" && (
        <SessionDetailScreen session={nav.session} pricing={pricing} isActive />
      )}
    </Box>
  );
}
