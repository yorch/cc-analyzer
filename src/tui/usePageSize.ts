import { useStdout } from "ink";

/**
 * Rows available for a scrollable list, derived from the live terminal height.
 * `reserved` is the number of lines the surrounding chrome (title, tabs, footer,
 * margins) takes. Falls back to a sensible size when the height is unknown
 * (e.g. under the test renderer).
 */
export function usePageSize(reserved: number): number {
  const { stdout } = useStdout();
  const rows = stdout?.rows ?? 24;
  return Math.max(4, rows - reserved);
}
