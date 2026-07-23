import { useState } from "react";
import {
  type AnalyticsResponse,
  api,
  type BashCommandRow,
  type CompactionUsage,
  type NameUsageRow,
  type SkillUsageRow,
  type ToolUsageRow,
  type TurnDepthStats,
  weeklySeries,
} from "../api.ts";
import { count, shortPath, usd } from "../format.ts";
import { Histogram } from "../Histogram.tsx";
import { SortTh } from "../SortTh.tsx";
import { areaPath, linePath, xScale } from "../trend-charts.tsx";
import { useAsync } from "../useAsync.ts";
import { type Accessors, useSort } from "../useSort.ts";

const TOOL_SORT: Accessors<ToolUsageRow> = {
  tool: (t) => t.tool,
  uses: (t) => t.uses,
  errors: (t) => t.errors,
  errorRate: (t) => t.errorRate,
  sessions: (t) => t.sessions,
};
const SKILL_SORT: Accessors<SkillUsageRow> = {
  name: (r) => r.name,
  invocations: (r) => r.invocations,
  sessions: (r) => r.sessions,
  projects: (r) => r.projects,
  errorRate: (r) => r.errorRate,
  totalCost: (r) => r.totalCost,
};
const NAME_SORT: Accessors<NameUsageRow> = {
  name: (r) => r.name,
  sessions: (r) => r.sessions,
};

const rateClass = (r: number): string => (r >= 0.05 ? "rate-hi" : r >= 0.01 ? "rate-mid" : "muted");

function SkillSpark({ values }: { values: number[] }) {
  const W = 640;
  const H = 64;
  const pad = 4;
  const max = Math.max(...values, 1e-9);
  const n = values.length;
  const x = xScale(n, W, pad);
  const y = (v: number) => H - pad - (v / max) * (H - pad * 2);
  const line = linePath(values, x, y);
  return (
    <svg className="skillspark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img">
      <title>Invocations per week</title>
      <path className="burn-area" d={areaPath(line, x, n, H)} />
      <path className="burn-line" d={line} />
    </svg>
  );
}

function SkillDetail({ skill }: { skill: SkillUsageRow }) {
  const series = weeklySeries(skill.daily);
  return (
    <div className="skill-detail">
      <div className="skill-detail-head">
        <strong>{skill.name}</strong>
        <span className="muted">
          first {skill.firstUsed ?? "—"} · last {skill.lastUsed ?? "—"} · {skill.projects} project
          {skill.projects === 1 ? "" : "s"} · avg {usd(skill.avgCostPerSession)}/session · total{" "}
          {usd(skill.totalCost)}
        </span>
      </div>
      {series.length > 0 ? (
        <>
          <SkillSpark values={series} />
          <span className="muted spark-cap">invocations / week</span>
        </>
      ) : (
        <span className="muted">no dated sessions</span>
      )}
    </div>
  );
}

