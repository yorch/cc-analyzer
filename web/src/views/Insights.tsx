import { projectDisplayName } from "../../../src/core/project-labels.ts";
import { EmptyNotice, ErrorNotice, LoadingNotice } from "../AsyncNotice.tsx";
import {
  api,
  type ContextTax,
  cacheVerdict,
  costFramingNote,
  type IdleCacheBucket,
  PORTFOLIO_DIAGNOSTIC_CODES,
  type PortfolioDiagnostic,
  type ProjectCacheRow,
  type SessionCacheRow,
  type WhatIfRepricing,
} from "../api.ts";
import { DiagnosticList } from "../DiagnosticList.tsx";
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
  project: (r) => projectDisplayName(r.projectPath, r.projectId),
};

export function Insights() {
  const { data, error, loading, retry } = useAsync(() => api.insights(), []);
  // Cost basis is a preference, not an insight: fetch it from the tiny
  // `/api/prefs` endpoint rather than pulling the whole portfolio payload in
  // just to frame the dollar tables below.
  const costBasis = useAsync(() => api.prefs(), []).data?.costBasis;
  const framingNote = costBasis ? costFramingNote(costBasis) : undefined;
  const [query, setQuery] = useHashParam<string>("q", "");
  const q = query.toLowerCase();
  const all = data?.projects ?? [];
  const filtered = q
    ? all.filter((p) => projectDisplayName(p.projectPath, p.projectId).toLowerCase().includes(q))
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
        <h1>Insights</h1>
        <span className="muted">
          {usd(s.writeCost)} written · {usd(s.waste)} un-amortized · {wastePct}% of spend
        </span>
      </header>
      {framingNote && <p className="muted">{framingNote}</p>}

      <PortfolioInsights diagnostics={data.diagnostics} />

      <h2 className="section-h">Cache efficiency</h2>
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
      <p className="muted">
        R:W is the cache read-to-write ratio: efficient ≥2×, ok 1–2×, leaky &lt;1×.
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
                  <a href={link.insightsProject(p.projectId)}>
                    {projectDisplayName(p.projectPath, p.projectId)}
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length === 0 && <EmptyNotice>No cache-active projects match this filter.</EmptyNotice>}

      <CostOptimization />
    </>
  );
}

/** Ranked portfolio findings from the bun-free rules engine — the "coach"
 * section: warnings first, each with observed evidence and a next action.
 * Project-scoped findings link to their project page. */
function PortfolioInsights({ diagnostics }: { diagnostics: PortfolioDiagnostic[] }) {
  return (
    <section>
      <h2 className="section-h">Portfolio insights · what to do differently</h2>
      <p className="muted">
        Named heuristics folded over every portfolio signal — cache, compactions, context tax,
        repricing, errors, and your setup. Not a score: every finding shows its evidence and a
        suggested next step.
      </p>
      {diagnostics.length === 0 ? (
        <p className="muted">
          No findings — the portfolio looks healthy by every rule (
          {PORTFOLIO_DIAGNOSTIC_CODES.length} rules checked).
        </p>
      ) : (
        <DiagnosticList
          items={diagnostics}
          keyOf={(d) => `${d.code}:${d.projectId ?? ""}`}
          extra={(d) =>
            d.projectId && (
              <p>
                <a href={link.project(d.projectId)}>
                  {projectDisplayName(d.projectPath, d.projectId)}
                </a>
              </p>
            )
          }
        />
      )}
    </section>
  );
}

/** Context tax + what-if repricing, from `/api/analytics`. Fetched separately
 * from the cache data so a slow (or failing) analytics scan never blocks the
 * cache hit-list this page is primarily about. */
function CostOptimization() {
  const { data } = useAsync(() => api.analytics(), []);
  if (!data) return null;
  return (
    <>
      <ContextTaxPanel tax={data.contextTax} />
      <WhatIfPanel whatIf={data.whatIf} />
    </>
  );
}

