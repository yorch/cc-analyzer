import { useEffect } from "react";
import { api } from "./api.ts";
import { IndexFreshness, IndexNotice } from "./IndexNotice.tsx";
import { link, useHashRoute } from "./router.ts";
import { trackView } from "./telemetry.ts";
import { useAsync } from "./useAsync.ts";
import { Dashboard } from "./views/Dashboard.tsx";
import { Insights, InsightsProject } from "./views/Insights.tsx";
import { Project } from "./views/Project.tsx";
import { Session } from "./views/Session.tsx";
import { Tools } from "./views/Tools.tsx";
import { Trends } from "./views/Trends.tsx";

export function App() {
  const route = useHashRoute();
  const indexStatus = useAsync(api.indexStatus, []);
  // Report a sanitized pageview whenever the route changes. Depending on the
  // complete route counts navigation between two records of the same type, but
  // only the route name is passed through so ids are never sent.
  useEffect(() => {
    trackView(route.name);
  }, [route]);
  const onInsights = route.name === "insights" || route.name === "insightsProject";
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
        <span className="masthead-blink" aria-hidden="true" />
      </header>
      <IndexNotice status={indexStatus.data} />
      <main id="main-content">
        {route.name === "dashboard" && <Dashboard />}
        {route.name === "insights" && <Insights />}
        {route.name === "insightsProject" && <InsightsProject id={route.id} />}
        {route.name === "trends" && <Trends />}
        {route.name === "tools" && <Tools />}
        {route.name === "project" && <Project id={route.id} />}
        {route.name === "session" && <Session id={route.id} />}
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
