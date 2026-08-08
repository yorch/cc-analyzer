import "./fonts.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import "./styles.css";
import { initTelemetry } from "./telemetry.ts";
import { watchSystemTheme } from "./theme.ts";

initTelemetry();
// The inline <head> script (index.html) has already stamped the initial theme;
// this keeps a "system" choice live if the OS theme flips while the page is open.
watchSystemTheme();

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
