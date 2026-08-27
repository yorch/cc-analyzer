import { type ReactNode, useEffect, useMemo, useState } from "react";
import { EmptyNotice, ErrorNotice, LoadingNotice } from "../AsyncNotice.tsx";
import {
  api,
  buildContextGrowth,
  buildSessionDiagnostics,
  buildTurnSeries,
  burstAttributionNote,
  CONTEXT_GROWTH_CAVEAT,
  CONTEXT_GROWTH_FLAG_SHARE,
  type ContextGrowthEntry,
  type CostRankCohort,
  cumulativeShares,
  formatSignedUSD,
  groupSidechainBursts,
  MIN_RANK_COHORT,
  OUTCOME_CAVEAT,
  outcomeRows,
  pct,
  type SessionAnalysis,
  type SessionResponse,
  type SidechainBurst,
  SKILL_COST_CAVEAT,
  sessionOutcomes,
  shareOf,
  type TranscriptItem,
  type Turn,
  type TurnStep,
  topEntries,
  turnCostShape,
  WHATIF_CAVEAT,
} from "../api.ts";
import { Card } from "../Card.tsx";
import { copyText } from "../clipboard.ts";
import { DiagnosticList } from "../DiagnosticList.tsx";
import { ExportPanel } from "../ExportPanel.tsx";
import { cacheOf, count, duration, ioOf, tokensOf, usd } from "../format.ts";
import { link, useHashParam } from "../router.ts";
import { Seg } from "../Seg.tsx";
import { SessionCharts } from "../SessionCharts.tsx";
import { ChartData, chartBox } from "../trend-charts.tsx";
import { useAsync } from "../useAsync.ts";
import { useProjects } from "../useProjects.ts";
import { type Accessors, useSort } from "../useSort.ts";

type Tab = "summary" | "charts" | "timeline" | "turns" | "transcript" | "claude";
const SESSION_TABS = ["summary", "charts", "timeline", "turns", "transcript", "claude"] as const;

/** One-click model choices for "Analyze with Claude Code". Mirrors
 *  `ANALYSIS_MODELS` in `src/core/claude-handoff.ts` (bun-side, not importable
 *  here); a persisted custom default is added to this list at render time. */
const MODEL_OPTIONS = ["sonnet", "opus", "haiku"];

/** A turn the page was asked to reveal. The nonce makes a repeat request for
 *  the same turn a new event, so clicking the same anchor twice still scrolls. */
interface TurnFocus {
  turn: number;
  nonce: number;
}

/** The anchor id every turn header carries, so charts and tables elsewhere in
 *  the page can point at one turn. */
export const turnAnchorId = (turnIndex: number): string => `turn-${turnIndex + 1}`;

