import React from "react";
import ReactDOM from "react-dom/client";
import { MenuBar } from "./screens/MenuBar";
import { useStateSync } from "./lib/useSync";
import "./styles/tokens.css";
import "./styles/global.css";
import "./styles/app.css";
import "./styles/windows.css";

function Popover() {
  useStateSync();
  return <MenuBar />;
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Popover />
  </React.StrictMode>,
);
