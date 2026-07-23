/**
 * Map a hash-route name to a stable, NON-IDENTIFYING view path for analytics.
 *
 * The SPA's routes embed identifying data — `#/session/<uuid>` and
 * `#/project/<encoded-cwd-path>` carry session UUIDs and real filesystem paths.
 * Telemetry must never send those, so this deliberately drops the id segment and
 * reports only the view *type*. Pure and import-free so it can be unit-tested
 * outside the browser.
 */
export function viewPath(routeName: string): string {
  switch (routeName) {
    case "insights":
      return "/insights";
    case "insightsProject":
      return "/insights/project";
    case "trends":
      return "/trends";
    case "tools":
      return "/tools";
    case "project":
      return "/project";
    case "session":
      return "/session";
    default:
      return "/"; // dashboard + any unknown route
  }
}