export function Session({ id }: { id: string }) {
  const [tab, setTab] = useHashParam<Tab>("tab", "summary", SESSION_TABS);
  const [focus, setFocus] = useState<TurnFocus | null>(null);
  // Cross-tab navigation: switch to Turns, then let `Turns` widen its window to
  // cover the turn and scroll to it once it has actually rendered.
  const goToTurn = (turnIndex: number) => {
    setFocus((prev) => ({ turn: turnIndex, nonce: (prev?.nonce ?? 0) + 1 }));
    setTab("turns");
  };
  // Sticky once the transcript tab has been opened, so switching tabs doesn't
  // refetch — but the (potentially huge) transcript is never fetched eagerly.
  // Derived from `tab` in an effect so any way of reaching the tab (deep link,
  // keyboard) latches it, not just the tab button's onClick.
  const [transcriptWanted, setTranscriptWanted] = useState(false);
  useEffect(() => {
    if (tab === "transcript") setTranscriptWanted(true);
  }, [tab]);
  // Shared across every page that needs the project list — see useProjects.ts
  // — so this doesn't refetch the whole portfolio just to resolve one id.
  const projects = useProjects();
  const analysis = useAsync(() => api.session(id), [id]);
  const transcript = useAsync(
    () => (transcriptWanted ? api.transcript(id) : Promise.resolve(null)),
    [id, transcriptWanted],
  );

  if (analysis.loading || projects.loading) return <LoadingNotice>Loading session…</LoadingNotice>;
  if (analysis.error)
    return (
      <ErrorNotice
        error={analysis.error}
        retry={analysis.retry}
        label="Couldn’t load this session."
      />
    );
  const a = analysis.data;
  if (!a) return null;
  // By id, not by path: two Claude roots can hold a project for the same
  // working directory, and a path match would link to whichever sorted first.
  const project = projects.data?.find((row) => row.projectId === a.projectId);
  const c = a.totals.cost;
  const rankCard = pickRankCohort(a.insights?.rank ?? null);

  return (
    <>
      <div className="crumbs">
        <a href={link.dashboard()}>Dashboard</a>
        {a.projectPath && " · "}
        {project ? (
          <a href={link.project(project.projectId)}>{a.projectPath}</a>
        ) : (
          <span className="muted">{a.projectPath}</span>
        )}
      </div>
      {/* The session itself loaded fine — this is only the shared project-list
          fetch (used solely for the breadcrumb link above) failing on its
          own. Non-blocking: surfaced with a retry rather than hidden. */}
      {projects.error && (
        <ErrorNotice
          error={String(projects.error)}
          retry={projects.retry}
          label="Couldn’t load the project link."
        />
      )}
      <header className="top">
        <h1>{a.title ?? a.sessionId ?? "(untitled)"}</h1>
      </header>

      <div className="cards">
        <Card label="Cost" value={usd(c.total)} sub={c.estimated ? "estimated" : undefined} />
        <Card label="Tokens" value={tokensOf(a.totals.tokens)} />
        <Card label="Turns" value={String(a.totals.turns)} sub={`${a.totals.apiCalls} api calls`} />
        <Card label="Tool calls" value={String(a.totals.toolCalls)} />
        <Card
          label="Duration"
          value={duration(a.durationMs)}
          sub={`${duration(a.totals.activeMs)} active`}
        />
        {a.totals.sidechainCost > 0 && (
          <Card
            label="Subagents"
            value={usd(a.totals.sidechainCost)}
            sub={`${a.totals.sidechainApiCalls} sidechain calls`}
          />
        )}
        {rankCard && (
          <Card label="Cost rank" value={`p${rankCard.cohort.pct}`} sub={rankCard.sub} />
        )}
      </div>

      <SessionExport id={id} />
      <ExportPanel sessionId={id} />

      <div className="tabs" role="tablist" aria-label="Session Views">
        {SESSION_TABS.map((t, index) => (
          <button
            type="button"
            key={t}
            className={t === tab ? "active" : ""}
            onClick={() => setTab(t)}
            onKeyDown={(event) => {
              if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
              event.preventDefault();
              const delta = event.key === "ArrowRight" ? 1 : -1;
              const next = SESSION_TABS[
                (index + delta + SESSION_TABS.length) % SESSION_TABS.length
              ] as Tab;
              setTab(next);
              document.getElementById(`session-tab-${next}`)?.focus();
            }}
            id={`session-tab-${t}`}
            role="tab"
            aria-selected={t === tab}
            aria-controls={`session-panel-${t}`}
            tabIndex={t === tab ? 0 : -1}
          >
            {t}
          </button>
        ))}
      </div>

      <div id={`session-panel-${tab}`} role="tabpanel" aria-labelledby={`session-tab-${tab}`}>
        {tab === "summary" && <Summary a={a} onGoToTurn={goToTurn} />}
        {tab === "charts" && <SessionCharts a={a} onGoToTurn={goToTurn} />}
        {tab === "timeline" && <Timeline a={a} />}
        {tab === "turns" && <Turns a={a} focus={focus} />}
        {tab === "transcript" && (
          <Transcript
            loading={transcript.loading}
            error={transcript.error}
            retry={transcript.retry}
            items={transcript.data ?? []}
          />
        )}
        {tab === "claude" && <SessionClaude id={id} />}
      </div>
    </>
  );
}

