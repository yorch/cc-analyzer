import { type ReactNode, useEffect, useState } from "react";
import { api, type SessionAnalysis, type TranscriptItem, type TurnStep } from "../api.ts";
import { count, duration, tokensOf, usd } from "../format.ts";
import { link } from "../router.ts";
import { useAsync } from "../useAsync.ts";

type Tab = "summary" | "timeline" | "turns" | "transcript";

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
        {(["summary", "timeline", "turns", "transcript"] as Tab[]).map((t) => (
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

function Card({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="card">
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {sub && <div className="sub">{sub}</div>}
    </div>
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
            <Row
              k="Stop reasons"
              v={
                Object.entries(a.stopReasons)
                  .sort((x, y) => y[1] - x[1])
                  .map(([r, n]) => `${r}:${n}`)
                  .join(", ") || "-"
              }
            />
            <Row
              k="Permission modes"
              v={
                Object.entries(a.permissionModes)
                  .sort((x, y) => y[1] - x[1])
                  .map(([m, n]) => `${m}:${n}`)
                  .join(", ") || "-"
              }
            />
            <Row
              k="Shell commands"
              v={
                Object.entries(a.bashCommands)
                  .sort((x, y) => y[1] - x[1])
                  .slice(0, 8)
                  .map(([cmd, n]) => `${cmd}:${n}`)
                  .join(", ") || "-"
              }
            />
            <Row
              k="Test runs"
              v={a.testRuns > 0 ? `${a.testRuns} (${a.testFailures} failed)` : "none detected"}
            />
            <Row
              k="Tool-call churn"
              v={a.retries > 0 ? `${a.retries} repeated identical calls` : "none"}
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

/** Gantt: one lane per turn across the session's wall clock; dots are API
 * calls (teal = sidechain, red ring = a tool error inside the call). */
function Timeline({ a }: { a: SessionAnalysis }) {
  const turns = a.turns.filter((t) => t.startTime && t.endTime);
  if (turns.length === 0) return <p className="muted">No timed turns in this session.</p>;
  const t0 = Math.min(...turns.map((t) => Date.parse(t.startTime as string)));
  const t1 = Math.max(...turns.map((t) => Date.parse(t.endTime as string)));
  const span = Math.max(t1 - t0, 1);
  const W = 900;
  const rowH = 16;
  const H = turns.length * rowH + 8;
  const x = (ms: number) => ((ms - t0) / span) * (W - 16) + 8;
  const offset = (ms: number) => duration(ms - t0);
  return (
    <section>
      <p className="muted">
        {duration(span)} wall · {duration(a.totals.activeMs)} active · one lane per turn; dots are
        API calls (teal = subagent sidechain, red ring = tool error in that call)
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
          {turns.map((t, i) => {
            const y = i * rowH + 4;
            const sx = x(Date.parse(t.startTime as string));
            const ex = x(Date.parse(t.endTime as string));
            return (
              <g key={t.index}>
                <rect
                  className="tl-turn"
                  x={sx}
                  y={y + 2}
                  width={Math.max(ex - sx, 2)}
                  height={8}
                  rx={2}
                >
                  <title>{`#${t.index + 1} +${offset(Date.parse(t.startTime as string))} · ${usd(t.cost.total)} · ${t.apiCalls.length} calls\n${t.prompt.slice(0, 160)}`}</title>
                </rect>
                {t.apiCalls.map((call, ci) => {
                  if (!call.timestamp) return null;
                  const ms = Date.parse(call.timestamp);
                  if (Number.isNaN(ms)) return null;
                  const hasError = call.steps.some((s) => s.status === "error");
                  const cls = `tl-call${call.isSidechain ? " side" : ""}${hasError ? " err" : ""}`;
                  return (
                    <circle
                      // biome-ignore lint/suspicious/noArrayIndexKey: calls have no stable id; order is fixed
                      key={`${t.index}.${ci}`}
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
