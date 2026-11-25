import { useCallback, useEffect, useRef, useState } from "react";

export type Route =
  | { name: "dashboard" }
  | { name: "insights" }
  | { name: "insightsProject"; id: string }
  | { name: "trends" }
  | { name: "tools" }
  | { name: "projects" }
  | { name: "project"; id: string }
  | { name: "session"; id: string }
  | { name: "notFound"; path: string };

/** A malformed escape (`%E0%A4%A`) must not throw during render — fall back to
 *  the raw segment, which simply won't match any id. */
function decode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function parse(hash: string): Route {
  const path = hash.replace(/^#/, "").split("?")[0] ?? "";
  // Only hash paths are routes. A fragment that is not a path (an in-page
  // anchor such as `#main-content`) is not a missing page, so show the dashboard.
  if (!path.startsWith("/")) return { name: "dashboard" };
  const insightsProject = path.match(/^\/insights\/(.+)$/);
  if (insightsProject) return { name: "insightsProject", id: decode(insightsProject[1] as string) };
  if (path === "/insights") return { name: "insights" };
  if (path === "/trends") return { name: "trends" };
  if (path === "/tools") return { name: "tools" };
  if (path === "/projects") return { name: "projects" };
  const project = path.match(/^\/project\/(.+)$/);
  if (project) return { name: "project", id: decode(project[1] as string) };
  const session = path.match(/^\/session\/(.+)$/);
  if (session) return { name: "session", id: decode(session[1] as string) };
  if (path === "" || path === "/") return { name: "dashboard" };
  return { name: "notFound", path };
}

/** Pure read of one hash-query param: the value when present and permitted,
 *  otherwise the fallback. Split from the hook so it is testable without a DOM. */
export function resolveHashParam<T extends string>(
  hash: string,
  key: string,
  fallback: T,
  allowed?: readonly T[],
): T {
  const value = new URLSearchParams(hash.split("?")[1] ?? "").get(key) as T | null;
  return value && (!allowed || allowed.includes(value)) ? value : fallback;
}

/** `replaceState` emits no `hashchange`, so a write announces itself here and
 *  every other hook on the same key re-reads the URL. */
const PARAM_EVENT = "cc-hashparam";

/** Persist view controls in the hash query without triggering a route change.
 *
 *  `fallback` and `allowed` are read through a ref, never through the effect's
 *  dependencies. A caller may pass an inline array (new identity every render);
 *  if that re-subscribed the `hashchange` listener each render, the route
 *  listener's re-render would remove this hook's listener *mid-dispatch*, and a
 *  listener removed before its turn is never called — the URL changed but the
 *  value stayed put. The subscription must depend on `key` alone. */
export function useHashParam<T extends string>(
  key: string,
  fallback: T,
  allowed?: readonly T[],
): [T, (next: T) => void] {
  const latest = useRef({ fallback, allowed });
  latest.current = { fallback, allowed };
  const read = useCallback(
    () =>
      resolveHashParam<T>(
        window.location.hash,
        key,
        latest.current.fallback,
        latest.current.allowed,
      ),
    [key],
  );
  const [value, setValue] = useState<T>(read);
  useEffect(() => {
    const onChange = () => setValue(read());
    window.addEventListener("hashchange", onChange);
    window.addEventListener(PARAM_EVENT, onChange);
    // The hash may have moved between render and subscription.
    onChange();
    return () => {
      window.removeEventListener("hashchange", onChange);
      window.removeEventListener(PARAM_EVENT, onChange);
    };
  }, [read]);
  const update = useCallback(
    (next: T) => {
      const [path = "", query = ""] = window.location.hash.split("?");
      const nextParams = new URLSearchParams(query);
      if (next === latest.current.fallback) nextParams.delete(key);
      else nextParams.set(key, next);
      const suffix = nextParams.size > 0 ? `?${nextParams.toString()}` : "";
      window.history.replaceState(null, "", `${path}${suffix}`);
      setValue(next);
      window.dispatchEvent(new Event(PARAM_EVENT));
    },
    [key],
  );
  return [value, update];
}

export function useHashRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parse(window.location.hash));
  useEffect(() => {
    const onChange = () => setRoute(parse(window.location.hash));
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return route;
}

export const link = {
  dashboard: () => "#/",
  insights: () => "#/insights",
  insightsProject: (id: string) => `#/insights/${encodeURIComponent(id)}`,
  trends: () => "#/trends",
  tools: () => "#/tools",
  projects: () => "#/projects",
  project: (id: string) => `#/project/${encodeURIComponent(id)}`,
  session: (id: string) => `#/session/${encodeURIComponent(id)}`,
};
