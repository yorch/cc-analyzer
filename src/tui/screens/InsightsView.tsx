import type { Database } from "bun:sqlite";
import { Box, Text } from "ink";
import { useMemo, useState } from "react";
import { formatCount, formatUSD, truncate } from "../../cli/format.ts";
import {
  buildPortfolioDiagnostics,
  type PortfolioDiagnostic,
} from "../../core/portfolio-diagnostics.ts";
import { assemblePortfolioSignals } from "../../core/portfolio-signals.ts";
import type { PricingTable } from "../../core/pricing.ts";
import { projectDisplayName } from "../../core/project-labels.ts";
import {
  type CacheMetrics,
  type ContextTaxRow,
  type ContextTaxSummary,
  cacheVerdict,
  cacheWasteBySession,
  type ProjectCacheRow,
  type SessionCacheRow,
  type WhatIfSummary,
} from "../../core/stats.ts";
import { FilterableList } from "../components/FilterableList.tsx";
import { CachePreview } from "../components/previews.tsx";
import { MasterDetail, masterWidth } from "../shell/MasterDetail.tsx";
import { gutter, palette, role, selection, VERDICT_COLOR } from "../theme.ts";
import { type SortField, useSort } from "../useSort.ts";

const PROJECT_SORT: SortField<ProjectCacheRow>[] = [
  { key: "waste", label: "waste", value: (r) => r.waste },
  { key: "ratio", label: "ratio", value: (r) => r.ratio },
  { key: "write", label: "write$", value: (r) => r.writeCost },
  { key: "name", label: "name", value: (r) => projectDisplayName(r.projectPath, r.projectId) },
];
const SESSION_SORT: SortField<SessionCacheRow>[] = [
  { key: "waste", label: "waste", value: (r) => r.waste },
  { key: "ratio", label: "ratio", value: (r) => r.ratio },
  { key: "write", label: "write$", value: (r) => r.writeCost },
  { key: "title", label: "title", value: (r) => r.title ?? r.sessionId ?? "" },
];

interface Props {
  db: Database;
  /** Rates for the what-if repricing summary line. */
  pricing: PricingTable;
  columns: number;
  pageSize: number;
  isActive: boolean;
  /** Open a session's full detail by id. */
  onOpenSession: (sessionId: string) => void;
  /** Called on esc from the top-level project list (focus the rail). */
  onBack: () => void;
}

/**
 * Cache-efficiency hit-list: projects ranked by un-amortized cache-write $,
 * drilling into a project's sessions. Self-contained two-level drill (like the
 * detail screen) so App only routes to it.
 */
