import { useState } from "react";
import { api } from "../api.ts";
import { relTime, tokens, usd } from "../format.ts";
import { link } from "../router.ts";
import { useAsync } from "../useAsync.ts";

export function Project({ id }: { id: string }) {
  const { data, error, loading } = useAsync(
    () => Promise.all([api.projects(), api.sessions(id)]),
    [id],
  );
  const [query, setQuery] = useState("");
  if (loading) return <div className="loading">Loading project…</div>;
  if (error) return <div className="loading err">Error: {error}</div>;
  if (!data) return null;

  const [projects, allSessions] = data;
  const project = projects.find((p) => p.projectId === id);
  const q = query.toLowerCase();
  const sessions = q
    ? allSessions.filter((s) => `${s.title ?? ""} ${s.sessionId ?? ""}`.toLowerCase().includes(q))
    : allSessions;

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
              <th className="num">Cost</th>
              <th className="num">Tokens</th>
              <th className="num">Turns</th>
              <th className="num">Tools</th>
              <th>Modified</th>
              <th>Title</th>
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
