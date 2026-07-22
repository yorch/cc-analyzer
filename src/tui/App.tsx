import type { Database } from "bun:sqlite";
import { Box, Text, useInput } from "ink";
import { useMemo, useState } from "react";
import { truncate } from "../cli/format.ts";
import type { PricingTable } from "../core/pricing.ts";
import {
  type IndexedProject,
  type IndexedSession,
  indexedSessionById,
  listAllSessions,
  listIndexedProjects,
  listIndexedSessions,
} from "../core/queries.ts";
import {
  costDistribution,
  durationSummary,
  localDayOfMs,
  portfolioSummary,
  spendByMonth,
  streaks,
} from "../core/stats.ts";
import { PortfolioLede } from "./components/PortfolioLede.tsx";
import { HelpOverlay } from "./components/ui.tsx";
import { keyIndex } from "./keys.ts";
import { InsightsView } from "./screens/InsightsView.tsx";
import { ProjectsView } from "./screens/ProjectsView.tsx";
import { SessionDetailScreen } from "./screens/SessionDetailScreen.tsx";
import { SessionListView } from "./screens/SessionListView.tsx";
import { ToolsView } from "./screens/ToolsView.tsx";
import { TrendsView } from "./screens/TrendsView.tsx";
import { AppShell, type NavEntry } from "./shell/AppShell.tsx";
import { role } from "./theme.ts";
import { useTermSize } from "./useTermSize.ts";

interface Props {
  db: Database;
  pricing: PricingTable;
}

type View = "portfolio" | "projects" | "sessions" | "insights" | "trends" | "tools";
const VIEW_KEYS: View[] = ["portfolio", "projects", "sessions", "insights", "trends", "tools"];
const RAIL: NavEntry[] = [
  { key: "portfolio", label: "portfolio", icon: "▤" },
  { key: "projects", label: "projects", icon: "▸" },
  { key: "sessions", label: "sessions", icon: "≡" },
  { key: "insights", label: "insights", icon: "◈" },
  { key: "trends", label: "trends", icon: "∿" },
  { key: "tools", label: "tools", icon: "⚒" },
];

export function App({ db, pricing }: Props) {
  const projects = useMemo(() => listIndexedProjects(db), [db]);
  const allSessions = useMemo(() => listAllSessions(db), [db]);
  const summary = useMemo(() => portfolioSummary(db), [db]);
  const months = useMemo(() => spendByMonth(db), [db]);
  const duration = useMemo(() => durationSummary(db), [db]);
  const distribution = useMemo(() => costDistribution(db), [db]);
  const streakInfo = useMemo(() => streaks(db, localDayOfMs(Date.now())), [db]);
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
      const n = keyIndex("123456", input);
      if (n >= 0) {
        setView(VIEW_KEYS[n] as View);
        setFocus("body");
      }
    },
    // Active even while a session is open so `?` still opens help there; the
    // rail keys are unreachable in that state (focus is "body").
    { isActive: !help },
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
  const openSessionById = (id: string) => {
    const session = indexedSessionById(db, id);
    if (session) setOpenSession(session);
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
      ? "↑↓ switch view · ↵ focus list · 1-6 jump"
      : drill
        ? "type filter · tab sort · ↑↓ move · ↵ open · esc back"
        : view === "trends"
          ? "tab/1·2 panel · m metric · g granularity · esc menu"
          : view === "tools"
            ? "tab/1·2·3 panel · s sort · ↑↓ scroll · esc menu"
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
        db={db}
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
  } else if (view === "insights") {
    body = (
      <InsightsView
        db={db}
        columns={columns}
        pageSize={listPageSize}
        isActive={bodyActive}
        onOpenSession={openSessionById}
        onBack={focusRail}
      />
    );
  } else if (view === "trends") {
    body = (
      <TrendsView db={db} columns={columns} rows={rows} isActive={bodyActive} onBack={focusRail} />
    );
  } else {
    body = (
      <ToolsView db={db} columns={columns} rows={rows} isActive={bodyActive} onBack={focusRail} />
    );
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
        lede={
          showLede ? (
            <PortfolioLede
              summary={summary}
              months={months}
              duration={duration}
              distribution={distribution}
              streaks={streakInfo}
            />
          ) : undefined
        }
      >
        {body}
      </AppShell>
    </Box>
  );
}
