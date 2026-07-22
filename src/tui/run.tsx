import { render } from "ink";
import { openDb } from "../core/db.ts";
import { loadPricing } from "../core/pricing-source.ts";
import { App } from "./App.tsx";

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
  const app = render(<App db={db} pricing={table} />);
  await app.waitUntilExit();
  db.close();
  return 0;
}
