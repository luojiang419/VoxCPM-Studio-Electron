import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import BrandAnnouncementPreview from "./BrandAnnouncementPreview";
import WindowBehaviorPreview from "./WindowBehaviorPreview";
import "./styles.css";
import "./studio-shell.css";
import "./voice-workspace.css";
import "./batch-workspace.css";
import "./resource-overview.css";
import "./light-theme.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {new URLSearchParams(window.location.search).get("preview") === "jvox-announcement" ? <BrandAnnouncementPreview /> : new URLSearchParams(window.location.search).get("preview") === "window-behavior" ? <WindowBehaviorPreview /> : <App />}
  </React.StrictMode>,
);

