import React from "react";
import ReactDOM from "react-dom/client";
import { Settings } from "./screens/Settings";
import { useSettingsSync, useStateSync } from "./lib/useSync";
import "./styles/tokens.css";
import "./styles/global.css";
import "./styles/app.css";
import "./styles/windows.css";

function SettingsWindow() {
  useStateSync();
  useSettingsSync();
  return <Settings />;
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <SettingsWindow />
  </React.StrictMode>,
);
