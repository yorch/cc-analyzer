import { init, track } from "@plausible-analytics/tracker";
import { viewPath } from "./view-path.ts";

/** Runtime telemetry config injected by the server into the served HTML as
 *  `window.__CC_TELEMETRY__` — present only when telemetry is enabled, so its
 *  absence is the SPA's opt-out signal (governed by the same switch as the CLI). */
interface TelemetryConfig {
  domain: string;
  endpoint: string;
}

declare global {
  interface Window {
    __CC_TELEMETRY__?: TelemetryConfig;
  }
}

let config: TelemetryConfig | undefined;

/** Initialize the Plausible tracker if telemetry is enabled. Auto-capture is
 *  OFF: we send sanitized pageviews ourselves so route ids never leak. */
export function initTelemetry(): void {
  config = window.__CC_TELEMETRY__;
  if (!config) return;
  init({
    domain: config.domain,
    endpoint: config.endpoint,
    autoCapturePageviews: false,
    captureOnLocalhost: true,
  });
}

/** Send a pageview for the current view, with the id stripped (see viewPath). */
export function trackView(routeName: string): void {
  if (!config) return;
  track("pageview", { url: `https://${config.domain}${viewPath(routeName)}` });
}
