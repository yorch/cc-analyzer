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
import type { StepKind, TurnStep } from "../../core/steps.ts";
import {
  buildTranscript,
  type TranscriptItem,
  type TranscriptKind,
} from "../../core/transcript.ts";

interface Props {
  session: IndexedSession;
  pricing: PricingTable;
  isActive: boolean;
  onBack: () => void;
}

type Tab = "summary" | "turns" | "transcript";
const TABS: Tab[] = ["summary", "turns", "transcript"];
const PAGE_SIZE = 16;

interface Loaded {
  analysis: SessionAnalysis;
  transcript: TranscriptItem[];
}

const KIND_COLOR: Record<TranscriptKind, string> = {
  prompt: "green",
  text: "white",
  thinking: "gray",
  tool_use: "yellow",
  tool_result: "blue",
};

export function SessionDetailScreen({ session, pricing, isActive, onBack }: Props) {
  const [data, setData] = useState<Loaded | null>(null);
  const [tab, setTab] = useState<Tab>("summary");

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

  useInput(
    (input, key) => {
      if (key.escape) return onBack();
      if (input === "1" || input === "s") return setTab("summary");
      if (input === "2" || input === "t") return setTab("turns");
      if (input === "3" || input === "r") return setTab("transcript");
      if (key.tab) setTab(TABS[(TABS.indexOf(tab) + 1) % TABS.length] as Tab);
    },
    { isActive },
  );

  if (!data) return <Text dimColor>Loading session…</Text>;
  const { analysis } = data;

  return (
    <Box flexDirection="column">
      <Text bold color="cyan">
        {truncate(analysis.title ?? session.sessionId ?? "(untitled)", 70)}
      </Text>
      <Box>
        {TABS.map((t) => (
          <Text
            key={t}
            color={t === tab ? "black" : "gray"}
            backgroundColor={t === tab ? "cyan" : undefined}
          >
            {" "}
            {t}{" "}
          </Text>
        ))}
      </Box>
      <Box marginTop={1} flexDirection="column">
        {tab === "summary" && <SummaryView a={analysis} />}
        {tab === "turns" && <TurnsView a={analysis} isActive={isActive} />}
        {tab === "transcript" && <TranscriptView items={data.transcript} isActive={isActive} />}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>1/2/3 or tab switch · ↑/↓ move · enter expand · esc back · ctrl-c quit</Text>
      </Box>
    </Box>
  );
}

