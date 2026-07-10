import type { Database } from "bun:sqlite";
import { Box, Text, useInput } from "ink";
import { useMemo, useState } from "react";
import { formatCount, formatTokens, formatUSD, truncate } from "../../cli/format.ts";
import {
  type ModelRow,
  type MonthRow,
  type ProjectRow,
  portfolioSummary,
  type SessionRankRow,
  spendByModel,
  spendByMonth,
  spendByProject,
  topSessions,
} from "../../core/stats.ts";

interface Props {
  db: Database;
  isActive: boolean;
  /** Drill into a project's sessions by project id. */
  onOpenProject: (projectId: string) => void;
  /** Open a session's detail by session id. */
  onOpenSession: (sessionId: string) => void;
  /** Open the full filterable projects list. */
  onOpenProjects: () => void;
  onBack: () => void;
}

type Panel = "months" | "projects" | "models" | "sessions";
const PANELS: Panel[] = ["months", "projects", "models", "sessions"];
/** Panels whose rows can be selected and drilled into. */
const SELECTABLE: Record<Panel, boolean> = {
  months: false,
  projects: true,
  models: false,
  sessions: true,
};
const PAGE_SIZE = 12;

interface Stats {
  summary: ReturnType<typeof portfolioSummary>;
  months: MonthRow[];
  projects: ProjectRow[];
  models: ModelRow[];
  sessions: SessionRankRow[];
}

export function DashboardScreen({
  db,
  isActive,
  onOpenProject,
  onOpenSession,
  onOpenProjects,
  onBack,
}: Props) {
  const stats = useMemo<Stats>(
    () => ({
      summary: portfolioSummary(db),
      months: spendByMonth(db).slice().reverse(), // most recent first
      projects: spendByProject(db, 25),
      models: spendByModel(db),
      sessions: topSessions(db, 25),
    }),
    [db],
  );

  const [panel, setPanel] = useState<Panel>("months");
  const [cursor, setCursor] = useState(0);
  const [offset, setOffset] = useState(0);

  const rowCount = stats[panel].length;

  const goPanel = (p: Panel) => {
    setPanel(p);
    setCursor(0);
    setOffset(0);
  };

  useInput(
    (input, key) => {
      if (key.escape) return onBack();
      if (input === "p") return onOpenProjects();
      if (key.tab) {
        goPanel(PANELS[(PANELS.indexOf(panel) + 1) % PANELS.length] as Panel);
        return;
      }
      const numIdx = "1234".indexOf(input);
      if (numIdx >= 0) return goPanel(PANELS[numIdx] as Panel);

      if (key.return && SELECTABLE[panel]) {
        if (panel === "projects") {
          const p = stats.projects[cursor];
          if (p) onOpenProject(p.projectId);
        } else if (panel === "sessions") {
          const s = stats.sessions[cursor];
          if (s?.sessionId) onOpenSession(s.sessionId);
        }
        return;
      }

      const step = key.downArrow || input === "j" ? 1 : key.upArrow || input === "k" ? -1 : 0;
      if (step === 0) return;
      if (SELECTABLE[panel]) {
        const next = Math.max(0, Math.min(cursor + step, rowCount - 1));
        setCursor(next);
        if (next < offset) setOffset(next);
        else if (next >= offset + PAGE_SIZE) setOffset(next - PAGE_SIZE + 1);
      } else {
        setOffset((o) => Math.max(0, Math.min(o + step, Math.max(0, rowCount - PAGE_SIZE))));
      }
    },
    { isActive },
  );

  const s = stats.summary;
  const io = s.inputTokens + s.outputTokens;
  const cache = s.cacheWriteTokens + s.cacheReadTokens;
  const range = s.firstDay && s.lastDay ? `${s.firstDay} → ${s.lastDay}` : "—";
  const estPct = (s.estimatedShare * 100).toFixed(0);

  return (
    <Box flexDirection="column">
      <Text bold color="cyan">
        {formatUSD(s.cost)} total <Text dimColor>· {formatTokens(io, cache)} · </Text>
        {formatCount(s.sessions)} sessions / {s.projects} projects
      </Text>
      <Text dimColor>
        {range} · {estPct}% estimated
      </Text>

      <Box marginTop={1}>
        {PANELS.map((p) => (
          <Text
            key={p}
            color={p === panel ? "black" : "gray"}
            backgroundColor={p === panel ? "cyan" : undefined}
          >
            {" "}
            {p}
            {SELECTABLE[p] ? "*" : " "}
          </Text>
        ))}
        <Text dimColor> ↑↓ · enter · p=all · tab</Text>
      </Box>

      <Box marginTop={1} flexDirection="column">
        {panel === "months" && <MonthsPanel rows={stats.months} offset={offset} />}
        {panel === "projects" && (
          <ProjectsPanel rows={stats.projects} cursor={cursor} offset={offset} active={isActive} />
        )}
        {panel === "models" && <ModelsPanel rows={stats.models} offset={offset} />}
        {panel === "sessions" && (
          <SessionsPanel rows={stats.sessions} cursor={cursor} offset={offset} active={isActive} />
        )}
        {rowCount > PAGE_SIZE && (
          <Text dimColor>
            {Math.min(offset + 1, rowCount)}–{Math.min(offset + PAGE_SIZE, rowCount)} / {rowCount}
          </Text>
        )}
        {rowCount === 0 && <Text dimColor>(no data)</Text>}
      </Box>
    </Box>
  );
}

