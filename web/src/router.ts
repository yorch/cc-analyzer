import { useCallback, useEffect, useState } from "react";

export type Route =
  | { name: "dashboard" }
  | { name: "insights" }
  | { name: "insightsProject"; id: string }
  | { name: "trends" }
  | { name: "tools" }
  | { name: "project"; id: string }
  | { name: "session"; id: string };

function parse(hash: string): Route {
  const path = hash.replace(/^#/, "").split("?")[0] ?? "";
  const insightsProject = path.match(/^\/insights\/(.+)$/);
  if (insightsProject)
    return { name: "insightsProject", id: decodeURIComponent(insightsProject[1] as string) };
  if (path === "/insights") return { name: "insights" };
  if (path === "/trends") return { name: "trends" };
  if (path === "/tools") return { name: "tools" };
  const project = path.match(/^\/project\/(.+)$/);
  if (project) return { name: "project", id: decodeURIComponent(project[1] as string) };
  const session = path.match(/^\/session\/(.+)$/);
  if (session) return { name: "session", id: decodeURIComponent(session[1] as string) };
  return { name: "dashboard" };
}

function params(): URLSearchParams {
  return new URLSearchParams(window.location.hash.split("?")[1] ?? "");
}

/** Persist view controls in the hash query without triggering a route change. */
export function useHashParam<T extends string>(
  key: string,
  fallback: T,
  allowed?: readonly T[],
): [T, (next: T) => void] {
  const read = useCallback(() => {
    const value = params().get(key) as T | null;
    return value && (!allowed || allowed.includes(value)) ? value : fallback;
  }, [key, fallback, allowed]);
  const [value, setValue] = useState<T>(read);
  useEffect(() => {
    const onChange = () => setValue(read());
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, [read]);
  const update = useCallback(
    (next: T) => {
      const [path = "", query = ""] = window.location.hash.split("?");
      const nextParams = new URLSearchParams(query);
      if (next === fallback) nextParams.delete(key);
      else nextParams.set(key, next);
      const suffix = nextParams.size > 0 ? `?${nextParams.toString()}` : "";
      window.history.replaceState(null, "", `${path}${suffix}`);
      setValue(next);
    },
    [key, fallback],
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
  project: (id: string) => `#/project/${encodeURIComponent(id)}`,
  session: (id: string) => `#/session/${encodeURIComponent(id)}`,
};
