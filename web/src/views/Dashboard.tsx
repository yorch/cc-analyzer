import { api } from "../api.ts";
import { count, usd } from "../format.ts";
import { link } from "../router.ts";
import { useAsync } from "../useAsync.ts";

export function Dashboard() {
  const { data, error, loading } = useAsync(() => api.stats(), []);
  if (loading) return <div className="loading">Loading portfolio…</div>;
  if (error) return <div className="loading err">Error: {error}</div>;
  if (!data) return null;

  const { summary, byMonth, byProject, byModel, top } = data;
  const maxMonth = Math.max(1, ...byMonth.map((m) => m.cost));

  return (
    <>
      <div className="cards">
        <Card
          label="Total cost"
          value={usd(summary.cost)}
          sub={`${(summary.estimatedShare * 100).toFixed(0)}% estimated`}
        />
        <Card
          label="Sessions"
          value={count(summary.sessions)}
          sub={`${summary.projects} projects`}
        />
        <Card
          label="Output tokens"
          value={count(summary.outputTokens)}
          sub={`${count(summary.inputTokens)} input`}
        />
        <Card
          label="Cache read"
          value={count(summary.cacheReadTokens)}
          sub={`${count(summary.cacheWriteTokens)} written`}
        />
        <Card label="Range" value={summary.firstDay ?? "-"} sub={`→ ${summary.lastDay ?? "-"}`} />
      </div>

      <section>
        <h2>Spend by month</h2>
        <div className="tablewrap">
          <table>
            <thead>
              <tr>
                <th>Month</th>
                <th className="num">Cost</th>
                <th className="num">Sessions</th>
                <th style={{ width: "40%" }} />
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
              {byProject.slice(0, 15).map((p) => (
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
                  <td className="muted">{t.startTime?.slice(0, 10) ?? "-"}</td>
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

function Card({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="card">
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {sub && <div className="sub">{sub}</div>}
    </div>
  );
}
