import type { Database } from "bun:sqlite";
import { Box, Text, useInput } from "ink";
import { useMemo, useState } from "react";
import { formatCount, formatUSD, truncate } from "../../cli/format.ts";
import {
  PARSE_COVERAGE_MAX_UNPARSED_SHARE,
  PARSE_COVERAGE_MIN_LINES,
} from "../../core/portfolio-diagnostics.ts";
import {
  type AnalyticsRollup,
  analyticsRollup,
  CORRECTION_CAVEAT,
  type NameUsageRow,
  type ParseCoverageStats,
  parseCoverage,
  SKILL_COST_CAVEAT,
  type SkillUsageRow,
  type ToolUsageRow,
} from "../../core/stats.ts";
import { sparkline, weeklySkillSeries } from "../charts.ts";
import { ScrollRange } from "../components/ui.tsx";
import { keyIndex } from "../keys.ts";
import { clampWindow, scrollOffset } from "../scroll.ts";
import { palette, role } from "../theme.ts";

type Panel = "tools" | "skills" | "subagents" | "reliability";
const PANELS: Panel[] = ["tools", "skills", "subagents", "reliability"];

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
  {
    key: "turn $",
    cmp: (a: SkillUsageRow, b: SkillUsageRow) => b.attributedCost - a.attributedCost,
  },
  { key: "session $", cmp: (a: SkillUsageRow, b: SkillUsageRow) => b.totalCost - a.totalCost },
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
  // One table scan feeds the ranked panels; reliability reads the same
  // rollup's tests/retries/thrash/corrections plus a parse-coverage scan.
  const rollup = useMemo(() => analyticsRollup(db), [db]);
  const { tools, skills, subagents } = rollup;
  const coverage = useMemo(() => parseCoverage(db), [db]);

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
  const isReliability = panel === "reliability";

  // The skills panel reserves rows for the adoption detail strip below the
  // table: a fixed part (top margin + divider + head + sparkline) plus
  // however many terminal-width lines SKILL_COST_CAVEAT actually wraps to —
  // a constant undercounted this at narrow widths and let the table overflow.
  const SKILLS_DETAIL_FIXED_ROWS = 4;
  const caveatRows = Math.ceil(SKILL_COST_CAVEAT.length / Math.max(1, columns));
  const detailRows = panel === "skills" ? SKILLS_DETAIL_FIXED_ROWS + caveatRows : 0;
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
      const n = keyIndex("1234", input);
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

  // Body width minus the rail and 2-char cursor. The skills panel has 6 number
  // columns, tools 4, the subagents panel just one — so name budgets differ.
  const nameW =
    panel === "skills"
      ? Math.max(10, columns - 52)
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
          {/* Comparators are hardcoded descending — no reverse toggle here (unlike
           * the list views' tab/shift-tab sort), so the arrow is constant. */}
          tab · 1/2/3/4{sortKey ? ` · s sort: ${sortKey} ↓` : ""} · esc menu
        </Text>
      </Box>

      <Box marginTop={1} flexDirection="column">
        {isReliability ? (
          <ReliabilityPanel rollup={rollup} coverage={coverage} columns={columns} />
        ) : list.length === 0 ? (
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
              {"PROJ".padStart(5)} {"ERR%".padStart(6)} {"TURN $".padStart(9)}{" "}
              {"SESS $".padStart(9)}
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
                <Text color={role.cost}>{formatUSD(r.attributedCost).padStart(9)}</Text>{" "}
                <Text color={role.muted}>{formatUSD(r.totalCost).padStart(9)}</Text>
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
        {!isReliability && <ScrollRange offset={offset} size={pageSize} total={list.length} />}
      </Box>

      {selSkill && (
        <Box flexDirection="column" marginTop={1}>
          <Text color={role.muted}>{"─".repeat(Math.max(10, Math.min(columns - 2, 68)))}</Text>
          <Text>
            <Text color={palette.amber}>{selSkill.name}</Text>
            <Text color={role.muted}>
              {"  ·  "}first {selSkill.firstUsed ?? "—"} · last {selSkill.lastUsed ?? "—"} ·{" "}
              {`${formatUSD(selSkill.attributedCost)} over ${selSkill.attributedTurns} ` +
                `${selSkill.attributedTurns === 1 ? "turn" : "turns"} · ` +
                `${formatUSD(selSkill.totalCost)} session-scoped`}
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
          {/* Mandatory caveats print VERBATIM — Ink wraps long lines. */}
          <Text color={role.muted}>{SKILL_COST_CAVEAT}</Text>
        </Box>
      )}
    </Box>
  );
}

/** A padded `label   value` line, matching the preview panes' field style. */
function Line({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Text>
      <Text color={role.muted}>{label.padEnd(13)}</Text>
      {children}
    </Text>
  );
}

const pct = (share: number): string => `${(share * 100).toFixed(1)}%`;

