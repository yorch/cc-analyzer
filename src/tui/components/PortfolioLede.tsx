import { Box, Text } from "ink";
import { formatCount, formatDuration, formatTokens, formatUSD } from "../../cli/format.ts";
import type {
  CostDistribution,
  DurationSummary,
  MonthRow,
  PortfolioSummary,
  StreakSummary,
} from "../../core/stats.ts";
import { palette, role, sparkline } from "../theme.ts";

/** The full-width portfolio band under the title bar: big total + a months
 * spend sparkline, plus the time/percentile/streak vitals. Rendered in the
 * shell's `lede` slot on the portfolio view. */
export function PortfolioLede({
  summary,
  months,
  duration,
  distribution,
  streaks,
}: {
  summary: PortfolioSummary;
  months: MonthRow[];
  duration?: DurationSummary;
  distribution?: CostDistribution;
  streaks?: StreakSummary;
}) {
  const io = summary.inputTokens + summary.outputTokens;
  const cache = summary.cacheWriteTokens + summary.cacheReadTokens;
  const range =
    summary.firstDay && summary.lastDay ? `${summary.firstDay} → ${summary.lastDay}` : "—";
  const est = (summary.estimatedShare * 100).toFixed(0);
  const spark = sparkline(months.map((m) => m.cost)); // ascending by month → L=old, R=new

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
      {duration && distribution && streaks ? (
        <Text color={role.muted}>
          {formatDuration(duration.totalMs)} with claude ({(duration.activeShare * 100).toFixed(0)}%
          active) · median {formatUSD(distribution.p50)} / p90 {formatUSD(distribution.p90)} per
          session · top 10% = {(distribution.topDecileShare * 100).toFixed(0)}% of spend · streak{" "}
          {streaks.currentStreak}d (best {streaks.longestStreak}d)
        </Text>
      ) : null}
    </Box>
  );
}
