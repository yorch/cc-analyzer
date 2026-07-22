import type { Database } from "bun:sqlite";
import { Box, Text, useInput } from "ink";
import { useMemo, useState } from "react";
import { formatCount, formatUSD, truncate } from "../../cli/format.ts";
import {
  analyticsRollup,
  type NameUsageRow,
  type SkillUsageRow,
  type ToolUsageRow,
} from "../../core/stats.ts";
import { sparkline, weeklySkillSeries } from "../charts.ts";
import { ScrollRange } from "../components/ui.tsx";
import { keyIndex } from "../keys.ts";
import { clampWindow, scrollOffset } from "../scroll.ts";
import { palette, role } from "../theme.ts";

type Panel = "tools" | "skills" | "subagents";
const PANELS: Panel[] = ["tools", "skills", "subagents"];

const TOOL_SORTS = [
  { key: "uses", cmp: (a: ToolUsageRow, b: ToolUsageRow) => b.uses - a.uses },
  { key: "errors", cmp: (a: ToolUsageRow, b: ToolUsageRow) => b.errors - a.errors },
  { key: "err%", cmp: (a: ToolUsageRow, b: ToolUsageRow) => b.errorRate - a.errorRate },
  { key: "sessions", cmp: (a: ToolUsageRow, b: ToolUsageRow) => b.sessions - a.sessions },
  { key: "name", cmp: (a: ToolUsageRow, b: ToolUsageRow) => a.tool.localeCompare(b.tool) },
] as const;

