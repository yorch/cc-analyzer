import { useState } from "react";
import {
  api,
  type NameUsageRow,
  type SkillDayCount,
  type SkillUsageRow,
  type ToolUsageRow,
} from "../api.ts";
import { count, usd } from "../format.ts";
import { SortTh } from "../SortTh.tsx";
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

/** Monday (UTC) of the ISO week containing `day` (YYYY-MM-DD), as YYYY-MM-DD. */
function weekKey(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

/** Dense weekly invocation totals across the skill's active span (gap weeks = 0). */
function weeklySeries(daily: SkillDayCount[]): number[] {
  if (daily.length === 0) return [];
  const byWeek = new Map<string, number>();
  for (const d of daily) byWeek.set(weekKey(d.day), (byWeek.get(weekKey(d.day)) ?? 0) + d.count);
  const keys = [...byWeek.keys()].sort();
  const first = keys[0];
  const last = keys[keys.length - 1];
  if (first === undefined || last === undefined) return [];
  const out: number[] = [];
  const cur = new Date(`${first}T00:00:00Z`);
  const end = new Date(`${last}T00:00:00Z`);
  while (cur <= end) {
    out.push(byWeek.get(cur.toISOString().slice(0, 10)) ?? 0);
    cur.setUTCDate(cur.getUTCDate() + 7);
  }
  return out;
}

function SkillSpark({ values }: { values: number[] }) {
  const W = 640;
  const H = 64;
  const pad = 4;
  const max = Math.max(...values, 1e-9);
  const n = values.length;
  const x = (i: number) => (n <= 1 ? pad : (i / (n - 1)) * (W - pad * 2) + pad);
  const y = (v: number) => H - pad - (v / max) * (H - pad * 2);
  const line = values.map((v, i) => `${i === 0 ? "M" : "L"} ${x(i).toFixed(1)},${y(v).toFixed(1)}`);
  const area = `M ${x(0).toFixed(1)},${H} ${line.join(" ").replace(/^M/, "L")} L ${x(n - 1).toFixed(1)},${H} Z`;
  return (
    <svg className="skillspark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img">
      <title>Invocations per week</title>
      <path className="burn-area" d={area} />
      <path className="burn-line" d={line.join(" ")} />
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

export function Tools() {
  const { data, error, loading } = useAsync(() => api.analytics(), []);
  if (loading) return <div className="loading">Loading analytics…</div>;
  if (error) return <div className="loading err">Error: {error}</div>;
  if (!data) return null;
  return (
    <>
      <header className="top">
        <h1>Tools &amp; skills</h1>
        <span className="muted">what you use across every session — and what fails</span>
      </header>

      <h2 className="section-h">Tools · by invocations, with error rate</h2>
      <ToolsTable tools={data.tools} />

      <h2 className="section-h">Skills · invocations, reach, reliability &amp; cost</h2>
      <SkillsTable skills={data.skills} />

      <h2 className="section-h">Subagents · by sessions</h2>
      <NameTable label="Subagent" rows={data.subagents} />
    </>
  );
}
