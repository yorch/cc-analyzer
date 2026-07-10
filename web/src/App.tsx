import { link, useHashRoute } from "./router.ts";
import { Dashboard } from "./views/Dashboard.tsx";
import { Project } from "./views/Project.tsx";
import { Session } from "./views/Session.tsx";

export function App() {
  const route = useHashRoute();
  return (
    <div className="wrap">
      <header className="masthead">
        <a className="brand" href={link.dashboard()} aria-label="cc-analyzer home">
          <span className="brand-mark">cc</span>
          <span className="brand-name">analyzer</span>
        </a>
        <span className="masthead-tag">Claude Code · Session Ledger</span>
        <span className="masthead-rule" />
        <span className="masthead-blink" />
      </header>
      {route.name === "dashboard" && <Dashboard />}
      {route.name === "project" && <Project id={route.id} />}
      {route.name === "session" && <Session id={route.id} />}
    </div>
  );
}
