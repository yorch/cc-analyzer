import { Box, Text, useInput } from "ink";
import { useEffect, useMemo, useState } from "react";
import {
  formatCount,
  formatDuration,
  formatSignedUSD,
  formatTokens,
  formatUSD,
  pct,
  truncate,
} from "../../cli/format.ts";
import type { SessionAnalysis } from "../../core/analyze.ts";
import { analyzeSession } from "../../core/analyze.ts";
import {
  buildBurnSeries,
  buildCacheSeries,
  buildContextGrowth,
  buildContextSeries,
  buildGapMarkers,
  buildTurnSeries,
  burstAttributionNote,
  type ContextGrowthEntry,
  groupSidechainBursts,
  modelMixRows,
  pctOfLimit,
  projectHeadroom,
  shareOf,
  summarizeCompactions,
  type TurnCostShape,
  turnCostShape,
  turnFlags,
} from "../../core/chart-series.ts";
import {
  ANALYSIS_MODELS,
  CLAUDE_NOT_FOUND_MESSAGE,
  resolveClaudeBinary,
  runClaudeAnalysis,
} from "../../core/claude-handoff.ts";
import { openDb } from "../../core/db.ts";
import { sessionSourceAt, sessionTree } from "../../core/discover.ts";
import { parseSessionTree } from "../../core/parser.ts";
import { getAnalysisModel, getCostBasis, setAnalysisModel } from "../../core/prefs.ts";
import { cacheTokens, ioTokens, type PricingTable } from "../../core/pricing.ts";
import type { IndexedSession } from "../../core/queries.ts";
import { buildSessionDiagnostics } from "../../core/session-diagnostics.ts";
import { inspectSessionHealth } from "../../core/session-health.ts";
import {
  OUTCOME_CAVEAT,
  outcomeRows,
  sessionOutcomes,
  sessionWhatIf,
} from "../../core/session-insights.ts";
import {
  buildSessionHtml,
  buildSessionMarkdown,
  sanitizeFilename,
} from "../../core/session-markdown.ts";
import { sessionCostRank } from "../../core/stats.ts";
import {
  CONTEXT_GROWTH_CAVEAT,
  CORRECTION_CAVEAT,
  SKILL_COST_CAVEAT,
  WHATIF_CAVEAT,
  type WhatIfRepricing,
} from "../../core/stats-types.ts";
import type { TurnStep } from "../../core/steps.ts";
import { buildTranscript, type TranscriptItem } from "../../core/transcript.ts";
import { brailleChart, markerRow, sparkline } from "../charts.ts";
import { Loading, ScrollRange } from "../components/ui.tsx";
import { scrollOffset } from "../scroll.ts";
import { masterWidth } from "../shell/MasterDetail.tsx";
import { KIND_COLOR, palette, role, STEP_COLOR, STEP_ICON, selection } from "../theme.ts";
import { usePageSize } from "../usePageSize.ts";
import { type SortField, useSort } from "../useSort.ts";
import { layoutMode } from "../useTermSize.ts";

interface Props {
  session: IndexedSession;
  pricing: PricingTable;
  isActive: boolean;
  columns: number;
  rows: number;
  onBack: () => void;
}

type Mode = "turns" | "charts" | "transcript" | "summary" | "claude" | "export";

type ExportFormat = "md" | "html" | "json";

interface Loaded {
  analysis: SessionAnalysis;
  transcript: TranscriptItem[];
  events: import("../../core/events.ts").SessionEvent[];
  coverage: import("../../core/events.ts").ParseCoverage | undefined;
  errors: import("../../core/parser.ts").ParseError[];
}

/** Burst rows the summary pane shows before collapsing to "+N more". The pane
 *  is fixed-height and does not scroll, so this is a clipping guard, not a
 *  style choice — the caveats below the table must stay visible. */
const BURST_ROWS_SHOWN = 5;

/** How many top turns the ranked turns header sums into its "top N = X%" read.
 *  Five is the smallest count that reliably says something about a real
 *  session and still fits beside the sort indicator on a narrow terminal. */
const PARETO_ROWS = 5;

/** Context-growth contributors named on the turns detail line. Two fits a
 *  narrow pane; the rest are visible in `analyze`'s Context growth table. */
const GROWTH_ENTRIES_SHOWN = 2;

export function SessionDetailScreen({ session, pricing, isActive, columns, rows, onBack }: Props) {
  const [data, setData] = useState<Loaded | null>(null);
  const [mode, setMode] = useState<Mode>("turns");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // The whole tree, so a session's subagent spend is part of its detail.
      const source = await sessionSourceAt(session.path);
      const { events, coverage, errors } = await parseSessionTree(sessionTree(source));
      const analysis = analyzeSession(events, pricing, { coverage, agentMeta: source.agentMeta });
      const transcript = buildTranscript(events);
      if (!cancelled) setData({ analysis, transcript, events, coverage, errors });
    })();
    return () => {
      cancelled = true;
    };
  }, [session.path, pricing]);

  // Mode switching lives here; each mode owns its own cursor/scroll and handles
  // esc itself (steps→turns→close for turns mode; back-to-turns for the others).
  useInput(
    (input, key) => {
      if (input === "t") return setMode("transcript");
      if (input === "s") return setMode("summary");
      if (input === "c") return setMode("charts");
      if (input === "a") return setMode("claude");
      if (input === "e" || input === "6") return setMode("export");
      if (input === "u" || input === "1") return setMode("turns");
      if (input === "2") return setMode("charts");
      if (input === "3") return setMode("transcript");
      if (input === "4") return setMode("summary");
      if (input === "5") return setMode("claude");
      if (key.escape && mode !== "turns") return setMode("turns");
    },
    { isActive: isActive && !!data },
  );

  // Computed at the screen boundary (has `pricing`) and handed down as a prop
  // — SummaryView only sees the analysis otherwise.
  const whatIf = useMemo<WhatIfRepricing | undefined>(
    () => (data ? sessionWhatIf(data.analysis.models, pricing) : undefined),
    [data, pricing],
  );

  if (!data) return <Loading label="Loading session" />;
  const { analysis } = data;

  return (
    <Box flexDirection="column" height={Math.max(1, rows - 2)} overflow="hidden">
      <Text bold color={role.heading}>
        {truncate(analysis.title ?? session.sessionId ?? "(untitled)", 70)}
      </Text>
      <SummaryBand a={analysis} />
      <Box marginTop={1}>
        {(["turns", "charts", "transcript", "summary", "claude", "export"] as Mode[]).map((m) => (
          <Text key={m} {...(m === mode ? selection(true) : { color: role.muted })}>
            {" "}
            {m}{" "}
          </Text>
        ))}
      </Box>
      <Box marginTop={1} flexGrow={1} flexDirection="column" overflow="hidden">
        {mode === "turns" && (
          <TurnsPane a={analysis} columns={columns} isActive={isActive} onBack={onBack} />
        )}
        {mode === "charts" && <ChartsView a={analysis} columns={columns} rows={rows} />}
        {mode === "transcript" && <TranscriptView items={data.transcript} isActive={isActive} />}
        {mode === "summary" && <SummaryView a={analysis} whatIf={whatIf} />}
        {mode === "claude" && (
          <ClaudeView
            a={analysis}
            sessionPath={session.path}
            whatIf={whatIf}
            isActive={isActive}
            rows={rows}
          />
        )}
        {mode === "export" && (
          <ExportView
            key={`${session.path}-${mode}`}
            analysis={analysis}
            transcript={data.transcript}
            events={data.events}
            coverage={data.coverage}
            errors={data.errors}
            pricing={pricing}
            sessionId={session.sessionId ?? analysis.sessionId ?? "session"}
            isActive={isActive}
          />
        )}
      </Box>
      <Box marginTop={1}>
        <Text color={role.muted}>
          {mode === "turns"
            ? "↑↓ turn · →/tab steps · o/O sort · g/G jump · c charts · t transcript · s summary · a claude · e export · esc back"
            : mode === "claude"
              ? "r run · m model · ↑↓ scroll · esc turns"
              : mode === "export"
                ? "f format · r redact · t transcript · w write · esc turns"
                : mode === "charts" || mode === "summary"
                  ? "1-6 modes · esc turns"
                  : "↑↓ move · ↵ expand · g/G jump · esc turns"}
          {" · "}
          <Text color={palette.amberDim}>?</Text> help · ctrl-c quit
        </Text>
      </Box>
    </Box>
  );
}

