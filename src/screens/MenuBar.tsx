import { Kbd } from "../components/Kbd";
import { useMemo } from "react";
import { StoreToast } from "../components/Toast";
import { HEALTH_LABEL, STATUS_LABEL, formatAge, plural } from "../lib/format";
import { needsYou, projectNames, toRows, type Row } from "../lib/grouping";
import { invokeTyped } from "../lib/ipc";
import { defaultOpenHow, openRow } from "../lib/openRow";
import { useNow } from "../lib/useNow";
import { useAppStore } from "../store/appStore";

type RowItemProps = {
  row: Row;
  project: string | null;
  nowMs: number;
  /** Needs-you rows get the primary button. */
  primary: boolean;
};

function RowItem({ row, project, nowMs, primary }: RowItemProps) {
  const report = useAppStore((s) => s.reportError);
  // This window opens no tabs. With "Open sessions" set to the app, it asks the main window.
  const open = () => {
    if (defaultOpenHow() === "app") {
      invokeTyped("show_main_open_row", {
        machineId: row.machineId,
        paneId: row.paneId,
      }).catch(report);
    } else {
      void openRow(row, "external");
    }
  };
  const age = formatAge(row.sinceMs, nowMs);
  const detail = [project, row.machineLabel, age].filter(Boolean).join(" · ");
  return (
    <li className="pop-row" data-row-key={row.key}>
      <span className="dot" data-status={row.status} aria-hidden="true" />
      <span className="pop-row-text">
        <span className="pop-row-name">{row.name}</span>
        <span className="mono muted pop-row-detail">
          <span className="pop-row-status">{STATUS_LABEL[row.status]}</span> ·{" "}
          {detail}
        </span>
      </span>
      <button
        type="button"
        className={primary ? "btn btn-small btn-primary" : "btn btn-small"}
        aria-label={`Open ${row.name}`}
        onClick={open}
      >
        Open
      </button>
    </li>
  );
}

/**
 * The menu bar popover (spec section 9.6): what needs you, what is working, an idle summary,
 * the workboxes' health, and the two ways back into the app.
 */
export function MenuBar() {
  const state = useAppStore((s) => s.state);
  const report = useAppStore((s) => s.reportError);
  const shortcutOn = useAppStore((s) => s.settings?.global_shortcut_enabled);
  const nowMs = useNow(30_000);

  const rows = useMemo(() => (state ? toRows(state) : []), [state]);
  const projectOf = useMemo(() => projectNames(rows), [rows]);
  const needs = useMemo(() => needsYou(rows), [rows]);
  const working = useMemo(
    () => rows.filter((r) => r.status === "working"),
    [rows],
  );
  const idle = useMemo(() => rows.filter((r) => r.status === "idle"), [rows]);
  const agentCount = rows.filter((r) => r.status !== "shell").length;
  const idleNames = [
    ...new Set(idle.map((r) => projectOf.get(r.key) ?? r.name)),
  ].join(", ");

  const showApp = () => invokeTyped("show_main").catch(report);
  const newSession = () => invokeTyped("show_main_new_session").catch(report);

  return (
    <div className="popover">
      <header className="pop-head">
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M4 7l4 4-4 4" />
          <path d="M11 17h9" />
        </svg>
        <span className="pop-brand">Crafted Herdr</span>
        {state && (
          <span className="muted pop-count">
            {plural(agentCount, "agent", "agents")} ·{" "}
            {plural(state.machines.length, "workbox", "workboxes")}
          </span>
        )}
      </header>

      <div className="pop-body">
        {state === null ? (
          <p className="empty pop-pad">Connecting to herdr…</p>
        ) : (
          <>
            <section aria-labelledby="pop-needs">
              <h2 id="pop-needs" className="pop-title pop-title-needs">
                Needs you · {needs.length}
              </h2>
              {needs.length === 0 ? (
                <p className="muted pop-pad">All clear</p>
              ) : (
                <ul className="pop-list">
                  {needs.map((r) => (
                    <RowItem
                      key={r.key}
                      row={r}
                      project={projectOf.get(r.key) ?? null}
                      nowMs={nowMs}
                      primary
                    />
                  ))}
                </ul>
              )}
            </section>

            <section aria-labelledby="pop-working">
              <h2 id="pop-working" className="pop-title">
                Working · {working.length}
              </h2>
              <ul className="pop-list">
                {working.map((r) => (
                  <RowItem
                    key={r.key}
                    row={r}
                    project={projectOf.get(r.key) ?? null}
                    nowMs={nowMs}
                    primary={false}
                  />
                ))}
              </ul>
            </section>

            <section aria-labelledby="pop-idle">
              <h2 id="pop-idle" className="pop-title">
                Idle · {idle.length}
              </h2>
              {idleNames && (
                <p className="muted pop-pad pop-idle">{idleNames}</p>
              )}
            </section>
          </>
        )}
      </div>

      {state && (
        <ul className="pop-boxes" aria-label="Workboxes">
          {state.machines.map((m) => (
            <li key={m.id} className="health" data-health={m.health.kind}>
              <span className="dot" aria-hidden="true" />
              {m.label}
              <span className="sr-only"> {HEALTH_LABEL[m.health.kind]}</span>
            </li>
          ))}
        </ul>
      )}

      <div className="pop-foot">
        <button type="button" className="btn" onClick={() => void showApp()}>
          Open app {shortcutOn && <Kbd id="global-show" />}
        </button>
        <button type="button" className="btn" onClick={() => void newSession()}>
          New session
        </button>
      </div>
      <StoreToast />
    </div>
  );
}
