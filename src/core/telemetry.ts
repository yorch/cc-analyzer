import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { indexDbPath, telemetryConfigPath } from "./paths.ts";
import { isCompiledBinary } from "./runtime.ts";
import { VERSION } from "./version.ts";

/**
 * Privacy-respecting usage telemetry.
 *
 * cc-analyzer reports anonymous, cookieless usage events to a self-hosted
 * Plausible instance. It never sends session content, file paths, or personal
 * data. Telemetry is opt-out (default on) with a one-time first-run notice; the
 * on/off setting and the notice flag live in the tool's own state dir, never in
 * `~/.claude`. This one module governs the CLI/TUI (server-side Events API) and
 * the local web SPA (the `serve` command injects a Plausible tag only when
 * telemetry is enabled). The docs site is a separate static lifecycle.
 */

const WEB_DOMAIN = "cc-analyzer-webui";

/** Base URL of the Plausible instance (env-overridable for tests). */
const plausibleUrl = (): string =>
  process.env.CC_ANALYZER_TELEMETRY_URL ?? "https://plausible.brnby.com";

/** Plausible "site" id for CLI/TUI events (env-overridable for tests). */
const cliDomain = (): string => process.env.CC_ANALYZER_TELEMETRY_DOMAIN ?? "cc-analyzer-tui";

interface TelemetryConfig {
  enabled?: boolean;
  noticeShown?: boolean;
}

function readConfig(): TelemetryConfig {
  try {
    return JSON.parse(readFileSync(telemetryConfigPath(), "utf8")) as TelemetryConfig;
  } catch {
    return {};
  }
}

function writeConfig(cfg: TelemetryConfig): void {
  try {
    mkdirSync(dirname(telemetryConfigPath()), { recursive: true });
    writeFileSync(telemetryConfigPath(), JSON.stringify(cfg, null, 2));
  } catch {
    // Best-effort: a read-only state dir just means the setting isn't persisted.
  }
}

const NOTICE =
  "\ncc-analyzer collects anonymous usage stats to improve the tool.\n" +
  "No session content, paths, or personal data is ever sent.\n" +
  "Disable: CC_ANALYZER_TELEMETRY=0  (or run: cc-analyzer telemetry off)\n\n";

/**
 * Resolve whether telemetry is enabled and why. Disable precedence (first match
 * wins): CC_ANALYZER_TELEMETRY -> DO_NOT_TRACK -> CI -> persisted config -> on.
 */
export function telemetryStatus(): { enabled: boolean; reason: string } {
  const env = process.env.CC_ANALYZER_TELEMETRY?.toLowerCase();
  if (env === "0" || env === "false" || env === "off" || env === "no") {
    return { enabled: false, reason: "disabled via CC_ANALYZER_TELEMETRY" };
  }
  if (process.env.DO_NOT_TRACK && process.env.DO_NOT_TRACK !== "0") {
    return { enabled: false, reason: "disabled via DO_NOT_TRACK" };
  }
  if (process.env.CI) {
    return { enabled: false, reason: "disabled in CI" };
  }
  if (readConfig().enabled === false) {
    return { enabled: false, reason: "disabled via `cc-analyzer telemetry off`" };
  }
  return { enabled: true, reason: "enabled (opt-out; disable with CC_ANALYZER_TELEMETRY=0)" };
}

export function isTelemetryEnabled(): boolean {
  return telemetryStatus().enabled;
}

/** Persist the on/off setting (used by the `telemetry on|off` subcommand). */
export function setTelemetryEnabled(enabled: boolean): void {
  writeConfig({ ...readConfig(), enabled });
}

/** Print the one-time notice on first enabled run, then remember it. stderr so
 *  piped stdout stays clean. No-op when disabled or already shown. */
export function maybeShowFirstRunNotice(): void {
  if (!isTelemetryEnabled()) return;
  const cfg = readConfig();
  if (cfg.noticeShown) return;
  process.stderr.write(NOTICE);
  writeConfig({ ...cfg, noticeShown: true });
}

/** Map a session count to a non-identifying scale bucket. */
export function bucketize(n: number): string {
  if (n <= 10) return "1-10";
  if (n <= 100) return "11-100";
  if (n <= 1000) return "101-1000";
  return "1000+";
}

