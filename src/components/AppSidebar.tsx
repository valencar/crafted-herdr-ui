import { useMemo } from "react";
import { groupByProject, needsYou, toRows } from "../lib/grouping";
import { openSettings, scrollToId } from "../lib/uiHelpers";
import { useAppStore } from "../store/appStore";
import { HOME, useTerminalStore } from "../terminal/terminalStore";
import { Sidebar } from "./Sidebar";

/** The sidebar of the window, fed from the stores; it looks the same on every screen. */
export function AppSidebar() {
  const state = useAppStore((s) => s.state);
  const view = useAppStore((s) => s.view);
  const setView = useAppStore((s) => s.setView);
  const setGroupBy = useAppStore((s) => s.setGroupBy);
  const setSheet = useAppStore((s) => s.setSheet);
  const activityOpen = useAppStore((s) => s.activityOpen);
  const setActivityOpen = useAppStore((s) => s.setActivityOpen);

  // The sidebar changes what the Home tab shows, so a click brings that tab back first.
  const showHome = () => useTerminalStore.getState().activate(HOME);

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
        showHome();
        setView({ kind: "home" });
        scrollToId(id);
      }}
      onProject={(g) => {
        showHome();
        setView({ kind: "home" });
        setGroupBy("project");
        scrollToId(`group-${g.key}`);
      }}
      activeWorkbox={view.kind === "workbox" ? view.machineId : null}
      onWorkbox={(id) => {
        showHome();
        setView({ kind: "workbox", machineId: id });
      }}
      onAddWorkbox={() => setSheet("add-workbox")}
      onSettings={openSettings}
      activityOpen={activityOpen}
      onActivity={() => setActivityOpen(!activityOpen)}
    />
  );
}
