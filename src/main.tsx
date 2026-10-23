import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { applyStoredTheme } from "./lib/theme";
import "./styles/tokens.css";
import "./styles/global.css";
import "./styles/app.css";
import "./styles/windows.css";

// The remembered theme goes on <html> before the first render, so there is no dark flash.
applyStoredTheme();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
