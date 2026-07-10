import { useState } from "react";
import { api, type SessionAnalysis, type TranscriptItem, type TurnStep } from "../api.ts";
import { count, duration, usd } from "../format.ts";
import { link } from "../router.ts";
import { useAsync } from "../useAsync.ts";

type Tab = "summary" | "turns" | "transcript";

export function Session({ id }: { id: string }) {
  const [tab, setTab] = useState<Tab>("summary");
  const analysis = useAsync(() => api.session(id), [id]);
  const transcript = useAsync(() => api.transcript(id), [id]);

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
        <Card label="Turns" value={String(a.totals.turns)} sub={`${a.totals.apiCalls} api calls`} />
        <Card label="Tool calls" value={String(a.totals.toolCalls)} />
        <Card label="Duration" value={duration(a.durationMs)} />
      </div>

      <div className="tabs">
        {(["summary", "turns", "transcript"] as Tab[]).map((t) => (
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
      {tab === "turns" && <Turns a={a} />}
      {tab === "transcript" && (
        <Transcript loading={transcript.loading} items={transcript.data ?? []} />
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
  return (
    <section>
      <div className="tablewrap">
        <table>
          <tbody>
            <Row k="Cost (input/output)" v={`${usd(c.input)} / ${usd(c.output)}`} />
            <Row k="Cost (cache write/read)" v={`${usd(c.cacheWrite)} / ${usd(c.cacheRead)}`} />
            <Row k="Models" v={Object.keys(a.models).join(", ") || "-"} />
            <Row k="Web search / fetch" v={`${a.totals.webSearches} / ${a.totals.webFetches}`} />
            <Row k="Git branches" v={a.gitBranches.join(", ") || "-"} />
            <Row k="CC versions" v={a.versions.join(", ") || "-"} />
            <Row k="Files touched" v={String(a.filesTouched.length)} />
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
      {a.skills.length > 0 && <p className="muted">Skills: {a.skills.join(", ")}</p>}
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

function Turns({ a }: { a: SessionAnalysis }) {
  const [open, setOpen] = useState<Set<number>>(new Set());
  const toggle = (i: number) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });

  return (
    <div>
      {a.turns.map((t) => {
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
              {t.apiCalls.length} calls ·{" "}
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
                      <span className="muted">{usd(call.cost.total)}</span>
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

function Transcript({ loading, items }: { loading: boolean; items: TranscriptItem[] }) {
  const [visible, setVisible] = useState(TRANSCRIPT_WINDOW);
  if (loading) return <div className="loading">Loading transcript…</div>;
  const shown = items.slice(0, visible);
  return (
    <section>
      <p className="muted">
        {count(items.length)} items{items.length > visible ? ` · showing ${visible}` : ""}
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
      {items.length > visible && (
        <div className="loadmore">
          <button type="button" onClick={() => setVisible((v) => v + TRANSCRIPT_WINDOW)}>
            Show more
          </button>
          <button type="button" onClick={() => setVisible(items.length)}>
            Show all ({count(items.length)})
          </button>
        </div>
      )}
    </section>
  );
}
