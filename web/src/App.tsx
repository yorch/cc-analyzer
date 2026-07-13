import { link, useHashRoute } from "./router.ts";
import { Dashboard } from "./views/Dashboard.tsx";
import { Insights, InsightsProject } from "./views/Insights.tsx";
import { Project } from "./views/Project.tsx";
import { Session } from "./views/Session.tsx";
import { Tools } from "./views/Tools.tsx";
import { Trends } from "./views/Trends.tsx";

export function App() {
  const route = useHashRoute();
  const onInsights = route.name === "insights" || route.name === "insightsProject";
  return (
    <div className="wrap">
      <header className="masthead">
        <a className="brand" href={link.dashboard()} aria-label="cc-analyzer home">
          <span className="brand-mark">cc</span>
          <span className="brand-name">analyzer</span>
        </a>
        <nav className="masthead-nav">
          <a className={route.name === "dashboard" ? "active" : ""} href={link.dashboard()}>
            Dashboard
          </a>
          <a className={onInsights ? "active" : ""} href={link.insights()}>
            Insights
          </a>
          <a className={route.name === "trends" ? "active" : ""} href={link.trends()}>
            Trends
          </a>
          <a className={route.name === "tools" ? "active" : ""} href={link.tools()}>
            Tools
          </a>
        </nav>
        <span className="masthead-tag">Claude Code · Session Ledger</span>
        <span className="masthead-rule" />
        <span className="masthead-blink" />
      </header>
      {route.name === "dashboard" && <Dashboard />}
      {route.name === "insights" && <Insights />}
      {route.name === "insightsProject" && <InsightsProject id={route.id} />}
      {route.name === "trends" && <Trends />}
      {route.name === "tools" && <Tools />}
      {route.name === "project" && <Project id={route.id} />}
      {route.name === "session" && <Session id={route.id} />}
    </div>
  );
}
