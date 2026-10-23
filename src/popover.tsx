import React from "react";
import ReactDOM from "react-dom/client";
import { MenuBar } from "./screens/MenuBar";
import { useSettingsSync, useStateSync } from "./lib/useSync";
import { setPlatformAttribute } from "./lib/platform";
import { applyStoredTheme } from "./lib/theme";
import "./styles/tokens.css";
import "./styles/global.css";
import "./styles/app.css";
import "./styles/windows.css";

function Popover() {
  useStateSync();
  useSettingsSync();
  return <MenuBar />;
}

// The remembered theme goes on <html> before the first render, so there is no dark flash.
applyStoredTheme();
setPlatformAttribute();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Popover />
  </React.StrictMode>,
);
