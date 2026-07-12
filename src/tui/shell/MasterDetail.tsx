import { Box, Text } from "ink";
import type { ReactNode } from "react";
import { palette } from "../theme.ts";
import { layoutMode } from "../useTermSize.ts";

interface Props {
  columns: number;
  master: ReactNode;
  detail: ReactNode;
  /** Master pane width as a percentage of available columns. */
  masterPct?: number;
  /** Label for the detail pane when nothing is selected. */
  emptyDetail?: string;
}

const DEFAULT_PCT = 40;

/** The master pane's column width for a given terminal, so callers can
 * truncate row content to fit rather than letting Ink wrap it. */
export function masterWidth(columns: number, pct = DEFAULT_PCT): number {
  return Math.max(22, Math.floor((columns * pct) / 100));
}

/**
 * Two-pane master-detail body. The master list drives the detail preview. On
 * narrow terminals it collapses to the master pane alone (detail is reached by
 * drilling in), matching the pre-shell single-column behavior.
 */
export function MasterDetail({
  columns,
  master,
  detail,
  masterPct = DEFAULT_PCT,
  emptyDetail,
}: Props) {
  if (layoutMode(columns) === "narrow") {
    return <Box flexDirection="column">{master}</Box>;
  }
  return (
    <Box>
      <Box
        flexDirection="column"
        width={masterWidth(columns, masterPct)}
        flexShrink={0}
        borderStyle="single"
        borderColor={palette.line}
        borderTop={false}
        borderBottom={false}
        borderLeft={false}
        paddingRight={1}
        marginRight={1}
      >
        {master}
      </Box>
      <Box flexDirection="column" flexGrow={1}>
        {detail ?? (emptyDetail ? <Text color={palette.ink3}>{emptyDetail}</Text> : null)}
      </Box>
    </Box>
  );
}