function MonthsPanel({ rows, offset }: { rows: MonthRow[]; offset: number }) {
  const max = Math.max(1, ...rows.map((m) => m.cost));
  return (
    <Box flexDirection="column">
      {rows.slice(offset, offset + PAGE_SIZE).map((m) => (
        <Text key={m.month}>
          <Text color="cyan">{m.month} </Text>
          {formatUSD(m.cost).padStart(9)}{" "}
          <Text dimColor>{formatTokens(m.ioTokens, m.cacheTokens).padStart(16)} </Text>
          {String(m.sessions).padStart(5)} <Text color="yellow">{bar(m.cost, max)}</Text>
        </Text>
      ))}
    </Box>
  );
}

function ProjectsPanel({
  rows,
  cursor,
  offset,
  active,
}: {
  rows: ProjectRow[];
  cursor: number;
  offset: number;
  active: boolean;
}) {
  return (
    <Box flexDirection="column">
      {rows.slice(offset, offset + PAGE_SIZE).map((p, i) => {
        const selected = offset + i === cursor && active;
        return (
          <Text
            key={p.projectId}
            color={selected ? "black" : undefined}
            backgroundColor={selected ? "cyan" : undefined}
          >
            {formatUSD(p.cost).padStart(9)} {formatTokens(p.ioTokens, p.cacheTokens).padStart(16)}{" "}
            {String(p.sessions).padStart(4)}
            {"  "}
            {truncate(p.projectPath ?? p.projectId, 44)}
          </Text>
        );
      })}
    </Box>
  );
}

function ModelsPanel({ rows, offset }: { rows: ModelRow[]; offset: number }) {
  return (
    <Box flexDirection="column">
      {rows.slice(offset, offset + PAGE_SIZE).map((m) => (
        <Text key={m.model}>
          {formatUSD(m.cost).padStart(9)}{" "}
          <Text dimColor>{formatTokens(m.ioTokens, m.cacheTokens).padStart(16)} </Text>
          {formatCount(m.calls).padStart(6)} calls{"  "}
          <Text color="magenta">{truncate(m.model, 40)}</Text>
        </Text>
      ))}
    </Box>
  );
}

function SessionsPanel({
  rows,
  cursor,
  offset,
  active,
}: {
  rows: SessionRankRow[];
  cursor: number;
  offset: number;
  active: boolean;
}) {
  return (
    <Box flexDirection="column">
      {rows.slice(offset, offset + PAGE_SIZE).map((sr, i) => {
        const selected = offset + i === cursor && active;
        return (
          <Text
            key={`${sr.sessionId}-${sr.startTime}`}
            color={selected ? "black" : undefined}
            backgroundColor={selected ? "cyan" : undefined}
          >
            {formatUSD(sr.cost).padStart(9)}{" "}
            {formatTokens(sr.ioTokens, sr.cacheTokens).padStart(16)}{" "}
            {(sr.startTime?.slice(0, 10) ?? "—").padEnd(10)}
            {"  "}
            {truncate(sr.title ?? sr.sessionId ?? "(untitled)", 40)}
          </Text>
        );
      })}
    </Box>
  );
}

/** A proportional block bar, up to 16 cells wide. */
function bar(value: number, max: number): string {
  const width = Math.round((value / max) * 16);
  return "█".repeat(Math.max(0, width));
}
