import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { indexDbPath, telemetryConfigPath } from "./paths.ts";
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

const WEB_DOMAIN = "web.cc-analyzer";

/** Base URL of the Plausible instance (env-overridable for tests). */
const plausibleUrl = (): string =>
  process.env.CC_ANALYZER_TELEMETRY_URL ?? "https://plausible.brnby.com";

/** Plausible "site" id for CLI/TUI events (env-overridable for tests). */
const cliDomain = (): string => process.env.CC_ANALYZER_TELEMETRY_DOMAIN ?? "cli.cc-analyzer";

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

async function postEvent(body: EventBody): Promise<void> {
  try {
    await fetch(`${plausibleUrl()}/api/event`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": `cc-analyzer/${VERSION} (${process.platform}; ${process.arch})`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(1000),
    });
  } catch {
    // Fire-and-forget: network/timeout/non-2xx must never surface to the user.
  }
}

/** Record a command run. No-op when disabled. Fire-and-forget: returns
 *  immediately, never throws, never blocks or delays the caller. */
export function trackCommand(name: string, extraProps: Record<string, string> = {}): void {
  if (!isTelemetryEnabled()) return;
  void postEvent(buildEventBody(name, extraProps));
}

/** The Plausible script tag for the local web SPA, or "" when disabled. Uses the
 *  `script.local.js` variant because the standard script ignores localhost. */
export function spaScriptTag(): string {
  if (!isTelemetryEnabled()) return "";
  return `<script defer data-domain="${WEB_DOMAIN}" src="${plausibleUrl()}/js/script.local.js"></script>`;
}

/** Insert the SPA telemetry tag before </head>, or return html unchanged when
 *  telemetry is disabled or there is no </head> to anchor to. */
export function injectSpaTelemetry(html: string): string {
  const tag = spaScriptTag();
  if (!tag) return html;
  return html.replace("</head>", `${tag}</head>`);
}
