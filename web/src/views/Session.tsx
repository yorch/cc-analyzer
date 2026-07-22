import { type ReactNode, useEffect, useMemo, useState } from "react";
import {
  api,
  type SessionAnalysis,
  type TranscriptItem,
  type Turn,
  type TurnStep,
  topEntries,
} from "../api.ts";
import { Card } from "../Card.tsx";
import { count, duration, tokensOf, usd } from "../format.ts";
import { link } from "../router.ts";
import { SessionCharts } from "../SessionCharts.tsx";
import { useAsync } from "../useAsync.ts";

type Tab = "summary" | "charts" | "timeline" | "turns" | "transcript";

export function Session({ id }: { id: string }) {
  const [tab, setTab] = useState<Tab>("summary");
  // Sticky once the transcript tab has been opened, so switching tabs doesn't
  // refetch — but the (potentially huge) transcript is never fetched eagerly.
  // Derived from `tab` in an effect so any way of reaching the tab (deep link,
  // keyboard) latches it, not just the tab button's onClick.
  const [transcriptWanted, setTranscriptWanted] = useState(false);
  useEffect(() => {
    if (tab === "transcript") setTranscriptWanted(true);
  }, [tab]);
  const analysis = useAsync(() => api.session(id), [id]);
  const transcript = useAsync(
    () => (transcriptWanted ? api.transcript(id) : Promise.resolve(null)),
    [id, transcriptWanted],
  );

  if (analysis.loading) return <div className="loading">Loading session…</div>;
  if (analysis.error) return <div className="loading err">Error: {analysis.error}</div>;
  const a = analysis.data;
  if (!a) return null;
  const c = a.totals.cost;

  return (
    <>
      <div className="crumbs">
        <a href={link.dashboard()}>Dashboard</a>
        {a.projectPath && " · "}
        <span className="muted">{a.projectPath}</span>
      </div>
      <header className="top">
        <h1>{a.title ?? a.sessionId ?? "(untitled)"}</h1>
      </header>

      <div className="cards">
        <Card label="Cost" value={usd(c.total)} sub={c.estimated ? "estimated" : undefined} />
        <Card label="Tokens" value={tokensOf(a.totals.tokens)} />
        <Card label="Turns" value={String(a.totals.turns)} sub={`${a.totals.apiCalls} api calls`} />
        <Card label="Tool calls" value={String(a.totals.toolCalls)} />
        <Card
          label="Duration"
          value={duration(a.durationMs)}
          sub={`${duration(a.totals.activeMs)} active`}
        />
        {a.totals.sidechainCost > 0 && (
          <Card
            label="Subagents"
            value={usd(a.totals.sidechainCost)}
            sub={`${a.totals.sidechainApiCalls} sidechain calls`}
          />
        )}
      </div>

      <div className="tabs">
        {(["summary", "charts", "timeline", "turns", "transcript"] as Tab[]).map((t) => (
          <button
            type="button"
            key={t}
            className={t === tab ? "active" : ""}
            onClick={() => setTab(t)}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === "summary" && <Summary a={a} />}
      {tab === "charts" && <SessionCharts a={a} />}
      {tab === "timeline" && <Timeline a={a} />}
      {tab === "turns" && <Turns a={a} />}
      {tab === "transcript" && (
        <Transcript
          loading={transcript.loading}
          error={transcript.error}
          items={transcript.data ?? []}
        />
      )}
    </>
  );
}

function Summary({ a }: { a: SessionAnalysis }) {
  const c = a.totals.cost;
  const t = a.totals.tokens;
  return (
    <section>
      <div className="tablewrap">
        <table>
          <tbody>
            <Row k="Cost (input/output)" v={`${usd(c.input)} / ${usd(c.output)}`} />
            <Row k="Cost (cache write/read)" v={`${usd(c.cacheWrite)} / ${usd(c.cacheRead)}`} />
            <Row
              k="Tokens (input/output)"
              v={`${count(t.inputTokens)} / ${count(t.outputTokens)}`}
            />
            <Row
              k="Tokens (cache write/read)"
              v={`${count(t.cacheWrite5mTokens + t.cacheWrite1hTokens)} / ${count(t.cacheReadTokens)}`}
            />
            <Row k="Models" v={Object.keys(a.models).join(", ") || "-"} />
            <Row k="Web search / fetch" v={`${a.totals.webSearches} / ${a.totals.webFetches}`} />
            <Row k="Git branches" v={a.gitBranches.join(", ") || "-"} />
            <Row k="CC versions" v={a.versions.join(", ") || "-"} />
            <Row k="Files touched" v={String(a.filesTouched.length)} />
            <Row
              k="Active / wall time"
              v={`${duration(a.totals.activeMs)} / ${duration(a.durationMs)}`}
            />
            <Row k="Stop reasons" v={topEntries(a.stopReasons) || "-"} />
            <Row k="Permission modes" v={topEntries(a.permissionModes) || "-"} />
            <Row k="Shell commands" v={topEntries(a.bashCommands, 8) || "-"} />
            <Row
              k="Test runs"
              v={a.testRuns > 0 ? `${a.testRuns} (${a.testFailures} failed)` : "none detected"}
            />
            <Row
              k="Tool-call churn"
              v={a.retries > 0 ? `${a.retries} repeated identical calls` : "none"}
            />
            <Row
              k="Compactions"
              v={
                a.compactions.length > 0
                  ? `${a.compactions.length} (${a.compactions
                      .map((c) => `${c.trigger ?? "unknown"}${c.isSidechain ? " subagent" : ""}`)
                      .join(", ")})`
                  : "none"
              }
            />
          </tbody>
        </table>
      </div>
      <div style={{ marginTop: 12 }}>
        {Object.entries(a.tools).map(([t, n]) => (
          <span className="tag" key={t}>
            {t} {n}
          </span>
        ))}
      </div>
      {Object.keys(a.skills).length > 0 && (
        <p className="muted">
          Skills:{" "}
          {Object.entries(a.skills)
            .map(([s, n]) => `${s}:${n}`)
            .join(", ")}
        </p>
      )}
      {a.subagents.length > 0 && <p className="muted">Subagents: {a.subagents.join(", ")}</p>}
    </section>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <tr>
      <td className="muted" style={{ width: 220 }}>
        {k}
      </td>
      <td>{v}</td>
    </tr>
  );
}

interface TimedTurn {
  turn: Turn;
  startMs: number;
  endMs: number;
  calls: { ms: number; hasError: boolean; ci: number }[];
}

const TIMELINE_WINDOW = 200;

/** Gantt: one lane per turn across the session's wall clock; dots are API
 * calls (teal = sidechain, red ring = a tool error inside the call). */
function Timeline({ a }: { a: SessionAnalysis }) {
  // Geometry is parsed once per session — huge sessions have tens of
  // thousands of calls, and Date.parse per render would jank every re-render.
  const timed = useMemo<TimedTurn[]>(
    () =>
      a.turns.flatMap((turn) => {
        const startMs = turn.startTime ? Date.parse(turn.startTime) : Number.NaN;
        const endMs = turn.endTime ? Date.parse(turn.endTime) : Number.NaN;
        if (Number.isNaN(startMs) || Number.isNaN(endMs)) return [];
        const calls = turn.apiCalls.flatMap((call, ci) => {
          const ms = call.timestamp ? Date.parse(call.timestamp) : Number.NaN;
          if (Number.isNaN(ms)) return [];
          return [{ ms, hasError: call.steps.some((s) => s.status === "error"), ci }];
        });
        return [{ turn, startMs, endMs, calls }];
      }),
    [a],
  );
  const { limit, more } = useWindowed(timed.length, TIMELINE_WINDOW);
  if (timed.length === 0) return <p className="muted">No timed turns in this session.</p>;
  const t0 = Math.min(...timed.map((t) => t.startMs));
  const t1 = Math.max(...timed.map((t) => t.endMs));
  const span = Math.max(t1 - t0, 1);
  const shown = timed.slice(0, limit);
  const W = 900;
  const rowH = 16;
  const H = shown.length * rowH + 8;
  const x = (ms: number) => ((ms - t0) / span) * (W - 16) + 8;
  const offset = (ms: number) => duration(ms - t0);
  return (
    <section>
      <p className="muted">
        {duration(span)} wall · {duration(a.totals.activeMs)} active · one lane per turn; dots are
        API calls (teal = subagent sidechain, red ring = tool error in that call)
        {timed.length > limit ? ` · showing ${limit}/${timed.length} turns` : ""}
      </p>
      <div className="timelinewrap">
        <svg
          className="timeline"
          viewBox={`0 0 ${W} ${H}`}
          style={{ height: H }}
          preserveAspectRatio="none"
          role="img"
        >
          <title>Session timeline</title>
          {shown.map((t, i) => {
            const y = i * rowH + 4;
            const sx = x(t.startMs);
            const ex = x(t.endMs);
            return (
              <g key={t.turn.index}>
                <rect
                  className="tl-turn"
                  x={sx}
                  y={y + 2}
                  width={Math.max(ex - sx, 2)}
                  height={8}
                  rx={2}
                >
                  <title>{`#${t.turn.index + 1} +${offset(t.startMs)} · ${usd(t.turn.cost.total)} · ${t.turn.apiCalls.length} calls\n${t.turn.prompt.slice(0, 160)}`}</title>
                </rect>
                {t.calls.map(({ ms, hasError, ci }) => {
                  const call = t.turn.apiCalls[ci] as Turn["apiCalls"][number];
                  const cls = `tl-call${call.isSidechain ? " side" : ""}${hasError ? " err" : ""}`;
                  return (
                    <circle
                      key={`${t.turn.index}.${ci}`}
                      className={cls}
                      cx={x(ms)}
                      cy={y + 6}
                      r={3}
                    >
                      <title>{`+${offset(ms)} · ${call.model ?? "?"} · ${usd(call.cost.total)}${call.stopReason ? ` · ${call.stopReason}` : ""}${call.isSidechain ? " · sidechain" : ""}${hasError ? " · tool error" : ""}`}</title>
                    </circle>
                  );
                })}
              </g>
            );
          })}
        </svg>
      </div>
      <div className="axis">
        <span>start</span>
        <span>{duration(span)}</span>
      </div>
      {more}
    </section>
  );
}

const TURNS_WINDOW = 100;

/** Reveal a long list in `step`-sized chunks; returns the current slice length
 *  and a "Show more / Show all" control (or null when everything fits). */
function useWindowed(total: number, step: number): { limit: number; more: ReactNode } {
  const [visible, setVisible] = useState(step);
  const limit = Math.min(visible, total);
  const more =
    total > limit ? (
      <div className="loadmore">
        <button type="button" onClick={() => setVisible((v) => v + step)}>
          Show more
        </button>
        <button type="button" onClick={() => setVisible(total)}>
          Show all ({count(total)})
        </button>
      </div>
    ) : null;
  return { limit, more };
}

function Turns({ a }: { a: SessionAnalysis }) {
  const [open, setOpen] = useState<Set<number>>(new Set());
  const { limit, more } = useWindowed(a.turns.length, TURNS_WINDOW);
  const toggle = (i: number) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });

  return (
    <div>
      {a.turns.slice(0, limit).map((t) => {
        const expanded = open.has(t.index);
        return (
          <div className="item" key={t.index}>
            <button
              type="button"
              className="turnhead"
              onClick={() => toggle(t.index)}
              aria-expanded={expanded}
            >
              <span className="muted">{expanded ? "▾" : "▸"}</span>{" "}
              <span className="num">#{t.index + 1}</span> · {usd(t.cost.total)} ·{" "}
              <span className="muted">{tokensOf(t.tokens)}</span> · {t.apiCalls.length} calls ·{" "}
              <span className="muted">
                {Object.entries(t.toolCounts)
                  .map(([n, c]) => `${n}:${c}`)
                  .join(" ") || "no tools"}
              </span>
              <div className="turnprompt">{t.prompt.slice(0, 140) || "(no text)"}</div>
            </button>
            {expanded && (
              <div className="turncalls">
                {t.apiCalls.map((call, ci) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: API calls within a turn have no stable id; order is fixed
                  <div key={`${t.index}.${ci}`} className="callblock">
                    <div className="calldivider">
                      <span className="muted">{call.model ?? "?"}</span>
                      <span className="muted">
                        {usd(call.cost.total)} · {tokensOf(call.tokens)}
                      </span>
                    </div>
                    {call.steps.map((step, si) => (
                      <StepRow key={step.toolUseId ?? `${t.index}.${ci}.${si}`} step={step} />
                    ))}
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
      {more}
    </div>
  );
}

function StepRow({ step }: { step: TurnStep }) {
  const [open, setOpen] = useState(false);
  const hasDetail = Boolean(step.detail?.input || step.detail?.result);
  const icon = STEP_ICON[step.kind] ?? "·";
  return (
    <div className={`step k-${step.kind}`}>
      <button
        type="button"
        className="steprow"
        onClick={() => hasDetail && setOpen((v) => !v)}
        aria-expanded={open}
        style={{ cursor: hasDetail ? "pointer" : "default" }}
      >
        <span className="stepicon">{icon}</span>
        <span className="steplabel">{step.label}</span>
        {step.summary && <span className="stepsummary">{step.summary}</span>}
        {step.status === "error" && <span className="err"> ✗</span>}
        {step.status === "ok" && <span className="ok"> ✓</span>}
        {step.resultHint && <span className="stephint">{step.resultHint}</span>}
      </button>
      {open && hasDetail && (
        <div className="stepdetail">
          {step.detail?.input && step.kind !== "note" && step.kind !== "thinking" && (
            <>
              <div className="stepdetaillabel">input</div>
              <pre>{step.detail.input}</pre>
            </>
          )}
          {step.detail?.result && (
            <>
              <div className="stepdetaillabel">
                {step.kind === "note" || step.kind === "thinking" ? "full text" : "result"}
              </div>
              <pre>{step.detail.result}</pre>
            </>
          )}
          {step.detail?.truncated && (
            <div className="muted">truncated · see Transcript for full</div>
          )}
        </div>
      )}
    </div>
  );
}

const STEP_ICON: Record<string, string> = {
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

const TRANSCRIPT_WINDOW = 200;

function Transcript({
  loading,
  error,
  items,
}: {
  loading: boolean;
  error: string | null;
  items: TranscriptItem[];
}) {
  const { limit, more } = useWindowed(items.length, TRANSCRIPT_WINDOW);
  if (loading) return <div className="loading">Loading transcript…</div>;
  if (error) return <div className="loading err">Error loading transcript: {error}</div>;
  const shown = items.slice(0, limit);
  return (
    <section>
      <p className="muted">
        {count(items.length)} items{items.length > limit ? ` · showing ${limit}` : ""}
      </p>
      {shown.map((item) => (
        <div className={`item k-${item.kind}`} key={item.index}>
          <div className="head">
            {item.label}
            {item.isError && <span className="err"> ✗ error</span>}
          </div>
          <pre>{item.body || "(empty)"}</pre>
        </div>
      ))}
      {more}
    </section>
  );
}
