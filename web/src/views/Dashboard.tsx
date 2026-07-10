import { useState } from "react";
import { api } from "../api.ts";
import { count, usd } from "../format.ts";
import { link } from "../router.ts";
import { useAsync } from "../useAsync.ts";

export function Dashboard() {
  const { data, error, loading } = useAsync(() => api.stats(), []);
  const [projectQuery, setProjectQuery] = useState("");
  if (loading) return <div className="loading">Loading portfolio</div>;
  if (error) return <div className="loading err">Error: {error}</div>;
  if (!data) return null;

  const { summary, byMonth, byProject, byModel, top } = data;
  const maxMonth = Math.max(1, ...byMonth.map((m) => m.cost));
  const pct = (summary.estimatedShare * 100).toFixed(0);
  const range =
    summary.firstDay && summary.lastDay ? `${summary.firstDay} → ${summary.lastDay}` : "—";
  const pq = projectQuery.toLowerCase();
  const projectRows = pq
    ? byProject.filter((p) => (p.projectPath ?? p.projectId).toLowerCase().includes(pq))
    : byProject.slice(0, 15);

  return (
    <>
      <section className="hero">
        <div className="hero-main">
          <div className="hero-label">Total spend</div>
          <div className="hero-figure">{usd(summary.cost)}</div>
          <div className="hero-sub">
            <span className="est">{pct}% estimated</span> · {range} · {count(summary.sessions)}{" "}
            sessions
          </div>
        </div>
        <dl className="hero-stats">
          <div>
            <dt>Projects</dt>
            <dd>{summary.projects}</dd>
          </div>
          <div>
            <dt>Sessions</dt>
            <dd>{count(summary.sessions)}</dd>
          </div>
          <div>
            <dt>Output tokens</dt>
            <dd>
              {count(summary.outputTokens)} <small>{count(summary.inputTokens)} in</small>
            </dd>
          </div>
          <div>
            <dt>Cache read</dt>
            <dd>
              {count(summary.cacheReadTokens)} <small>{count(summary.cacheWriteTokens)} wr</small>
            </dd>
          </div>
        </dl>
      </section>

      <section>
        <h2>Spend by month</h2>
        <div className="tablewrap">
          <table>
            <thead>
              <tr>
                <th>Month</th>
                <th className="num">Cost</th>
                <th className="num">Sessions</th>
                <th style={{ width: "42%" }} />
              </tr>
            </thead>
            <tbody>
              {byMonth.map((m) => (
                <tr key={m.month}>
                  <td>{m.month}</td>
                  <td className="num">{usd(m.cost)}</td>
                  <td className="num">{m.sessions}</td>
                  <td>
                    <div className="bar">
                      <span style={{ width: `${(m.cost / maxMonth) * 100}%` }} />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <h2>Top projects</h2>
        <input
          className="search"
          type="search"
          placeholder="Filter projects by path"
          value={projectQuery}
          onChange={(e) => setProjectQuery(e.target.value)}
        />
        <div className="tablewrap">
          <table>
            <thead>
              <tr>
                <th className="num">Cost</th>
                <th className="num">Sessions</th>
                <th>Project</th>
              </tr>
            </thead>
            <tbody>
              {projectRows.map((p) => (
                <tr key={p.projectId}>
                  <td className="num">{usd(p.cost)}</td>
                  <td className="num">{p.sessions}</td>
                  <td>
                    <a href={link.project(p.projectId)}>{p.projectPath ?? p.projectId}</a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <h2>Spend by model</h2>
        <div className="tablewrap">
          <table>
            <thead>
              <tr>
                <th>Model</th>
                <th className="num">Calls</th>
                <th className="num">Cost</th>
              </tr>
            </thead>
            <tbody>
              {byModel.map((m) => (
                <tr key={m.model}>
                  <td>{m.model}</td>
                  <td className="num">{count(m.calls)}</td>
                  <td className="num">{usd(m.cost)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <h2>Most expensive sessions</h2>
        <div className="tablewrap">
          <table>
            <thead>
              <tr>
                <th className="num">Cost</th>
                <th>Date</th>
                <th>Title</th>
              </tr>
            </thead>
            <tbody>
              {top.map((t) => (
                <tr key={`${t.sessionId}-${t.startTime}`}>
                  <td className="num">{usd(t.cost)}</td>
                  <td className="muted">{t.startTime?.slice(0, 10) ?? "—"}</td>
                  <td>
                    {t.sessionId ? (
                      <a href={link.session(t.sessionId)}>{t.title ?? t.sessionId}</a>
                    ) : (
                      (t.title ?? "?")
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
