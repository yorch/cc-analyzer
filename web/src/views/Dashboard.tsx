import { useEffect, useState } from "react";
import { EmptyNotice, ErrorNotice, LoadingNotice } from "../AsyncNotice.tsx";
import {
  api,
  type CostDistribution,
  type ModelRow,
  type MonthRow,
  type ProjectRow,
  type SessionRankRow,
  type SessionWithProject,
  type StatsResponse,
} from "../api.ts";
import { Card } from "../Card.tsx";
import { count, date, duration, shortPath, tokens, usd } from "../format.ts";
import { Histogram } from "../Histogram.tsx";
import { link, useHashParam } from "../router.ts";
import { SearchField } from "../SearchField.tsx";
import { SortTh } from "../SortTh.tsx";
import { useAsync } from "../useAsync.ts";
import { type Accessors, useSort } from "../useSort.ts";

const MONTH_SORT: Accessors<MonthRow> = {
  month: (m) => m.month,
  cost: (m) => m.cost,
  tokens: (m) => m.ioTokens + m.cacheTokens,
  sessions: (m) => m.sessions,
};
const PROJECT_SORT: Accessors<ProjectRow> = {
  cost: (p) => p.cost,
  tokens: (p) => p.ioTokens + p.cacheTokens,
  sessions: (p) => p.sessions,
  project: (p) => p.projectPath ?? p.projectId,
};
const MODEL_SORT: Accessors<ModelRow> = {
  model: (m) => m.model,
  calls: (m) => m.calls,
  cost: (m) => m.cost,
  tokens: (m) => m.ioTokens + m.cacheTokens,
};
const TOP_SORT: Accessors<SessionRankRow> = {
  cost: (s) => s.cost,
  tokens: (s) => s.ioTokens + s.cacheTokens,
  date: (s) => s.startTime ?? "",
  title: (s) => s.title ?? s.sessionId ?? "",
};

