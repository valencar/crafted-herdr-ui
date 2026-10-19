import { useAppStore } from "../store/appStore";
import { showHomeView } from "../lib/uiHelpers";

/**
 * The views the Home tab can show, as buttons under the workspace tabs: the Dashboard, All
 * agents, and, while a workbox screen is showing, that workbox.
 */
export function HomeViewsRow() {
  const view = useAppStore((s) => s.view);
  const state = useAppStore((s) => s.state);

  const workboxLabel =
    view.kind === "workbox"
      ? (state?.machines.find((m) => m.id === view.machineId)?.label ??
        view.machineId)
      : null;

  return (
    <nav className="home-views" aria-label="Home views">
      <button
        type="button"
        className="home-view"
        data-active={view.kind === "dashboard"}
        aria-current={view.kind === "dashboard" ? "page" : undefined}
        onClick={() => showHomeView({ kind: "dashboard" })}
      >
        Dashboard
      </button>
      <button
        type="button"
        className="home-view"
        data-active={view.kind === "all"}
        aria-current={view.kind === "all" ? "page" : undefined}
        onClick={() => showHomeView({ kind: "all" })}
      >
        All agents
      </button>
      {view.kind === "workbox" && workboxLabel !== null && (
        <button
          type="button"
          className="home-view"
          data-active="true"
          aria-current="page"
          onClick={() => showHomeView(view)}
        >
          {workboxLabel}
        </button>
      )}
    </nav>
  );
}
