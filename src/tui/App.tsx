import type { Database } from "bun:sqlite";
import { Box, Text, useInput } from "ink";
import { useMemo, useState } from "react";
import { truncate } from "../cli/format.ts";
import type { IndexStatus } from "../core/index-status-types.ts";
import { INDEX_AGE_WARNING_MS } from "../core/index-status-types.ts";
import {
  buildPortfolioDiagnostics,
  type PortfolioDiagnostic,
} from "../core/portfolio-diagnostics.ts";
import { assemblePortfolioSignals } from "../core/portfolio-signals.ts";
import { getCostBasis } from "../core/prefs.ts";
import type { PricingTable } from "../core/pricing.ts";
import { labelProjects, projectDisplayName } from "../core/project-labels.ts";
import {
  type IndexedProject,
  type IndexedSession,
  indexedSessionById,
  listAllSessions,
  listIndexedProjects,
  listIndexedSessions,
} from "../core/queries.ts";
import {
  cacheWasteByProject,
  costDistribution,
  durationSummary,
  localDayOfMs,
  MAX_PROJECT_ROWS,
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
  indexStatus?: IndexStatus;
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

export function App({ db, pricing, indexStatus }: Props) {
  const projects = useMemo(() => listIndexedProjects(db), [db]);
  const allSessions = useMemo(() => listAllSessions(db), [db]);
  const summary = useMemo(() => portfolioSummary(db), [db]);
  const months = useMemo(() => spendByMonth(db), [db]);
  const duration = useMemo(() => durationSummary(db), [db]);
  const distribution = useMemo(() => costDistribution(db), [db]);
  const streakInfo = useMemo(() => streaks(db, localDayOfMs(Date.now())), [db]);
  // Display-only preference, read once at the screen boundary — TUI
  // presentation components never touch the state dir themselves.
  const costBasis = useMemo(() => getCostBasis(), []);
  // Per-project cache efficiency for the project preview, at full width (the
  // default limit is a top-50 slice, which would make a filtered-for project
  // show no waste it actually has). Computed here, not in ProjectsView, so
  // switching rail views doesn't re-scan.
  const wasteByProject = useMemo(
    () => new Map(cacheWasteByProject(db, MAX_PROJECT_ROWS).map((r) => [r.projectId, r] as const)),
    [db],
  );
  // Project-scoped portfolio findings for the preview. `audit: false` skips
  // the filesystem inventory scan at startup — no project-scoped rule *fires*
  // on the audit (context-tax-heavy only names unused MCP servers in its
  // action text), so the per-project set is the same either way. The Insights
  // screen still assembles its own full signals when opened.
  const findingsByProject = useMemo(() => {
    const diagnostics = buildPortfolioDiagnostics(
      assemblePortfolioSignals(db, pricing, { audit: false }),
    );
    const byProject = new Map<string, PortfolioDiagnostic[]>();
    for (const d of diagnostics) {
      if (!d.projectId) continue;
      byProject.set(d.projectId, [...(byProject.get(d.projectId) ?? []), d]);
    }
    return byProject;
  }, [db, pricing]);
  // Root-qualified labels for the drill breadcrumb — bare projectDisplayName
  // would render two same-path projects from different roots identically.
  const { label: projectLabel } = useMemo(
    () =>
      labelProjects(
        projects,
        (p) => projectDisplayName(p.projectPath, p.projectId),
        (p) => p.claudeDir,
      ),
    [projects],
  );
  const { columns, rows } = useTermSize();

  const [view, setView] = useState<View>("portfolio");
  const [focus, setFocus] = useState<"rail" | "body">("body");
  const [drill, setDrill] = useState<IndexedProject | null>(null);
  const [drillSessions, setDrillSessions] = useState<IndexedSession[]>([]);
  const [openSession, setOpenSession] = useState<IndexedSession | null>(null);
  const [help, setHelp] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchInput, setSearchInput] = useState("");
  const [searchError, setSearchError] = useState<string | null>(null);
  const [searchLoading, setSearchLoading] = useState(false);

  const moveView = (delta: number) => {
    const idx = VIEW_KEYS.indexOf(view);
    const next = VIEW_KEYS[Math.max(0, Math.min(idx + delta, VIEW_KEYS.length - 1))];
    if (next) setView(next);
  };

  const handleSessionSearch = async (raw: string) => {
    const trimmed = raw.trim();
    if (!trimmed) return;
    setSearchLoading(true);
    setSearchError(null);
    try {
      // Try indexed lookup first (ID)
      const indexed = indexedSessionById(db, trimmed);
      if (indexed) {
        setOpenSession(indexed);
        setSearchOpen(false);
        setSearchInput("");
        return;
      }
      // Path-like: only .jsonl files (prevents arbitrary file read like /etc/passwd)
      const isPathLike = trimmed.endsWith(".jsonl");
      if (isPathLike) {
        // Create a temporary IndexedSession for path-based sessions not in index
        // SessionDetailScreen will parse via sessionSourceAt, so we just need path
        const tmp: IndexedSession = {
          sessionId: trimmed.split("/").pop()?.replace(".jsonl", "") ?? trimmed,
          path: trimmed,
          title: null,
          cost: 0,
          costEstimated: false,
          ioTokens: 0,
          cacheTokens: 0,
          startTime: null,
          turns: 0,
          apiCalls: 0,
          toolCalls: 0,
          mtimeMs: Date.now(),
        };
        // Verify the path is readable (or has subagents) before opening
        try {
          const { sessionSourceAt } = await import("../core/discover.ts");
          const source = await sessionSourceAt(trimmed);
          if (source.parentExists || source.subagentPaths.length > 0) {
            setOpenSession(tmp);
            setSearchOpen(false);
            setSearchInput("");
            return;
          }
        } catch {
          // Filesystem probe failed — fall through to not-found
        }
      }
      setSearchError(`Session not found: ${trimmed}`);
    } finally {
      setSearchLoading(false);
    }
  };

  // Search prompt input handler — active only when search is open
  useInput(
    (input, key) => {
      if (!searchOpen) return;
      if (key.escape) {
        setSearchOpen(false);
        setSearchInput("");
        setSearchError(null);
        return;
      }
      if (key.return) {
        void handleSessionSearch(searchInput);
        return;
      }
      if (key.backspace || key.delete) {
        setSearchInput((prev) => prev.slice(0, -1));
        return;
      }
      // Printable characters (including paste which arrives as multiple chars in quick succession)
      if (input && !key.ctrl && !key.meta && input.length === 1) {
        setSearchInput((prev) => prev + input);
        return;
      }
      // Handle paste of multiple characters (e.g., full path)
      if (input && input.length > 1 && !key.ctrl && !key.meta) {
        setSearchInput((prev) => prev + input);
      }
    },
    { isActive: searchOpen && !help },
  );

  useInput(
    (input, key) => {
      if (input === "?") return setHelp(true);
      if (input === "/" && !searchOpen) {
        setSearchOpen(true);
        setSearchInput("");
        setSearchError(null);
        return;
      }
      if (searchOpen) return; // search prompt owns input when open
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

  if (searchOpen) {
    return (
      <Box flexDirection="column" padding={1}>
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor="cyan"
          paddingX={1}
          paddingY={1}
        >
          <Text bold color="cyan">
            Open session by ID or path
          </Text>
          <Text color={role.muted}>
            Enter session UUID or .jsonl path — Enter to open, Esc to cancel
          </Text>
          <Box marginTop={1}>
            <Text color="cyan">❯ </Text>
            <Text>{searchInput}</Text>
            <Text color={role.muted}>█</Text>
          </Box>
          {searchLoading && <Text color={role.muted}>Resolving…</Text>}
          {searchError && <Text color="red">{searchError}</Text>}
          <Box marginTop={1}>
            <Text color={role.muted}>Press Enter to open · Esc to cancel · paste supported</Text>
          </Box>
        </Box>
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
  const indexNotice = indexStatus
    ? indexStatus.stale ||
      indexStatus.lastRefreshedAt === null ||
      (indexStatus.ageMs ?? 0) >= INDEX_AGE_WARNING_MS
      ? indexStatus.stale
        ? `Index behind: ${indexStatus.added} new · ${indexStatus.changed} changed · ${indexStatus.deleted} deleted · run cc-analyzer index`
        : indexStatus.lastRefreshedAt === null
          ? "Index refresh time unknown · run cc-analyzer index"
          : "Index refresh is over 24h old · run cc-analyzer index"
      : undefined
    : undefined;
  // Rows the master list may render: terminal height minus the fixed shell
  // chrome (title/lede/margins/key bar) and the list's own header + scroll
  // indicator. Keeps content within the pinned viewport so it never overflows —
  // an underestimate here doesn't just clip content, it overflows Ink's fixed-
  // height shell Box and corrupts the frame (rows bleed into each other).
  // The lede now always renders 4 lines (adding the unconditional
  // `INDEXED_COST_CAVEAT` line) instead of 3; the reservation below was
  // bumped from 2 to 5 to match — empirically verified against the smoke
  // test, not derived from the shell's other constants, since Ink's own
  // layout overhead here isn't 1:1 with visible lede lines.
  const listPageSize = Math.max(3, rows - 9 - (showLede ? 5 : 0) - (indexNotice ? 1 : 0));

  const breadcrumb = drill ? `projects ▸ ${truncate(projectLabel(drill), 40)}` : view;

  const keyHints =
    focus === "rail"
      ? "↑↓ switch view · ↵ focus list · 1-6 jump · / search"
      : drill
        ? "type filter · tab sort · ↑↓ move · ↵ open · esc back · / search"
        : view === "trends"
          ? "tab/1·2·3·4 panel · m metric · g granularity · esc menu · / search"
          : view === "tools"
            ? "tab/1·2·3·4 panel · s sort · ↑↓ scroll · esc menu · / search"
            : "type filter · tab sort · ↑↓ move · ↵ open · esc menu · / search";

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
        wasteByProject={wasteByProject}
        findingsByProject={findingsByProject}
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
        pricing={pricing}
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
        notice={indexNotice}
        lede={
          showLede ? (
            <PortfolioLede
              summary={summary}
              months={months}
              duration={duration}
              distribution={distribution}
              streaks={streakInfo}
              costBasis={costBasis}
            />
          ) : undefined
        }
      >
        {body}
      </AppShell>
    </Box>
  );
}