const SKILL_SORTS = [
  {
    key: "invocations",
    cmp: (a: SkillUsageRow, b: SkillUsageRow) => b.invocations - a.invocations,
  },
  { key: "sessions", cmp: (a: SkillUsageRow, b: SkillUsageRow) => b.sessions - a.sessions },
  { key: "projects", cmp: (a: SkillUsageRow, b: SkillUsageRow) => b.projects - a.projects },
  { key: "err%", cmp: (a: SkillUsageRow, b: SkillUsageRow) => b.errorRate - a.errorRate },
  { key: "cost", cmp: (a: SkillUsageRow, b: SkillUsageRow) => b.totalCost - a.totalCost },
  { key: "name", cmp: (a: SkillUsageRow, b: SkillUsageRow) => a.name.localeCompare(b.name) },
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

/** Tool/skill/subagent usage analytics as switchable ranked-list panels. The
 * skills panel goes deeper: invocation/reach/reliability/cost columns plus an
 * adoption detail strip for the selected skill. */
export function ToolsView({ db, columns, rows, isActive, onBack }: Props) {
  // One table scan feeds all three panels.
  const { tools, skills, subagents } = useMemo(() => analyticsRollup(db), [db]);

  const [panel, setPanel] = useState<Panel>("tools");
  const [offsetState, setOffset] = useState(0);
  const [selState, setSel] = useState(0);
  const [toolSortIdx, setToolSortIdx] = useState(0);
  const [skillSortIdx, setSkillSortIdx] = useState(0);

  const sortedTools = useMemo(
    () => [...tools].sort(TOOL_SORTS[toolSortIdx]?.cmp),
    [tools, toolSortIdx],
  );
  const sortedSkills = useMemo(
    () => [...skills].sort(SKILL_SORTS[skillSortIdx]?.cmp),
    [skills, skillSortIdx],
  );
  const list: (ToolUsageRow | SkillUsageRow | NameUsageRow)[] =
    panel === "tools" ? sortedTools : panel === "skills" ? sortedSkills : subagents;

  // The skills panel reserves rows for the adoption detail strip below the table.
  const detailRows = panel === "skills" ? 4 : 0;
  const pageSize = Math.max(3, rows - 10 - detailRows);

  // Clamp cursor + window: switching panel/sort or shrinking the terminal can
  // leave `sel`/`offset` past the current list's end.
  const { cursor: sel, offset } = clampWindow(selState, offsetState, pageSize, list.length);

  const go = (p: Panel) => {
    setPanel(p);
    setOffset(0);
    setSel(0);
  };

  useInput(
    (input, key) => {
      if (key.escape) return onBack();
      if (key.tab) return go(PANELS[(PANELS.indexOf(panel) + 1) % PANELS.length] as Panel);
      const n = keyIndex("123", input);
      if (n >= 0) return go(PANELS[n] as Panel);
      if (input === "s") {
        if (panel === "tools") setToolSortIdx((i) => (i + 1) % TOOL_SORTS.length);
        else if (panel === "skills") setSkillSortIdx((i) => (i + 1) % SKILL_SORTS.length);
        else return;
        setOffset(0);
        setSel(0);
        return;
      }
      const dir = key.downArrow || input === "j" ? 1 : key.upArrow || input === "k" ? -1 : 0;
      if (dir === 0) return;
      const nextSel = Math.max(0, Math.min(sel + dir, list.length - 1));
      setSel(nextSel);
      setOffset(scrollOffset(nextSel, offset, pageSize));
    },
    { isActive },
  );

  // Body width minus the rail and 2-char cursor. The skills panel has 5 number
  // columns, tools 4, the subagents panel just one — so name budgets differ.
  const nameW =
    panel === "skills"
      ? Math.max(10, columns - 48)
      : panel === "tools"
        ? Math.max(10, columns - 54)
        : Math.max(10, columns - 28);
  const visible = list.slice(offset, offset + pageSize);
  const sortKey =
    panel === "tools"
      ? TOOL_SORTS[toolSortIdx]?.key
      : panel === "skills"
        ? SKILL_SORTS[skillSortIdx]?.key
        : undefined;
  const selSkill =
    panel === "skills" ? (sortedSkills[sel] as SkillUsageRow | undefined) : undefined;

  const cursor = (absIdx: number) => (absIdx === sel ? "›" : " ");

  return (
    <Box flexDirection="column">
      <Box>
        {PANELS.map((p) => (
          <Text key={p} {...(p === panel ? { color: palette.amber } : { color: role.muted })}>
            {" "}
            {p}{" "}
          </Text>
        ))}
        <Text color={role.muted}>
          {" "}
          tab · 1/2/3{sortKey ? ` · s sort: ${sortKey}` : ""} · esc menu
        </Text>
      </Box>

      <Box marginTop={1} flexDirection="column">
        {list.length === 0 ? (
          <Text color={role.muted}>Nothing recorded in the index.</Text>
        ) : panel === "tools" ? (
          <>
            <Text color={role.muted}>
              {"  "}
              {"TOOL".padEnd(nameW)} {"USES".padStart(8)} {"ERR".padStart(7)} {"ERR%".padStart(6)}{" "}
              {"SESS".padStart(7)}
            </Text>
            {(visible as ToolUsageRow[]).map((t, i) => (
              <Text key={t.tool}>
                <Text color={palette.amber}>{cursor(offset + i)} </Text>
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
        ) : panel === "skills" ? (
          <>
            <Text color={role.muted}>
              {"  "}
              {"SKILL".padEnd(nameW)} {"INVOC".padStart(7)} {"SESS".padStart(6)}{" "}
              {"PROJ".padStart(5)} {"ERR%".padStart(6)} {"TOTAL $".padStart(10)}
            </Text>
            {(visible as SkillUsageRow[]).map((r, i) => (
              <Text key={r.name}>
                <Text color={palette.amber}>{cursor(offset + i)} </Text>
                <Text color={offset + i === sel ? palette.amber : role.body}>
                  {truncate(r.name, nameW).padEnd(nameW)}{" "}
                </Text>
                <Text color={role.cost}>{formatCount(r.invocations).padStart(7)}</Text>{" "}
                <Text color={role.muted}>{formatCount(r.sessions).padStart(6)}</Text>{" "}
                <Text color={role.muted}>{formatCount(r.projects).padStart(5)}</Text>{" "}
                <Text color={rateColor(r.errorRate)}>
                  {`${(r.errorRate * 100).toFixed(1)}%`.padStart(6)}
                </Text>{" "}
                <Text color={role.cost}>{formatUSD(r.totalCost).padStart(10)}</Text>
              </Text>
            ))}
          </>
        ) : (
          <>
            <Text color={role.muted}>
              {"  "}
              {"SUBAGENT".padEnd(nameW)} {"SESSIONS".padStart(9)}
            </Text>
            {(visible as NameUsageRow[]).map((r, i) => (
              <Text key={r.name}>
                <Text color={palette.amber}>{cursor(offset + i)} </Text>
                <Text color={role.body}>{truncate(r.name, nameW).padEnd(nameW)} </Text>
                <Text color={role.cost}>{formatCount(r.sessions).padStart(9)}</Text>
              </Text>
            ))}
          </>
        )}
        <ScrollRange offset={offset} size={pageSize} total={list.length} />
      </Box>

      {selSkill && (
        <Box flexDirection="column" marginTop={1}>
          <Text color={role.muted}>{"─".repeat(Math.max(10, Math.min(columns - 2, 68)))}</Text>
          <Text>
            <Text color={palette.amber}>{selSkill.name}</Text>
            <Text color={role.muted}>
              {"  ·  "}first {selSkill.firstUsed ?? "—"} · last {selSkill.lastUsed ?? "—"} · avg{" "}
              {formatUSD(selSkill.avgCostPerSession)}/session · total{" "}
              {formatUSD(selSkill.totalCost)}
            </Text>
          </Text>
          <Text>
            <Text color={role.cost}>
              {sparkline(
                weeklySkillSeries(selSkill.daily),
                Math.max(10, Math.min(columns - 24, 48)),
              )}
            </Text>
            <Text color={role.muted}> invocations / week</Text>
          </Text>
        </Box>
      )}
    </Box>
  );
}
