import { EmptyNotice, ErrorNotice, LoadingNotice } from "../AsyncNotice.tsx";
import {
  type AnalyticsResponse,
  api,
  type BashCommandRow,
  CORRECTION_CAVEAT,
  type CompactionUsage,
  type NameUsageRow,
  PARSE_COVERAGE_MAX_UNPARSED_SHARE,
  PARSE_COVERAGE_MIN_LINES,
  type ParseCoverageStats,
  type PluginUsageRow,
  SETUP_AUDIT_CAVEAT,
  type SetupAudit,
  SKILL_COST_CAVEAT,
  type SkillUsageRow,
  type ToolUsageRow,
  type TurnDepthStats,
  weeklySeries,
} from "../api.ts";
import { DiagnosticList } from "../DiagnosticList.tsx";
import { count, shortPath, usd } from "../format.ts";
import { Histogram } from "../Histogram.tsx";
import { useHashParam } from "../router.ts";
import { SearchField } from "../SearchField.tsx";
import { SortTh } from "../SortTh.tsx";
import { areaPath, chartBox, linePath, xScale } from "../trend-charts.tsx";
import { useAsync } from "../useAsync.ts";
import { type Accessors, useSort } from "../useSort.ts";
import { ViewPanel, ViewTabs } from "../ViewTabs.tsx";

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
  attributedCost: (r) => r.attributedCost,
  totalCost: (r) => r.totalCost,
};
const NAME_SORT: Accessors<NameUsageRow> = {
  name: (r) => r.name,
  sessions: (r) => r.sessions,
};

const rateClass = (r: number): string => (r >= 0.05 ? "rate-hi" : r >= 0.01 ? "rate-mid" : "muted");
/** The severity the color encodes, spelled out — color alone is not a signal. */
const rateTitle = (r: number): string =>
  r >= 0.05
    ? "high error rate (5% or more)"
    : r >= 0.01
      ? "elevated error rate (1–5%)"
      : "low error rate";

/** An error rate with its severity carried in text, not only in color: a ⚠
 *  prefix at the top tier and the tier itself in the title. */
function ErrRate({ rate }: { rate: number }) {
  return (
    <span title={rateTitle(rate)}>
      {rate >= 0.05 ? "⚠ " : ""}
      {(rate * 100).toFixed(1)}%
    </span>
  );
}

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
    <svg
      className="skillspark"
      viewBox={`0 0 ${W} ${H}`}
      style={chartBox(W, H)}
      role="img"
      aria-label={`Weekly skill invocation trend across ${n} weeks, peak ${Math.round(max)}`}
    >
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
          {skill.projects === 1 ? "" : "s"} · {count(skill.attributedTurns)} attributed turn
          {skill.attributedTurns === 1 ? "" : "s"} · {usd(skill.attributedCost)} turn-scoped ·{" "}
          {usd(skill.totalCost)} session-scoped
        </span>
      </div>
      {series.length > 0 ? (
        <>
          <SkillSpark values={series} />
          {/* The sparkline's own tabular fallback: it carries no hover titles,
              so the numbers that bound it have to be readable in text. */}
          <span className="muted spark-cap">
            invocations / week · {series.length} week{series.length === 1 ? "" : "s"} · min{" "}
            {count(Math.min(...series))} · max {count(Math.max(...series))} · total{" "}
            {count(series.reduce((s, v) => s + v, 0))}
          </span>
        </>
      ) : (
        <span className="muted">no dated sessions</span>
      )}
    </div>
  );
}