/** One-line vitals for the session, always visible above the body. */
function SummaryBand({ a }: { a: SessionAnalysis }) {
  const io = ioTokens(a.totals.tokens);
  const cache = cacheTokens(a.totals.tokens);
  const cachePct = io + cache > 0 ? `${Math.round((cache / (io + cache)) * 100)}%` : "—";
  const models = Object.keys(a.models).join(", ") || "-";
  return (
    <Box>
      <Text color={role.cost}>{formatUSD(a.totals.cost.total)}</Text>
      <Text color={role.muted}>
        {a.totals.cost.estimated ? " (est)" : ""} · {a.totals.turns} turns · {a.totals.apiCalls}{" "}
        calls · {a.totals.toolCalls} tools · cache {cachePct} · {truncate(models, 28)} ·{" "}
        {formatDuration(a.durationMs)}
      </Text>
    </Box>
  );
}

interface TurnRow {
  index: number;
  cost: number;
  calls: number;
  tokens: number;
  wallMs: number;
  prompt: string;
  steps: TurnStep[];
  /** What this turn's cost is made of, from the shared `turnCostShape`. */
  shape: TurnCostShape | undefined;
  /** Per-call context growth issued in this turn, biggest first. */
  growth: ContextGrowthEntry[];
}

function turnRows(a: SessionAnalysis): TurnRow[] {
  const shapes = new Map(buildTurnSeries(a).map((p) => [p.index, turnCostShape(p)]));
  const growth = new Map<number, ContextGrowthEntry[]>();
  for (const entry of buildContextGrowth(a).entries) {
    const list = growth.get(entry.turnIndex) ?? [];
    list.push(entry);
    growth.set(entry.turnIndex, list);
  }
  for (const list of growth.values()) list.sort((x, y) => y.deltaTokens - x.deltaTokens);
  return a.turns.map((t) => {
    const start = t.startTime ? Date.parse(t.startTime) : Number.NaN;
    const end = t.endTime ? Date.parse(t.endTime) : Number.NaN;
    return {
      index: t.index,
      cost: t.cost.total,
      calls: t.apiCalls.length,
      tokens: ioTokens(t.tokens) + cacheTokens(t.tokens),
      wallMs: Number.isNaN(start) || Number.isNaN(end) ? 0 : end - start,
      prompt: t.prompt,
      steps: t.apiCalls.flatMap((c) => c.steps),
      shape: shapes.get(t.index),
      growth: growth.get(t.index) ?? [],
    };
  });
}

/** Sort keys for the turns list. `index` leads because a session is a
 *  narrative — ranking by cost is the added lens, one `o` away. */
const TURN_SORT_FIELDS: SortField<TurnRow>[] = [
  { key: "index", label: "turn", value: (t) => t.index },
  { key: "cost", label: "cost", value: (t) => t.cost },
  { key: "tokens", label: "tokens", value: (t) => t.tokens },
  { key: "calls", label: "calls", value: (t) => t.calls },
  { key: "time", label: "time", value: (t) => t.wallMs },
];

/** Turns list (master) → selected turn's steps (detail), with a turns↔steps
 * focus toggle mirroring the app shell's rail↔body model. */
