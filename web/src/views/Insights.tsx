import { EmptyNotice, ErrorNotice, LoadingNotice } from "../AsyncNotice.tsx";
import {
  api,
  cacheVerdict,
  type IdleCacheBucket,
  type ProjectCacheRow,
  type SessionCacheRow,
} from "../api.ts";
import { count, shortPath, usd } from "../format.ts";
import { link, useHashParam } from "../router.ts";
import { SearchField } from "../SearchField.tsx";
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
  const { data, error, loading, retry } = useAsync(() => api.insights(), []);
  const [query, setQuery] = useHashParam<string>("q", "");
  const q = query.toLowerCase();
  const all = data?.projects ?? [];
  const filtered = q
    ? all.filter((p) => (p.projectPath ?? p.projectId).toLowerCase().includes(q))
    : all;
  const sort = useSort(filtered, PROJECT_SORT, "waste");
  const rows = sort.sorted;
  if (loading) return <LoadingNotice>Loading insights…</LoadingNotice>;
  if (error)
    return <ErrorNotice error={error} retry={retry} label="Couldn’t load cache insights." />;
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
      <p className="insight-callout">
        <strong>What to look for:</strong> projects marked “leaky” repeatedly pay to rebuild cache
        without reading enough of it back.
      </p>
      <p className="muted">
        Write TTL mix: {count(data.ttl.write5mTokens)} tokens @5m · {count(data.ttl.write1hTokens)}{" "}
        tokens @1h (1h writes are priced ~2× input, 5m ~1.25×).
      </p>

      <IdleBuckets rows={data.idleBuckets} />

      <SearchField
        label="Filter Projects"
        placeholder="Filter projects…"
        value={query}
        onChange={setQuery}
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
      {rows.length === 0 && <EmptyNotice>No cache-active projects match this filter.</EmptyNotice>}
    </>
  );
}

/** Cross-insight: sessions bucketed by idle share vs how their cache amortized.
 * Waste concentrating in idle sessions ⇒ the cache expired between turns. */
function IdleBuckets({ rows }: { rows: IdleCacheBucket[] }) {
  if (!rows.some((r) => r.sessions > 0)) return null;
  return (
    <details className="idle-panel">
      <summary>Idle time × cache waste — does waste concentrate in sessions that sat idle?</summary>
      <div className="tablewrap">
        <table>
          <thead>
            <tr>
              <th>Session idle share</th>
              <th className="num">Sessions</th>
              <th className="num">R:W ratio</th>
              <th className="num">Write $ wasted</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.bucket}>
                <td>{r.bucket}</td>
                <td className="num">{count(r.sessions)}</td>
                <td className="num">{r.ratio.toFixed(1)}×</td>
                <td className="num">{(r.wasteShare * 100).toFixed(0)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted">
        Idle share = 1 − active/wall time. Correlational: long idle gaps let the 5-minute cache TTL
        lapse, so the next turn re-writes what it just paid to cache.
      </p>
    </details>
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
  const { data, error, loading, retry } = useAsync(() => api.insightsSessions(id), [id]);
  const [query, setQuery] = useHashParam<string>("q", "");
  const q = query.toLowerCase();
  const all = data ?? [];
  const filtered = q
    ? all.filter((s) => `${s.title ?? ""} ${s.sessionId ?? ""}`.toLowerCase().includes(q))
    : all;
  const sort = useSort(filtered, SESSION_SORT, "waste");
  const rows = sort.sorted;
  if (loading) return <LoadingNotice>Loading sessions…</LoadingNotice>;
  if (error)
    return <ErrorNotice error={error} retry={retry} label="Couldn’t load insight sessions." />;
  if (!data) return null;

  const projectPath = all[0]?.projectPath ?? id;

  return (
    <>
      <div className="crumbs">
        <a href={link.insights()}>← Insights</a> · <a href={link.project(id)}>Project Overview</a>
      </div>
      <header className="top">
        <h1>{shortPath(projectPath)}</h1>
        <span className="muted">
          {rows.length}
          {q ? `/${all.length}` : ""} sessions with cache activity, ranked by waste
        </span>
      </header>
      <div className="cards compact-cards">
        <div className="card">
          <div className="label">Total Waste</div>
          <div className="value">{usd(all.reduce((sum, row) => sum + row.waste, 0))}</div>
        </div>
        <div className="card">
          <div className="label">Cache Sessions</div>
          <div className="value">{count(all.length)}</div>
        </div>
        <div className="card">
          <div className="label">Worst Session</div>
          <div className="value">{usd(Math.max(0, ...all.map((row) => row.waste)))}</div>
        </div>
      </div>

      <SearchField
        label="Filter Sessions"
        placeholder="Filter sessions…"
        value={query}
        onChange={setQuery}
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
      {rows.length === 0 && <EmptyNotice>No cache-active sessions match this filter.</EmptyNotice>}
    </>
  );
}
