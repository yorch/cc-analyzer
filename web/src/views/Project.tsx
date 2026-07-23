import { useState } from "react";
import {
  api,
  type CostDistribution,
  type HotFileRow,
  type IndexedSession,
  type ToolUsageRow,
  type TurnDepthStats,
} from "../api.ts";
import { count, relTime, tokens, usd } from "../format.ts";
import { Histogram } from "../Histogram.tsx";
import { link } from "../router.ts";
import { SortTh } from "../SortTh.tsx";
import { BurnPanel, ModelMix, ScatterPanel } from "../trend-charts.tsx";
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
    () =>
      Promise.all([api.projects(), api.sessions(id), api.projectFiles(id), api.projectTrends(id)]),
    [id],
  );
  const [query, setQuery] = useState("");
  const [projects, allSessions, hotFiles, trends] = data ?? [[], [], [], null];
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
          {project && project.compactions > 0
            ? ` · ${count(project.compactions)} compaction${project.compactions === 1 ? "" : "s"}`
            : ""}
        </span>
      </header>

      {trends && trends.daily.length > 0 && (
        <section className="trend-panel">
          <BurnPanel daily={trends.daily} />
        </section>
      )}

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

      {trends && (
        <>
          <section className="trend-panel">
            <div className="trend-head">
              <h2>Session cost distribution</h2>
              <span className="muted">how spend spreads across this project's sessions</span>
            </div>
            <CostDist d={trends.distribution} />
          </section>

          <section className="trend-panel">
            <div className="trend-head">
              <h2>Turn depth</h2>
              <span className="muted">main-chain API calls per turn</span>
            </div>
            <DepthDist depth={trends.turnDepth} />
          </section>

          <section className="trend-panel">
            <div className="trend-head">
              <h2>Tool mix</h2>
              <span className="muted">invocations across this project's sessions</span>
            </div>
            <ToolMix tools={trends.tools} />
          </section>

          {trends.modelMix.length > 0 && (
            <section className="trend-panel">
              <div className="trend-head">
                <h2>Model mix</h2>
                <span className="muted">daily spend per model in this project</span>
              </div>
              <ModelMix rows={trends.modelMix} />
            </section>
          )}

          <section className="trend-panel">
            <ScatterPanel points={trends.scatter} />
          </section>
        </>
      )}

      <HotFiles rows={hotFiles} projectPath={project?.projectPath ?? null} />
    </>
  );
}

function CostDist({ d }: { d: CostDistribution }) {
  if (d.sessions === 0) return <p className="muted">No costed sessions yet.</p>;
  return (
    <>
      <p className="muted">
        {count(d.sessions)} sessions · median {usd(d.p50)} · p90 {usd(d.p90)} · max {usd(d.max)}
        {d.topDecileShare !== null &&
          ` · top 10% of sessions carry ${(d.topDecileShare * 100).toFixed(0)}% of spend`}
      </p>
      <Histogram rows={d.buckets.map((b) => ({ label: b.label, count: b.count }))} />
    </>
  );
}

function DepthDist({ depth }: { depth: TurnDepthStats }) {
  if (depth.turns === 0) return <p className="muted">No turns recorded yet.</p>;
  return (
    <>
      <p className="muted">
        {count(depth.turns)} turns · avg {depth.avgDepth.toFixed(1)} calls/turn · deepest{" "}
        {depth.maxDepth}
      </p>
      <Histogram rows={depth.buckets.map((b) => ({ label: `${b.label} calls`, count: b.turns }))} />
    </>
  );
}

const TOOL_MIX_LIMIT = 12;

function ToolMix({ tools }: { tools: ToolUsageRow[] }) {
  if (tools.length === 0) return <p className="muted">No tool calls recorded yet.</p>;
  const top = tools.slice(0, TOOL_MIX_LIMIT);
  const errorful = top.filter((t) => t.errors > 0);
  return (
    <>
      <Histogram rows={top.map((t) => ({ label: t.tool, count: t.uses }))} />
      {errorful.length > 0 && (
        <p className="muted spark-cap">
          errors: {errorful.map((t) => `${t.tool} ${(t.errorRate * 100).toFixed(1)}%`).join(" · ")}
        </p>
      )}
    </>
  );
}

/** Files Claude keeps coming back to across this project's sessions. */
function HotFiles({ rows, projectPath }: { rows: HotFileRow[]; projectPath: string | null }) {
  if (rows.length === 0) return null;
  const prefix = projectPath ? `${projectPath}/` : "";
  const rel = (f: string) => (prefix && f.startsWith(prefix) ? f.slice(prefix.length) : f);
  return (
    <section>
      <h2 className="section-h">Hot files · written or edited across sessions</h2>
      <div className="tablewrap">
        <table>
          <thead>
            <tr>
              <th className="num">Sessions</th>
              <th>Last touched</th>
              <th>File</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((f) => (
              <tr key={f.file}>
                <td className="num">{f.sessions}</td>
                <td className="muted">{f.lastDay ?? "—"}</td>
                <td className="mono">{rel(f.file)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
