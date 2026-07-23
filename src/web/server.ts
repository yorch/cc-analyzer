import type { Database } from "bun:sqlite";
import { Hono } from "hono";
import { openDb } from "../core/db.ts";
import { refreshIndexIfNeeded } from "../core/index-refresh.ts";
import { inspectIndexStatus } from "../core/index-status.ts";
import { INDEX_AGE_WARNING_MS } from "../core/index-status-types.ts";
import type { PricingTable } from "../core/pricing.ts";
import { loadPricing } from "../core/pricing-source.ts";
import { isIndexEmpty } from "../core/queries.ts";
import { injectSpaTelemetry } from "../core/telemetry.ts";
import { createApi } from "./api.ts";
import { openBrowser } from "./open-browser.ts";
import { hasSpa, spaHtml } from "./spa.ts";

export interface ServeOptions {
  port?: number;
  /** Bind address. Defaults to loopback; pass e.g. "0.0.0.0" to expose deliberately. */
  host?: string;
  /** Incrementally refresh the index before serving. */
  refresh?: boolean;
  /** Open the local URL in the default browser after binding. */
  open?: boolean;
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1"]);

/** Whether a bind address / Host name is loopback. Parses via the URL host
 *  grammar so odd IPv6 spellings and trailing ports normalize consistently. */
export function isLoopbackHost(host: string): boolean {
  let h = host.trim().toLowerCase();
  // Bracket a bare IPv6 literal (multiple colons, unbracketed) — a bind address
  // like "::1" is legal but the URL host grammar needs the brackets.
  if (!h.startsWith("[") && (h.match(/:/g)?.length ?? 0) > 1) h = `[${h}]`;
  let name: string;
  try {
    name = new URL(`http://${h}`).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (name.startsWith("[") && name.endsWith("]")) name = name.slice(1, -1);
  return LOOPBACK.has(name);
}

/**
 * Compose the full web app (Host-header guard + JSON API + SPA fallback), pure
 * over its db/pricing inputs so it's testable without binding a port.
 */
export function createApp(
  db: Database,
  pricing: PricingTable,
  opts: { loopbackOnly: boolean },
): Hono {
  const app = new Hono();

  // DNS-rebinding defense: when serving loopback-only, reject requests whose
  // Host header is not a local name — a hostile page that re-resolves its own
  // domain to 127.0.0.1 would otherwise get same-origin access to the API.
  // (Registered before the API routes so it wraps them.)
  if (opts.loopbackOnly) {
    app.use("*", async (c, next) => {
      const host = c.req.header("host");
      if (!host || !isLoopbackHost(host)) {
        return c.text("Forbidden: bad Host header", 403);
      }
      return next();
    });
  }

  app.route("/", createApi(db, pricing));

  // Unknown API paths must fail as JSON, not fall through to the SPA HTML.
  app.get("/api/*", (c) => c.json({ error: "not found" }, 404));

  // Inject the Plausible tag once (the telemetry setting is fixed for the
  // server's lifetime); omitted entirely when telemetry is opted out.
  const html = injectSpaTelemetry(spaHtml);

  // Serve the single-page app for everything that is not an API route.
  app.get("*", (c) => {
    if (hasSpa) return c.html(html);
    return c.text(
      "Web UI is not built into this binary. Run `bun run build:web` (dev) or use a release build.",
      200,
    );
  });

  return app;
}

/**
 * Start the local web server (JSON API + embedded SPA). Blocks until killed.
 * Returns a non-zero exit code when it cannot start (e.g. empty index).
 */
export async function runServe(opts: ServeOptions = {}): Promise<number> {
  const db = openDb();
  const { table } = await loadPricing();
  const refreshed = await refreshIndexIfNeeded(db, {
    refresh: opts.refresh,
    pricing: table,
    onProgress: (done, total) => {
      process.stderr.write(`\rIndexing ${done}/${total}...`);
    },
  });
  if (refreshed) {
    if (refreshed.total > 0) process.stderr.write("\n");
    console.error(
      `Indexed ${refreshed.indexed}, skipped ${refreshed.skipped}, ` +
        `deleted ${refreshed.deleted} (${refreshed.total} sessions).`,
    );
  }
  if (isIndexEmpty(db)) {
    console.error("No Claude Code sessions were found; nothing to serve.");
    db.close();
    return 1;
  }
  const indexStatus = await inspectIndexStatus(db);
  if (indexStatus.stale) {
    console.error(
      `Index is behind: ${indexStatus.added} new, ${indexStatus.changed} changed, ` +
        `${indexStatus.deleted} deleted sessions. Restart with --refresh to update it.`,
    );
  } else if (indexStatus.lastRefreshedAt === null) {
    console.error("Index refresh time is unknown. Restart with --refresh to update it.");
  } else if ((indexStatus.ageMs ?? 0) >= INDEX_AGE_WARNING_MS) {
    console.error(
      "Index was last refreshed over 24 hours ago. Restart with --refresh to update it.",
    );
  }

  const hostname = opts.host ?? "127.0.0.1";
  const loopbackOnly = isLoopbackHost(hostname);
  const app = createApp(db, table, { loopbackOnly });

  const port = opts.port ?? 4317;
  const server = Bun.serve({ port, hostname, fetch: app.fetch });
  const shownHost =
    hostname === "127.0.0.1" ? "localhost" : hostname.includes(":") ? `[${hostname}]` : hostname;
  const url = `http://${shownHost}:${server.port}`;
  console.log(`cc-analyzer web UI: ${url}  (Ctrl-C to stop)`);
  if (!loopbackOnly) {
    console.error(
      `warning: listening on ${hostname} — session transcripts are exposed to your network.`,
    );
  }
  if (opts.open) {
    if (!loopbackOnly) {
      console.error("warning: --open ignored for a non-loopback host.");
    } else if (!openBrowser(url)) {
      console.error(`warning: could not open a browser; visit ${url}`);
    }
  }

  // Keep the process alive; Bun.serve runs until the process is killed.
  return await new Promise<never>(() => {});
}
