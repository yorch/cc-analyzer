import { useState } from "react";
import { api, cacheVerdict, type ProjectCacheRow, type SessionCacheRow } from "../api.ts";
import { shortPath, usd } from "../format.ts";
import { link } from "../router.ts";
import { SortTh } from "../SortTh.tsx";
import { useAsync } from "../useAsync.ts";
import { type Accessors, useSort } from "../useSort.ts";

function Verdict({ ratio }: { ratio: number }) {
  const v = cacheVerdict(ratio);
  return <span className={`verdict ${v}`}>{v}</span>;
}

const PROJECT_SORT: Accessors<ProjectCacheRow> = {
  waste: (r) => r.waste,
  ratio: (r) => r.ratio,
  write: (r) => r.writeCost,
  read: (r) => r.readCost,
  sessions: (r) => r.sessions,
  project: (r) => r.projectPath ?? r.projectId,
};

export function Insights() {
  const { data, error, loading } = useAsync(() => api.insights(), []);
  const [query, setQuery] = useState("");
  const q = query.toLowerCase();
  const all = data?.projects ?? [];
  const filtered = q
    ? all.filter((p) => (p.projectPath ?? p.projectId).toLowerCase().includes(q))
    : all;
  const sort = useSort(filtered, PROJECT_SORT, "waste");
  const rows = sort.sorted;
  if (loading) return <div className="loading">Loading insights…</div>;
  if (error) return <div className="loading err">Error: {error}</div>;
  if (!data) return null;

  const s = data.summary;
  const wastePct = s.totalCost > 0 ? Math.round((s.waste / s.totalCost) * 100) : 0;

  return (
    <>
      <header className="top">
        <h1>Cache efficiency</h1>
        <span className="muted">
          {usd(s.writeCost)} written · {usd(s.waste)} un-amortized · {wastePct}% of spend
        </span>
      </header>
      <p className="muted">
        Projects ranked by cache-write $ that wasn't read back — writes you paid a premium for but
        didn't reuse. A high read:write ratio means the writes amortized.
      </p>

      <input
        className="search"
        type="search"
        placeholder="Filter projects…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />

      <div className="tablewrap">
        <table>
          <thead>
            <tr>
              <SortTh label="Waste" col="waste" sort={sort} className="num" />
              <SortTh label="R:W" col="ratio" sort={sort} className="num" />
              <th>Verdict</th>
              <SortTh label="Cache-write" col="write" sort={sort} className="num" />
              <SortTh label="Cache-read" col="read" sort={sort} className="num" />
              <SortTh label="Sessions" col="sessions" sort={sort} className="num" />
              <SortTh label="Project" col="project" sort={sort} />
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <tr key={p.projectId}>
                <td className="num">{usd(p.waste)}</td>
                <td className="num">{p.ratio.toFixed(1)}×</td>
                <td>
                  <Verdict ratio={p.ratio} />
                </td>
                <td className="num">{usd(p.writeCost)}</td>
                <td className="num">{usd(p.readCost)}</td>
                <td className="num">{p.sessions}</td>
                <td>
                  <a href={link.insightsProject(p.projectId)}>{p.projectPath ?? p.projectId}</a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

const SESSION_SORT: Accessors<SessionCacheRow> = {
  waste: (r) => r.waste,
  ratio: (r) => r.ratio,
  write: (r) => r.writeCost,
  read: (r) => r.readCost,
  title: (r) => r.title ?? r.sessionId ?? "",
};

export function InsightsProject({ id }: { id: string }) {
  const { data, error, loading } = useAsync(() => api.insightsSessions(id), [id]);
  const [query, setQuery] = useState("");
  const q = query.toLowerCase();
  const all = data ?? [];
  const filtered = q
    ? all.filter((s) => `${s.title ?? ""} ${s.sessionId ?? ""}`.toLowerCase().includes(q))
    : all;
  const sort = useSort(filtered, SESSION_SORT, "waste");
  const rows = sort.sorted;
  if (loading) return <div className="loading">Loading sessions…</div>;
  if (error) return <div className="loading err">Error: {error}</div>;
  if (!data) return null;

  const projectPath = all[0]?.projectPath ?? id;

  return (
    <>
      <div className="crumbs">
        <a href={link.insights()}>← Insights</a>
      </div>
      <header className="top">
        <h1>{shortPath(projectPath)}</h1>
        <span className="muted">
          {rows.length}
          {q ? `/${all.length}` : ""} sessions with cache activity, ranked by waste
        </span>
      </header>

      <input
        className="search"
        type="search"
        placeholder="Filter sessions…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />

      <div className="tablewrap">
        <table>
          <thead>
            <tr>
              <SortTh label="Waste" col="waste" sort={sort} className="num" />
              <SortTh label="R:W" col="ratio" sort={sort} className="num" />
              <th>Verdict</th>
              <SortTh label="Cache-write" col="write" sort={sort} className="num" />
              <SortTh label="Cache-read" col="read" sort={sort} className="num" />
              <SortTh label="Session" col="title" sort={sort} />
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => (
              <tr key={s.sessionId ?? `${s.title}-${s.waste}`}>
                <td className="num">{usd(s.waste)}</td>
                <td className="num">{s.ratio.toFixed(1)}×</td>
                <td>
                  <Verdict ratio={s.ratio} />
                </td>
                <td className="num">{usd(s.writeCost)}</td>
                <td className="num">{usd(s.readCost)}</td>
                <td>
                  {s.sessionId ? (
                    <a href={link.session(s.sessionId)}>{s.title ?? s.sessionId}</a>
                  ) : (
                    (s.title ?? "(untitled)")
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