export function Dashboard() {
  const { data, error, loading, retry } = useAsync(() => api.stats(), []);
  const [projectQuery, setProjectQuery] = useHashParam<string>("projects", "");
  const byMonth = data?.byMonth ?? [];
  const byProject = data?.byProject ?? [];
  const byModel = data?.byModel ?? [];
  const top = data?.top ?? [];
  const pq = projectQuery.toLowerCase();
  const projectFiltered = pq
    ? byProject.filter((p) => (p.projectPath ?? p.projectId).toLowerCase().includes(pq))
    : byProject;
  const monthSort = useSort(byMonth, MONTH_SORT, "month", "asc");
  const projectSort = useSort(projectFiltered, PROJECT_SORT, "cost");
  const modelSort = useSort(byModel, MODEL_SORT, "cost");
  const topSort = useSort(top, TOP_SORT, "cost");
  if (loading) return <LoadingNotice>Loading portfolio…</LoadingNotice>;
  if (error)
    return <ErrorNotice error={error} retry={retry} label="Couldn’t load the portfolio." />;
  if (!data) return null;

  const { summary } = data;
  const maxMonth = Math.max(1, ...byMonth.map((m) => m.cost));
  const totalIo = summary.inputTokens + summary.outputTokens;
  const totalCache = summary.cacheWriteTokens + summary.cacheReadTokens;
  const pct = (summary.estimatedShare * 100).toFixed(0);
  const range =
    summary.firstDay && summary.lastDay ? `${summary.firstDay} → ${summary.lastDay}` : "—";
  const projectRows = pq ? projectSort.sorted : projectSort.sorted.slice(0, 15);

  return (
    <>
      <section className="hero">
        <div className="hero-main">
          <div className="hero-label">Total spend</div>
          <div className="hero-figure">{usd(summary.cost)}</div>
          <div className="hero-sub">
            <span className="est">{pct}% estimated</span> · {tokens(totalIo, totalCache)} tokens
          </div>
          <div className="hero-sub">
            {range} · {count(summary.sessions)} sessions
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

      <GlobalSearch />

      <StatCards data={data} />

      <section>
        <h2>Session cost distribution</h2>
        <Distribution dist={data.distribution} />
      </section>

      <section>
        <h2>Spend by month</h2>
        <div className="tablewrap">
          <table>
            <thead>
              <tr>
                <SortTh label="Month" col="month" sort={monthSort} />
                <SortTh label="Cost" col="cost" sort={monthSort} className="num" />
                <SortTh label="Tokens" col="tokens" sort={monthSort} className="num" />
                <SortTh label="Sessions" col="sessions" sort={monthSort} className="num" />
                <th style={{ width: "34%" }} />
              </tr>
            </thead>
            <tbody>
              {monthSort.sorted.map((m) => (
                <tr key={m.month}>
                  <td>{m.month}</td>
                  <td className="num">{usd(m.cost)}</td>
                  <td className="num">{tokens(m.ioTokens, m.cacheTokens)}</td>
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
        <SearchField
          label="Filter Projects"
          placeholder="Filter projects by path…"
          value={projectQuery}
          onChange={setProjectQuery}
        />
        <div className="tablewrap">
          <table>
            <thead>
              <tr>
                <SortTh label="Cost" col="cost" sort={projectSort} className="num" />
                <SortTh label="Tokens" col="tokens" sort={projectSort} className="num" />
                <SortTh label="Sessions" col="sessions" sort={projectSort} className="num" />
                <SortTh label="Project" col="project" sort={projectSort} />
              </tr>
            </thead>
            <tbody>
              {projectRows.map((p) => (
                <tr key={p.projectId}>
                  <td className="num">{usd(p.cost)}</td>
                  <td className="num">{tokens(p.ioTokens, p.cacheTokens)}</td>
                  <td className="num">{p.sessions}</td>
                  <td>
                    <a href={link.project(p.projectId)}>{p.projectPath ?? p.projectId}</a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {projectRows.length === 0 && <EmptyNotice>No projects match this filter.</EmptyNotice>}
        {!pq && projectSort.sorted.length > projectRows.length && (
          <p className="muted">
            Showing the 15 highest-cost projects. Filter by path to find the rest.
          </p>
        )}
      </section>

      <section>
        <h2>Spend by model</h2>
        <div className="tablewrap">
          <table>
            <thead>
              <tr>
                <SortTh label="Model" col="model" sort={modelSort} />
                <SortTh label="Calls" col="calls" sort={modelSort} className="num" />
                <SortTh label="Cost" col="cost" sort={modelSort} className="num" />
                <SortTh label="Tokens" col="tokens" sort={modelSort} className="num" />
              </tr>
            </thead>
            <tbody>
              {modelSort.sorted.map((m) => (
                <tr key={m.model}>
                  <td>{m.model}</td>
                  <td className="num">{count(m.calls)}</td>
                  <td className="num">{usd(m.cost)}</td>
                  <td className="num">{tokens(m.ioTokens, m.cacheTokens)}</td>
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
                <SortTh label="Cost" col="cost" sort={topSort} className="num" />
                <SortTh label="Tokens" col="tokens" sort={topSort} className="num" />
                <SortTh label="Date" col="date" sort={topSort} />
                <SortTh label="Title" col="title" sort={topSort} />
              </tr>
            </thead>
            <tbody>
              {topSort.sorted.map((t) => (
                <tr key={`${t.sessionId}-${t.startTime}`}>
                  <td className="num">{usd(t.cost)}</td>
                  <td className="num">{tokens(t.ioTokens, t.cacheTokens)}</td>
                  <td className="muted">{t.startTime ? date(t.startTime) : "—"}</td>
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

      {data.estimatedByProject.length > 0 && (
        <section>
          <h2>Heuristically priced spend</h2>
          <p className="muted">
            Projects whose totals lean on family-heuristic pricing (unknown model ids) — treat these
            numbers as soft.
          </p>
          <div className="tablewrap">
            <table>
              <thead>
                <tr>
                  <th className="num">Estimated $</th>
                  <th className="num">Share</th>
                  <th className="num">Total $</th>
                  <th>Project</th>
                </tr>
              </thead>
              <tbody>
                {data.estimatedByProject.map((r) => (
                  <tr key={r.projectId}>
                    <td className="num">{usd(r.estimatedCost)}</td>
                    <td className="num">{(r.share * 100).toFixed(0)}%</td>
                    <td className="num">{usd(r.cost)}</td>
                    <td>
                      <a href={link.project(r.projectId)}>
                        {shortPath(r.projectPath, r.projectId)}
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </>
  );
}

/** The tier-1 headline metrics: time, percentiles, cadence, forecast, subagents. */
function StatCards({ data }: { data: StatsResponse }) {
  const d = data.duration;
  const dist = data.distribution;
  const st = data.streaks;
  const rr = data.runRate;
  const sc = data.sidechain;
  return (
    <div className="cards">
      <Card
        label="Time with Claude"
        value={duration(d.totalMs)}
        sub={`${duration(d.totalActiveMs)} active (${(d.activeShare * 100).toFixed(0)}%)`}
      />
      <Card
        label="Session length"
        value={duration(d.medianMs)}
        sub={`median · p90 ${duration(d.p90Ms)}`}
      />
      <Card
        label="Session cost"
        value={usd(dist.p50)}
        sub={`median · p90 ${usd(dist.p90)} · p99 ${usd(dist.p99)}`}
      />
      <Card
        label="Streak"
        value={`${st.currentStreak}d`}
        sub={`longest ${st.longestStreak}d · ${st.last30ActiveDays}/30 days active`}
      />
      <Card
        label={`Projected ${rr.month}`}
        value={usd(rr.projected)}
        sub={`${usd(rr.monthToDate)} so far · ${rr.prevMonth} was ${usd(rr.prevMonthTotal)}`}
      />
      <Card
        label="Subagent spend"
        value={usd(sc.cost)}
        sub={
          sc.cost > 0 ? `${(sc.share * 100).toFixed(0)}% of total · ${count(sc.calls)} calls` : "—"
        }
      />
    </div>
  );
}

/** Histogram of per-session cost plus the spend-concentration headline. */
function Distribution({ dist }: { dist: CostDistribution }) {
  return (
    <>
      <p className="muted">
        {count(dist.sessions)} costed sessions · mean {usd(dist.mean)}
        {dist.topDecileShare !== null && (
          <>
            {" "}
            · the top 10% of sessions carry{" "}
            <strong>{(dist.topDecileShare * 100).toFixed(0)}%</strong> of all spend
          </>
        )}
      </p>
      <Histogram rows={dist.buckets.map((b) => ({ label: b.label, count: b.count }))} />
    </>
  );
}

function GlobalSearch() {
  const [q, setQ] = useHashParam<string>("search", "");
  const [results, setResults] = useState<SessionWithProject[]>([]);
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const query = q.trim();

  useEffect(() => {
    if (query.length < 2) {
      setResults([]);
      setStatus("idle");
      return;
    }
    let cancelled = false;
    setStatus("loading");
    const timer = window.setTimeout(() => {
      api
        .searchSessions(query)
        .then((r) => {
          if (!cancelled) {
            setResults(r);
            setStatus("ready");
          }
        })
        .catch(() => {
          if (!cancelled) {
            setResults([]);
            setStatus("error");
          }
        });
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [query]);

  return (
    <section>
      <h2>Search sessions</h2>
      <SearchField
        label="Search Sessions"
        placeholder="Search all sessions by title, id, or project…"
        value={q}
        onChange={setQ}
        describedBy="session-search-status"
      />
      {results.length > 0 && (
        <div className="tablewrap">
          <table>
            <thead>
              <tr>
                <th className="num">Cost</th>
                <th className="num">Tokens</th>
                <th>Project</th>
                <th>Title</th>
              </tr>
            </thead>
            <tbody>
              {results.map((s) => (
                <tr key={s.path}>
                  <td className="num">{usd(s.cost)}</td>
                  <td className="num">{tokens(s.ioTokens, s.cacheTokens)}</td>
                  <td className="muted">{s.projectPath ?? "—"}</td>
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
      )}
      <div id="session-search-status" aria-live="polite">
        {status === "loading" && <p className="muted">Searching…</p>}
        {status === "ready" && results.length === 0 && (
          <EmptyNotice>No sessions match this search.</EmptyNotice>
        )}
        {status === "error" && (
          <p className="notice error-notice">
            Search failed. Check the local server and try again.
          </p>
        )}
      </div>
    </section>
  );
}
