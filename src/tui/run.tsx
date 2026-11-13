import { render } from "ink";
import { openDb } from "../core/db.ts";
import { archiveSkippedWarning, refreshIndexIfNeeded } from "../core/index-refresh.ts";
import { inspectIndexStatus } from "../core/index-status.ts";
import type { ReindexResult } from "../core/indexer.ts";
import { loadPricing } from "../core/pricing-source.ts";
import { App } from "./App.tsx";

/** Print the outcome of the startup index refresh (stderr, before the TUI takes the screen). */
export function reportRefresh(
  refreshed: ReindexResult | undefined,
  log: (message: string) => void = console.error,
): void {
  if (!refreshed) return;
  log(`Indexed ${refreshed.indexed} Claude Code sessions.`);
  const warning = archiveSkippedWarning(refreshed);
  if (warning) log(warning);
}

/** Launch the interactive terminal UI. Returns the process exit code. */
export async function runTui(): Promise<number> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error(
      "The interactive TUI needs a terminal (TTY). Use `cc-analyzer stats`, " +
        "`projects`, `sessions <id>`, or `analyze <id>` for non-interactive output.",
    );
    return 2;
  }
  const db = openDb();
  const { table } = await loadPricing();
  const refreshed = await refreshIndexIfNeeded(db, {
    pricing: table,
    onProgress: (done, total) => {
      process.stderr.write(`\rBuilding initial index ${done}/${total}...`);
    },
  });
  if (refreshed && refreshed.total > 0) process.stderr.write("\n");
  reportRefresh(refreshed);
  let indexStatus: Awaited<ReturnType<typeof inspectIndexStatus>>;
  try {
    indexStatus = await inspectIndexStatus(db);
  } catch (error) {
    // A strict alias-file read failure: report it cleanly instead of a stack trace.
    db.close();
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  const app = render(<App db={db} pricing={table} indexStatus={indexStatus} />);
  await app.waitUntilExit();
  db.close();
  return 0;
}
