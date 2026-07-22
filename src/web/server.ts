import type { Database } from "bun:sqlite";
import { Hono } from "hono";
import { openDb } from "../core/db.ts";
import type { PricingTable } from "../core/pricing.ts";
import { loadPricing } from "../core/pricing-source.ts";
import { isIndexEmpty } from "../core/queries.ts";
import { createApi } from "./api.ts";
import { hasSpa, spaHtml } from "./spa.ts";

export interface ServeOptions {
  port?: number;
  /** Bind address. Defaults to loopback; pass e.g. "0.0.0.0" to expose deliberately. */
  host?: string;
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

  // Serve the single-page app for everything that is not an API route.
  app.get("*", (c) => {
    if (hasSpa) return c.html(spaHtml);
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
  if (isIndexEmpty(db)) {
    console.error("The index is empty. Run `cc-analyzer index` first, then `serve`.");
    db.close();
    return 1;
  }

  const { table } = await loadPricing();
  const hostname = opts.host ?? "127.0.0.1";
  const loopbackOnly = isLoopbackHost(hostname);
  const app = createApp(db, table, { loopbackOnly });

  const port = opts.port ?? 4317;
  const server = Bun.serve({ port, hostname, fetch: app.fetch });
  const shownHost = hostname === "127.0.0.1" ? "localhost" : hostname;
  console.log(`cc-analyzer web UI: http://${shownHost}:${server.port}  (Ctrl-C to stop)`);
  if (!loopbackOnly) {
    console.error(
      `warning: listening on ${hostname} — session transcripts are exposed to your network.`,
    );
  }

  // Keep the process alive; Bun.serve runs until the process is killed.
  return await new Promise<never>(() => {});
}