function TurnsPane({
  a,
  columns,
  isActive,
  onBack,
}: {
  a: SessionAnalysis;
  columns: number;
  isActive: boolean;
  onBack: () => void;
}) {
  const all = useMemo(() => turnRows(a), [a]);
  // Ascending by default so the list opens in session order; `o` cycles the
  // key and `O` flips the direction (tab is already the turns↔steps toggle).
  const sort = useSort(TURN_SORT_FIELDS, 1);
  const rows = sort.sorted(all);
  const sessionCost = a.totals.cost.total;
  const [pane, setPane] = useState<"turns" | "steps">("turns");
  const [turnSel, setTurnSel] = useState(0);
  const [turnOff, setTurnOff] = useState(0);
  const [stepSel, setStepSel] = useState(0);
  const [stepOff, setStepOff] = useState(0);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const wide = layoutMode(columns) !== "narrow";
  const pageSize = usePageSize(11);

  const activeTurn = Math.min(turnSel, Math.max(0, rows.length - 1));
  const turn = rows[activeTurn];
  const steps = turn?.steps ?? [];

  const selectTurn = (next: number) => {
    const n = Math.max(0, Math.min(next, rows.length - 1));
    setTurnSel(n);
    setTurnOff(scrollOffset(n, turnOff, pageSize));
    setStepSel(0);
    setStepOff(0);
    setExpanded(new Set());
  };

  // The steps pane scrolls against its OWN (reduced) height, not the master
  // list's, or the cursor would run off the visible slice.
  const selectStep = (next: number) => {
    const n = Math.max(0, Math.min(next, steps.length - 1));
    setStepSel(n);
    setStepOff(scrollOffset(n, stepOff, detailPageSize));
  };

  useInput(
    (input, key) => {
      if (pane === "turns") {
        if (key.downArrow || input === "j") return selectTurn(activeTurn + 1);
        if (key.upArrow || input === "k") return selectTurn(activeTurn - 1);
        if (input === "g") return selectTurn(0);
        if (input === "G") return selectTurn(rows.length - 1);
        // Re-ordering moves rows under the cursor, so both keys reset the
        // selection to the top rather than leaving it on an arbitrary turn.
        if (input === "o") {
          sort.cycle();
          return selectTurn(0);
        }
        if (input === "O") {
          sort.reverse();
          return selectTurn(0);
        }
        if ((key.rightArrow || key.tab || key.return) && steps.length > 0) return setPane("steps");
        if (key.escape) return onBack();
        return;
      }
      // pane === "steps"
      if (key.leftArrow || (key.tab && key.shift) || key.escape) return setPane("turns");
      if (key.downArrow || input === "j") return selectStep(stepSel + 1);
      if (key.upArrow || input === "k") return selectStep(stepSel - 1);
      if (input === "g") return selectStep(0);
      if (input === "G") return selectStep(steps.length - 1);
      if (key.return || input === " ") {
        setExpanded((prev) => toggle(prev, stepSel));
      }
    },
    { isActive },
  );

  const promptW = wide ? Math.max(8, masterWidth(columns) - 26) : 34;
  // A running share reads as a Pareto only while the list is ranked descending
  // by the very column it accumulates; in session order it would just be a
  // burn curve wearing a share's label, so the line appears only in that order.
  const ranked = sort.key === "cost" && sort.dir === -1;
  const paretoRows = Math.min(PARETO_ROWS, rows.length);
  const paretoShare = ranked
    ? shareOf(
        rows.slice(0, paretoRows).reduce((sum, r) => sum + r.cost, 0),
        sessionCost,
      )
    : 0;
  const master = (
    <Box flexDirection="column">
      <Text color={role.muted}>
        turns · {rows.length} · {sort.label}
        {ranked && paretoRows > 0 ? ` · top ${paretoRows} = ${pct(paretoShare)}` : ""}
      </Text>
      {rows.slice(turnOff, turnOff + pageSize).map((r, i) => {
        const sel = turnOff + i === activeTurn;
        return (
          <Text key={r.index} {...selection(sel && pane === "turns")}>
            {sel && pane === "turns" ? "❯" : " "} #{r.index + 1} {formatUSD(r.cost).padStart(8)}{" "}
            {pct(shareOf(r.cost, sessionCost)).padStart(4)}{" "}
            {truncate(r.prompt || "(no text)", promptW)}
          </Text>
        );
      })}
      <ScrollRange offset={turnOff} size={pageSize} total={rows.length} />
    </Box>
  );

  // "+47.0k after call 2 (Read)" — the biggest few contributors in this turn.
  const growthLine = (turn?.growth ?? [])
    .slice(0, GROWTH_ENTRIES_SHOWN)
    .map(
      (e) =>
        `+${formatCount(e.deltaTokens)} after call ${e.callIndex + 1}` +
        (e.steps.length > 0 ? ` (${truncate(e.steps.join(", "), 28)})` : ""),
    )
    .join(" · ");
  // The screen is a pinned-height frame with `overflow: hidden`, so lines added
  // to the detail pane must come OUT of its step list rather than pushing the
  // footer off the bottom. The caveat wraps, so it is budgeted at two rows.
  const detailExtraRows = (turn?.shape ? 1 : 0) + (growthLine ? 3 : 0);
  const detailPageSize = Math.max(3, pageSize - detailExtraRows);

  const detail = (
    <Box flexDirection="column">
      <Text color={role.heading}>
        turn #{(turn?.index ?? 0) + 1} · {turn?.calls ?? 0} calls · {formatUSD(turn?.cost ?? 0)} ·{" "}
        {pct(shareOf(turn?.cost ?? 0, sessionCost))} of session
      </Text>
      {turn?.shape ? (
        // The detail pane, not the master list: the shape's value is its
        // evidence sentence, and the narrow master column has no room for it
        // without eating the prompt preview that makes a turn recognisable.
        <Text color={role.muted} wrap="truncate-end">
          shape: {turn.shape.detail}
        </Text>
      ) : null}
      {growthLine ? (
        <Text color={role.muted} wrap="truncate-end">
          context: {growthLine}
        </Text>
      ) : null}
      {growthLine ? (
        // Mandatory caveat: printed verbatim and allowed to wrap. Truncating a
        // caveat would leave the number standing without its qualification.
        <Text color={role.muted}>{CONTEXT_GROWTH_CAVEAT}</Text>
      ) : null}
      {steps.length === 0 ? (
        <Text color={role.muted}>(no steps)</Text>
      ) : (
        steps.slice(stepOff, stepOff + detailPageSize).map((step, i) => {
          const idx = stepOff + i;
          const sel = idx === stepSel && pane === "steps";
          const open = expanded.has(idx);
          return <StepRow key={idx} step={step} selected={sel} expanded={open} />;
        })
      )}
      <ScrollRange offset={stepOff} size={detailPageSize} total={steps.length} />
    </Box>
  );

  if (!wide) {
    return (
      <Box flexDirection="column">
        {master}
        <Box marginTop={1} flexDirection="column">
          {detail}
        </Box>
      </Box>
    );
  }
  return (
    <Box>
      <Box
        flexDirection="column"
        width={masterWidth(columns)}
        flexShrink={0}
        borderStyle="single"
        borderColor={palette.line}
        borderTop={false}
        borderBottom={false}
        borderLeft={false}
        paddingRight={1}
        marginRight={1}
      >
        {master}
      </Box>
      <Box flexDirection="column" flexGrow={1}>
        {detail}
      </Box>
    </Box>
  );
}