/** The tokens every session in a project pays for before the user types. */
function ContextTaxPanel({ tax }: { tax: ContextTax }) {
  if (tax.summary.sessions === 0) return null;
  return (
    <section>
      <h2 className="section-h">Context tax · what a session costs before you type</h2>
      <p className="muted">
        Prompt-side tokens of each session's first main-chain API call — the system prompt, your
        CLAUDE.md, and every MCP tool schema, loaded before your first word. Portfolio median{" "}
        <strong>{count(Math.round(tax.summary.medianTokens))}</strong> · p90{" "}
        <strong>{count(Math.round(tax.summary.p90Tokens))}</strong> tokens across{" "}
        {count(tax.summary.sessions)} {tax.summary.sessions === 1 ? "session" : "sessions"}.
      </p>
      <p className="muted">
        A heuristic baseline, not a measurement: a continuation session (resumed from a compaction
        summary) or one opened with a large paste inflates its own number, so read the median as the
        recurring floor and p90 as the bad case.
      </p>
      <div className="tablewrap">
        <table>
          <thead>
            <tr>
              <th className="num">Median</th>
              <th className="num">p90</th>
              <th className="num">Average</th>
              <th className="num">Sessions</th>
              <th>Project</th>
            </tr>
          </thead>
          <tbody>
            {tax.byProject.map((p) => (
              <tr key={p.projectId}>
                <td className="num">{count(Math.round(p.medianTokens))}</td>
                <td className="num">{count(Math.round(p.p90Tokens))}</td>
                <td className="num">{count(Math.round(p.avgTokens))}</td>
                <td className="num">{p.sessions}</td>
                <td>
                  <a href={link.project(p.projectId)}>
                    {projectDisplayName(p.projectPath, p.projectId)}
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** Each model's actual token mix replayed at the other models' rates. */
function WhatIfPanel({ whatIf }: { whatIf: WhatIfRepricing }) {
  if (whatIf.rows.length === 0) return null;
  const s = whatIf.summary;
  return (
    <section>
      <h2 className="section-h">What-if · the same tokens at another model's rates</h2>
      <p className="muted">
        Every model's actual token mix — input, output, both cache-write TTLs, and cache-read —
        priced at the rates of{" "}
        {s.fallbackAlternatives
          ? "a canonical model per family"
          : "the other models you actually ran"}
        .
        {s.bestModel && s.bestDelta < 0 && (
          <>
            {" "}
            Running all of it on <strong>{s.bestModel}</strong> would have priced out at{" "}
            <strong>{usd(s.bestCost)}</strong> instead of {usd(s.actualCost)} —{" "}
            <strong>{usd(-s.bestDelta)}</strong> lower.
          </>
        )}
      </p>
      <p className="insight-callout">
        <strong>Caveat:</strong> these are your actual token counts replayed at other models' rates.
        A different model would produce a different number of tokens — usually more of them on a
        smaller model — and quality is not priced in at all. Treat it as a rate comparison, not a
        forecast.
      </p>
      {s.fallbackAlternatives && (
        <p className="muted">
          You've run fewer than two priceable models, so the comparison uses a canonical model per
          family rather than your own mix.
        </p>
      )}
      <div className="tablewrap">
        <table>
          <thead>
            <tr>
              <th>Model</th>
              <th className="num">Calls</th>
              <th className="num">Actual $</th>
              <th>Repriced at</th>
            </tr>
          </thead>
          <tbody>
            {whatIf.rows.map((r) => (
              <tr key={r.model}>
                <td>{r.model}</td>
                <td className="num">{count(r.calls)}</td>
                <td className="num">{usd(r.cost)}</td>
                <td>
                  {r.alternatives.map((a) => (
                    <div key={a.model}>
                      {a.model}: {usd(a.cost)}{" "}
                      <span className={a.delta < 0 ? "delta-down" : "delta-up"}>
                        {a.delta < 0 ? "−" : "+"}
                        {usd(Math.abs(a.delta))}
                      </span>
                    </div>
                  ))}
                  {r.alternatives.length === 0 && <span className="muted">no alternatives</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
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