function SummaryView({ a }: { a: SessionAnalysis }) {
  const c = a.totals.cost;
  const est = c.estimated ? " (estimated)" : "";
  const line = (k: string, v: string) => (
    <Text>
      <Text dimColor>{k.padEnd(16)}</Text>
      {v}
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

const STEP_ICON: Record<StepKind, string> = {
  note: "»",
  thinking: "◦",
  run: "$",
  read: "▤",
  edit: "✎",
  search: "⌕",
  skill: "◆",
  subagent: "⌥",
  web: "◍",
  task: "☑",
  ask: "?",
  tool: "·",
};
const STEP_COLOR: Record<StepKind, string> = {
  note: "white",
  thinking: "gray",
  run: "yellow",
  read: "gray",
  edit: "cyan",
  search: "yellow",
  skill: "magenta",
  subagent: "cyan",
  web: "blue",
  task: "gray",
  ask: "yellow",
  tool: "gray",
};

type TRow =
  | {
      kind: "turn";
      actionable: true;
      index: number;
      cost: number;
      tokens: string;
      calls: number;
      prompt: string;
      expandable: boolean;
      expanded: boolean;
    }
  | { kind: "call"; actionable: false; model: string; cost: number; tokens: string }
  | {
      kind: "step";
      actionable: true;
      id: string;
      step: TurnStep;
      expandable: boolean;
      expanded: boolean;
    }
  | { kind: "detail"; actionable: false; text: string };

/** Flatten turns → calls → steps → step detail into visible rows, honoring the
 * collapsed/expanded state. Turns are collapsed by default. */
function buildRows(
  a: SessionAnalysis,
  openTurns: Set<number>,
  openSteps: Set<string>,
): { rows: TRow[]; actionable: number[] } {
  const rows: TRow[] = [];
  for (const t of a.turns) {
    const hasSteps = t.apiCalls.some((c) => c.steps.length > 0);
    const turnOpen = openTurns.has(t.index);
    rows.push({
      kind: "turn",
      actionable: true,
      index: t.index,
      cost: t.cost.total,
      tokens: formatTokens(ioTokens(t.tokens), cacheTokens(t.tokens)),
      calls: t.apiCalls.length,
      prompt: t.prompt,
      expandable: hasSteps,
      expanded: turnOpen,
    });
    if (!turnOpen) continue;
    t.apiCalls.forEach((call, ci) => {
      if (call.steps.length === 0) return;
      rows.push({
        kind: "call",
        actionable: false,
        model: call.model ?? "?",
        cost: call.cost.total,
        tokens: formatTokens(ioTokens(call.tokens), cacheTokens(call.tokens)),
      });
      call.steps.forEach((step, si) => {
        const id = `${t.index}:${ci}:${si}`;
        const hasDetail = Boolean(step.detail?.input || step.detail?.result);
        const stepOpen = openSteps.has(id);
        rows.push({
          kind: "step",
          actionable: true,
          id,
          step,
          expandable: hasDetail,
          expanded: stepOpen,
        });
        if (stepOpen && hasDetail) {
          for (const text of stepDetailLines(step))
            rows.push({ kind: "detail", actionable: false, text });
        }
      });
    });
  }
  const actionable = rows.map((r, i) => (r.actionable ? i : -1)).filter((i) => i >= 0);
  return { rows, actionable };
}

function stepDetailLines(step: TurnStep): string[] {
  const isNote = step.kind === "note" || step.kind === "thinking";
  const out: string[] = [];
  if (step.detail?.input && !isNote) {
    out.push("input:");
    out.push(...capLines(step.detail.input, 10));
  }
  if (step.detail?.result) {
    out.push(isNote ? "full text:" : "result:");
    out.push(...capLines(step.detail.result, 10));
  }
  if (step.detail?.truncated) out.push("truncated · see Transcript for full");
  return out;
}

function capLines(s: string, n: number): string[] {
  const lines = s.split("\n");
  if (lines.length <= n) return lines;
  return [...lines.slice(0, n), `… +${lines.length - n} more lines`];
}

function TurnsView({ a, isActive }: { a: SessionAnalysis; isActive: boolean }) {
  const [openTurns, setOpenTurns] = useState<Set<number>>(new Set());
  const [openSteps, setOpenSteps] = useState<Set<string>>(new Set());
  const [sel, setSel] = useState(0);
  const [offset, setOffset] = useState(0);

  const { rows, actionable } = useMemo(
    () => buildRows(a, openTurns, openSteps),
    [a, openTurns, openSteps],
  );
  const activeSel = Math.min(sel, Math.max(0, actionable.length - 1));
  const selectedRow = actionable[activeSel] ?? -1;

  useInput(
    (input, key) => {
      if (key.return || input === " ") {
        const row = rows[selectedRow];
        if (row?.kind === "turn" && row.expandable) {
          setOpenTurns((prev) => toggle(prev, row.index));
        } else if (row?.kind === "step" && row.expandable) {
          setOpenSteps((prev) => toggle(prev, row.id));
        }
        return;
      }
      if (input === "g") {
        setSel(0);
        setOffset(0);
        return;
      }
      if (input === "G") {
        setSel(actionable.length - 1);
        setOffset(Math.max(0, rows.length - PAGE_SIZE));
        return;
      }
      const dir = key.downArrow || input === "j" ? 1 : key.upArrow || input === "k" ? -1 : 0;
      if (dir === 0 || actionable.length === 0) return;
      const nextSel = Math.max(0, Math.min(activeSel + dir, actionable.length - 1));
      setSel(nextSel);
      const rowIdx = actionable[nextSel] ?? 0;
      if (rowIdx < offset) setOffset(rowIdx);
      else if (rowIdx >= offset + PAGE_SIZE) setOffset(rowIdx - PAGE_SIZE + 1);
    },
    { isActive },
  );

  const visible = rows.slice(offset, offset + PAGE_SIZE);
  return (
    <Box flexDirection="column">
      {visible.map((row, i) => {
        const rowIndex = offset + i;
        const selected = rowIndex === selectedRow;
        return <RowView key={rowIndex} row={row} selected={selected} />;
      })}
      {rows.length > PAGE_SIZE && (
        <Text dimColor>
          {offset + 1}–{Math.min(offset + PAGE_SIZE, rows.length)} / {rows.length}
        </Text>
      )}
    </Box>
  );
}

function RowView({ row, selected }: { row: TRow; selected: boolean }) {
  if (row.kind === "turn") {
    const chevron = row.expandable ? (row.expanded ? "▾" : "▸") : " ";
    return (
      <Text
        bold
        color={selected ? "black" : undefined}
        backgroundColor={selected ? "cyan" : undefined}
      >
        {chevron} #{row.index + 1} {formatUSD(row.cost).padStart(9)}{" "}
        <Text dimColor={!selected}>{row.tokens} </Text>
        {row.calls}c {truncate(row.prompt || "(no text)", 40)}
      </Text>
    );
  }
  if (row.kind === "call") {
    return (
      <Text dimColor>
        {"    "}
        {row.model} · {formatUSD(row.cost)} · {row.tokens}
      </Text>
    );
  }
  if (row.kind === "step") {
    const { step } = row;
    const chevron = row.expandable ? (row.expanded ? "▾" : "▸") : " ";
    const mark = step.status === "error" ? " ✗" : step.status === "ok" ? " ✓" : "";
    return (
      <Text color={selected ? "black" : undefined} backgroundColor={selected ? "cyan" : undefined}>
        {"  "}
        {chevron}{" "}
        <Text color={selected ? "black" : STEP_COLOR[step.kind]}>
          {STEP_ICON[step.kind]} {step.label}
        </Text>
        {step.summary ? <Text> {truncate(step.summary, 40)}</Text> : null}
        <Text color={selected ? "black" : step.status === "error" ? "red" : "green"}>{mark}</Text>
        {step.resultHint ? (
          <Text dimColor={!selected}> {truncate(step.resultHint, 20)}</Text>
        ) : null}
      </Text>
    );
  }
  return (
    <Text dimColor>
      {"      │ "}
      {truncate(row.text, 68)}
    </Text>
  );
}

function toggle<T>(set: Set<T>, value: T): Set<T> {
  const next = new Set(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

function TranscriptView({ items, isActive }: { items: TranscriptItem[]; isActive: boolean }) {
  const [offset, setOffset] = useState(0);
  useInput(
    (input, key) => {
      if (key.downArrow || input === "j")
        setOffset((o) => Math.min(o + 1, Math.max(0, items.length - 1)));
      else if (key.upArrow || input === "k") setOffset((o) => Math.max(0, o - 1));
      else if (input === "g") setOffset(0);
      else if (input === "G") setOffset(Math.max(0, items.length - PAGE_SIZE));
    },
    { isActive },
  );

  const visible = items.slice(offset, offset + PAGE_SIZE);
  return (
    <Box flexDirection="column">
      {visible.map((item) => {
        const body = item.body.split("\n").slice(0, 4).join("\n");
        const more = item.body.split("\n").length > 4 ? " …" : "";
        return (
          <Box key={item.index} flexDirection="column" marginBottom={1}>
            <Text color={KIND_COLOR[item.kind]} bold>
              {item.label}
              {item.isError ? " ✗" : ""}
            </Text>
            <Text color={item.kind === "thinking" ? "gray" : undefined}>
              {truncate(body, 320)}
              {more}
            </Text>
          </Box>
        );
      })}
      {items.length > PAGE_SIZE && (
        <Text dimColor>
          {offset + 1}–{Math.min(offset + PAGE_SIZE, items.length)} / {items.length}
        </Text>
      )}
    </Box>
  );
}