function SkillsTable({ skills }: { skills: SkillUsageRow[] }) {
  const sort = useSort(skills, SKILL_SORT, "invocations");
  const [selected, setSelected] = useState<string | null>(null);
  const sel = skills.find((s) => s.name === selected) ?? sort.sorted[0];
  return (
    <>
      <div className="tablewrap">
        <table>
          <thead>
            <tr>
              <SortTh label="Skill" col="name" sort={sort} />
              <SortTh label="Invoc" col="invocations" sort={sort} className="num" />
              <SortTh label="Sessions" col="sessions" sort={sort} className="num" />
              <SortTh label="Projects" col="projects" sort={sort} className="num" />
              <SortTh label="Err %" col="errorRate" sort={sort} className="num" />
              <SortTh label="Total $" col="totalCost" sort={sort} className="num" />
            </tr>
          </thead>
          <tbody>
            {sort.sorted.map((r) => (
              <tr
                key={r.name}
                className={`skillrow${r.name === sel?.name ? " sel" : ""}`}
                onClick={() => setSelected(r.name)}
              >
                <td>{r.name}</td>
                <td className="num">{count(r.invocations)}</td>
                <td className="num">{count(r.sessions)}</td>
                <td className="num">{count(r.projects)}</td>
                <td className={`num ${rateClass(r.errorRate)}`}>
                  {(r.errorRate * 100).toFixed(1)}%
                </td>
                <td className="num">{usd(r.totalCost)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {sel && <SkillDetail skill={sel} />}
      <p className="muted spark-cap">
        Cost is session-scoped: a session using several skills counts its full cost toward each —
        correlational, not causal.
      </p>
    </>
  );
}

function ToolsTable({ tools }: { tools: ToolUsageRow[] }) {
  const sort = useSort(tools, TOOL_SORT, "uses");
  return (
    <div className="tablewrap">
      <table>
        <thead>
          <tr>
            <SortTh label="Tool" col="tool" sort={sort} />
            <SortTh label="Uses" col="uses" sort={sort} className="num" />
            <SortTh label="Errors" col="errors" sort={sort} className="num" />
            <SortTh label="Err %" col="errorRate" sort={sort} className="num" />
            <SortTh label="Sessions" col="sessions" sort={sort} className="num" />
          </tr>
        </thead>
        <tbody>
          {sort.sorted.map((t) => (
            <tr key={t.tool}>
              <td>{t.tool}</td>
              <td className="num">{count(t.uses)}</td>
              <td className="num">{count(t.errors)}</td>
              <td className={`num ${rateClass(t.errorRate)}`}>{(t.errorRate * 100).toFixed(1)}%</td>
              <td className="num">{count(t.sessions)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function NameTable({ label, rows }: { label: string; rows: NameUsageRow[] }) {
  const sort = useSort(rows, NAME_SORT, "sessions");
  return (
    <div className="tablewrap">
      <table>
        <thead>
          <tr>
            <SortTh label={label} col="name" sort={sort} />
            <SortTh label="Sessions" col="sessions" sort={sort} className="num" />
          </tr>
        </thead>
        <tbody>
          {sort.sorted.map((r) => (
            <tr key={r.name}>
              <td>{r.name}</td>
              <td className="num">{count(r.sessions)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const BASH_SORT: Accessors<BashCommandRow> = {
  command: (b) => b.command,
  uses: (b) => b.uses,
  errors: (b) => b.errors,
  errorRate: (b) => b.errorRate,
  sessions: (b) => b.sessions,
};

function BashTable({ rows }: { rows: BashCommandRow[] }) {
  const sort = useSort(rows, BASH_SORT, "uses");
  return (
    <div className="tablewrap">
      <table>
        <thead>
          <tr>
            <SortTh label="Command" col="command" sort={sort} />
            <SortTh label="Uses" col="uses" sort={sort} className="num" />
            <SortTh label="Errors" col="errors" sort={sort} className="num" />
            <SortTh label="Err %" col="errorRate" sort={sort} className="num" />
            <SortTh label="Sessions" col="sessions" sort={sort} className="num" />
          </tr>
        </thead>
        <tbody>
          {sort.sorted.map((b) => (
            <tr key={b.command}>
              <td>{b.command}</td>
              <td className="num">{count(b.uses)}</td>
              <td className="num">{count(b.errors)}</td>
              <td className={`num ${rateClass(b.errorRate)}`}>{(b.errorRate * 100).toFixed(1)}%</td>
              <td className="num">{count(b.sessions)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Distribution of main-chain API calls per turn — how agentic the turns are. */
function DepthPanel({ depth }: { depth: TurnDepthStats }) {
  if (depth.turns === 0) return <p className="muted">No turns in the index.</p>;
  const trend = depth.byMonth;
  return (
    <>
      <p className="muted">
        {count(depth.turns)} turns · avg {depth.avgDepth.toFixed(1)} API calls/turn · deepest{" "}
        {depth.maxDepth}
        {trend.length >= 2 &&
          ` · ${trend[0]?.avgDepth.toFixed(1)} → ${trend[trend.length - 1]?.avgDepth.toFixed(1)} avg over ${trend.length} months`}
      </p>
      <Histogram rows={depth.buckets.map((b) => ({ label: `${b.label} calls`, count: b.turns }))} />
    </>
  );
}

/** Two-column facts table for small rollups (modes, stop reasons, versions…). */
function FactsTable({ head, rows }: { head: string[]; rows: (string | number)[][] }) {
  return (
    <div className="tablewrap">
      <table>
        <thead>
          <tr>
            {head.map((h, i) => (
              <th key={h} className={i === 0 ? undefined : "num"}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={String(r[0])}>
              {r.map((c, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: fixed small column count
                <td key={i} className={i === 0 ? undefined : "num"}>
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Which projects chronically hit the context ceiling. Only a session's own
 * main-chain compactions count — subagent compactions and boundaries inherited
 * by continuation files are split out in the summary line. */
function Compactions({ data }: { data: CompactionUsage }) {
  const s = data.summary;
  if (s.compactions === 0 && s.sidechain === 0 && s.inherited === 0) {
    return <p className="muted">No compactions recorded. Reindex if this seems wrong.</p>;
  }
  return (
    <>
      <p className="muted">
        <strong>{count(s.compactions)}</strong> compactions ({count(s.auto)} auto ·{" "}
        {count(s.manual)} manual{s.unknown > 0 ? ` · ${count(s.unknown)} unknown trigger` : ""}) in{" "}
        {count(s.sessions)} of {count(s.totalSessions)} sessions
        {s.sidechain > 0 && ` · ${count(s.sidechain)} in subagents`}
        {s.inherited > 0 && ` · ${count(s.inherited)} inherited from continued sessions`}
      </p>
      {data.byProject.length > 0 && (
        <FactsTable
          head={["Project", "Compactions", "Sessions hit", "Share of sessions"]}
          rows={data.byProject.map((p) => [
            shortPath(p.projectPath, p.projectId),
            count(p.compactions),
            `${count(p.sessionsWithCompaction)}/${count(p.sessions)}`,
            `${(p.share * 100).toFixed(0)}%`,
          ])}
        />
      )}
      <p className="muted spark-cap">
        A high share means this project's sessions chronically overflow the context window —
        consider smaller tasks or trimming CLAUDE.md.
      </p>
    </>
  );
}

function Reliability({ data }: { data: AnalyticsResponse }) {
  const t = data.tests;
  const r = data.retries;
  return (
    <>
      <p className="muted">
        Test runs:{" "}
        {t.runs > 0 ? (
          <>
            <strong>{count(t.runs)}</strong> across {count(t.sessions)} sessions ·{" "}
            {(t.failureRate * 100).toFixed(0)}% failed
          </>
        ) : (
          "none detected"
        )}
        {" · "}Tool-call churn:{" "}
        {r.total > 0 ? (
          <>
            <strong>{count(r.total)}</strong> repeated identical calls in {count(r.sessions)}{" "}
            sessions
          </>
        ) : (
          "none"
        )}
      </p>
      {r.byTool.length > 0 && (
        <FactsTable
          head={["Tool", "Retries", "Sessions"]}
          rows={r.byTool
            .slice(0, 10)
            .map((row) => [row.tool, count(row.retries), count(row.sessions)])}
        />
      )}
    </>
  );
}

export function Tools() {
  const { data, error, loading } = useAsync(() => api.analytics(), []);
  if (loading) return <div className="loading">Loading analytics…</div>;
  if (error) return <div className="loading err">Error: {error}</div>;
  if (!data) return null;
  const wt = data.webTools;
  const sc = data.sidechain;
  return (
    <>
      <header className="top">
        <h1>Tools &amp; skills</h1>
        <span className="muted">what you use across every session — and what fails</span>
      </header>

      <h2 className="section-h">Tools · by invocations, with error rate</h2>
      <ToolsTable tools={data.tools} />

      <h2 className="section-h">Shell commands · what Bash actually runs</h2>
      <BashTable rows={data.bash} />

      <h2 className="section-h">Reliability · test runs &amp; churn</h2>
      <Reliability data={data} />

      <h2 className="section-h">Turn depth · API calls per turn</h2>
      <DepthPanel depth={data.turnDepth} />

      <h2 className="section-h">Compactions · context-window pressure</h2>
      <Compactions data={data.compactions} />

      <h2 className="section-h">Skills · invocations, reach, reliability &amp; cost</h2>
      <SkillsTable skills={data.skills} />

      <h2 className="section-h">Subagents · by sessions</h2>
      <NameTable label="Subagent" rows={data.subagents} />
      {sc.summary.cost > 0 && (
        <>
          <p className="muted">
            Sidechain (subagent) spend: <strong>{usd(sc.summary.cost)}</strong> ·{" "}
            {(sc.summary.share * 100).toFixed(0)}% of total · {count(sc.summary.calls)} API calls
          </p>
          <FactsTable
            head={["Project", "Subagent $", "Share", "Total $"]}
            rows={sc.byProject.map((p) => [
              shortPath(p.projectPath, p.projectId),
              usd(p.sidechainCost),
              `${(p.share * 100).toFixed(0)}%`,
              usd(p.cost),
            ])}
          />
        </>
      )}

      <h2 className="section-h">Web search &amp; fetch</h2>
      {wt.summary.searches + wt.summary.fetches === 0 ? (
        <p className="muted">No server-side web tool use recorded.</p>
      ) : (
        <>
          <p className="muted">
            {count(wt.summary.searches)} searches · {count(wt.summary.fetches)} fetches ·{" "}
            {count(wt.summary.sessions)} sessions
          </p>
          <FactsTable
            head={["Project", "Searches", "Fetches"]}
            rows={wt.byProject.map((p) => [
              shortPath(p.projectPath, p.projectId),
              count(p.searches),
              count(p.fetches),
            ])}
          />
        </>
      )}

      <h2 className="section-h">Permission modes · how turns run</h2>
      <FactsTable
        head={["Mode", "Turns", "Sessions", "Avg $/session"]}
        rows={data.permissionModes.map((m) => [
          m.mode,
          count(m.turns),
          count(m.sessions),
          usd(m.avgCostPerSession),
        ])}
      />
      <p className="muted spark-cap">
        Avg cost is session-scoped (a session using several modes counts toward each) —
        correlational, not causal.
      </p>

      <h2 className="section-h">Stop reasons · how API calls end</h2>
      <FactsTable
        head={["Reason", "Calls", "Sessions"]}
        rows={data.stopReasons.map((r) => [r.reason, count(r.count), count(r.sessions)])}
      />

      <h2 className="section-h">Claude Code versions</h2>
      <FactsTable
        head={["Version", "Sessions", "First seen", "Last seen"]}
        rows={data.versions
          .slice(0, 15)
          .map((v) => [v.version, count(v.sessions), v.firstDay ?? "—", v.lastDay ?? "—"])}
      />

      <h2 className="section-h">Git branches · by sessions</h2>
      <FactsTable
        head={["Branch", "Sessions", "Session $"]}
        rows={data.branches.slice(0, 15).map((b) => [b.branch, count(b.sessions), usd(b.cost)])}
      />
      <p className="muted spark-cap">
        Session $ is session-scoped: a session touching several branches counts its full cost toward
        each — correlational, not causal.
      </p>
    </>
  );
}