function SessionExport({ id }: { id: string }) {
  const [redact, setRedact] = useState(false);
  const [includeTranscript, setIncludeTranscript] = useState(false);
  const [copied, setCopied] = useState<"idle" | "ok" | "failed">("idle");

  const doCopy = async () => {
    try {
      const text = await api.sessionReportText(id, { redact, transcript: includeTranscript });
      setCopied((await copyText(text)) ? "ok" : "failed");
    } catch {
      setCopied("failed");
    }
    setTimeout(() => setCopied("idle"), 2000);
  };

  const doDownload = (format: "md" | "html" | "json") => {
    const { url } = api.sessionReport(id, { format, redact, transcript: includeTranscript });
    // Use a hidden anchor so the browser honors Content-Disposition without leaving the SPA.
    const a = document.createElement("a");
    a.href = url;
    a.download = "";
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  return (
    <div className="digest-actions" style={{ marginTop: 8, marginBottom: 8 }}>
      <label style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
        <input type="checkbox" checked={redact} onChange={(e) => setRedact(e.target.checked)} />{" "}
        redact
      </label>
      <label style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
        <input
          type="checkbox"
          checked={includeTranscript}
          onChange={(e) => setIncludeTranscript(e.target.checked)}
        />{" "}
        transcript
      </label>
      <button type="button" onClick={doCopy}>
        {copied === "ok" ? "Copied!" : copied === "failed" ? "Copy failed" : "Copy as Markdown"}
      </button>
      <button type="button" onClick={() => doDownload("md")}>
        Download MD
      </button>
      <button type="button" onClick={() => doDownload("html")}>
        HTML
      </button>
      <button type="button" onClick={() => doDownload("json")}>
        JSON
      </button>
    </div>
  );
}

/**
 * "Analyze with Claude Code": spawns a local `claude` headless (server-side) and
 * streams a read-only retrospective of this session, grounded in cc-analyzer's
 * own metrics. Explicitly opt-in — nothing runs until Analyze is clicked, since
 * the run is a real (billable) Claude Code session.
 */
function SessionClaude({ id }: { id: string }) {
  const prefs = useAsync(() => api.prefs(), []);
  const [model, setModel] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [output, setOutput] = useState("");
  const [cost, setCost] = useState<number | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  // Adopt the persisted default once prefs load, before the user picks.
  const defaultModel = prefs.data?.analysisModel ?? "sonnet";
  const selected = model ?? defaultModel;
  const options = MODEL_OPTIONS.includes(selected) ? MODEL_OPTIONS : [selected, ...MODEL_OPTIONS];

  const onModelChange = (next: string) => {
    setModel(next);
    // Persist as the new default; best-effort, never blocks the run.
    api.setAnalysisModel(next).catch(() => {});
  };

  const run = async () => {
    setRunning(true);
    setOutput("");
    setCost(undefined);
    setError(null);
    setDone(false);
    let streamed = false;
    try {
      await api.analyze(id, selected, (event) => {
        if (event.type === "text") {
          streamed = true;
          setOutput((prev) => prev + event.delta);
        } else if (event.type === "result") {
          if (!streamed && event.text) setOutput(event.text);
          setCost(event.costUsd);
        } else {
          setError(event.message);
        }
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
      setDone(true);
    }
  };

  return (
    <div className="claude-analyze">
      <p className="muted">
        Runs the Claude Code CLI on your machine over this session (read-only), grounded in the
        metrics above. It’s a real Claude Code run and costs tokens, so it only starts when you
        click Analyze.
      </p>
      <div className="digest-actions">
        <label>
          Model{" "}
          <select
            value={selected}
            onChange={(event) => onModelChange(event.target.value)}
            disabled={running}
          >
            {options.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>
        <button type="button" onClick={run} disabled={running}>
          {running ? "Analyzing…" : done ? "Analyze again" : "Analyze with Claude Code"}
        </button>
        {cost !== undefined && <span className="muted">Run cost: {usd(cost)}</span>}
      </div>
      {error && (
        <p className="muted" role="alert">
          {error}
        </p>
      )}
      {output && (
        <pre className="claude-output" aria-live="polite">
          {output}
        </pre>
      )}
      {running && !output && <p className="muted">Waiting for Claude Code…</p>}
    </div>
  );
}

/**
 * Which cohort the Cost-rank card shows: the project's when it is big enough
 * to mean something (`MIN_RANK_COHORT`), else the portfolio's; no card at all
 * when both are tiny — "p50 of 2 sessions" is noise, not signal. When the
 * project cohort is shown, the portfolio rank rides along in the sub-line.
 */
function pickRankCohort(
  rank: { portfolio: CostRankCohort; project?: CostRankCohort } | null,
): { cohort: CostRankCohort; sub: string } | undefined {
  if (!rank) return undefined;
  const { portfolio, project } = rank;
  if (project && project.sessions >= MIN_RANK_COHORT) {
    const overall =
      portfolio.sessions > project.sessions ? ` · p${portfolio.pct} of all sessions` : "";
    return { cohort: project, sub: `of ${project.sessions} project sessions${overall}` };
  }
  if (portfolio.sessions >= MIN_RANK_COHORT) {
    return { cohort: portfolio, sub: `of ${portfolio.sessions} sessions` };
  }
  return undefined;
}

/** Rows in the Summary tab's "Costliest turns" block. Enough to answer "where
 *  did the money go" at a glance without turning the summary into a second
 *  Turns tab — the link into Turns is there for the rest. */
const COSTLIEST_TURNS = 5;

/**
 * The few turns that dominate the session's spend, as an entry point rather
 * than a report: every row jumps into the Turns tab at that turn. Ordered by
 * cost, so a session whose expensive turn sits at #480 still leads with it.
 */
function CostliestTurns({
  a,
  onGoToTurn,
}: {
  a: SessionAnalysis;
  onGoToTurn: (turnIndex: number) => void;
}) {
  const rows = useMemo(
    () => [...a.turns].sort((x, y) => y.cost.total - x.cost.total).slice(0, COSTLIEST_TURNS),
    [a],
  );
  const sessionCost = a.totals.cost.total;
  // Rows are already cost-descending, which is what makes the running share a
  // Pareto reading ("the top 3 are 61% of the spend") rather than a burn curve.
  const cum = useMemo(
    () =>
      cumulativeShares(
        rows.map((t) => t.cost.total),
        sessionCost,
      ),
    [rows, sessionCost],
  );
  if (rows.length === 0 || (rows[0]?.cost.total ?? 0) <= 0) return null;
  return (
    <section className="summary-group" style={{ marginTop: 12 }}>
      <h2>Costliest turns</h2>
      <div className="tablewrap">
        <table>
          <thead>
            <tr>
              <th className="num">#</th>
              <th className="num">Cost</th>
              <th className="num">Share</th>
              <th className="num">Cumulative</th>
              <th className="num">Calls</th>
              <th>Prompt</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((t, i) => (
              <tr key={t.index}>
                <td className="num">
                  <button
                    type="button"
                    className="row-button"
                    title={`Open turn #${t.index + 1} in the Turns tab`}
                    onClick={() => onGoToTurn(t.index)}
                  >
                    #{t.index + 1}
                  </button>
                </td>
                <td className="num">{usd(t.cost.total)}</td>
                <td className="num">{pct(shareOf(t.cost.total, sessionCost))}</td>
                <td className="num">{pct(cum[i] ?? 0)}</td>
                <td className="num">{t.apiCalls.length}</td>
                <td className="muted">{t.prompt.slice(0, 80) || "(no text)"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Summary({ a, onGoToTurn }: { a: SessionResponse; onGoToTurn: (i: number) => void }) {
  const c = a.totals.cost;
  const t = a.totals.tokens;
  const diagnostics = useMemo(() => buildSessionDiagnostics(a), [a]);
  // The shared row set (labels, order, absent-not-$0 rule) — same list the
  // CLI report and TUI summary render; only the leading capital is local.
  const outcomes = useMemo(() => outcomeRows(sessionOutcomes(a)), [a]);
  const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  const whatIf = a.insights?.whatIf;
  return (
    <section>
      <section className="session-diagnostics" aria-labelledby="session-diagnostics-title">
        <h2 id="session-diagnostics-title">Actionable diagnostics</h2>
        {diagnostics.length === 0 ? (
          <p className="muted">
            No notable context or cost patterns crossed the current diagnostic thresholds.
          </p>
        ) : (
          <DiagnosticList items={diagnostics} keyOf={(d) => d.code} />
        )}
      </section>
      <div className="summary-grid">
        <SummaryGroup title="Spend & Tokens">
          <Row k="Cost (input/output)" v={`${usd(c.input)} / ${usd(c.output)}`} />
          <Row k="Cost (cache write/read)" v={`${usd(c.cacheWrite)} / ${usd(c.cacheRead)}`} />
          <Row k="Tokens (input/output)" v={`${count(t.inputTokens)} / ${count(t.outputTokens)}`} />
          <Row
            k="Tokens (cache write/read)"
            v={`${count(t.cacheWrite5mTokens + t.cacheWrite1hTokens)} / ${count(t.cacheReadTokens)}`}
          />
          <Row
            k="Active / wall time"
            v={`${duration(a.totals.activeMs)} / ${duration(a.durationMs)}`}
          />
        </SummaryGroup>
        <SummaryGroup title="Execution">
          <Row k="Models" v={Object.keys(a.models).join(", ") || "-"} />
          <Row k="Web search / fetch" v={`${a.totals.webSearches} / ${a.totals.webFetches}`} />
          <Row k="Stop reasons" v={topEntries(a.stopReasons) || "-"} />
          <Row k="Permission modes" v={topEntries(a.permissionModes) || "-"} />
          <Row
            k="Test runs"
            v={a.testRuns > 0 ? `${a.testRuns} (${a.testFailures} failed)` : "none detected"}
          />
          <Row
            k="Tool-call churn"
            v={a.retries > 0 ? `${a.retries} repeated identical calls` : "none"}
          />
          <Row
            k="Compactions"
            v={
              a.compactions.length > 0
                ? `${a.compactions.length} (${a.compactions
                    .map(
                      (c) =>
                        `${c.trigger ?? "unknown"}${c.isSidechain ? " subagent" : ""}${c.inherited ? " inherited" : ""}`,
                    )
                    .join(", ")})`
                : "none"
            }
          />
        </SummaryGroup>
        <SummaryGroup title="Environment">
          <Row k="Git branches" v={a.gitBranches.join(", ") || "-"} />
          <Row k="CC versions" v={a.versions.join(", ") || "-"} />
          <Row k="Files touched" v={String(a.filesTouched.length)} />
          <Row k="Shell commands" v={topEntries(a.bashCommands, 8) || "-"} />
        </SummaryGroup>
        {outcomes.length > 0 && (
          <SummaryGroup title="Cost per outcome">
            {outcomes.map((r) => (
              <Row key={r.label} k={capitalize(r.label)} v={usd(r.cost)} />
            ))}
          </SummaryGroup>
        )}
      </div>
      {outcomes.length > 0 && <p className="muted">{OUTCOME_CAVEAT}</p>}
      <CostliestTurns a={a} onGoToTurn={onGoToTurn} />
      <Subagents bursts={a.sidechainBursts} />
      {whatIf?.summary.bestModel && (
        <section className="summary-group" style={{ marginTop: 12 }}>
          <h2>What-if repricing</h2>
          <p>
            cheapest single model: {whatIf.summary.bestModel} at {usd(whatIf.summary.bestCost)} (
            {formatSignedUSD(whatIf.summary.bestDelta)} vs actual {usd(whatIf.summary.actualCost)})
          </p>
          <p className="muted">{WHATIF_CAVEAT}</p>
        </section>
      )}
      {/* Detailed tools & skills breakdown — session-level, with error rates and turn-scoped cost */}
      {Object.keys(a.tools).length > 0 && (
        <section className="summary-group" style={{ marginTop: 12 }}>
          <h2>Tools</h2>
          <div className="tablewrap">
            <table>
              <thead>
                <tr>
                  <th>Tool</th>
                  <th className="num">Count</th>
                  <th className="num">Errors</th>
                  <th className="num">Err %</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(a.tools)
                  .sort((x, y) => y[1] - x[1])
                  .map(([tool, n]) => {
                    const errs = a.toolErrors[tool] ?? 0;
                    const pct = n > 0 ? Math.round((errs / n) * 100) : 0;
                    return (
                      <tr key={tool}>
                        <td>{tool}</td>
                        <td className="num">{n}</td>
                        <td className="num">{errs}</td>
                        <td className="num">{pct}%</td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </div>
        </section>
      )}
      {Object.keys(a.skills).length > 0 && (
        <section className="summary-group" style={{ marginTop: 12 }}>
          <h2>Skills</h2>
          <div className="tablewrap">
            <table>
              <thead>
                <tr>
                  <th>Skill</th>
                  <th className="num">Uses</th>
                  <th className="num">Turns</th>
                  <th className="num">Turn $</th>
                  <th className="num">Errors</th>
                  <th className="num">Err %</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(a.skills)
                  .sort((x, y) => y[1] - x[1])
                  .map(([skill, uses]) => {
                    const attr = a.skillTurnCosts[skill];
                    const errs = a.skillErrors[skill] ?? 0;
                    const errPct = uses > 0 ? Math.round((errs / uses) * 100) : 0;
                    return (
                      <tr key={skill}>
                        <td>{skill}</td>
                        <td className="num">{uses}</td>
                        <td className="num">{attr?.turns ?? 0}</td>
                        <td className="num">{usd(attr?.cost ?? 0)}</td>
                        <td className="num">{errs}</td>
                        <td className="num">{errPct}%</td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </div>
          <p className="muted">{SKILL_COST_CAVEAT}</p>
        </section>
      )}
      {a.subagents.length > 0 && <p className="muted">Subagents: {a.subagents.join(", ")}</p>}
    </section>
  );
}

/**
 * Per-burst subagent spend: which agent ran, in which turn, and what it cost.
 *
 * The per-type rollup answers "what do my reviewers cost"; this answers "which
 * burst cost $3", which is the question a session view is actually asked. Both
 * render, rollup first, because a session with many same-type agents is
 * unreadable as bursts alone.
 */
function Subagents({ bursts }: { bursts: SidechainBurst[] }) {
  const rows = useMemo(() => groupSidechainBursts(bursts), [bursts]);
  const note = burstAttributionNote(bursts);
  if (bursts.length === 0) return null;
  return (
    <section className="summary-group" style={{ marginTop: 12 }}>
      <h2>Subagents</h2>
      <div className="tablewrap">
        <table>
          <thead>
            <tr>
              <th>Type</th>
              <th className="num">Bursts</th>
              <th className="num">Calls</th>
              <th className="num">Cost</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.type}>
                <td>{r.type}</td>
                <td className="num">{r.bursts}</td>
                <td className="num">{r.apiCalls}</td>
                <td className="num">{usd(r.cost)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="tablewrap" style={{ marginTop: 8 }}>
        <table>
          <thead>
            <tr>
              <th className="num">#</th>
              <th>Type</th>
              <th>Agent</th>
              <th className="num">Turn</th>
              <th className="num">Calls</th>
              <th className="num">Cost</th>
            </tr>
          </thead>
          <tbody>
            {bursts.map((b, i) => (
              <tr key={b.agentId ?? `${b.startTime ?? "?"}-${i}`}>
                <td className="num">{i + 1}</td>
                <td>
                  {b.subagentType ?? "(unmatched)"}
                  {b.spawnDepth !== undefined && b.spawnDepth > 1 && (
                    <span className="muted"> · nested ×{b.spawnDepth}</span>
                  )}
                </td>
                <td className="muted">{b.agentId ?? "-"}</td>
                <td className="num">{b.turnIndex !== undefined ? `#${b.turnIndex + 1}` : "-"}</td>
                <td className="num">{b.apiCalls}</td>
                <td className="num">{usd(b.cost)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {note && <p className="muted">{note}</p>}
    </section>
  );
}

function SummaryGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="summary-group">
      <h2>{title}</h2>
      <div className="tablewrap">
        <table>
          <tbody>{children}</tbody>
        </table>
      </div>
    </section>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <tr>
      <td className="muted" style={{ width: 220 }}>
        {k}
      </td>
      <td>{v}</td>
    </tr>
  );
}

interface TimedTurn {
  turn: Turn;
  startMs: number;
  endMs: number;
  calls: { ms: number; hasError: boolean; ci: number }[];
}

const TIMELINE_WINDOW = 200;

/** Gantt: one lane per turn across the session's wall clock; dots are API
 * calls (teal = sidechain, red ring = a tool error inside the call). */
function Timeline({ a }: { a: SessionAnalysis }) {
  // Geometry is parsed once per session — huge sessions have tens of
  // thousands of calls, and Date.parse per render would jank every re-render.
  const timed = useMemo<TimedTurn[]>(
    () =>
      a.turns.flatMap((turn) => {
        const startMs = turn.startTime ? Date.parse(turn.startTime) : Number.NaN;
        const endMs = turn.endTime ? Date.parse(turn.endTime) : Number.NaN;
        if (Number.isNaN(startMs) || Number.isNaN(endMs)) return [];
        const calls = turn.apiCalls.flatMap((call, ci) => {
          const ms = call.timestamp ? Date.parse(call.timestamp) : Number.NaN;
          if (Number.isNaN(ms)) return [];
          return [{ ms, hasError: call.steps.some((s) => s.status === "error"), ci }];
        });
        return [{ turn, startMs, endMs, calls }];
      }),
    [a],
  );
  const { limit, more } = useWindowed(timed.length, TIMELINE_WINDOW);
  if (timed.length === 0) return <EmptyNotice>No timed turns in this session.</EmptyNotice>;
  const t0 = Math.min(...timed.map((t) => t.startMs));
  const t1 = Math.max(...timed.map((t) => t.endMs));
  const span = Math.max(t1 - t0, 1);
  const shown = timed.slice(0, limit);
  const W = 900;
  const rowH = 16;
  const H = shown.length * rowH + 8;
  const x = (ms: number) => ((ms - t0) / span) * (W - 16) + 8;
  const offset = (ms: number) => duration(ms - t0);
  return (
    <section>
      <p className="muted">
        {duration(span)} wall · {duration(a.totals.activeMs)} active · one lane per turn, dots are
        API calls
        {timed.length > limit ? ` · showing ${limit}/${timed.length} turns` : ""}
      </p>
      <div className="legend">
        <span className="legend-item">
          <span className="legend-swatch tl-turn" />
          turn lane
        </span>
        <span className="legend-item">
          <span className="legend-swatch tl-turn-flagged" />
          interrupted or correction turn
        </span>
        <span className="legend-item">
          <span className="legend-swatch tl-call" />
          API call
        </span>
        <span className="legend-item">
          <span className="legend-swatch tl-call-side" />
          subagent (sidechain) call
        </span>
        <span className="legend-item">
          <span className="legend-swatch tl-call-err" />
          tool error in that call
        </span>
      </div>
      <div className="timelinewrap">
        <svg
          className="timeline"
          viewBox={`0 0 ${W} ${H}`}
          style={chartBox(W, H)}
          role="img"
          aria-label={`Session timeline showing ${shown.length} turns and their API calls`}
        >
          <title>Session timeline</title>
          {shown.map((t, i) => {
            const y = i * rowH + 4;
            const sx = x(t.startMs);
            const ex = x(t.endMs);
            // Deliberately the user-intervention subset, not the full
            // `turnFlags` thrash predicate: a red lane means "the human
            // stepped in here"; tool errors already mark their own call dots.
            const flags = [
              ...(t.turn.interrupted ? ["interrupted"] : []),
              ...(t.turn.correction ? ["correction prompt"] : []),
            ];
            return (
              <g key={t.turn.index}>
                <rect
                  className={`tl-turn${flags.length > 0 ? " flagged" : ""}`}
                  x={sx}
                  y={y + 2}
                  width={Math.max(ex - sx, 2)}
                  height={8}
                  rx={2}
                >
                  <title>{`#${t.turn.index + 1} +${offset(t.startMs)} · ${usd(t.turn.cost.total)} · ${t.turn.apiCalls.length} calls${flags.length > 0 ? ` · ⚠ ${flags.join(" · ")}` : ""}\n${t.turn.prompt.slice(0, 160)}`}</title>
                </rect>
                {t.calls.map(({ ms, hasError, ci }) => {
                  const call = t.turn.apiCalls[ci] as Turn["apiCalls"][number];
                  const cls = `tl-call${call.isSidechain ? " side" : ""}${hasError ? " err" : ""}`;
                  return (
                    <circle
                      key={`${t.turn.index}.${ci}`}
                      className={cls}
                      cx={x(ms)}
                      cy={y + 6}
                      r={3}
                    >
                      <title>{`+${offset(ms)} · ${call.model ?? "?"} · ${usd(call.cost.total)}${call.stopReason ? ` · ${call.stopReason}` : ""}${call.isSidechain ? " · sidechain" : ""}${hasError ? " · tool error" : ""}`}</title>
                    </circle>
                  );
                })}
              </g>
            );
          })}
        </svg>
      </div>
      <div className="axis">
        <span>start</span>
        <span>{duration(span)}</span>
      </div>
      <ChartData
        labelHeading="Turn"
        valueHeading="Cost"
        labels={shown.map((t) => `#${t.turn.index + 1} · +${offset(t.startMs)}`)}
        values={shown.map((t) => t.turn.cost.total)}
        format={usd}
      />
      {more}
    </section>
  );
}

const TURNS_WINDOW = 100;

/** Reveal a long list in `step`-sized chunks; returns the current slice length
 *  and a "Show more / Show all" control (or null when everything fits).
 *  `atLeast` lets a caller demand a minimum window — how a deep link to turn
 *  #480 reveals it without the reader clicking "Show more" five times. */
function useWindowed(total: number, step: number, atLeast = 0): { limit: number; more: ReactNode } {
  const [visible, setVisible] = useState(step);
  const limit = Math.min(Math.max(visible, atLeast), total);
  const more =
    total > limit ? (
      <div className="loadmore">
        <button type="button" onClick={() => setVisible((v) => v + step)}>
          Show more
        </button>
        <span className="muted">{count(total - limit)} remaining</span>
      </div>
    ) : null;
  return { limit, more };
}

/** Wall-clock span of a turn, when both ends are timestamped. */
function turnWallMs(t: Turn): number | undefined {
  const start = t.startTime ? Date.parse(t.startTime) : Number.NaN;
  const end = t.endTime ? Date.parse(t.endTime) : Number.NaN;
  return Number.isNaN(start) || Number.isNaN(end) ? undefined : end - start;
}

const TURN_SORT_KEYS = ["index", "cost", "tokens", "calls", "time"] as const;

const TURN_ACCESSORS: Accessors<Turn> = {
  index: (t) => t.index,
  cost: (t) => t.cost.total,
  tokens: (t) => ioOf(t.tokens) + cacheOf(t.tokens),
  calls: (t) => t.apiCalls.length,
  time: (t) => turnWallMs(t) ?? 0,
};

function Turns({ a, focus }: { a: SessionAnalysis; focus?: TurnFocus | null }) {
  const [open, setOpen] = useState<Set<number>>(new Set());
  // Index-ascending by default: a session is a narrative, and ranking is an
  // added lens rather than a replacement. Clicking the active key flips the
  // direction, exactly as `SortTh` does for the tabled views.
  const sort = useSort(a.turns, TURN_ACCESSORS, "index", "asc");
  const rows = sort.sorted;
  const sessionCost = a.totals.cost.total;
  // `turnCostShape` is a pure function of the shared `TurnPoint`, so it is
  // derived from the same series the charts use and joined by turn index.
  const shapes = useMemo(
    () => new Map(buildTurnSeries(a).map((p) => [p.index, turnCostShape(p)])),
    [a],
  );
  // Per-call context growth, keyed by the (turn, call-position) pair this view
  // already iterates — so the expanded call blocks below can say what each
  // call's steps put into the context.
  const growth = useMemo(() => buildContextGrowth(a), [a]);
  const growthByCall = useMemo(
    () => new Map(growth.entries.map((e) => [`${e.turnIndex}.${e.callIndex}`, e])),
    [growth],
  );
  // A requested turn widens the window before the scroll runs, so the anchor
  // exists by the time the effect below looks for it. Its POSITION, not its
  // number: under a cost sort turn #480 can be the first row.
  const focusPos = focus ? rows.findIndex((t) => t.index === focus.turn) : -1;
  const { limit, more } = useWindowed(rows.length, TURNS_WINDOW, focusPos + 1);
  useEffect(() => {
    if (!focus) return;
    document.getElementById(turnAnchorId(focus.turn))?.scrollIntoView({ block: "start" });
  }, [focus]);
  const toggle = (i: number) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });

  return (
    <div>
      <div className="trend-head">
        <span className="seg-group">
          sort{" "}
          <Seg
            label="Turn sort key"
            options={TURN_SORT_KEYS}
            value={sort.key as (typeof TURN_SORT_KEYS)[number]}
            onChange={sort.toggle}
          />{" "}
          <span className="muted" aria-hidden="true">
            {sort.dir === "asc" ? "▲" : "▼"}
          </span>
          <span className="sr-only">
            sorted by {sort.key}, {sort.dir === "asc" ? "ascending" : "descending"}; activate the
            active key again to reverse
          </span>
        </span>
      </div>
      {rows.slice(0, limit).map((t) => {
        const expanded = open.has(t.index);
        return (
          <div className="item" id={turnAnchorId(t.index)} key={t.index}>
            <button
              type="button"
              className="turnhead"
              onClick={() => toggle(t.index)}
              aria-expanded={expanded}
            >
              <span className="muted">{expanded ? "▾" : "▸"}</span>{" "}
              <span className="num">#{t.index + 1}</span> · {usd(t.cost.total)} ·{" "}
              <span className="muted">{pct(shareOf(t.cost.total, sessionCost))} of session</span> ·{" "}
              <span className="muted">{tokensOf(t.tokens)}</span> · {t.apiCalls.length} calls ·{" "}
              {shapes.get(t.index) ? (
                <>
                  <span className="turnshape" title={shapes.get(t.index)?.detail}>
                    {shapes.get(t.index)?.label}
                  </span>{" "}
                  ·{" "}
                </>
              ) : null}
              <span className="muted">
                {Object.entries(t.toolCounts)
                  .map(([n, c]) => `${n}:${c}`)
                  .join(" ") || "no tools"}
              </span>
              <div className="turnprompt">{t.prompt.slice(0, 140) || "(no text)"}</div>
            </button>
            {expanded && (
              <div className="turncalls">
                {t.apiCalls.map((call, ci) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: API calls within a turn have no stable id; order is fixed
                  <div key={`${t.index}.${ci}`} className="callblock">
                    <div className="calldivider">
                      <span className="muted">{call.model ?? "?"}</span>
                      <span className="muted">
                        {usd(call.cost.total)} · {tokensOf(call.tokens)}
                        <ContextGrowthTag entry={growthByCall.get(`${t.index}.${ci}`)} />
                      </span>
                    </div>
                    {call.steps.map((step, si) => (
                      <StepRow key={step.toolUseId ?? `${t.index}.${ci}.${si}`} step={step} />
                    ))}
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
      {more}
      {growth.entries.length > 0 && <p className="muted">{CONTEXT_GROWTH_CAVEAT}</p>}
    </div>
  );
}

/**
 * "+47.0k ctx" beside an API call: what the steps that call issued put into
 * the context, from the shared `buildContextGrowth`. Flagged when the call is
 * a large share of everything that entered the context this session — a token
 * delta only, never a derived dollar (see `CONTEXT_GROWTH_CAVEAT`).
 */
function ContextGrowthTag({ entry }: { entry?: ContextGrowthEntry }) {
  if (!entry) return null;
  const big = entry.share >= CONTEXT_GROWTH_FLAG_SHARE;
  return (
    <>
      {" · "}
      <span
        className={big ? "ctxgrowth big" : "ctxgrowth"}
        title={`${entry.steps.join(", ") || "this call"} added ${count(
          entry.deltaTokens,
        )} tokens to the context — ${pct(entry.share)} of this session's context growth`}
      >
        +{count(entry.deltaTokens)} ctx
      </span>
    </>
  );
}

function StepRow({ step }: { step: TurnStep }) {
  const [open, setOpen] = useState(false);
  const hasDetail = Boolean(step.detail?.input || step.detail?.result);
  const icon = STEP_ICON[step.kind] ?? "·";
  const content = (
    <>
      <span className="stepicon" aria-hidden="true">
        {icon}
      </span>
      <span className="steplabel">{step.label}</span>
      {step.summary && <span className="stepsummary">{step.summary}</span>}
      {step.status === "error" && <span className="err"> ✗</span>}
      {step.status === "ok" && <span className="ok"> ✓</span>}
      {step.resultHint && <span className="stephint">{step.resultHint}</span>}
    </>
  );
  return (
    <div className={`step k-${step.kind}`}>
      {hasDetail ? (
        <button
          type="button"
          className="steprow"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
        >
          {content}
        </button>
      ) : (
        <div className="steprow static">{content}</div>
      )}
      {open && hasDetail && (
        <div className="stepdetail">
          {step.detail?.input && step.kind !== "note" && step.kind !== "thinking" && (
            <>
              <div className="stepdetaillabel">input</div>
              <pre>{step.detail.input}</pre>
            </>
          )}
          {step.detail?.result && (
            <>
              <div className="stepdetaillabel">
                {step.kind === "note" || step.kind === "thinking" ? "full text" : "result"}
              </div>
              <pre>{step.detail.result}</pre>
            </>
          )}
          {step.detail?.truncated && (
            <div className="muted">truncated · see Transcript for full</div>
          )}
        </div>
      )}
    </div>
  );
}

const STEP_ICON: Record<string, string> = {
  note: "»",
  thinking: "◦",
  run: "$",
  read: "▤",
  edit: "✎",
  search: "⌕",
  skill: "◆",
  subagent: "⌥",
  web: "◍",
  task: "☑",
  ask: "?",
  tool: "·",
};

const TRANSCRIPT_WINDOW = 200;

function Transcript({
  loading,
  error,
  retry,
  items,
}: {
  loading: boolean;
  error: string | null;
  retry: () => void;
  items: TranscriptItem[];
}) {
  const { limit, more } = useWindowed(items.length, TRANSCRIPT_WINDOW);
  if (loading) return <LoadingNotice>Loading transcript…</LoadingNotice>;
  if (error)
    return <ErrorNotice error={error} retry={retry} label="Couldn’t load the transcript." />;
  const shown = items.slice(0, limit);
  return (
    <section>
      <p className="muted">
        {count(items.length)} items{items.length > limit ? ` · showing ${limit}` : ""}
      </p>
      {shown.map((item) => (
        <div className={`item k-${item.kind}`} key={item.index}>
          <div className="head">
            {item.label}
            {item.isError && <span className="err"> ✗ error</span>}
          </div>
          <pre>{item.body || "(empty)"}</pre>
        </div>
      ))}
      {more}
    </section>
  );
}
