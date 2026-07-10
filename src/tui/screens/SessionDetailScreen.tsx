import { Box, Text, useInput } from "ink";
import { useEffect, useState } from "react";
import { formatDuration, formatUSD, truncate } from "../../cli/format.ts";
import type { SessionAnalysis } from "../../core/analyze.ts";
import { analyzeSession } from "../../core/analyze.ts";
import { parseSessionFile } from "../../core/parser.ts";
import type { PricingTable } from "../../core/pricing.ts";
import type { IndexedSession } from "../../core/queries.ts";
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

  const rows =
    tab === "transcript" ? (data?.transcript.length ?? 0) : (data?.analysis.turns.length ?? 0);
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
        {tab === "turns" && <TurnsView a={analysis} offset={offset} pageSize={pageSize} />}
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

function TurnsView({
  a,
  offset,
  pageSize,
}: {
  a: SessionAnalysis;
  offset: number;
  pageSize: number;
}) {
  const visible = a.turns.slice(offset, offset + pageSize);
  return (
    <Box flexDirection="column">
      {visible.map((t) => (
        <Text key={t.index}>
          <Text dimColor>{String(t.index + 1).padStart(3)} </Text>
          {formatUSD(t.cost.total).padStart(9)} {String(t.apiCalls.length).padStart(3)}c{"  "}
          {truncate(t.prompt || "(no text)", 58)}
        </Text>
      ))}
      {a.turns.length > pageSize && (
        <Text dimColor>
          {offset + 1}–{Math.min(offset + pageSize, a.turns.length)} / {a.turns.length}
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
