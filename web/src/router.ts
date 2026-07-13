import { useEffect, useState } from "react";

export type Route =
  | { name: "dashboard" }
  | { name: "insights" }
  | { name: "insightsProject"; id: string }
  | { name: "trends" }
  | { name: "project"; id: string }
  | { name: "session"; id: string };

function parse(hash: string): Route {
  const path = hash.replace(/^#/, "");
  const insightsProject = path.match(/^\/insights\/(.+)$/);
  if (insightsProject)
    return { name: "insightsProject", id: decodeURIComponent(insightsProject[1] as string) };
  if (path === "/insights") return { name: "insights" };
  if (path === "/trends") return { name: "trends" };
  const project = path.match(/^\/project\/(.+)$/);
  if (project) return { name: "project", id: decodeURIComponent(project[1] as string) };
  const session = path.match(/^\/session\/(.+)$/);
  if (session) return { name: "session", id: decodeURIComponent(session[1] as string) };
  return { name: "dashboard" };
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
  project: (id: string) => `#/project/${encodeURIComponent(id)}`,
  session: (id: string) => `#/session/${encodeURIComponent(id)}`,
};
