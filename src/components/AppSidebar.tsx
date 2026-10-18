import { useMemo } from "react";
import { groupByProject, needsYou, toRows } from "../lib/grouping";
import { openSettings, scrollToId, showHomeView } from "../lib/uiHelpers";
import { useAppStore } from "../store/appStore";
import { HOME, useTerminalStore } from "../terminal/terminalStore";
import { Sidebar } from "./Sidebar";

/** The sidebar of the window, fed from the stores; it looks the same on every screen. */
export function AppSidebar() {
  const state = useAppStore((s) => s.state);
  const view = useAppStore((s) => s.view);
  const setGroupBy = useAppStore((s) => s.setGroupBy);
  const setSheet = useAppStore((s) => s.setSheet);
  const setQuery = useAppStore((s) => s.setQuery);
  const activityOpen = useAppStore((s) => s.activityOpen);
  const setActivityOpen = useAppStore((s) => s.setActivityOpen);

  const activeKey = useTerminalStore((s) => s.activeKey);

  const rows = useMemo(() => (state ? toRows(state) : []), [state]);
  const projects = useMemo(() => groupByProject(rows), [rows]);

  return (
    <Sidebar
      needsCount={needsYou(rows).length}
      agentCount={rows.filter((r) => r.status !== "shell").length}
      projects={projects}
      machines={state?.machines ?? []}
      herdrPath={state?.herdr_path ?? null}
      herdrVersion={state?.herdr_version ?? null}
      onJump={(id) => {
        showHomeView({ kind: "all" });
        scrollToId(id);
      }}
      onProject={(g) => {
        // A project the saved search filters out has no group to scroll to.
        setQuery("");
        showHomeView({ kind: "all" });
        setGroupBy("project");
        scrollToId(`group-${g.key}`);
      }}
      dashboardActive={activeKey === HOME && view.kind === "dashboard"}
      onDashboard={() => {
        showHomeView({ kind: "dashboard" });
      }}
      activeWorkbox={view.kind === "workbox" ? view.machineId : null}
      onWorkbox={(id) => {
        showHomeView({ kind: "workbox", machineId: id });
      }}
      onAddWorkbox={() => setSheet("add-workbox")}
      onSettings={openSettings}
      activityOpen={activityOpen}
      onActivity={() => setActivityOpen(!activityOpen)}
    />
  );
}
