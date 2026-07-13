import { Box, Text } from "ink";
import { formatCount, formatTokens, formatUSD } from "../../cli/format.ts";
import type { MonthRow, PortfolioSummary } from "../../core/stats.ts";
import { palette, role, sparkline } from "../theme.ts";

/** The full-width portfolio band under the title bar: big total + a months
 * spend sparkline. Rendered in the shell's `lede` slot on the portfolio view. */
export function PortfolioLede({
  summary,
  months,
}: {
  summary: PortfolioSummary;
  months: MonthRow[];
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
    </Box>
  );
}