/** Read the indexed session count WITHOUT creating or migrating the db. Returns
 *  undefined when no index exists yet (so no bucket is reported). */
function sessionCount(): number | undefined {
  try {
    const path = indexDbPath();
    if (!existsSync(path)) return undefined;
    const db = new Database(path, { readonly: true });
    const row = db.query("SELECT COUNT(*) AS n FROM sessions").get() as { n: number };
    db.close();
    return row.n;
  } catch {
    return undefined;
  }
}

export interface EventBody {
  name: string;
  url: string;
  domain: string;
  props: Record<string, string>;
}

/** Build the Plausible Events API payload for a command run. Exposed for tests. */
export function buildEventBody(name: string, extraProps: Record<string, string> = {}): EventBody {
  const props: Record<string, string> = {
    name,
    version: VERSION,
    os: process.platform,
    arch: process.arch,
    ...extraProps,
  };
  const n = sessionCount();
  if (n !== undefined && n > 0) props.sessions_bucket = bucketize(n);
  return { name: "command", url: `app://cli/${name}`, domain: cliDomain(), props };
}

async function postEvent(body: EventBody, url: string, timeoutMs: number): Promise<void> {
  try {
    await fetch(`${url}/api/event`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": `cc-analyzer/${VERSION} (${process.platform}; ${process.arch})`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    // Fire-and-forget: network/timeout/non-2xx must never surface to the user.
  }
}

/**
 * Hidden argv marker that re-enters this binary as the detached poster (see
 * `runTelemetryPoster`). Deliberately absent from `--help`: it is an internal
 * re-entry point, not a command anyone should type.
 */
export const POSTER_COMMAND = "__telemetry-post";

/** Timeout for the detached poster's request. Generous where the in-process
 *  fallback must stay tight: nothing is waiting on this process. */
const POSTER_TIMEOUT_MS = 10_000;

/** Request timeout, and how long `flushTelemetry` may hold up a quick command
 *  at exit, for the in-process fallback. Deliberately tight: here the user is
 *  waiting, so an undelivered event is the cheaper loss. */
const INLINE_TIMEOUT_MS = 1000;
const INLINE_FLUSH_MS = 100;

/**
 * argv that re-invokes this program as the detached poster. A compiled binary
 * re-runs itself; from source, `process.execPath` is the bun interpreter, so the
 * entrypoint has to be passed along. The endpoint travels in argv rather than
 * being re-derived from the environment so the child posts exactly where the
 * parent decided to — and the payload is piped via stdin (not argv) so it never
 * appears in `ps` output. The optional `body` param is retained for backward
 * compatibility (ignored); callers should pipe the body via `spawnPoster`. Exposed for tests.
 */
export function posterArgv(url: string, _body?: EventBody): string[] {
  const self = isCompiledBinary() ? [process.execPath] : [process.execPath, Bun.main];
  return [...self, POSTER_COMMAND, url];
}

/**
 * Hand the event to a detached child that outlives this process, and report
 * whether that worked.
 *
 * A short command (`projects`, `sessions`) fires its event at dispatch and then
 * exits ~10ms later via `process.exit()`, which kills an in-flight socket
 * outright. That budget does not cover a cold TLS handshake to the Plausible
 * host, so an in-process request is usually dead on arrival. The child starts a
 * new session (`setsid`) with no stdio tying it to the parent's terminal, so it
 * survives the exit and completes the handshake on its own time.
 */
function spawnPoster(body: EventBody): boolean {
  try {
    const payload = JSON.stringify(body);
    const proc = Bun.spawn({
      cmd: posterArgv(plausibleUrl()),
      stdin: "pipe",
      stdout: "ignore",
      stderr: "ignore",
      detached: true,
      windowsHide: true,
      env: process.env,
    });
    try {
      // SAFETY: Bun.spawn with stdin:"pipe" exposes a writable stdin at runtime
      const stdin = (proc as unknown as { stdin?: { write: (c: string) => void; end: () => void } })
        .stdin;
      stdin?.write(payload);
      stdin?.end();
    } catch {
      // if pipe write fails, child will see empty stdin and return 0 (no post)
    }
    // SAFETY: Bun.spawn detached proc exposes unref at runtime though types omit it
    (proc as unknown as { unref?: () => void }).unref?.();
    return true;
  } catch {
    return false;
  }
}

const pendingEvents = new Set<Promise<void>>();

/** Record a command run. No-op when disabled. Fire-and-forget: returns
 *  immediately, never throws, never blocks or delays the caller. */
export function trackCommand(name: string, extraProps: Record<string, string> = {}): void {
  if (!isTelemetryEnabled()) return;
  const body = buildEventBody(name, extraProps);
  if (spawnPoster(body)) return;
  // Fallback for environments that refuse the spawn (sandboxes, process
  // limits): post in-process and let `flushTelemetry` give it what time it can.
  const request = postEvent(body, plausibleUrl(), INLINE_TIMEOUT_MS);
  pendingEvents.add(request);
  void request.finally(() => pendingEvents.delete(request));
}

/**
 * Deliver one prebuilt event, then exit. This is the detached child's whole job.
 *
 * Always resolves 0: a beacon that could not be delivered is not a failed
 * command, and this process's exit status is visible in the user's shell if the
 * hidden subcommand is ever run by hand. Re-checks the opt-out so the marker
 * cannot be used to send an event while telemetry is off.
 */
export async function runTelemetryPoster(url?: string, payload?: string): Promise<number> {
  if (!url || !isTelemetryEnabled()) return 0;
  let raw: string | undefined = payload;
  if (!raw) {
    // Payload not in argv — read from piped stdin (new path). Only attempt
    // when stdin is piped to avoid hanging on manual TTY invocations.
    try {
      if (process.stdin.isTTY !== true) {
        // Prefer Bun's native stdin helper when available
        try {
          // SAFETY: Bun global gains stdin.text at runtime; types don't declare it
          const bunStdin = (Bun as unknown as { stdin?: { text?: () => Promise<string> } }).stdin;
          if (bunStdin && typeof bunStdin.text === "function") {
            const t = await bunStdin.text();
            if (t && t.trim() !== "") raw = t;
          }
        } catch {
          // fall through to Node fallback
        }
        if (!raw) {
          try {
            const { readFileSync } = await import("node:fs");
            // SAFETY: fd 0 is stdin; sync read is safe here because isTTY===false guarantees piped EOF
            const txt = readFileSync(0, "utf8") as string;
            if (txt.trim() !== "") raw = txt;
          } catch {
            // ignore
          }
        }
      }
    } catch {
      // treat as no payload
    }
  }
  if (!raw) return 0;
  let body: EventBody;
  try {
    body = JSON.parse(raw) as EventBody;
  } catch {
    return 0;
  }
  if (!isTelemetryEnabled()) return 0;
  await postEvent(body, url, POSTER_TIMEOUT_MS);
  return 0;
}

/** Give in-process fallback events a brief chance to leave before a quick CLI
 *  command exits. A no-op on the normal path, where the detached poster owns
 *  delivery and nothing is pending. Delivery stays best-effort and the bounded
 *  wait never changes the command's result. */
export async function flushTelemetry(timeoutMs = INLINE_FLUSH_MS): Promise<void> {
  if (pendingEvents.size === 0) return;
  await Promise.race([
    Promise.allSettled([...pendingEvents]),
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}

/** Runtime telemetry config for the SPA, or null when disabled. The SPA bundles
 *  the Plausible tracker and reads this to decide whether to initialize — so the
 *  same opt-out switch governs the CLI and the web UI. */
export function spaTelemetryConfig(): { domain: string; endpoint: string } | null {
  if (!isTelemetryEnabled()) return null;
  return { domain: WEB_DOMAIN, endpoint: `${plausibleUrl()}/api/event` };
}

/** Insert the SPA telemetry config (as `window.__CC_TELEMETRY__`) before </head>,
 *  or return html unchanged when telemetry is disabled. The inline classic script
 *  runs before the deferred module bundle, so the config is set before the SPA
 *  reads it. `<` is escaped so a value can never break out of the script tag. */
export function injectSpaTelemetry(html: string): string {
  const cfg = spaTelemetryConfig();
  if (!cfg) return html;
  const json = JSON.stringify(cfg).replace(/</g, "\\u003c");
  const tag = `<script>window.__CC_TELEMETRY__=${json}</script>`;
  return html.replace("</head>", `${tag}</head>`);
}
