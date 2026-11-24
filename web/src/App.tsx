import { Component, type ErrorInfo, type ReactNode, useEffect, useRef } from "react";
import { api } from "./api.ts";
import { IndexFreshness, IndexNotice } from "./IndexNotice.tsx";
import { link, useHashRoute } from "./router.ts";
import { ThemeToggle } from "./ThemeToggle.tsx";
import { trackView } from "./telemetry.ts";
import { useAsync } from "./useAsync.ts";
import { Dashboard } from "./views/Dashboard.tsx";
import { Insights, InsightsProject } from "./views/Insights.tsx";
import { Project } from "./views/Project.tsx";
import { Projects } from "./views/Projects.tsx";
import { Session } from "./views/Session.tsx";
import { Tools } from "./views/Tools.tsx";
import { Trends } from "./views/Trends.tsx";

const ROUTE_TITLES: Record<string, string> = {
  dashboard: "Dashboard",
  insights: "Insights",
  insightsProject: "Project insights",
  trends: "Trends",
  tools: "Tools",
  projects: "Projects",
  project: "Project",
  session: "Session",
  notFound: "Not found",
};

/** Catches a render-time throw in any view so one bad payload shows a message
 *  and a way out instead of a blank page. Reset by remounting on route change. */
class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("cc-analyzer view crashed", error, info.componentStack);
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="notice error-notice" role="alert">
        <strong>Something went wrong rendering this view.</strong>
        <span>{this.state.error.message}</span>
        <a href={link.dashboard()}>Back to dashboard</a>
      </div>
    );
  }
}

function NotFound({ path }: { path: string }) {
  return (
    <div className="notice empty-notice" role="status">
      <strong>Nothing lives at {path}.</strong> <a href={link.dashboard()}>Back to dashboard</a>
    </div>
  );
}

export function App() {
  const route = useHashRoute();
  const routeKey = "id" in route ? `${route.name}:${route.id}` : route.name;
  const firstRoute = useRef(true);
  // Per-route document title, and — after the first paint — move focus to the
  // main landmark and scroll to the top so keyboard and screen-reader users
  // land on the new view rather than on the link they just activated.
  // biome-ignore lint/correctness/useExhaustiveDependencies: routeKey (name + id) is the navigation trigger
  useEffect(() => {
    document.title = `${ROUTE_TITLES[route.name] ?? "cc-analyzer"} · cc-analyzer`;
    if (firstRoute.current) {
      firstRoute.current = false;
      return;
    }
    window.scrollTo(0, 0);
    document.getElementById("main-content")?.focus({ preventScroll: true });
  }, [route.name, routeKey]);
  const indexStatus = useAsync(api.indexStatus, []);
  // Report a sanitized pageview whenever the route changes. Depending on the
  // complete route counts navigation between two records of the same type, but
  // only the route name is passed through so ids are never sent.
  useEffect(() => {
    trackView(route.name);
  }, [route.name]);
  const onInsights = route.name === "insights" || route.name === "insightsProject";
  const onProjects = route.name === "projects" || route.name === "project";
  return (
    <div className="wrap">
      <a className="skip-link" href="#main-content">
        Skip to Main Content
      </a>
      <header className="masthead">
        <a className="brand" href={link.dashboard()} aria-label="cc-analyzer home">
          <span className="brand-mark">cc</span>
          <span className="brand-name">analyzer</span>
        </a>
        <nav className="masthead-nav">
          <a
            className={route.name === "dashboard" ? "active" : ""}
            href={link.dashboard()}
            aria-current={route.name === "dashboard" ? "page" : undefined}
          >
            Dashboard
          </a>
          <a
            className={onProjects ? "active" : ""}
            href={link.projects()}
            aria-current={onProjects ? "page" : undefined}
          >
            Projects
          </a>
          <a
            className={onInsights ? "active" : ""}
            href={link.insights()}
            aria-current={onInsights ? "page" : undefined}
          >
            Insights
          </a>
          <a
            className={route.name === "trends" ? "active" : ""}
            href={link.trends()}
            aria-current={route.name === "trends" ? "page" : undefined}
          >
            Trends
          </a>
          <a
            className={route.name === "tools" ? "active" : ""}
            href={link.tools()}
            aria-current={route.name === "tools" ? "page" : undefined}
          >
            Tools
          </a>
        </nav>
        <span className="masthead-tag">Claude Code · Session Ledger</span>
        <span className="masthead-rule" aria-hidden="true" />
        <ThemeToggle />
        <span className="masthead-blink" aria-hidden="true" />
      </header>
      <IndexNotice status={indexStatus.data} />
      <main id="main-content" tabIndex={-1}>
        <ErrorBoundary key={routeKey}>
          {route.name === "dashboard" && <Dashboard />}
          {route.name === "insights" && <Insights />}
          {route.name === "insightsProject" && <InsightsProject key={route.id} id={route.id} />}
          {route.name === "trends" && <Trends />}
          {route.name === "tools" && <Tools />}
          {route.name === "projects" && <Projects />}
          {route.name === "project" && <Project key={route.id} id={route.id} />}
          {route.name === "session" && <Session key={route.id} id={route.id} />}
          {route.name === "notFound" && <NotFound path={route.path} />}
        </ErrorBoundary>
      </main>
      <footer className="site-footer">
        <div className="site-footer-copy">
          <span className="site-footer-label">cc-analyzer · open source</span>
          <p>Data is read from your local Claude Code sessions and stays on this machine.</p>
          <IndexFreshness status={indexStatus.data} />
        </div>
        <nav aria-label="Project links">
          <a href="https://github.com/yorch/cc-analyzer" target="_blank" rel="noreferrer">
            GitHub <span aria-hidden="true">↗</span>
          </a>
          <a href="https://cc-analyzer.brnby.com/" target="_blank" rel="noreferrer">
            Website <span aria-hidden="true">↗</span>
          </a>
        </nav>
      </footer>
    </div>
  );
}