function StepRow({
  step,
  selected,
  expanded,
}: {
  step: TurnStep;
  selected: boolean;
  expanded: boolean;
}) {
  const hasDetail = Boolean(step.detail?.input || step.detail?.result);
  const chevron = hasDetail ? (expanded ? "▾" : "▸") : " ";
  const mark = step.status === "error" ? " ✗" : step.status === "ok" ? " ✓" : "";
  return (
    <Box flexDirection="column">
      <Text {...selection(selected)}>
        {chevron}{" "}
        <Text color={selected ? palette.bg : STEP_COLOR[step.kind]}>
          {STEP_ICON[step.kind]} {step.label}
        </Text>
        {step.summary ? <Text> {truncate(step.summary, 36)}</Text> : null}
        <Text color={selected ? palette.bg : step.status === "error" ? role.error : role.ok}>
          {mark}
        </Text>
      </Text>
      {expanded && hasDetail ? (
        <Box
          flexDirection="column"
          borderStyle="single"
          borderColor={palette.amber}
          borderTop={false}
          borderRight={false}
          borderBottom={false}
          paddingLeft={1}
          marginLeft={1}
        >
          {stepDetailLines(step).map((line, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static, order-stable detail lines
            <Text key={i} color={role.muted}>
              {line}
            </Text>
          ))}
        </Box>
      ) : null}
    </Box>
  );
}

function stepDetailLines(step: TurnStep): string[] {
  const isNote = step.kind === "note" || step.kind === "thinking";
  const out: string[] = [];
  if (step.detail?.input && !isNote) {
    out.push("input:");
    out.push(...capLines(step.detail.input, 12));
  }
  if (step.detail?.result) {
    out.push(isNote ? "full text:" : "result:");
    out.push(...capLines(step.detail.result, 12));
  }
  if (step.detail?.truncated) out.push("truncated · see transcript for full");
  return out;
}

function capLines(s: string, n: number): string[] {
  const lines = s.split("\n");
  if (lines.length <= n) return lines;
  return [...lines.slice(0, n), `… +${lines.length - n} more lines`];
}

