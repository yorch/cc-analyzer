import { Hono } from "hono";
import { openDb } from "../core/db.ts";
import { loadPricing } from "../core/pricing-source.ts";
import { isIndexEmpty } from "../core/queries.ts";
import { createApi } from "./api.ts";
import { hasSpa, spaHtml } from "./spa.ts";

export interface ServeOptions {
  port?: number;
  /** Bind address. Defaults to loopback; pass e.g. "0.0.0.0" to expose deliberately. */
  host?: string;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/** The host part of a Host header value (strips any port, keeps IPv6 brackets). */
function hostHeaderName(host: string): string {
  const v = host.trim().toLowerCase();
  if (v.startsWith("[")) return v.replace(/\]:\d+$/, "]");
  return v.replace(/:\d+$/, "");
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
  const loopbackOnly = LOOPBACK_HOSTS.has(hostname);

  const app = new Hono();

  // DNS-rebinding defense: when serving loopback-only, reject requests whose
  // Host header is not a local name — a hostile page that re-resolves its own
  // domain to 127.0.0.1 would otherwise get same-origin access to the API.
  // (Registered before the API routes so it wraps them.)
  if (loopbackOnly) {
    app.use("*", async (c, next) => {
      const host = c.req.header("host");
      if (!host || !LOOPBACK_HOSTS.has(hostHeaderName(host))) {
        return c.text("Forbidden: bad Host header", 403);
      }
      return next();
    });
  }

  app.route("/", createApi(db, table));

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
