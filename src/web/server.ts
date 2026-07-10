import { openDb } from "../core/db.ts";
import { loadPricing } from "../core/pricing-source.ts";
import { isIndexEmpty } from "../core/queries.ts";
import { createApi } from "./api.ts";
import { hasSpa, spaHtml } from "./spa.ts";

export interface ServeOptions {
  port?: number;
}

/** Start the local web server (JSON API + embedded SPA). Blocks until killed. */
export async function runServe(opts: ServeOptions = {}): Promise<void> {
  const db = openDb();
  if (isIndexEmpty(db)) {
    console.error("The index is empty. Run `cc-analyzer index` first, then `serve`.");
    db.close();
    return;
  }

  const { table } = await loadPricing();
  const app = createApi(db, table);

  // Serve the single-page app for everything that is not an API route.
  app.get("*", (c) => {
    if (hasSpa) return c.html(spaHtml);
    return c.text(
      "Web UI is not built into this binary. Run `bun run build:web` (dev) or use a release build.",
      200,
    );
  });

  const port = opts.port ?? 4317;
  const server = Bun.serve({ port, fetch: app.fetch });
  console.log(`cc-analyzer web UI: http://localhost:${server.port}  (Ctrl-C to stop)`);

  // Keep the process alive; Bun.serve runs until the process is killed.
  await new Promise<never>(() => {});
}
