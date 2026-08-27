import { Box, Text } from "ink";
import { formatCount, formatDuration, formatTokens, formatUSD } from "../../cli/format.ts";
import type { CostBasis } from "../../core/cost-framing.ts";
import { costFramingNote } from "../../core/cost-framing.ts";
import type {
  CostDistribution,
  DurationSummary,
  MonthRow,
  PortfolioSummary,
  StreakSummary,
} from "../../core/stats.ts";
import { INDEXED_COST_CAVEAT } from "../../core/stats-types.ts";
import { sparkline } from "../charts.ts";
import { palette, role } from "../theme.ts";

// theme.ts's old sparkline emitted one char per month with no downsampling —
// fine for a normal portfolio, but months only grow, so it would eventually
// wrap the lede line. Bound it like every other sparkline caller.
const LEDE_SPARK_WIDTH = 24;

/** The full-width portfolio band under the title bar: big total + a months
 * spend sparkline, plus the time/percentile/streak vitals. Rendered in the
 * shell's `lede` slot on the portfolio view. */
export function PortfolioLede({
  summary,
  months,
  duration,
  distribution,
  streaks,
  costBasis,
}: {
  summary: PortfolioSummary;
  months: MonthRow[];
  duration: DurationSummary;
  distribution: CostDistribution;
  streaks: StreakSummary;
  /** Display-only cost framing preference (`getCostBasis()`), computed at the
   *  App boundary — TUI presentation components never touch the state dir. */
  costBasis: CostBasis;
}) {
  const framingNote = costFramingNote(costBasis);
  const io = summary.inputTokens + summary.outputTokens;
  const cache = summary.cacheWriteTokens + summary.cacheReadTokens;
  const range =
    summary.firstDay && summary.lastDay ? `${summary.firstDay} → ${summary.lastDay}` : "—";
  const est = (summary.estimatedShare * 100).toFixed(0);
  // ascending by month → L=old, R=new
  const spark = sparkline(
    months.map((m) => m.cost),
    LEDE_SPARK_WIDTH,
  );

  return (
    <Box flexDirection="column">
      <Text bold color={role.heading}>
        {formatUSD(summary.cost)} total{" "}
        <Text color={role.muted}>· {formatTokens(io, cache)} · </Text>
        {formatCount(summary.sessions)} sessions / {summary.projects} projects
      </Text>
      <Text color={role.muted}>
        {range} · {est}% estimated
        {spark ? (
          <Text>
            {" · "}
            <Text color={palette.amberDim}>{spark}</Text> {months.length}mo
          </Text>
        ) : null}
      </Text>
      <Text color={role.muted}>
        {formatDuration(duration.totalMs)} with claude ({(duration.activeShare * 100).toFixed(0)}%
        active) · median {formatUSD(distribution.p50)} / p90 {formatUSD(distribution.p90)} per
        session
        {distribution.topDecileShare !== null
          ? ` · top 10% = ${(distribution.topDecileShare * 100).toFixed(0)}% of spend`
          : ""}{" "}
        · streak {streaks.currentStreak}d (best {streaks.longestStreak}d)
      </Text>
      {framingNote ? <Text color={role.muted}>{framingNote}</Text> : null}
      <Text color={role.muted}>{INDEXED_COST_CAVEAT}</Text>
    </Box>
  );
}
