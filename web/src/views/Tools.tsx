import { api, type NameUsageRow, type ToolUsageRow } from "../api.ts";
import { count } from "../format.ts";
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
const NAME_SORT: Accessors<NameUsageRow> = {
  name: (r) => r.name,
  sessions: (r) => r.sessions,
};

const rateClass = (r: number): string => (r >= 0.05 ? "rate-hi" : r >= 0.01 ? "rate-mid" : "muted");

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

      <h2 className="section-h">Skills · by sessions</h2>
      <NameTable label="Skill" rows={data.skills} />

      <h2 className="section-h">Subagents · by sessions</h2>
      <NameTable label="Subagent" rows={data.subagents} />
    </>
  );
}