function toggle<T>(set: Set<T>, value: T): Set<T> {
  const next = new Set(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

// The cache-hit chart's own row budget (`ChartsView` below): 4 rows × 4
// dot-rows/row = 16 levels across the 0–100% range, enough to show real
// variation instead of collapsing to a solid glyph above ~87.5% — the failure
// mode of the old fixed height-1 row (only 4 levels total). It competes with
// the context-window chart for the same space, so it only renders when the
// budget leaves the context chart at least its own floor.
const CACHE_CHART_ROWS = 4;
const MIN_CONTEXT_CHART_ROWS = 3;

/** Session charts: context-window sawtooth (▼ = compaction), cache hit rate,
 * cost per call, and per-turn cost — series shared with the web charts via
 * chart-series.ts. */
function ChartsView({ a, columns, rows }: { a: SessionAnalysis; columns: number; rows: number }) {
  const ctx = useMemo(() => buildContextSeries(a), [a]);
  const cache = useMemo(() => buildCacheSeries(ctx), [ctx]);
  const headroom = useMemo(() => projectHeadroom(ctx), [ctx]);
  const burn = useMemo(() => buildBurnSeries(a), [a]);
  const gaps = useMemo(() => buildGapMarkers(burn, a.totals.idlePeriods), [burn, a]);
  const turnSeries = useMemo(() => buildTurnSeries(a), [a]);
  const models = useMemo(() => modelMixRows(a), [a]);
  const subagents = useMemo(() => groupSidechainBursts(a.sidechainBursts), [a]);

  if (ctx.points.length === 0) {
    return <Text color={role.muted}>No main-chain API calls to chart.</Text>;
  }

  // Unlike the trends burn chart, this screen renders standalone with no nav
  // rail — only a small padding is needed to stay clear of the terminal edge
  // (a wrapped braille row destroys the whole layout).
  const CHART_MARGIN = 4;
  const width = Math.max(16, Math.min(columns - CHART_MARGIN, 120));
  const values = ctx.points.map((p) => p.contextTokens);

  // One canonical split (chart-series.ts): own compactions get ▼ markers;
  // subagent and inherited ones are labeled, never marked.
  const b = summarizeCompactions(a.compactions);
  const reclaimed = ctx.markers.reduce(
    (sum, m) => (m.reclaimed !== undefined ? sum + m.reclaimed : sum),
    0,
  );
  const hasReclaimed = ctx.markers.some((m) => m.reclaimed !== undefined);
  const compactions =
    (b.own.length === 0
      ? "no compactions"
      : `${b.own.length} compaction${b.own.length > 1 ? "s" : ""} (${b.own
          .map((c) => c.trigger ?? "?")
          .join(", ")})`) +
    (hasReclaimed ? ` (reclaimed ${formatCount(reclaimed)})` : "") +
    (b.inherited > 0 ? " · continued post-compaction" : "") +
    (b.sidechain > 0 ? ` · ${b.sidechain} subagent` : "");
  const totalCost = burn[burn.length - 1]?.cost ?? 0;
  const peakTurn = turnSeries.reduce(
    (best, t) => (t.cost > (turnSeries[best]?.cost ?? -1) ? t.index : best),
    0,
  );

  const limitLabel = ctx.contextLimit
    ? ` (${pctOfLimit(ctx.peakTokens, ctx.contextLimit)}% of ${formatCount(ctx.contextLimit)})`
    : "";
  const headroomLabel = headroom
    ? ` · ~${formatCount(headroom.callsToLimit)} calls to window (+${formatCount(
        Math.round(headroom.perCallTokens),
      )} tok/call)`
    : "";

  const totalGapMs = gaps.reduce((s, g) => s + g.durationMs, 0);
  const gapsLabel =
    gaps.length > 0
      ? ` · ${gaps.length} idle gap${gaps.length === 1 ? "" : "s"} (${formatDuration(totalGapMs)} idle)`
      : "";

  const flaggedTurns = turnSeries.filter((t) => turnFlags(t).length > 0).map((t) => t.index);
  // The sparkline underneath emits min(width, turns) characters, so the ▲ row
  // must use that SAME width or its markers land past the sparkline's end.
  const turnChartWidth = Math.min(width, turnSeries.length);
  const flagMarkers = markerRow(flaggedTurns, turnSeries.length, turnChartWidth, "▲");
  const showFlags = flaggedTurns.length > 0;

  const showModels = models.length > 1;
  const modelsLabel = models
    .map((m) => `${truncate(m.model, 22)} ${formatUSD(m.cost)} (${pct(m.share)})`)
    .join(" · ");

  const showSubagents = subagents.length > 0;
  const SUBAGENT_ROWS_SHOWN = 3;
  const subagentsLabel = subagents
    .slice(0, SUBAGENT_ROWS_SHOWN)
    .map((s) => `${s.type} ${formatUSD(s.cost)}/${s.apiCalls} call${s.apiCalls === 1 ? "" : "s"}`)
    .join(" · ");
  const subagentsMore =
    subagents.length > SUBAGENT_ROWS_SHOWN
      ? ` · +${subagents.length - SUBAGENT_ROWS_SHOWN} more`
      : "";

  const markers = markerRow(
    ctx.markers.map((m) => m.pos),
    ctx.points.length,
    width,
  );

  // Every line of this view EXCEPT the braille charts, as arrays — their
  // height is derived from these arrays' actual lengths, so a newly added or
  // toggled line shrinks a chart instead of overrunning the terminal and
  // corrupting the Ink frame. Only the screen chrome outside this component
  // (title, vitals band, tab row, margins, footer) remains a constant.
  const aboveChart = [
    <Text key="head" color={role.muted} wrap="truncate-end">
      context window · peak <Text color={role.accent}>{formatCount(ctx.peakTokens)} tokens</Text>
      {limitLabel} · {compactions}
      {headroomLabel}
    </Text>,
    ...(ctx.markers.length > 0
      ? [
          <Text key="markers" color={role.error}>
            {markers}
          </Text>,
          <Text key="markers-legend" color={role.muted}>
            ▼ = context compaction
          </Text>,
        ]
      : []),
  ];
  const axisLine = (
    <Text key="axis" color={role.muted}>
      call 1 {"─".repeat(Math.max(0, width - 13 - String(ctx.points.length).length))} call{" "}
      {ctx.points.length}
    </Text>
  );
  const modelsLines = showModels
    ? [
        <Text key="models" color={role.muted} wrap="truncate-end">
          models: {modelsLabel}
        </Text>,
      ]
    : [];
  const subagentsLines = showSubagents
    ? [
        <Text key="subagents" color={role.muted} wrap="truncate-end">
          subagents: {subagentsLabel}
          {subagentsMore}
        </Text>,
      ]
    : [];
  const restLines = [
    <Text key="blank"> </Text>,
    <Text key="burn-head" color={role.muted} wrap="truncate-end">
      cost per call{burn.length > width ? " (bucketed)" : ""} ·{" "}
      <Text color={role.cost}>{formatUSD(totalCost)}</Text> total
      {gapsLabel}
    </Text>,
    <Text key="burn-row" color={palette.amber}>
      {sparkline(
        burn.map((p) => p.callCost),
        width,
      )}
    </Text>,
    <Text key="turn-head" color={role.muted}>
      cost per turn{turnSeries.length > width ? " (bucketed)" : ""} · peak{" "}
      <Text color={role.cost}>{formatUSD(turnSeries[peakTurn]?.cost ?? 0)}</Text> (#
      {peakTurn + 1})
    </Text>,
    <Text key="turn-row" color={palette.amber}>
      {sparkline(
        turnSeries.map((t) => t.cost),
        width,
      )}
    </Text>,
    ...(showFlags
      ? [
          <Text key="flag-row" color={role.error}>
            {flagMarkers}
          </Text>,
          <Text key="flag-legend" color={role.muted}>
            ▲ = interrupted/correction/thrash turns ({flaggedTurns.length})
          </Text>,
        ]
      : []),
    // Mandatory caveat prints VERBATIM (wrap is fine, truncation is not) —
    // only when the session actually has corrections/interruptions to caveat.
    ...(a.correctionTurns > 0 || a.interruptionTurns > 0
      ? [
          <Text key="correction-caveat" color={role.muted}>
            {CORRECTION_CAVEAT}
          </Text>,
        ]
      : []),
  ];
  // Rows the enclosing screen spends around this view (title, vitals band,
  // tab row + margins, footer) — the one number left to keep in step with
  // SessionDetailScreen's frame, everything else is counted from the arrays.
  const SCREEN_CHROME_ROWS = 13;
  // What's left for the two braille charts to split, BEFORE deciding whether
  // the cache chart fits — every other line is fixed (axis + cache-head
  // always render; the rest are the conditional blocks above).
  const fixedBelowRows =
    1 /* axis */ +
    1 /* cache-head */ +
    modelsLines.length +
    subagentsLines.length +
    restLines.length;
  const available = Math.max(0, rows - SCREEN_CHROME_ROWS - aboveChart.length - fixedBelowRows);
  // A chart that cannot vary is worse than no chart: give the cache row real
  // height when the budget allows, and drop it entirely otherwise rather than
  // rendering the old always-solid height-1 version — the "cache hit N% · M
  // cold calls" text below already carries the number.
  const showCacheChart = available - CACHE_CHART_ROWS >= MIN_CONTEXT_CHART_ROWS;
  const chartH = Math.max(
    MIN_CONTEXT_CHART_ROWS,
    available - (showCacheChart ? CACHE_CHART_ROWS : 0),
  );
  // Ceiling at the window limit (like the web chart): the empty rows above
  // the sawtooth are the headroom signal.
  const chart = brailleChart(values, width, chartH, ctx.contextLimit);
  // A rate series needs a fixed 100 ceiling (so a flat 90% renders flat rather
  // than filling the chart) AND "min" bucketing. Height alone does not rescue
  // this chart: hit rates cluster in the 90s, so the *best* call in a
  // downsampled column is ~100% however bad its neighbours were, and max
  // bucketing paints a solid block at any height. The dips are the whole
  // signal here — a column shows its worst call, so a cache miss survives
  // downsampling the way a spend spike does on the charts above.
  const cacheChartRows = showCacheChart
    ? brailleChart(
        cache.points.map((p) => p.hitPct),
        width,
        CACHE_CHART_ROWS,
        100,
        "min",
      )
    : [];

  const belowChart = [
    axisLine,
    <Text key="cache-head" color={role.muted}>
      cache hit {cache.hitPct}% · {cache.coldCalls} cold call{cache.coldCalls === 1 ? "" : "s"}
      {showCacheChart ? " (y: 0–100%, worst call per column)" : ""}
    </Text>,
    ...cacheChartRows.map((line, i) => (
      // biome-ignore lint/suspicious/noArrayIndexKey: fixed-order chart rows
      <Text key={`cache-row-${i}`} color={palette.blue}>
        {line}
      </Text>
    )),
    ...modelsLines,
    ...subagentsLines,
    ...restLines,
  ];

  return (
    <Box flexDirection="column">
      {aboveChart}
      {chart.map((line, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: fixed-order chart rows
        <Text key={i} color={palette.amberDim}>
          {line}
        </Text>
      ))}
      {belowChart}
    </Box>
  );
}

function TranscriptView({ items, isActive }: { items: TranscriptItem[]; isActive: boolean }) {
  const [cursor, setCursor] = useState(0);
  const [offset, setOffset] = useState(0);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const activeCursor = Math.min(cursor, Math.max(0, items.length - 1));
  const pageSize = usePageSize(11);

  const select = (next: number) => {
    const n = Math.max(0, Math.min(next, items.length - 1));
    setCursor(n);
    setOffset(scrollOffset(n, offset, pageSize));
  };

  useInput(
    (input, key) => {
      if (key.return || input === " ") {
        const item = items[activeCursor];
        if (item?.body) setExpanded((prev) => toggle(prev, item.index));
        return;
      }
      if (input === "g") return select(0);
      if (input === "G") return select(items.length - 1);
      if (key.downArrow || input === "j") return select(activeCursor + 1);
      if (key.upArrow || input === "k") return select(activeCursor - 1);
    },
    { isActive },
  );

  const visible = items.slice(offset, offset + pageSize);
  return (
    <Box flexDirection="column">
      {visible.map((item, i) => {
        const selected = offset + i === activeCursor;
        const isOpen = expanded.has(item.index);
        const chevron = item.body ? (isOpen ? "▾" : "▸") : " ";
        const preview = item.body.split("\n")[0] ?? "";
        return (
          <Box key={item.index} flexDirection="column">
            <Text bold {...(selected ? selection(true) : { color: KIND_COLOR[item.kind] })}>
              {chevron} {item.label}
              {item.isError ? " ✗" : ""}
              {!isOpen && item.body ? (
                <Text color={selected ? palette.bg : role.muted}> {truncate(preview, 56)}</Text>
              ) : null}
            </Text>
            {isOpen && (
              <Box marginBottom={1}>
                <Text color={item.kind === "thinking" ? role.muted : undefined}>
                  {capLines(item.body, 40).join("\n") || "(empty)"}
                </Text>
              </Box>
            )}
          </Box>
        );
      })}
      <ScrollRange offset={offset} size={pageSize} total={items.length} />
    </Box>
  );
}

/**
 * "Analyze with Claude Code": runs a local `claude` headless over this session
 * (read-only, grounded in cc-analyzer's metrics) and streams the retrospective
 * into a scrollable pane. Opt-in (`r`) because the run costs real tokens.
 */
function ClaudeView({
  a,
  sessionPath,
  whatIf,
  isActive,
  rows,
}: {
  a: SessionAnalysis;
  sessionPath: string;
  whatIf: WhatIfRepricing | undefined;
  isActive: boolean;
  rows: number;
}) {
  const claudeBin = useMemo(() => resolveClaudeBinary(), []);
  const [model, setModel] = useState(() => getAnalysisModel());
  const [request, setRequest] = useState<{ id: number; model: string } | null>(null);
  const [output, setOutput] = useState("");
  const [cost, setCost] = useState<number | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [running, setRunning] = useState(false);
  const [scroll, setScroll] = useState(0);

  useInput(
    (input, key) => {
      if (running) return;
      if (input === "r") {
        setRequest((prev) => ({ id: (prev?.id ?? 0) + 1, model }));
        return;
      }
      if (input === "m") {
        const idx = ANALYSIS_MODELS.indexOf(model as (typeof ANALYSIS_MODELS)[number]);
        const next: string =
          ANALYSIS_MODELS[(idx + 1) % ANALYSIS_MODELS.length] ?? ANALYSIS_MODELS[0];
        setModel(next);
        setAnalysisModel(next);
        return;
      }
      if (key.upArrow || input === "k") return setScroll((s) => s + 1);
      if (key.downArrow || input === "j") return setScroll((s) => Math.max(0, s - 1));
    },
    { isActive },
  );

  // Keyed on `request` only — changing the model must not silently start a new
  // (billable) run. The run params are snapshotted into the request; `a`,
  // `whatIf`, `sessionPath`, and `claudeBin` are stable for the screen.
  useEffect(() => {
    if (!request) return;
    if (!claudeBin) {
      setError(CLAUDE_NOT_FOUND_MESSAGE);
      return;
    }
    let cancelled = false;
    let streamed = false;
    setOutput("");
    setCost(undefined);
    setError(undefined);
    setScroll(0);
    setRunning(true);
    (async () => {
      try {
        for await (const event of runClaudeAnalysis({
          claudeBin,
          sessionPath,
          analysis: a,
          model: request.model,
          whatIf,
        })) {
          if (cancelled) return;
          if (event.type === "text") {
            streamed = true;
            setOutput((prev) => prev + event.delta);
          } else if (event.type === "result") {
            if (!streamed && event.text) setOutput(event.text);
            setCost(event.costUsd);
          } else {
            setError(event.message);
          }
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setRunning(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [request, claudeBin, sessionPath, a, whatIf]);

  const lines = output ? output.split("\n") : [];
  const visibleRows = Math.max(3, rows - 12);
  const maxOffset = Math.max(0, lines.length - visibleRows);
  const off = Math.min(scroll, maxOffset);
  const start = Math.max(0, lines.length - visibleRows - off);
  const shown = lines.slice(start, start + visibleRows);

  return (
    <Box flexDirection="column">
      <Text color={role.muted}>
        Runs Claude Code locally over this session (read-only), grounded in the metrics above. A
        real Claude Code run — it costs tokens.
      </Text>
      <Box marginTop={1}>
        <Text>
          Model <Text color={role.heading}>{model}</Text>
          {"  ·  "}
          {running ? (
            <Text color={palette.amber}>analyzing…</Text>
          ) : request ? (
            <Text color={role.muted}>done (r to re-run)</Text>
          ) : (
            <Text color={role.muted}>press r to run</Text>
          )}
          {cost !== undefined ? (
            <Text color={role.muted}>{`  ·  run cost ${formatUSD(cost)}`}</Text>
          ) : null}
        </Text>
      </Box>
      {!claudeBin && (
        <Box marginTop={1}>
          <Text color={palette.red}>{CLAUDE_NOT_FOUND_MESSAGE}</Text>
        </Box>
      )}
      {error && (
        <Box marginTop={1}>
          <Text color={palette.red}>{error}</Text>
        </Box>
      )}
      {shown.length > 0 && (
        <Box marginTop={1} flexDirection="column">
          {shown.map((line, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: streamed log lines have no stable id; order is fixed
            <Text key={start + i}>{line || " "}</Text>
          ))}
        </Box>
      )}
    </Box>
  );
}

function SummaryView({ a, whatIf }: { a: SessionAnalysis; whatIf: WhatIfRepricing | undefined }) {
  const c = a.totals.cost;
  const est = c.estimated ? " (estimated)" : "";
  const diagnostics = buildSessionDiagnostics(a);
  // The shared row set (labels, order, absent-not-$0 rule) — same list the
  // CLI report and the web summary render.
  const outcomes = useMemo(() => outcomeRows(sessionOutcomes(a)), [a]);
  const burstNote = burstAttributionNote(a.sidechainBursts);
  const line = (k: string, v: string) => (
    <Text>
      {/* padEnd only helps up to 16 chars — the outcome rows carry a
       * parenthesized count and can run longer, so guarantee a gap. */}
      <Text color={role.muted}>{k.length >= 16 ? `${k} ` : k.padEnd(16)}</Text>
      <Text color={role.body}>{v}</Text>
    </Text>
  );
  // A non-null bestModel implies rows exist (repriceModelMixes nulls it for
  // an empty fold), so this is the one guard the section needs.
  const whatIfSummary = whatIf?.summary.bestModel ? whatIf.summary : undefined;
  return (
    <Box flexDirection="column">
      {line("project", a.projectPath ?? "?")}
      {line("cost", `${formatUSD(c.total)}${est}`)}
      {line("  input", formatUSD(c.input))}
      {line("  output", formatUSD(c.output))}
      {line("  cache write", formatUSD(c.cacheWrite))}
      {line("  cache read", formatUSD(c.cacheRead))}
      {line("tokens", formatTokens(ioTokens(a.totals.tokens), cacheTokens(a.totals.tokens)))}
      {line(
        "  input/output",
        `${formatCount(a.totals.tokens.inputTokens)} / ${formatCount(a.totals.tokens.outputTokens)}`,
      )}
      {line("turns", String(a.totals.turns))}
      {line("api calls", String(a.totals.apiCalls))}
      {line("tool calls", String(a.totals.toolCalls))}
      {line("duration", formatDuration(a.durationMs))}
      {line("models", Object.keys(a.models).join(", ") || "-")}
      {Object.keys(a.tools).length > 0 &&
        line(
          "tools",
          (() => {
            const sorted = Object.entries(a.tools).sort((x, y) => y[1] - x[1]);
            const shown = sorted.slice(0, 6).map(([tool, count]) => {
              const errs = a.toolErrors[tool] ?? 0;
              const pct = count > 0 ? `${Math.round((errs / count) * 100)}%` : "0%";
              return `${tool}:${count} (${errs} err ${pct})`;
            });
            const more = sorted.length > 6 ? ` +${sorted.length - 6} more` : "";
            return shown.join(" · ") + more || "-";
          })(),
        )}
      {Object.keys(a.skills).length > 0 && (
        <Box flexDirection="column">
          {line(
            "skills",
            (() => {
              const sorted = Object.entries(a.skills).sort((x, y) => y[1] - x[1]);
              const shown = sorted.slice(0, 6).map(([skill, uses]) => {
                const attr = a.skillTurnCosts[skill];
                const errs = a.skillErrors[skill] ?? 0;
                const errPct = uses > 0 ? `${Math.round((errs / uses) * 100)}%` : "0%";
                const cost = formatUSD(attr?.cost ?? 0);
                return `${skill}:${uses} (${attr?.turns ?? 0} turns ${cost} ${errs} err ${errPct})`;
              });
              const more = sorted.length > 6 ? ` +${sorted.length - 6} more` : "";
              return shown.join(" · ") + more || "-";
            })(),
          )}
          <Text color={role.muted}>{SKILL_COST_CAVEAT}</Text>
        </Box>
      )}
      {a.subagents.length > 0 && line("subagents", a.subagents.join(", "))}
      {/* Per-burst rows answer "which subagent burst cost $3", which the
       * type list above cannot. Rendered here rather than in the charts
       * pane because it is a table, not a series.
       *
       * Hard-capped: this pane is fixed-height with `overflow="hidden"` and no
       * scroll, and everything below it — the diagnostics block and the
       * mandatory OUTCOME/WHATIF caveats — would be clipped off-screen by a
       * subagent-heavy session, which is exactly the session this table exists
       * for. The charts pane caps its own subagent rows the same way. */}
      {a.sidechainBursts.length > 0 && (
        <Box flexDirection="column">
          {a.sidechainBursts.slice(0, BURST_ROWS_SHOWN).map((b, i) => (
            <Text key={b.agentId ?? `${b.startTime ?? "?"}-${i}`}>
              <Text color={role.muted}>{`  ${String(i + 1)}.`.padEnd(16)}</Text>
              <Text color={role.body}>
                {truncate(b.subagentType ?? "(unmatched)", 22).padEnd(23)}
                {(b.turnIndex !== undefined ? `#${b.turnIndex + 1}` : "-").padEnd(5)}
                {`${b.apiCalls} call${b.apiCalls === 1 ? "" : "s"}`.padEnd(10)}
              </Text>
              <Text color={role.cost}>{formatUSD(b.cost)}</Text>
            </Text>
          ))}
          {a.sidechainBursts.length > BURST_ROWS_SHOWN && (
            <Text color={role.muted}>
              {`  +${a.sidechainBursts.length - BURST_ROWS_SHOWN} more burst${
                a.sidechainBursts.length - BURST_ROWS_SHOWN === 1 ? "" : "s"
              } · see \`cc-analyzer analyze\` for the full table`}
            </Text>
          )}
          {burstNote && <Text color={role.muted}>{`  ${burstNote}`}</Text>}
        </Box>
      )}
      {a.compactions.length > 0 &&
        line(
          "compactions",
          `${a.compactions.length} (${a.compactions
            .map(
              (c) =>
                `${c.trigger ?? "?"}${c.isSidechain ? " subagent" : ""}${c.inherited ? " inherited" : ""}`,
            )
            .join(", ")})`,
        )}
      {line("files touched", String(a.filesTouched.length))}
      {/* Diagnostics sit right after the totals/header, above the outcome and
       * what-if sections, so a fixed-height pane on a small terminal never
       * clips them below the scroll fold. */}
      <Box marginTop={1} flexDirection="column">
        <Text color={role.heading}>Actionable diagnostics</Text>
        {diagnostics.length === 0 ? (
          <Text color={role.muted}>
            No notable context or cost patterns crossed the thresholds.
          </Text>
        ) : (
          diagnostics.map((diagnostic) => (
            <Box key={diagnostic.code} flexDirection="column" marginBottom={1}>
              <Text color={diagnostic.severity === "warning" ? palette.red : palette.blue}>
                {diagnostic.severity === "warning" ? "! " : "· "}
                {diagnostic.title}
              </Text>
              <Text color={role.body}>{diagnostic.evidence}</Text>
              <Text color={role.muted}>Next: {diagnostic.action}</Text>
            </Box>
          ))
        )}
      </Box>
      {outcomes.length > 0 && (
        <Box marginTop={1} flexDirection="column">
          <Text color={role.heading}>Cost per outcome</Text>
          {outcomes.map((r) => (
            <Box key={r.label}>{line(r.label, formatUSD(r.cost))}</Box>
          ))}
          {/* Mandatory caveats print VERBATIM — Ink wraps long lines. */}
          <Text color={role.muted}>{OUTCOME_CAVEAT}</Text>
        </Box>
      )}
      {whatIfSummary && (
        <Box marginTop={1} flexDirection="column">
          <Text color={role.muted}>
            what-if: cheapest single model{" "}
            <Text color={role.accent}>{whatIfSummary.bestModel}</Text> at{" "}
            <Text color={role.cost}>{formatUSD(whatIfSummary.bestCost)}</Text> (
            {formatSignedUSD(whatIfSummary.bestDelta)} vs actual)
          </Text>
          <Text color={role.muted}>{WHATIF_CAVEAT}</Text>
        </Box>
      )}
    </Box>
  );
}

function ExportView({
  analysis,
  transcript,
  events,
  coverage,
  errors,
  pricing,
  sessionId,
  isActive,
}: {
  analysis: SessionAnalysis;
  transcript: TranscriptItem[];
  events: import("../../core/events.ts").SessionEvent[];
  coverage: import("../../core/events.ts").ParseCoverage | undefined;
  errors: import("../../core/parser.ts").ParseError[];
  pricing: PricingTable;
  sessionId: string;
  isActive: boolean;
}) {
  const [format, setFormat] = useState<ExportFormat>("md");
  const [redact, setRedact] = useState(false);
  const [includeTranscript, setIncludeTranscript] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const ext = format === "md" ? ".md" : format === "html" ? ".html" : ".json";
  const filename = `cc-analyzer-${sanitizeFilename(sessionId)}${ext}`;

  const write = async () => {
    if (busy) return;
    setBusy(true);
    setStatus(null);
    try {
      const costBasis = getCostBasis();
      const whatIf = sessionWhatIf(analysis.models, pricing);
      const health = inspectSessionHealth(events, errors, coverage);
      let rank: ReturnType<typeof sessionCostRank> | null = null;
      try {
        const db = openDb();
        rank = sessionCostRank(db, sessionId) ?? null;
        db.close();
      } catch {
        // index unavailable — export without rank
      }
      // Cap transcript before builder/JSON to avoid DOS on huge sessions (same caps as CLI/Web)
      const cappedTranscript = transcript
        .slice(0, 600)
        .map((t) => ({ ...t, body: t.body.slice(0, 2000) }));
      const tx = includeTranscript ? cappedTranscript : undefined;
      let content: string;
      if (format === "md") {
        content = buildSessionMarkdown(analysis, {
          costBasis,
          whatIf,
          health,
          rank,
          redact,
          includeTranscript,
          transcript: tx,
        });
      } else if (format === "html") {
        content = buildSessionHtml(analysis, {
          costBasis,
          whatIf,
          health,
          rank,
          redact,
          includeTranscript,
          transcript: tx,
        });
      } else {
        const redactedTranscript = tx
          ? tx.map((t) => ({ ...t, body: redact ? "[redacted]" : t.body }))
          : undefined;
        const payload: Record<string, unknown> = {
          ...analysis,
          health,
          whatIf,
          rank,
          costBasis,
          ...(redact
            ? {
                title: "[redacted]",
                projectPath: "[redacted]",
                filesTouched: [],
                bashCommands: {},
                bashErrors: {},
                commandHeads: {},
                commandHeadErrors: {},
                turns: analysis.turns.map((t) => ({ ...t, prompt: "[redacted]" })),
              }
            : {}),
        };
        if (includeTranscript && redactedTranscript) payload.transcript = redactedTranscript;
        content = JSON.stringify(payload, null, 2);
      }
      await Bun.write(filename, content);
      setStatus(`Wrote ${filename} (${formatCount(content.length)} chars)`);
    } catch (err) {
      setStatus(`Failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  useInput(
    (input) => {
      if (input === "f") {
        setFormat((prev) => (prev === "md" ? "html" : prev === "html" ? "json" : "md"));
        setStatus(null);
      } else if (input === "r") {
        setRedact((prev) => !prev);
        setStatus(null);
      } else if (input === "t") {
        setIncludeTranscript((prev) => !prev);
        setStatus(null);
      } else if (input === "w") {
        void write();
      }
    },
    { isActive },
  );

  return (
    <Box flexDirection="column">
      <Text color={role.heading}>Export session</Text>
      <Text color={role.muted}>
        Same builders as CLI <Text color={role.accent}>analyze --md/--html/--json --out</Text> and
        Web Download — byte-identical reports.
      </Text>
      <Box marginTop={1} flexDirection="column">
        <Text>
          <Text color={role.muted}>format </Text>
          <Text color={role.accent}>{format}</Text>
          <Text color={role.muted}> (f to cycle md → html → json)</Text>
        </Text>
        <Text>
          <Text color={role.muted}>redact </Text>
          <Text color={redact ? palette.green : role.muted}>{redact ? "on" : "off"}</Text>
          <Text color={role.muted}> (r to toggle — hides prompt/transcript)</Text>
        </Text>
        <Text>
          <Text color={role.muted}>transcript </Text>
          <Text color={includeTranscript ? palette.green : role.muted}>
            {includeTranscript ? "included" : "omitted"}
          </Text>
          <Text color={role.muted}> (t to toggle — off by default)</Text>
        </Text>
        <Text color={role.muted}>file {filename}</Text>
      </Box>
      <Box marginTop={1}>
        <Text color={busy ? role.muted : palette.amber}>
          {busy ? "writing…" : "press w to write"}
        </Text>
      </Box>
      {status && (
        <Box marginTop={1}>
          <Text color={status.startsWith("Wrote") ? palette.green : palette.red}>{status}</Text>
        </Box>
      )}
      <Box marginTop={1} flexDirection="column">
        <Text color={role.muted}>f format · r redact · t transcript · w write · esc turns</Text>
      </Box>
    </Box>
  );
}
