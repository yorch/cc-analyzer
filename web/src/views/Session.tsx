import { useState } from "react";
import { api, type SessionAnalysis, type TranscriptItem } from "../api.ts";
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
  return (
    <div className="tablewrap">
      <table>
        <thead>
          <tr>
            <th className="num">#</th>
            <th className="num">Cost</th>
            <th className="num">Calls</th>
            <th>Tools</th>
            <th>Prompt</th>
          </tr>
        </thead>
        <tbody>
          {a.turns.map((t) => (
            <tr key={t.index}>
              <td className="num">{t.index + 1}</td>
              <td className="num">{usd(t.cost.total)}</td>
              <td className="num">{t.apiCalls.length}</td>
              <td className="muted">
                {Object.entries(t.toolCounts)
                  .map(([n, c]) => `${n}:${c}`)
                  .join(" ")}
              </td>
              <td>{t.prompt.slice(0, 100) || <span className="muted">(no text)</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Transcript({ loading, items }: { loading: boolean; items: TranscriptItem[] }) {
  if (loading) return <div className="loading">Loading transcript…</div>;
  return (
    <section>
      <p className="muted">{count(items.length)} items</p>
      {items.map((item) => (
        <div className={`item k-${item.kind}`} key={item.index}>
          <div className="head">
            {item.label}
            {item.isError && <span className="err"> ✗ error</span>}
          </div>
          <pre>{item.body || "(empty)"}</pre>
        </div>
      ))}
    </section>
  );
}