export function InsightsView({
  db,
  pricing,
  columns,
  pageSize,
  isActive,
  onOpenSession,
  onBack,
}: Props) {
  // One assembly at the screen boundary: the portfolio signals already carry
  // every number this screen shows (cache summary + hit-list, context tax,
  // what-if) as well as the inputs the rules fold, so computing them twice
  // would only be a second chance to disagree. Everything below is a plain
  // prop — the presentation components never touch the database.
  const signals = useMemo(() => assemblePortfolioSignals(db, pricing), [db, pricing]);
  const summary = signals.cache.summary;
  const projects = signals.cache.projects;
  const tax = signals.contextTax;
  const whatIf = signals.whatIf;
  const diagnostics = useMemo(() => buildPortfolioDiagnostics(signals), [signals]);
  const [drilled, setDrilled] = useState<ProjectCacheRow | null>(null);
  const sessions = useMemo(
    () => (drilled ? cacheWasteBySession(db, drilled.projectId) : []),
    [db, drilled],
  );

  const shownFindings = diagnostics.slice(0, MAX_FINDING_LINES);
  const overflow = diagnostics.length - shownFindings.length;
  // context-tax + what-if summary lines, plus the compact findings block.
  const extraLines = 2 + shownFindings.length + (overflow > 0 ? 1 : 0);
  const listSize = Math.max(3, pageSize - 1 - extraLines);
  const wastePct =
    summary.totalCost > 0 ? Math.round((summary.waste / summary.totalCost) * 100) : 0;

  const header = (
    <Box flexDirection="column">
      <FindingLines findings={shownFindings} overflow={overflow} columns={columns} />
      <Text color={role.muted}>
        cache: <Text color={role.body}>{formatUSD(summary.writeCost)}</Text> written ·{" "}
        <Text color={role.cost}>{formatUSD(summary.waste)}</Text> un-amortized · {wastePct}% of
        spend
      </Text>
      <ContextTaxLine summary={tax.summary} top={tax.byProject[0]} />
      <WhatIfLine summary={whatIf.summary} />
    </Box>
  );

  if (drilled) {
    return (
      <Box flexDirection="column">
        {header}
        <CacheHitList
          key={`sessions-${drilled.projectId}`}
          items={sessions}
          columns={columns}
          pageSize={listSize}
          isActive={isActive}
          sortFields={SESSION_SORT}
          filterText={(s) => `${s.title ?? ""} ${s.sessionId ?? ""}`}
          label={(s) => s.title ?? s.sessionId ?? "(untitled)"}
          previewTitle={(s) => s.title ?? s.sessionId ?? "(untitled)"}
          previewHint="↵ open full session"
          onOpen={(s) => {
            if (s.sessionId) onOpenSession(s.sessionId);
          }}
          onBack={() => setDrilled(null)}
        />
      </Box>
    );
  }

  if (projects.length === 0) {
    return (
      <Box flexDirection="column">
        {header}
        <Box marginTop={1}>
          <Text color={role.muted}>No cache activity in the index.</Text>
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      {header}
      <CacheHitList
        key="projects"
        items={projects}
        columns={columns}
        pageSize={listSize}
        isActive={isActive}
        sortFields={PROJECT_SORT}
        filterText={(p) => projectDisplayName(p.projectPath, p.projectId)}
        label={(p) => projectDisplayName(p.projectPath, p.projectId)}
        previewTitle={(p) => projectDisplayName(p.projectPath, p.projectId)}
        previewHint="↵ break down this project's sessions"
        onOpen={setDrilled}
        onBack={onBack}
      />
    </Box>
  );
}

/** Header space is scarce: three findings keeps the hit-list usable. */
const MAX_FINDING_LINES = 3;

/**
 * Compact portfolio findings (severity glyph + title, warnings first — the
 * engine already ranks them). Titles only; the full evidence and actions live
 * in `cc-analyzer insights` and the web Insights page.
 */
function FindingLines({
  findings,
  overflow,
  columns,
}: {
  findings: PortfolioDiagnostic[];
  overflow: number;
  columns: number;
}) {
  if (findings.length === 0) return null;
  return (
    <Box flexDirection="column">
      {findings.map((d) => (
        <Text
          key={`${d.code}:${d.projectId ?? ""}`}
          color={d.severity === "warning" ? role.accent : role.muted}
        >
          {d.severity === "warning" ? "!" : "·"} {truncate(d.title, Math.max(16, columns - 6))}
        </Text>
      ))}
      {overflow > 0 && (
        <Text color={role.muted}>
          {"  "}…{overflow} more — cc-analyzer insights
        </Text>
      )}
    </Box>
  );
}

/**
 * Context tax: the tokens every session pays before the user types (system
 * prompt + CLAUDE.md + MCP tool schemas). Heuristic — median, not mean, because
 * continuation sessions and big opening pastes inflate individual sessions.
 */
function ContextTaxLine({
  summary,
  top,
}: {
  summary: ContextTaxSummary;
  top: ContextTaxRow | undefined;
}) {
  if (summary.sessions === 0) return null;
  return (
    <Text color={role.muted}>
      context tax: <Text color={role.body}>{formatCount(Math.round(summary.medianTokens))}</Text>{" "}
      median · {formatCount(Math.round(summary.p90Tokens))} p90 tokens before you type
      {top ? ` · heaviest ${truncate(projectDisplayName(top.projectPath, top.projectId), 28)}` : ""}
    </Text>
  );
}

/**
 * What-if: the cheapest single model to have run everything on. Rate comparison
 * only — a different model produces different tokens, and quality isn't priced.
 */
function WhatIfLine({ summary }: { summary: WhatIfSummary }) {
  if (!summary.bestModel || summary.bestDelta >= 0) return null;
  return (
    <Text color={role.muted}>
      what-if: all tokens on <Text color={role.body}>{summary.bestModel}</Text> ={" "}
      <Text color={role.cost}>{formatUSD(summary.bestCost)}</Text> vs{" "}
      {formatUSD(summary.actualCost)} actual · same tokens, other rates (quality not priced)
    </Text>
  );
}

/** Shared ranked-by-waste master list + cache preview, for projects or sessions. */
function CacheHitList<T extends CacheMetrics>({
  items,
  columns,
  pageSize,
  isActive,
  sortFields,
  filterText,
  label,
  previewTitle,
  previewHint,
  onOpen,
  onBack,
}: {
  items: T[];
  columns: number;
  pageSize: number;
  isActive: boolean;
  sortFields: SortField<T>[];
  filterText: (item: T) => string;
  label: (item: T) => string;
  previewTitle: (item: T) => string;
  previewHint: string;
  onOpen: (item: T) => void;
  onBack: () => void;
}) {
  const sort = useSort(sortFields);
  const rows = sort.sorted(items);
  const [highlighted, setHighlighted] = useState<T | undefined>(rows[0]);
  const nameW = Math.max(10, masterWidth(columns) - 22);

  return (
    <MasterDetail
      columns={columns}
      master={
        <FilterableList
          items={rows}
          isActive={isActive}
          pageSize={pageSize}
          onSelect={onOpen}
          onBack={onBack}
          onHighlight={setHighlighted}
          sortLabel={sort.label}
          onCycleSort={sort.cycle}
          onReverseSort={sort.reverse}
          filterText={filterText}
          renderItem={(r, sel) => (
            <Text {...selection(sel)}>
              {gutter(sel)}
              {formatUSD(r.waste).padStart(8)} {`${r.ratio.toFixed(1)}×`.padStart(6)}{" "}
              <Text color={sel ? palette.bg : VERDICT_COLOR[cacheVerdict(r.ratio)]}>●</Text>{" "}
              {truncate(label(r), nameW)}
            </Text>
          )}
        />
      }
      detail={
        <CachePreview
          title={highlighted ? previewTitle(highlighted) : ""}
          row={highlighted}
          hint={previewHint}
        />
      }
    />
  );
}
