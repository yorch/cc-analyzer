import { useState } from "react";
import { api, type IndexedSession } from "../api.ts";
import { relTime, tokens, usd } from "../format.ts";
import { link } from "../router.ts";
import { SortTh } from "../SortTh.tsx";
import { useAsync } from "../useAsync.ts";
import { type Accessors, useSort } from "../useSort.ts";

const SESSION_SORT: Accessors<IndexedSession> = {
  cost: (s) => s.cost,
  tokens: (s) => s.ioTokens + s.cacheTokens,
  turns: (s) => s.turns,
  tools: (s) => s.toolCalls,
  modified: (s) => s.mtimeMs,
  title: (s) => s.title ?? s.sessionId ?? "",
};

export function Project({ id }: { id: string }) {
  const { data, error, loading } = useAsync(
    () => Promise.all([api.projects(), api.sessions(id)]),
    [id],
  );
  const [query, setQuery] = useState("");
  const [projects, allSessions] = data ?? [[], []];
  const q = query.toLowerCase();
  const filtered = q
    ? allSessions.filter((s) => `${s.title ?? ""} ${s.sessionId ?? ""}`.toLowerCase().includes(q))
    : allSessions;
  const sort = useSort(filtered, SESSION_SORT, "modified");
  const sessions = sort.sorted;
  if (loading) return <div className="loading">Loading project…</div>;
  if (error) return <div className="loading err">Error: {error}</div>;
  if (!data) return null;

  const project = projects.find((p) => p.projectId === id);

  return (
    <>
      <div className="crumbs">
        <a href={link.dashboard()}>← Dashboard</a>
      </div>
      <header className="top">
        <h1>{project?.projectPath ?? id}</h1>
        <span className="muted">
          {sessions.length}
          {q ? `/${allSessions.length}` : ""} sessions · {usd(project?.cost ?? 0)}
          {project ? ` · ${tokens(project.ioTokens, project.cacheTokens)} tokens` : ""}
        </span>
      </header>

      <input
        className="search"
        type="search"
        placeholder="Filter sessions by title…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />

      <div className="tablewrap">
        <table>
          <thead>
            <tr>
              <SortTh label="Cost" col="cost" sort={sort} className="num" />
              <SortTh label="Tokens" col="tokens" sort={sort} className="num" />
              <SortTh label="Turns" col="turns" sort={sort} className="num" />
              <SortTh label="Tools" col="tools" sort={sort} className="num" />
              <SortTh label="Modified" col="modified" sort={sort} />
              <SortTh label="Title" col="title" sort={sort} />
            </tr>
          </thead>
          <tbody>
            {sessions.map((s) => (
              <tr key={s.path}>
                <td className="num">
                  {usd(s.cost)}
                  {s.costEstimated && <span className="est"> ~</span>}
                </td>
                <td className="num">{tokens(s.ioTokens, s.cacheTokens)}</td>
                <td className="num">{s.turns}</td>
                <td className="num">{s.toolCalls}</td>
                <td className="muted">{relTime(s.mtimeMs)}</td>
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