function SkillsTable({ skills }: { skills: SkillUsageRow[] }) {
  const sort = useSort(skills, SKILL_SORT, "invocations");
  const [selected, setSelected] = useHashParam<string>("skill", "");
  if (skills.length === 0) return <EmptyNotice>No skills match this filter.</EmptyNotice>;
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
              <SortTh label="Turn $" col="attributedCost" sort={sort} className="num" />
              <SortTh label="Session $" col="totalCost" sort={sort} className="num" />
            </tr>
          </thead>
          <tbody>
            {sort.sorted.map((r) => (
              <tr key={r.name} className={`skillrow${r.name === sel?.name ? " sel" : ""}`}>
                <td>
                  <button
                    type="button"
                    className="row-button"
                    aria-pressed={r.name === sel?.name}
                    onClick={() => setSelected(r.name)}
                  >
                    {r.name}
                  </button>
                </td>
                <td className="num">{count(r.invocations)}</td>
                <td className="num">{count(r.sessions)}</td>
                <td className="num">{count(r.projects)}</td>
                <td className={`num ${rateClass(r.errorRate)}`}>
                  <ErrRate rate={r.errorRate} />
                </td>
                <td className="num">{usd(r.attributedCost)}</td>
                <td className="num muted">{usd(r.totalCost)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {sel && <SkillDetail skill={sel} />}
      <p className="muted spark-cap">{SKILL_COST_CAVEAT}</p>
    </>
  );
}

function ToolsTable({ tools }: { tools: ToolUsageRow[] }) {
  const sort = useSort(tools, TOOL_SORT, "uses");
  if (tools.length === 0) return <EmptyNotice>No tools match this filter.</EmptyNotice>;
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
              <td className={`num ${rateClass(t.errorRate)}`}>
                <ErrRate rate={t.errorRate} />
              </td>
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
  if (rows.length === 0) return <EmptyNotice>No subagents match this filter.</EmptyNotice>;
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
  if (rows.length === 0) return <EmptyNotice>No shell commands match this filter.</EmptyNotice>;
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
              <td className={`num ${rateClass(b.errorRate)}`}>
                <ErrRate rate={b.errorRate} />
              </td>
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
  if (depth.turns === 0) return <EmptyNotice>No turns in the index.</EmptyNotice>;
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
function Compactions({ data, query }: { data: CompactionUsage; query: string }) {
  const s = data.summary;
  if (s.compactions === 0 && s.sidechain === 0 && s.inherited === 0) {
    return <EmptyNotice>No compactions recorded. Reindex if this seems wrong.</EmptyNotice>;
  }
  const q = query.trim().toLowerCase();
  const rows = q
    ? data.byProject.filter((p) =>
        `${p.projectPath ?? ""} ${p.projectId}`.toLowerCase().includes(q),
      )
    : data.byProject;
  return (
    <>
      <p className="muted">
        <strong>{count(s.compactions)}</strong> compactions ({count(s.auto)} auto ·{" "}
        {count(s.manual)} manual{s.unknown > 0 ? ` · ${count(s.unknown)} unknown trigger` : ""}) in{" "}
        {count(s.sessions)} of {count(s.totalSessions)} sessions
        {s.sidechain > 0 && ` · ${count(s.sidechain)} in subagents`}
        {s.inherited > 0 && ` · ${count(s.inherited)} inherited from continued sessions`}
      </p>
      {rows.length > 0 ? (
        <>
          <FactsTable
            head={["Project", "Compactions", "Sessions hit", "Share of sessions"]}
            rows={rows.map((p) => [
              shortPath(p.projectPath, p.projectId),
              count(p.compactions),
              `${count(p.sessionsWithCompaction)}/${count(p.sessions)}`,
              `${(p.share * 100).toFixed(0)}%`,
            ])}
          />
          {rows.length < data.byProject.length && (
            <p className="muted spark-cap">
              showing {rows.length} of {data.byProject.length} projects
            </p>
          )}
        </>
      ) : (
        data.byProject.length > 0 && <EmptyNotice>No projects match this filter.</EmptyNotice>
      )}
      <p className="muted spark-cap">
        A high share means this project's sessions chronically overflow the context window —
        consider smaller tasks or trimming CLAUDE.md.
      </p>
    </>
  );
}

/**
 * How much of the indexed JSONL this build of the parser actually understood,
 * per Claude Code version (newest first). The session format is undocumented
 * and moves between releases; unparsed lines are excluded from every metric, so
 * a rising share on the newest version means the numbers below it read low.
 */
/** Row caps on the long tail tables; every one of them says so on screen. */
const VERSION_ROW_LIMIT = 15;
const RETRY_TOOL_LIMIT = 10;
const BRANCH_ROW_LIMIT = 15;

function ParseCoverage({ data, query }: { data: ParseCoverageStats; query: string }) {
  const s = data.summary;
  if (s.lines === 0) {
    return <EmptyNotice>No parse coverage recorded. Reindex if this seems wrong.</EmptyNotice>;
  }
  const q = query.trim().toLowerCase();
  const rows = data.byVersion.filter((r) => !q || r.version.toLowerCase().includes(q));
  const share = (v: number) => `${(v * 100).toFixed(2)}%`;
  const newest = data.byVersion[0];
  const behind =
    newest !== undefined &&
    newest.lines >= PARSE_COVERAGE_MIN_LINES &&
    newest.unparsedShare >= PARSE_COVERAGE_MAX_UNPARSED_SHARE;
  return (
    <>
      <p className="muted">
        <strong>{share(1 - s.unparsedShare)}</strong> of {count(s.lines)} indexed lines fully parsed
        across {count(s.sessions)} sessions · {count(s.parseErrors)} unreadable ·{" "}
        {count(s.unknownEvents)} kept as unknown events
      </p>
      {rows.length > 0 && (
        <>
          <FactsTable
            head={["Version", "Sessions", "Lines", "Unreadable", "Unknown", "Unparsed"]}
            rows={rows
              .slice(0, VERSION_ROW_LIMIT)
              .map((r) => [
                r.version,
                count(r.sessions),
                count(r.lines),
                count(r.parseErrors),
                count(r.unknownEvents),
                share(r.unparsedShare),
              ])}
          />
          {rows.length > VERSION_ROW_LIMIT && (
            <p className="muted spark-cap">
              showing the {VERSION_ROW_LIMIT} newest of {rows.length} versions
            </p>
          )}
        </>
      )}
      <p className="muted spark-cap">
        {behind
          ? `Claude Code ${newest?.version} sessions are ${share(newest?.unparsedShare ?? 0)} unparsed — run ` +
            "`cc-analyzer update`; the session format may have moved ahead of this parser."
          : "Unparsed lines are excluded from every metric. A version is attributed per session " +
            "(the newest version the session ran under), so this is a best-effort split."}
      </p>
    </>
  );
}

const PLUGIN_SORT: Accessors<PluginUsageRow> = {
  plugin: (p) => p.plugin,
  skillsUsed: (p) => p.skillsUsed,
  agentsUsed: (p) => p.agentsUsed,
  invocations: (p) => p.invocations,
  attributedCost: (p) => p.attributedCost,
  lastUsed: (p) => p.lastUsed ?? "",
};

/** What each installed plugin actually did: usage and turn-scoped cost rolled
 *  up from the skills/subagents/MCP servers it ships. */
function PluginsTable({ rows }: { rows: PluginUsageRow[] }) {
  const sort = useSort(rows, PLUGIN_SORT, "attributedCost");
  if (rows.length === 0) return null;
  return (
    <>
      <h3 className="section-h">Plugins · what each one does for you</h3>
      <div className="tablewrap">
        <table>
          <thead>
            <tr>
              <SortTh label="Plugin" col="plugin" sort={sort} />
              <SortTh label="Skills used" col="skillsUsed" sort={sort} className="num" />
              <SortTh label="Subagents used" col="agentsUsed" sort={sort} className="num" />
              <SortTh label="Invoc" col="invocations" sort={sort} className="num" />
              <SortTh label="Turn $" col="attributedCost" sort={sort} className="num" />
              <SortTh label="Last used" col="lastUsed" sort={sort} />
            </tr>
          </thead>
          <tbody>
            {sort.sorted.map((p) => (
              <tr key={p.plugin}>
                <td>{p.plugin}</td>
                <td className="num">
                  {p.skillsUsed}/{p.skillsShipped}
                </td>
                <td className="num">
                  {p.agentsUsed}/{p.agentsShipped}
                </td>
                <td className="num">{count(p.invocations)}</td>
                <td className="num">{usd(p.attributedCost)}</td>
                <td className="muted">{p.lastUsed ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted spark-cap">{SKILL_COST_CAVEAT}</p>
    </>
  );
}

/** Inventory counts + findings from `/api/audit`. Fetched on its own so the
 * filesystem scan never blocks the usage analytics the rest of this page shows. */
function SetupAuditPanel({ query }: { query: string }) {
  const { data, error, loading } = useAsync(() => api.audit(), []);
  if (loading) return <LoadingNotice>Scanning your setup…</LoadingNotice>;
  if (error || !data) return <p className="muted">Couldn’t load the setup audit.</p>;
  return <SetupAuditBody audit={data} query={query} />;
}

function SetupAuditBody({ audit, query }: { audit: SetupAudit; query: string }) {
  const c = audit.counts;
  const inv = audit.inventory;
  const q = query.trim().toLowerCase();
  const findings = q
    ? audit.findings.filter((f) => `${f.subject} ${f.code} ${f.title}`.toLowerCase().includes(q))
    : audit.findings;
  return (
    <>
      <h2 className="section-h">Setup audit · what’s installed vs what you use</h2>
      <p className="muted">
        Installed under{" "}
        {inv.claudeDirs.map((dir, i) => (
          <span key={dir}>
            {i > 0 ? ", " : ""}
            <code>{dir}</code>
          </span>
        ))}
        {inv.present ? "" : " (not found)"}
        {inv.model ? ` · model pinned to ${inv.model}` : ""}
      </p>
      <div className="cards compact-cards">
        <div className="card">
          <div className="label">Skills</div>
          <div className="value">{count(c.skills)}</div>
        </div>
        <div className="card">
          <div className="label">Subagents</div>
          <div className="value">{count(c.agents)}</div>
        </div>
        <div className="card">
          <div className="label">Plugins</div>
          <div className="value">{count(c.plugins)}</div>
        </div>
        <div className="card">
          <div className="label">MCP Servers</div>
          <div className="value">{count(c.mcpServers)}</div>
        </div>
        <div className="card">
          <div className="label">Hooks</div>
          <div className="value">{count(c.hooks)}</div>
        </div>
        <div className="card">
          <div className="label">Permission Rules</div>
          <div className="value">
            {count(c.permissionAllow + c.permissionDeny + c.permissionAsk)}
          </div>
        </div>
      </div>
      <p className="muted">
        {c.mcpGlobal} global · {c.mcpProject} project-scoped MCP servers · hooks on {c.hookEvents}{" "}
        {c.hookEvents === 1 ? "event" : "events"} · {c.permissionAllow} allow / {c.permissionDeny}{" "}
        deny / {c.permissionAsk} ask
      </p>
      <PluginsTable rows={audit.plugins} />
      {findings.length === 0 ? (
        <EmptyNotice>
          {audit.findings.length === 0
            ? "Everything installed is in use, and nothing crossed a threshold."
            : "No findings match this filter."}
        </EmptyNotice>
      ) : (
        <DiagnosticList items={findings} keyOf={(f) => `${f.code}:${f.subject}`} />
      )}
      <p className="muted spark-cap">{SETUP_AUDIT_CAVEAT}</p>
    </>
  );
}

function Reliability({ data, query }: { data: AnalyticsResponse; query: string }) {
  const t = data.tests;
  const r = data.retries;
  const th = data.thrash;
  const co = data.corrections;
  // The page's filter field renders on this tab too, so both of its tables
  // consume it — a control that does nothing is worse than no control.
  const q = query.trim().toLowerCase();
  const retryRows = q ? r.byTool.filter((row) => row.tool.toLowerCase().includes(q)) : r.byTool;
  const rereadRows = q
    ? th.topRereadFiles.filter((row) => row.file.toLowerCase().includes(q))
    : th.topRereadFiles;
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
      {retryRows.length > 0 ? (
        <>
          <FactsTable
            head={["Tool", "Retries", "Sessions"]}
            rows={retryRows
              .slice(0, RETRY_TOOL_LIMIT)
              .map((row) => [row.tool, count(row.retries), count(row.sessions)])}
          />
          {retryRows.length > RETRY_TOOL_LIMIT && (
            <p className="muted spark-cap">
              showing the {RETRY_TOOL_LIMIT} most-retried of {retryRows.length} tools
            </p>
          )}
        </>
      ) : (
        r.byTool.length > 0 && <EmptyNotice>No retried tools match this filter.</EmptyNotice>
      )}
      <h2 className="section-h">Thrash · edit-test loops &amp; redundant re-reads</h2>
      <p className="muted">
        Edit-test loops:{" "}
        {th.testThrashSessions > 0 ? (
          <>
            <strong>{count(th.testThrashSessions)}</strong> sessions hit 3+ consecutive failing test
            runs (worst streak: {count(th.worstTestFailStreak)})
          </>
        ) : (
          "none detected"
        )}
        {" · "}Redundant reads (3rd+ read of a file on one chain):{" "}
        {th.redundantReads > 0 ? (
          <>
            <strong>{count(th.redundantReads)}</strong> across {count(th.rereadSessions)} sessions
            with 4 or more
          </>
        ) : (
          "none"
        )}
      </p>
      {rereadRows.length > 0 && (
        <>
          <FactsTable
            head={["Most re-read file", "Sessions"]}
            rows={rereadRows.map((row) => [shortPath(row.file), count(row.sessions)])}
          />
          <p className="muted">
            Every re-read pays the whole file into context again — hot reference files belong in a
            CLAUDE.md summary or a subagent.
          </p>
        </>
      )}
      <h2 className="section-h">Corrections · prompts that redo the previous turn</h2>
      <p className="muted">
        Correction turns:{" "}
        {co.correctionTurns > 0 ? (
          <>
            <strong>{count(co.correctionTurns)}</strong> of {count(co.turns)} turns (
            {(co.correctionShare * 100).toFixed(0)}%) across {count(co.sessions)} sessions
          </>
        ) : (
          "none detected"
        )}
        {" · "}Interrupted mid-flight:{" "}
        {co.interruptionTurns > 0 ? (
          <>
            <strong>{count(co.interruptionTurns)}</strong> turns (
            {(co.interruptionShare * 100).toFixed(0)}%)
          </>
        ) : (
          "none"
        )}
      </p>
      <p className="muted">{CORRECTION_CAVEAT}</p>
    </>
  );
}

export function Tools() {
  const { data, error, loading, retry } = useAsync(() => api.analytics(), []);
  const toolViews = [
    "tools",
    "reliability",
    "compactions",
    "skills",
    "agents",
    "setup",
    "environment",
  ] as const;
  type ToolView = (typeof toolViews)[number];
  const [view, setView] = useHashParam<ToolView>("view", "tools", toolViews);
  const [query, setQuery] = useHashParam<string>("q", "");
  if (loading) return <LoadingNotice>Loading analytics…</LoadingNotice>;
  if (error)
    return <ErrorNotice error={error} retry={retry} label="Couldn’t load tool analytics." />;
  if (!data) return null;
  const wt = data.webTools;
  const sc = data.sidechain;
  const q = query.trim().toLowerCase();
  const matches = (...values: unknown[]) =>
    !q ||
    values.some((value) =>
      String(value ?? "")
        .toLowerCase()
        .includes(q),
    );
  // Filtered before the row cap, so "showing 15 of N" counts what the filter
  // actually matched rather than the whole table.
  const versionRows = data.versions.filter((row) => matches(row.version));
  const branchRows = data.branches.filter((row) => matches(row.branch));
  return (
    <>
      <header className="top">
        <h1>Tools &amp; skills</h1>
        <span className="muted">what you use across every session — and what fails</span>
      </header>
      <ViewTabs
        id="analytics"
        label="Analytics Sections"
        items={toolViews}
        value={view}
        onChange={setView}
      />
      <SearchField
        label={`Filter ${view}`}
        placeholder={`Filter ${view} data…`}
        value={query}
        onChange={setQuery}
      />

      {view === "tools" && (
        <ViewPanel id="analytics" view={view}>
          <h2 className="section-h">Tools · by invocations, with error rate</h2>
          <ToolsTable tools={data.tools.filter((row) => matches(row.tool))} />
          <h2 className="section-h">Shell commands · what Bash actually runs</h2>
          <BashTable rows={data.bash.filter((row) => matches(row.command))} />
        </ViewPanel>
      )}

      {view === "reliability" && (
        <ViewPanel id="analytics" view={view}>
          <h2 className="section-h">Test runs &amp; tool-call churn</h2>
          <Reliability data={data} query={query} />
          <h2 className="section-h">Turn depth · API calls per turn</h2>
          <DepthPanel depth={data.turnDepth} />
        </ViewPanel>
      )}

      {view === "compactions" && (
        <ViewPanel id="analytics" view={view}>
          <h2 className="section-h">Context-window pressure</h2>
          <Compactions data={data.compactions} query={query} />
        </ViewPanel>
      )}

      {view === "skills" && (
        <ViewPanel id="analytics" view={view}>
          <h2 className="section-h">Skills · invocations, reach, reliability &amp; cost</h2>
          <SkillsTable skills={data.skills.filter((row) => matches(row.name))} />
        </ViewPanel>
      )}

      {view === "agents" && (
        <ViewPanel id="analytics" view={view}>
          <h2 className="section-h">Subagents · by sessions</h2>
          <NameTable label="Subagent" rows={data.subagents.filter((row) => matches(row.name))} />
          {sc.summary.cost > 0 && (
            <>
              <p className="muted">
                Sidechain (subagent) spend: <strong>{usd(sc.summary.cost)}</strong> ·{" "}
                {(sc.summary.share * 100).toFixed(0)}% of total · {count(sc.summary.calls)} API
                calls
              </p>
              <FactsTable
                head={["Project", "Subagent $", "Share", "Total $"]}
                rows={sc.byProject
                  .filter((row) => matches(row.projectPath, row.projectId))
                  .map((p) => [
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
            <EmptyNotice>No server-side web tool use recorded.</EmptyNotice>
          ) : (
            <>
              <p className="muted">
                {count(wt.summary.searches)} searches · {count(wt.summary.fetches)} fetches ·{" "}
                {count(wt.summary.sessions)} sessions
              </p>
              <FactsTable
                head={["Project", "Searches", "Fetches"]}
                rows={wt.byProject
                  .filter((row) => matches(row.projectPath, row.projectId))
                  .map((p) => [
                    shortPath(p.projectPath, p.projectId),
                    count(p.searches),
                    count(p.fetches),
                  ])}
              />
            </>
          )}
        </ViewPanel>
      )}

      {view === "setup" && (
        <ViewPanel id="analytics" view={view}>
          <SetupAuditPanel query={query} />
        </ViewPanel>
      )}

      {view === "environment" && (
        <ViewPanel id="analytics" view={view}>
          <h2 className="section-h">Permission modes · how turns run</h2>
          <FactsTable
            head={["Mode", "Turns", "Sessions", "Avg $/session"]}
            rows={data.permissionModes
              .filter((row) => matches(row.mode))
              .map((m) => [m.mode, count(m.turns), count(m.sessions), usd(m.avgCostPerSession)])}
          />
          <p className="muted spark-cap">
            Avg cost is session-scoped (a session using several modes counts toward each) —
            correlational, not causal.
          </p>
          <h2 className="section-h">Stop reasons · how API calls end</h2>
          <FactsTable
            head={["Reason", "Calls", "Sessions"]}
            rows={data.stopReasons
              .filter((row) => matches(row.reason))
              .map((r) => [r.reason, count(r.count), count(r.sessions)])}
          />
          <h2 className="section-h">Claude Code versions</h2>
          <FactsTable
            head={["Version", "Sessions", "First seen", "Last seen"]}
            rows={versionRows
              .slice(0, VERSION_ROW_LIMIT)
              .map((v) => [v.version, count(v.sessions), v.firstDay ?? "—", v.lastDay ?? "—"])}
          />
          {versionRows.length > VERSION_ROW_LIMIT && (
            <p className="muted spark-cap">
              showing {VERSION_ROW_LIMIT} of {versionRows.length} versions
            </p>
          )}
          <h2 className="section-h">Parse coverage · how much of the format we understand</h2>
          <ParseCoverage data={data.parseCoverage} query={query} />
          <h2 className="section-h">Git branches · by sessions</h2>
          <FactsTable
            head={["Branch", "Sessions", "Session $"]}
            rows={branchRows
              .slice(0, BRANCH_ROW_LIMIT)
              .map((b) => [b.branch, count(b.sessions), usd(b.cost)])}
          />
          {branchRows.length > BRANCH_ROW_LIMIT && (
            <p className="muted spark-cap">
              showing {BRANCH_ROW_LIMIT} of {branchRows.length} branches
            </p>
          )}
          <p className="muted spark-cap">
            Session $ is session-scoped: a session touching several branches counts its full cost
            toward each — correlational, not causal.
          </p>
        </ViewPanel>
      )}
    </>
  );
}
