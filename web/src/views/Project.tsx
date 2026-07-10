import { api } from "../api.ts";
import { relTime, usd } from "../format.ts";
import { link } from "../router.ts";
import { useAsync } from "../useAsync.ts";

export function Project({ id }: { id: string }) {
  const { data, error, loading } = useAsync(
    () => Promise.all([api.projects(), api.sessions(id)]),
    [id],
  );
  if (loading) return <div className="loading">Loading project…</div>;
  if (error) return <div className="loading err">Error: {error}</div>;
  if (!data) return null;

  const [projects, sessions] = data;
  const project = projects.find((p) => p.projectId === id);

  return (
    <>
      <div className="crumbs">
        <a href={link.dashboard()}>← Dashboard</a>
      </div>
      <header className="top">
        <h1>{project?.projectPath ?? id}</h1>
        <span className="muted">
          {sessions.length} sessions · {usd(project?.cost ?? 0)}
        </span>
      </header>

      <div className="tablewrap">
        <table>
          <thead>
            <tr>
              <th className="num">Cost</th>
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
