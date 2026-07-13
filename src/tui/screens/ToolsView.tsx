import type { Database } from "bun:sqlite";
import { Box, Text, useInput } from "ink";
import { useMemo, useState } from "react";
import { formatCount, truncate } from "../../cli/format.ts";
import {
  type NameUsageRow,
  skillUsage,
  subagentUsage,
  type ToolUsageRow,
  toolUsage,
} from "../../core/stats.ts";
import { ScrollRange } from "../components/ui.tsx";
import { scrollOffset } from "../scroll.ts";
import { palette, role, selection } from "../theme.ts";

type Panel = "tools" | "skills" | "subagents";
const PANELS: Panel[] = ["tools", "skills", "subagents"];

const TOOL_SORTS = [
  { key: "uses", cmp: (a: ToolUsageRow, b: ToolUsageRow) => b.uses - a.uses },
  { key: "errors", cmp: (a: ToolUsageRow, b: ToolUsageRow) => b.errors - a.errors },
  { key: "err%", cmp: (a: ToolUsageRow, b: ToolUsageRow) => b.errorRate - a.errorRate },
  { key: "sessions", cmp: (a: ToolUsageRow, b: ToolUsageRow) => b.sessions - a.sessions },
  { key: "name", cmp: (a: ToolUsageRow, b: ToolUsageRow) => a.tool.localeCompare(b.tool) },
] as const;

interface Props {
  db: Database;
  columns: number;
  rows: number;
  isActive: boolean;
  onBack: () => void;
}

/** Error-rate color by severity. */
const rateColor = (r: number): string =>
  r >= 0.05 ? palette.red : r >= 0.01 ? palette.amberDim : role.muted;

/** Tool/skill/subagent usage analytics as switchable ranked-list panels. */
export function ToolsView({ db, columns, rows, isActive, onBack }: Props) {
  const tools = useMemo(() => toolUsage(db), [db]);
  const skills = useMemo(() => skillUsage(db), [db]);
  const subagents = useMemo(() => subagentUsage(db), [db]);

  const [panel, setPanel] = useState<Panel>("tools");
  const [offset, setOffset] = useState(0);
  const [sortIdx, setSortIdx] = useState(0);
  const pageSize = Math.max(3, rows - 10);

  const sortedTools = useMemo(() => [...tools].sort(TOOL_SORTS[sortIdx]?.cmp), [tools, sortIdx]);
  const list: (ToolUsageRow | NameUsageRow)[] =
    panel === "tools" ? sortedTools : panel === "skills" ? skills : subagents;

  const go = (p: Panel) => {
    setPanel(p);
    setOffset(0);
  };

  useInput(
    (input, key) => {
      if (key.escape) return onBack();
      if (key.tab) return go(PANELS[(PANELS.indexOf(panel) + 1) % PANELS.length] as Panel);
      const n = "123".indexOf(input);
      if (n >= 0) return go(PANELS[n] as Panel);
      if (input === "s" && panel === "tools") {
        setSortIdx((i) => (i + 1) % TOOL_SORTS.length);
        setOffset(0);
        return;
      }
      const dir = key.downArrow || input === "j" ? 1 : key.upArrow || input === "k" ? -1 : 0;
      if (dir === 0) return;
      const next = Math.max(0, Math.min(offset + dir, Math.max(0, list.length - pageSize)));
      setOffset(scrollOffset(next, offset, pageSize));
    },
    { isActive },
  );

  // Body width minus the rail; the tools panel has 4 number columns, the
  // name-only panels just one, so the name column budget differs.
  const nameW = panel === "tools" ? Math.max(10, columns - 52) : Math.max(10, columns - 26);
  const visible = list.slice(offset, offset + pageSize);

  return (
    <Box flexDirection="column">
      <Box>
        {PANELS.map((p) => (
          <Text key={p} {...(p === panel ? selection(true) : { color: role.muted })}>
            {" "}
            {p}{" "}
          </Text>
        ))}
        <Text color={role.muted}>
          {" "}
          tab · 1/2/3{panel === "tools" ? ` · s sort: ${TOOL_SORTS[sortIdx]?.key}` : ""} · esc menu
        </Text>
      </Box>

      <Box marginTop={1} flexDirection="column">
        {list.length === 0 ? (
          <Text color={role.muted}>Nothing recorded in the index.</Text>
        ) : panel === "tools" ? (
          <>
            <Text color={role.muted}>
              {"TOOL".padEnd(nameW)} {"USES".padStart(8)} {"ERR".padStart(7)} {"ERR%".padStart(6)}{" "}
              {"SESS".padStart(7)}
            </Text>
            {(visible as ToolUsageRow[]).map((t) => (
              <Text key={t.tool}>
                <Text color={role.body}>{truncate(t.tool, nameW).padEnd(nameW)} </Text>
                <Text color={role.cost}>{formatCount(t.uses).padStart(8)}</Text>{" "}
                <Text color={role.muted}>{formatCount(t.errors).padStart(7)}</Text>{" "}
                <Text color={rateColor(t.errorRate)}>
                  {`${(t.errorRate * 100).toFixed(1)}%`.padStart(6)}
                </Text>{" "}
                <Text color={role.muted}>{formatCount(t.sessions).padStart(7)}</Text>
              </Text>
            ))}
          </>
        ) : (
          <>
            <Text color={role.muted}>
              {(panel === "skills" ? "SKILL" : "SUBAGENT").padEnd(nameW)} {"SESSIONS".padStart(9)}
            </Text>
            {(visible as NameUsageRow[]).map((r) => (
              <Text key={r.name}>
                <Text color={role.body}>{truncate(r.name, nameW).padEnd(nameW)} </Text>
                <Text color={role.cost}>{formatCount(r.sessions).padStart(9)}</Text>
              </Text>
            ))}
          </>
        )}
        <ScrollRange offset={offset} size={pageSize} total={list.length} />
      </Box>
    </Box>
  );
}
