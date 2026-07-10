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
  const [offset, setOffset] = useState(0);

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

  const turnRows = useMemo(() => (data ? buildTurnRows(data.analysis) : []), [data]);
  const rows =
    tab === "transcript" ? (data?.transcript.length ?? 0) : tab === "turns" ? turnRows.length : 0;
  const pageSize = 16;

  const goTab = (t: Tab) => {
    setTab(t);
    setOffset(0);
  };

  useInput(
    (input, key) => {
      if (key.escape) return onBack();
      if (input === "1" || input === "s") return goTab("summary");
      if (input === "2" || input === "t") return goTab("turns");
      if (input === "3" || input === "r") return goTab("transcript");
      if (key.tab) {
        const idx = TABS.indexOf(tab);
        goTab(TABS[(idx + 1) % TABS.length] as Tab);
        return;
      }
      if (key.downArrow || input === "j") setOffset((o) => Math.min(o + 1, Math.max(0, rows - 1)));
      else if (key.upArrow || input === "k") setOffset((o) => Math.max(0, o - 1));
      else if (input === "G") setOffset(Math.max(0, rows - pageSize));
      else if (input === "g") setOffset(0);
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
        {tab === "turns" && <TurnsView rows={turnRows} offset={offset} pageSize={pageSize} />}
        {tab === "transcript" && (
          <TranscriptView items={data.transcript} offset={offset} pageSize={pageSize} />
        )}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>1/2/3 or tab switch · ↑/↓ scroll · esc back · ctrl-c quit</Text>
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

type TurnRow =
  | { type: "turn"; index: number; cost: number; tokens: string; calls: number; prompt: string }
  | { type: "call"; model: string; cost: number; tokens: string }
  | { type: "step"; step: TurnStep };

/** Flatten turns → api-call dividers → step rows for a scrollable timeline. */
function buildTurnRows(a: SessionAnalysis): TurnRow[] {
  const rows: TurnRow[] = [];
  for (const t of a.turns) {
    rows.push({
      type: "turn",
      index: t.index,
      cost: t.cost.total,
      tokens: formatTokens(ioTokens(t.tokens), cacheTokens(t.tokens)),
      calls: t.apiCalls.length,
      prompt: t.prompt,
    });
    for (const call of t.apiCalls) {
      if (call.steps.length === 0) continue;
      rows.push({
        type: "call",
        model: call.model ?? "?",
        cost: call.cost.total,
        tokens: formatTokens(ioTokens(call.tokens), cacheTokens(call.tokens)),
      });
      for (const step of call.steps) rows.push({ type: "step", step });
    }
  }
  return rows;
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

function TurnsView({
  rows,
  offset,
  pageSize,
}: {
  rows: TurnRow[];
  offset: number;
  pageSize: number;
}) {
  const visible = rows.slice(offset, offset + pageSize);
  return (
    <Box flexDirection="column">
      {visible.map((row, i) => {
        const key = offset + i;
        if (row.type === "turn") {
          return (
            <Text key={key} bold>
              <Text color="cyan">
                #{row.index + 1} {formatUSD(row.cost).padStart(9)}{" "}
              </Text>
              <Text dimColor>{row.tokens} </Text>
              <Text color="cyan">{row.calls}c </Text>
              {truncate(row.prompt || "(no text)", 44)}
            </Text>
          );
        }
        if (row.type === "call") {
          return (
            <Text key={key} dimColor>
              {"  "}
              {row.model} · {formatUSD(row.cost)} · {row.tokens}
            </Text>
          );
        }
        const { step } = row;
        const mark = step.status === "error" ? " ✗" : step.status === "ok" ? " ✓" : "";
        return (
          <Text key={key}>
            {"   "}
            <Text color={STEP_COLOR[step.kind]}>
              {STEP_ICON[step.kind]} {step.label}
            </Text>
            {step.summary ? <Text> {truncate(step.summary, 46)}</Text> : null}
            <Text color={step.status === "error" ? "red" : "green"}>{mark}</Text>
            {step.resultHint ? <Text dimColor> {truncate(step.resultHint, 24)}</Text> : null}
          </Text>
        );
      })}
      {rows.length > pageSize && (
        <Text dimColor>
          {offset + 1}–{Math.min(offset + pageSize, rows.length)} / {rows.length}
        </Text>
      )}
    </Box>
  );
}

function TranscriptView({
  items,
  offset,
  pageSize,
}: {
  items: TranscriptItem[];
  offset: number;
  pageSize: number;
}) {
  const visible = items.slice(offset, offset + pageSize);
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
      {items.length > pageSize && (
        <Text dimColor>
          {offset + 1}–{Math.min(offset + pageSize, items.length)} / {items.length}
        </Text>
      )}
    </Box>
  );
}
