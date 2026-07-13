import type { Database } from "bun:sqlite";
import { Box, Text, useInput } from "ink";
import { useMemo, useState } from "react";
import { truncate } from "../cli/format.ts";
import type { PricingTable } from "../core/pricing.ts";
import {
  type IndexedProject,
  type IndexedSession,
  listAllSessions,
  listIndexedProjects,
  listIndexedSessions,
} from "../core/queries.ts";
import { portfolioSummary, spendByMonth } from "../core/stats.ts";
import { PortfolioLede } from "./components/PortfolioLede.tsx";
import { HelpOverlay } from "./components/ui.tsx";
import { ProjectsView } from "./screens/ProjectsView.tsx";
import { SessionDetailScreen } from "./screens/SessionDetailScreen.tsx";
import { SessionListView } from "./screens/SessionListView.tsx";
import { AppShell, type NavEntry } from "./shell/AppShell.tsx";
import { role } from "./theme.ts";
import { useTermSize } from "./useTermSize.ts";

interface Props {
  db: Database;
  pricing: PricingTable;
}

type View = "portfolio" | "projects" | "sessions" | "insights" | "trends";
const VIEW_KEYS: View[] = ["portfolio", "projects", "sessions", "insights", "trends"];
const RAIL: NavEntry[] = [
  { key: "portfolio", label: "portfolio", icon: "▤" },
  { key: "projects", label: "projects", icon: "▸" },
  { key: "sessions", label: "sessions", icon: "≡" },
  { key: "insights", label: "insights", icon: "◈", soon: true },
  { key: "trends", label: "trends", icon: "∿", soon: true },
];

export function App({ db, pricing }: Props) {
  const projects = useMemo(() => listIndexedProjects(db), [db]);
  const allSessions = useMemo(() => listAllSessions(db), [db]);
  const summary = useMemo(() => portfolioSummary(db), [db]);
  const months = useMemo(() => spendByMonth(db), [db]);
  const { columns, rows } = useTermSize();

  const [view, setView] = useState<View>("portfolio");
  const [focus, setFocus] = useState<"rail" | "body">("body");
  const [drill, setDrill] = useState<IndexedProject | null>(null);
  const [drillSessions, setDrillSessions] = useState<IndexedSession[]>([]);
  const [openSession, setOpenSession] = useState<IndexedSession | null>(null);
  const [help, setHelp] = useState(false);

  const moveView = (delta: number) => {
    const idx = VIEW_KEYS.indexOf(view);
    const next = VIEW_KEYS[Math.max(0, Math.min(idx + delta, VIEW_KEYS.length - 1))];
    if (next) setView(next);
  };

  useInput(
    (input, key) => {
      if (input === "?") return setHelp(true);
      if (focus !== "rail") return; // body focus: the active view owns input
      if (key.upArrow) return moveView(-1);
      if (key.downArrow) return moveView(1);
      if (key.return || key.rightArrow || key.escape || key.leftArrow) return setFocus("body");
      const n = "12345".indexOf(input);
      if (n >= 0) {
        setView(VIEW_KEYS[n] as View);
        setFocus("body");
      }
    },
    { isActive: !help && !openSession },
  );

  if (projects.length === 0) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text color={role.heading}>The index is empty.</Text>
        <Text color={role.body}>
          Run <Text color={role.accent}>cc-analyzer index</Text> first, then relaunch.
        </Text>
        <Text color={role.muted}>Press ctrl-c to quit.</Text>
      </Box>
    );
  }

  if (help) {
    return (
      <Box flexDirection="column" padding={1}>
        <HelpOverlay isActive onClose={() => setHelp(false)} />
      </Box>
    );
  }

  if (openSession) {
    return (
      <Box flexDirection="column" padding={1}>
        <SessionDetailScreen
          session={openSession}
          pricing={pricing}
          isActive
          columns={columns}
          rows={rows}
          onBack={() => setOpenSession(null)}
        />
      </Box>
    );
  }

  const bodyActive = focus === "body";
  const focusRail = () => setFocus("rail");
  const openProject = (p: IndexedProject) => {
    setDrill(p);
    setDrillSessions(listIndexedSessions(db, p.projectId));
    setFocus("body");
  };
  const popDrill = () => {
    setDrill(null);
    setDrillSessions([]);
  };

  const showLede = view === "portfolio" && !drill;
  // Rows the master list may render: terminal height minus the fixed shell
  // chrome (title/lede/margins/key bar) and the list's own header + scroll
  // indicator. Keeps content within the pinned viewport so it never overflows.
  const listPageSize = Math.max(3, rows - 9 - (showLede ? 2 : 0));

  const breadcrumb = drill
    ? `projects ▸ ${truncate(drill.projectPath ?? drill.projectId, 40)}`
    : view;

  const keyHints =
    focus === "rail"
      ? "↑↓ switch view · ↵ focus list · 1-5 jump"
      : drill
        ? "type filter · tab sort · ↑↓ move · ↵ open · esc back"
        : view === "insights" || view === "trends"
          ? "esc menu"
          : "type filter · tab sort · ↑↓ move · ↵ open · esc menu";

  let body: React.ReactNode;
  if (drill) {
    body = (
      <SessionListView
        sessions={drillSessions}
        columns={columns}
        pageSize={listPageSize}
        isActive={bodyActive}
        onOpen={setOpenSession}
        onBack={popDrill}
      />
    );
  } else if (view === "portfolio" || view === "projects") {
    body = (
      <ProjectsView
        projects={projects}
        columns={columns}
        pageSize={listPageSize}
        isActive={bodyActive}
        onOpen={openProject}
        onBack={focusRail}
      />
    );
  } else if (view === "sessions") {
    body = (
      <SessionListView
        sessions={allSessions}
        columns={columns}
        pageSize={listPageSize}
        isActive={bodyActive}
        showProject
        onOpen={setOpenSession}
        onBack={focusRail}
      />
    );
  } else {
    body = <Placeholder label={view === "insights" ? "Insights" : "Trends"} />;
  }

  return (
    <Box flexDirection="column" padding={1}>
      <AppShell
        breadcrumb={breadcrumb}
        entries={RAIL}
        active={view}
        keyHints={keyHints}
        columns={columns}
        rows={rows}
        railFocused={focus === "rail"}
        lede={showLede ? <PortfolioLede summary={summary} months={months} /> : undefined}
      >
        {body}
      </AppShell>
    </Box>
  );
}

function Placeholder({ label }: { label: string }) {
  return (
    <Box flexDirection="column">
      <Text color={role.heading}>{label}</Text>
      <Text color={role.muted}>Coming in a later phase of the TUI revamp.</Text>
    </Box>
  );
}
