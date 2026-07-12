import { Box, Text, useInput } from "ink";
import { useEffect, useMemo, useState } from "react";
import {
  formatCount,
  formatDuration,
  formatTokens,
  formatUSD,
  truncate,
} from "../../cli/format.ts";
import type { SessionAnalysis } from "../../core/analyze.ts";
import { analyzeSession } from "../../core/analyze.ts";
import { parseSessionFile } from "../../core/parser.ts";
import { cacheTokens, ioTokens, type PricingTable } from "../../core/pricing.ts";
import type { IndexedSession } from "../../core/queries.ts";
import type { TurnStep } from "../../core/steps.ts";
import { buildTranscript, type TranscriptItem } from "../../core/transcript.ts";
import { Loading } from "../components/ui.tsx";
import { masterWidth } from "../shell/MasterDetail.tsx";
import { KIND_COLOR, palette, role, STEP_COLOR, STEP_ICON, selection } from "../theme.ts";
import { usePageSize } from "../usePageSize.ts";
import { layoutMode } from "../useTermSize.ts";

interface Props {
  session: IndexedSession;
  pricing: PricingTable;
  isActive: boolean;
  columns: number;
  onBack: () => void;
}

type Mode = "turns" | "transcript" | "summary";

interface Loaded {
  analysis: SessionAnalysis;
  transcript: TranscriptItem[];
}

export function SessionDetailScreen({ session, pricing, isActive, columns, onBack }: Props) {
  const [data, setData] = useState<Loaded | null>(null);
  const [mode, setMode] = useState<Mode>("turns");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { events } = await parseSessionFile(session.path);
      const analysis = analyzeSession(events, pricing);
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
      if (input === "u" || input === "1") return setMode("turns");
      if (input === "2") return setMode("transcript");
      if (input === "3") return setMode("summary");
      if (key.escape && mode !== "turns") return setMode("turns");
    },
    { isActive: isActive && !!data },
  );

  if (!data) return <Loading label="Loading session" />;
  const { analysis } = data;

  return (
    <Box flexDirection="column">
      <Text bold color={role.heading}>
        {truncate(analysis.title ?? session.sessionId ?? "(untitled)", 70)}
      </Text>
      <SummaryBand a={analysis} />
      <Box marginTop={1}>
        {(["turns", "transcript", "summary"] as Mode[]).map((m) => (
          <Text key={m} {...(m === mode ? selection(true) : { color: role.muted })}>
            {" "}
            {m}{" "}
          </Text>
        ))}
      </Box>
      <Box marginTop={1} flexDirection="column">
        {mode === "turns" && (
          <TurnsPane a={analysis} columns={columns} isActive={isActive} onBack={onBack} />
        )}
        {mode === "transcript" && <TranscriptView items={data.transcript} isActive={isActive} />}
        {mode === "summary" && <SummaryView a={analysis} />}
      </Box>
      <Box marginTop={1}>
        <Text color={role.muted}>
          {mode === "turns"
            ? "↑↓ turn · →/tab steps · t transcript · s summary · esc back"
            : "↑↓ move · ↵ expand · esc turns · "}
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
    if (n < turnOff) setTurnOff(n);
    else if (n >= turnOff + pageSize) setTurnOff(n - pageSize + 1);
    setStepSel(0);
    setStepOff(0);
    setExpanded(new Set());
  };

  useInput(
    (input, key) => {
      if (pane === "turns") {
        if (key.downArrow || input === "j") return selectTurn(activeTurn + 1);
        if (key.upArrow || input === "k") return selectTurn(activeTurn - 1);
        if ((key.rightArrow || key.tab || key.return) && steps.length > 0) return setPane("steps");
        if (key.escape) return onBack();
        return;
      }
      // pane === "steps"
      if (key.leftArrow || (key.tab && key.shift) || key.escape) return setPane("turns");
      if (key.downArrow || input === "j") {
        const n = Math.min(stepSel + 1, steps.length - 1);
        setStepSel(n);
        if (n >= stepOff + pageSize) setStepOff(n - pageSize + 1);
        return;
      }
      if (key.upArrow || input === "k") {
        const n = Math.max(stepSel - 1, 0);
        setStepSel(n);
        if (n < stepOff) setStepOff(n);
        return;
      }
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

function TranscriptView({ items, isActive }: { items: TranscriptItem[]; isActive: boolean }) {
  const [cursor, setCursor] = useState(0);
  const [offset, setOffset] = useState(0);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const activeCursor = Math.min(cursor, Math.max(0, items.length - 1));
  const pageSize = usePageSize(11);

  useInput(
    (input, key) => {
      if (key.return || input === " ") {
        const item = items[activeCursor];
        if (item?.body) setExpanded((prev) => toggle(prev, item.index));
        return;
      }
      if (input === "g") {
        setCursor(0);
        setOffset(0);
        return;
      }
      if (input === "G") {
        setCursor(items.length - 1);
        setOffset(Math.max(0, items.length - pageSize));
        return;
      }
      const dir = key.downArrow || input === "j" ? 1 : key.upArrow || input === "k" ? -1 : 0;
      if (dir === 0 || items.length === 0) return;
      const next = Math.max(0, Math.min(activeCursor + dir, items.length - 1));
      setCursor(next);
      if (next < offset) setOffset(next);
      else if (next >= offset + pageSize) setOffset(next - pageSize + 1);
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
      {items.length > pageSize && (
        <Text color={role.muted}>
          {offset + 1}–{Math.min(offset + pageSize, items.length)} / {items.length}
        </Text>
      )}
    </Box>
  );
}

function SummaryView({ a }: { a: SessionAnalysis }) {
  const c = a.totals.cost;
  const est = c.estimated ? " (estimated)" : "";
  const line = (k: string, v: string) => (
    <Text>
      <Text color={role.muted}>{k.padEnd(16)}</Text>
      <Text color={role.body}>{v}</Text>
    </Text>
  );
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
      {a.skills.length > 0 && line("skills", a.skills.join(", "))}
      {a.subagents.length > 0 && line("subagents", a.subagents.join(", "))}
      {line("files touched", String(a.filesTouched.length))}
    </Box>
  );
}
