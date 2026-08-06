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
  buildContextSeries,
  buildGapMarkers,
  buildTurnSeries,
  groupSidechainBursts,
  modelMixRows,
  pctOfLimit,
  projectHeadroom,
  summarizeCompactions,
  turnFlags,
} from "../../core/chart-series.ts";
import { parseSessionFile } from "../../core/parser.ts";
import { cacheTokens, ioTokens, type PricingTable } from "../../core/pricing.ts";
import type { IndexedSession } from "../../core/queries.ts";
import { buildSessionDiagnostics } from "../../core/session-diagnostics.ts";
import {
  OUTCOME_CAVEAT,
  outcomeRows,
  sessionOutcomes,
  sessionWhatIf,
} from "../../core/session-insights.ts";
import { WHATIF_CAVEAT, type WhatIfRepricing } from "../../core/stats-types.ts";
import type { TurnStep } from "../../core/steps.ts";
import { buildTranscript, type TranscriptItem } from "../../core/transcript.ts";
import { brailleChart, markerRow, sparkline } from "../charts.ts";
import { Loading, ScrollRange } from "../components/ui.tsx";
import { scrollOffset } from "../scroll.ts";
import { masterWidth } from "../shell/MasterDetail.tsx";
import { KIND_COLOR, palette, role, STEP_COLOR, STEP_ICON, selection } from "../theme.ts";
import { usePageSize } from "../usePageSize.ts";
import { layoutMode } from "../useTermSize.ts";

interface Props {
  session: IndexedSession;
  pricing: PricingTable;
  isActive: boolean;
  columns: number;
  rows: number;
  onBack: () => void;
}

type Mode = "turns" | "charts" | "transcript" | "summary";

interface Loaded {
  analysis: SessionAnalysis;
  transcript: TranscriptItem[];
}

