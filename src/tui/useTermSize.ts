import { useStdout } from "ink";
import { useEffect, useState } from "react";

export interface TermSize {
  columns: number;
  rows: number;
}

/** Live terminal size, updated on resize. Falls back to 80×24 when unknown. */
export function useTermSize(): TermSize {
  const { stdout } = useStdout();
  const [size, setSize] = useState<TermSize>({
    columns: stdout?.columns ?? 80,
    rows: stdout?.rows ?? 24,
  });

  useEffect(() => {
    if (!stdout) return;
    const onResize = () => setSize({ columns: stdout.columns ?? 80, rows: stdout.rows ?? 24 });
    stdout.on("resize", onResize);
    return () => {
      stdout.off("resize", onResize);
    };
  }, [stdout]);

  return size;
}

export type LayoutMode = "full" | "compact" | "narrow";

/**
 * Responsive layout mode from terminal width:
 * - `full`    (≥100 cols): nav rail with labels + two panes
 * - `compact` (90–99):     nav rail as an icon strip + two panes
 * - `narrow`  (<90):       single pane, rail hidden (degrades to the old stack)
 */
export function layoutMode(columns: number): LayoutMode {
  if (columns >= 100) return "full";
  if (columns >= 90) return "compact";
  return "narrow";
}
