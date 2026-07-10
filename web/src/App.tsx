import { link, useHashRoute } from "./router.ts";
import { Dashboard } from "./views/Dashboard.tsx";
import { Project } from "./views/Project.tsx";
import { Session } from "./views/Session.tsx";

export function App() {
  const route = useHashRoute();
  return (
    <div className="wrap">
      <header className="top">
        <h1>
          <a href={link.dashboard()} style={{ color: "inherit" }}>
            cc-analyzer
          </a>
        </h1>
        <span className="muted">Claude Code session analytics</span>
      </header>
      {route.name === "dashboard" && <Dashboard />}
      {route.name === "project" && <Project id={route.id} />}
      {route.name === "session" && <Session id={route.id} />}
    </div>
  );
}