export function SessionDetailScreen({ session, pricing, isActive, columns, rows, onBack }: Props) {
  const [data, setData] = useState<Loaded | null>(null);
  const [mode, setMode] = useState<Mode>("turns");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { events, coverage } = await parseSessionFile(session.path);
      const analysis = analyzeSession(events, pricing, { coverage });
      const transcript = buildTranscript(events);
      if (!cancelled) setData({ analysis, transcript });
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
      if (input === "u" || input === "1") return setMode("turns");
      if (input === "2") return setMode("charts");
      if (input === "3") return setMode("transcript");
      if (input === "4") return setMode("summary");
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
        {(["turns", "charts", "transcript", "summary"] as Mode[]).map((m) => (
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
      </Box>
      <Box marginTop={1}>
        <Text color={role.muted}>
          {mode === "turns"
            ? "↑↓ turn · →/tab steps · g/G jump · c charts · t transcript · s summary · esc back"
            : mode === "charts"
              ? "1-4 modes · esc turns"
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
  prompt: string;
  steps: TurnStep[];
}

function turnRows(a: SessionAnalysis): TurnRow[] {
  return a.turns.map((t) => ({
    index: t.index,
    cost: t.cost.total,
    calls: t.apiCalls.length,
    prompt: t.prompt,
    steps: t.apiCalls.flatMap((c) => c.steps),
  }));
}

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
  const rows = useMemo(() => turnRows(a), [a]);
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

  const selectStep = (next: number) => {
    const n = Math.max(0, Math.min(next, steps.length - 1));
    setStepSel(n);
    setStepOff(scrollOffset(n, stepOff, pageSize));
  };

  useInput(
    (input, key) => {
      if (pane === "turns") {
        if (key.downArrow || input === "j") return selectTurn(activeTurn + 1);
        if (key.upArrow || input === "k") return selectTurn(activeTurn - 1);
        if (input === "g") return selectTurn(0);
        if (input === "G") return selectTurn(rows.length - 1);
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

  const promptW = wide ? Math.max(8, masterWidth(columns) - 18) : 40;
  const master = (
    <Box flexDirection="column">
      <Text color={role.muted}>turns · {rows.length}</Text>
      {rows.slice(turnOff, turnOff + pageSize).map((r, i) => {
        const sel = turnOff + i === activeTurn;
        return (
          <Text key={r.index} {...selection(sel && pane === "turns")}>
            {sel && pane === "turns" ? "❯" : " "} #{r.index + 1} {formatUSD(r.cost).padStart(8)}{" "}
            {truncate(r.prompt || "(no text)", promptW)}
          </Text>
        );
      })}
      <ScrollRange offset={turnOff} size={pageSize} total={rows.length} />
    </Box>
  );

  const detail = (
    <Box flexDirection="column">
      <Text color={role.heading}>
        turn #{(turn?.index ?? 0) + 1} · {turn?.calls ?? 0} calls · {formatUSD(turn?.cost ?? 0)}
      </Text>
      {steps.length === 0 ? (
        <Text color={role.muted}>(no steps)</Text>
      ) : (
        steps.slice(stepOff, stepOff + pageSize).map((step, i) => {
          const idx = stepOff + i;
          const sel = idx === stepSel && pane === "steps";
          const open = expanded.has(idx);
          return <StepRow key={idx} step={step} selected={sel} expanded={open} />;
        })
      )}
      <ScrollRange offset={stepOff} size={pageSize} total={steps.length} />
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

  // Same horizontal margin the trends burn chart uses — a braille row that
  // wraps destroys the whole layout, so stay well inside the terminal.
  const width = Math.max(16, Math.min(columns - 18, 120));
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
  // A rate series must not be bucket-SUMMED (sparkline's downsampling — right
  // for cost, wrong for percentages): a one-row braille chart buckets by MAX
  // and takes 100 as its fixed ceiling, so a flat 90% renders flat.
  const cacheRow = brailleChart(
    cache.points.map((p) => p.hitPct),
    width,
    1,
    100,
  )[0];

  // Every line of this view EXCEPT the braille chart, as arrays — the chart's
  // height is derived from their actual lengths, so a newly added or toggled
  // line shrinks the chart instead of overrunning the terminal and corrupting
  // the Ink frame. Only the screen chrome outside this component (title,
  // vitals band, tab row, margins, footer) remains a constant.
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
        ]
      : []),
  ];
  const belowChart = [
    <Text key="axis" color={role.muted}>
      call 1 {"─".repeat(Math.max(0, width - 14 - String(ctx.points.length).length))} call{" "}
      {ctx.points.length}
    </Text>,
    <Text key="cache-head" color={role.muted}>
      cache hit {cache.hitPct}% · {cache.coldCalls} cold call{cache.coldCalls === 1 ? "" : "s"}
    </Text>,
    <Text key="cache-row" color={palette.blue}>
      {cacheRow}
    </Text>,
    ...(showModels
      ? [
          <Text key="models" color={role.muted} wrap="truncate-end">
            models: {modelsLabel}
          </Text>,
        ]
      : []),
    ...(showSubagents
      ? [
          <Text key="subagents" color={role.muted} wrap="truncate-end">
            subagents: {subagentsLabel}
            {subagentsMore}
          </Text>,
        ]
      : []),
    <Text key="blank"> </Text>,
    <Text key="burn-head" color={role.muted} wrap="truncate-end">
      cost per call · <Text color={role.cost}>{formatUSD(totalCost)}</Text> total
      {gapsLabel}
    </Text>,
    <Text key="burn-row" color={palette.amber}>
      {sparkline(
        burn.map((p) => p.callCost),
        width,
      )}
    </Text>,
    <Text key="turn-head" color={role.muted}>
      cost per turn · peak{" "}
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
  ];
  // Rows the enclosing screen spends around this view (title, vitals band,
  // tab row + margins, footer) — the one number left to keep in step with
  // SessionDetailScreen's frame, everything else is counted from the arrays.
  const SCREEN_CHROME_ROWS = 13;
  const chartH = Math.max(3, rows - SCREEN_CHROME_ROWS - aboveChart.length - belowChart.length);
  // Ceiling at the window limit (like the web chart): the empty rows above
  // the sawtooth are the headroom signal.
  const chart = brailleChart(values, width, chartH, ctx.contextLimit);

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

function SummaryView({ a, whatIf }: { a: SessionAnalysis; whatIf: WhatIfRepricing | undefined }) {
  const c = a.totals.cost;
  const est = c.estimated ? " (estimated)" : "";
  const diagnostics = buildSessionDiagnostics(a);
  // The shared row set (labels, order, absent-not-$0 rule) — same list the
  // CLI report and the web summary render.
  const outcomes = useMemo(() => outcomeRows(sessionOutcomes(a)), [a]);
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
      {line(
        "tools",
        Object.entries(a.tools)
          .map(([t, n]) => `${t}:${n}`)
          .join(" ") || "-",
      )}
      {Object.keys(a.skills).length > 0 &&
        line(
          "skills",
          Object.entries(a.skills)
            .map(([s, n]) => `${s}:${n}`)
            .join(" "),
        )}
      {a.subagents.length > 0 && line("subagents", a.subagents.join(", "))}
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
    </Box>
  );
}