/**
 * Reliability at a glance: tests, tool-call churn, the two thrash signals,
 * corrections (with its mandatory caveat), and parse coverage — the same
 * numbers the web Tools view's Reliability/Environment sections and
 * `cc-analyzer stats` report, in compact field lines.
 */
function ReliabilityPanel({
  rollup,
  coverage,
  columns,
}: {
  rollup: AnalyticsRollup;
  coverage: ParseCoverageStats;
  columns: number;
}) {
  const { tests, retries, thrash, corrections } = rollup;
  const cov = coverage.summary;
  const newest = coverage.byVersion[0];
  // Same thresholds as the parse-coverage-drop portfolio rule, so this panel
  // and the diagnostic can never disagree about when the parser is behind.
  const parserBehind =
    newest !== undefined &&
    newest.lines >= PARSE_COVERAGE_MIN_LINES &&
    newest.unparsedShare >= PARSE_COVERAGE_MAX_UNPARSED_SHARE;
  if (cov.sessions === 0) {
    return <Text color={role.muted}>Nothing recorded in the index.</Text>;
  }
  return (
    <Box flexDirection="column">
      <Line label="tests">
        {tests.runs > 0 ? (
          <>
            <Text color={role.body}>{formatCount(tests.runs)} runs</Text>
            <Text color={role.muted}>
              {" "}
              · {formatCount(tests.failures)} failed ({pct(tests.failureRate)}) ·{" "}
              {formatCount(tests.sessions)} sessions
            </Text>
          </>
        ) : (
          <Text color={role.muted}>none detected</Text>
        )}
      </Line>
      <Line label="churn">
        {retries.total > 0 ? (
          <>
            <Text color={role.body}>{formatCount(retries.total)} repeated identical calls</Text>
            <Text color={role.muted}>
              {" "}
              in {formatCount(retries.sessions)} sessions
              {retries.byTool[0]
                ? ` · worst ${retries.byTool[0].tool} (${formatCount(retries.byTool[0].retries)})`
                : ""}
            </Text>
          </>
        ) : (
          <Text color={role.muted}>none</Text>
        )}
      </Line>
      <Line label="test thrash">
        {thrash.testThrashSessions > 0 ? (
          <>
            <Text color={role.body}>
              {formatCount(thrash.testThrashSessions)} sessions in edit→test→fail loops
            </Text>
            <Text color={role.muted}> · worst streak {thrash.worstTestFailStreak}</Text>
          </>
        ) : (
          <Text color={role.muted}>none</Text>
        )}
      </Line>
      <Line label="re-reads">
        {thrash.redundantReads > 0 ? (
          <>
            <Text color={role.body}>{formatCount(thrash.redundantReads)} redundant reads</Text>
            <Text color={role.muted}>
              {" "}
              · {formatCount(thrash.rereadSessions)} reread-heavy sessions
            </Text>
          </>
        ) : (
          <Text color={role.muted}>none</Text>
        )}
      </Line>
      {thrash.topRereadFiles.slice(0, 3).map((f) => (
        <Text key={f.file}>
          <Text color={role.muted}>{"".padEnd(13)}</Text>
          <Text color={role.body}>{String(f.sessions).padStart(3)}× </Text>
          <Text color={role.muted}>{truncate(f.file, Math.max(16, columns - 22))}</Text>
        </Text>
      ))}
      {thrash.redundantReads > 0 && (
        <Text color={role.muted}>
          {"".padEnd(13)}every re-read pays the whole file into context again
        </Text>
      )}
      <Box marginTop={1} flexDirection="column">
        <Line label="corrections">
          {corrections.turns > 0 ? (
            <>
              <Text color={role.body}>{pct(corrections.correctionShare)}</Text>
              <Text color={role.muted}>
                {" "}
                of {formatCount(corrections.turns)} turns (
                {formatCount(corrections.correctionTurns)}) · {formatCount(corrections.sessions)}{" "}
                sessions · {formatCount(corrections.interruptionTurns)} interrupted mid-flight
              </Text>
            </>
          ) : (
            <Text color={role.muted}>no turns recorded</Text>
          )}
        </Line>
        {/* Mandatory caveat prints VERBATIM — Ink wraps long lines. */}
        <Text color={role.muted}>{CORRECTION_CAVEAT}</Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Line label="parse cover">
          <Text color={role.body}>{pct(1 - cov.unparsedShare)} parsed</Text>
          <Text color={role.muted}>
            {" "}
            of {formatCount(cov.lines)} lines · {formatCount(cov.parseErrors)} unreadable ·{" "}
            {formatCount(cov.unknownEvents)} unknown events
          </Text>
        </Line>
        {newest && (
          <Line label="">
            <Text color={role.muted}>
              newest {newest.version}: {pct(1 - newest.unparsedShare)} parsed of{" "}
              {formatCount(newest.lines)} lines
            </Text>
            {parserBehind && (
              <Text color={role.accent}> · parser behind — run cc-analyzer update</Text>
            )}
          </Line>
        )}
      </Box>
    </Box>
  );
}
