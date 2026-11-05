import { Kbd } from "../components/Kbd";
import { useEffect, useMemo, useState } from "react";
import { ClearEndedConfirm } from "../components/CloseConfirm";
import { PaneBox } from "../components/PaneBox";
import {
  WorkboxDialogs,
  type WorkboxDialog,
} from "../components/WorkboxDialogs";
import { WorkboxSummary, type Counts } from "../components/WorkboxSummary";
import { shortPath } from "../lib/format";
import { groupByProject, isNeedsYou, isShell, toRows } from "../lib/grouping";
import { invokeTyped } from "../lib/ipc";
import { openRow } from "../lib/openRow";
import { tailTargets, useTails } from "../lib/useTails";
import { isEditable, isInTerminal } from "../lib/uiHelpers";
import { useNow } from "../lib/useNow";
import { useAppStore } from "../store/appStore";
import { openMachineCommand } from "../terminal/commandTabs";

/** The Workbox screen: one machine's state and actions, and its terminals grouped by project. */
export function Workbox({ machineId }: { machineId: string }) {
  const state = useAppStore((s) => s.state);
  const sheet = useAppStore((s) => s.sheet);
  const setView = useAppStore((s) => s.setView);
  const setSettings = useAppStore((s) => s.setSettings);
  const openNewSession = useAppStore((s) => s.openNewSession);
  const report = useAppStore((s) => s.reportError);

  const nowMs = useNow(30_000);
  const [dialog, setDialog] = useState<WorkboxDialog | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [clearing, setClearing] = useState(false);

  const machine = state?.machines.find((m) => m.id === machineId) ?? null;
  const online = machine?.health.kind === "online";
  // A hidden workbox is not shown (spec 7.4): it comes back from Settings.
  const hidden = machine?.health.kind === "hidden";

  const allRows = useMemo(() => (state ? toRows(state) : []), [state]);
  const rows = useMemo(
    () => allRows.filter((r) => r.machineId === machineId),
    [allRows, machineId],
  );
  // The terminals by project folder, the same rule as everywhere else.
  const groups = useMemo(() => groupByProject(rows), [rows]);
  // A machine that is not answering is not read; its boxes keep their last line.
  const targets = useMemo(
    () => (online ? tailTargets(rows) : []),
    [online, rows],
  );
  const tails = useTails(machineId, targets);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (sheet || useAppStore.getState().dialogOpen > 0) return;
      if (
        e.metaKey &&
        e.key === "n" &&
        !isEditable(e.target) &&
        !isInTerminal(e.target)
      ) {
        e.preventDefault();
        openNewSession({ machineId });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sheet, machineId, openNewSession]);

  const goHome = () => setView({ kind: "dashboard" });

  const connect = () => {
    setConnecting(true);
    invokeTyped("machine_connect", { machineId })
      .catch(report)
      .finally(() => setConnecting(false));
  };

  // Hide is an app setting with no core call behind it (spec section 7.4). The workbox is then
  // not shown anywhere, so the screen goes back to Home; Settings shows it again.
  const hide = () => {
    invokeTyped("set_workbox_hidden", { machineId, hidden: true })
      .then((saved) => {
        setSettings(saved);
        goHome();
      })
      .catch(report);
  };

  const counts: Counts = {
    sessions: rows.length,
    agents: rows.filter((r) => !isShell(r)).length,
    needsYou: rows.filter(isNeedsYou).length,
  };

  let content;
  if (state === null) {
    content = <p className="empty">Connecting to herdr…</p>;
  } else if (machine === null) {
    content = (
      <div className="empty">
        <p>“{machineId}” isn’t one of your workboxes.</p>
        <button type="button" className="btn" onClick={goHome}>
          Back to all workboxes
        </button>
      </div>
    );
  } else if (hidden) {
    content = (
      <div className="empty">
        <p>{machine.name} is hidden. Show it again in Settings.</p>
        <button type="button" className="btn" onClick={goHome}>
          Back to all workboxes
        </button>
      </div>
    );
  } else {
    content = (
      <>
        <WorkboxSummary
          machine={machine}
          counts={counts}
          nowMs={nowMs}
          coreVersion={state.core_version}
          connecting={connecting}
          onConnect={connect}
          onLogIn={() => void openMachineCommand(machine, "login")}
          onUpdate={() => setDialog({ kind: "update" })}
          onRename={() => setDialog({ kind: "rename-box" })}
          onHide={hide}
          onRemove={() => setDialog({ kind: "remove" })}
        />
        {machine.last_ok_ms === null && rows.length === 0 && (
          <p className="empty">
            Waiting for {machine.name} to report its terminals…
          </p>
        )}
        {(machine.last_ok_ms !== null || rows.length > 0) && (
          <div className={online ? "workbox-layout" : "workbox-layout is-dim"}>
            {rows.length === 0 && (
              <p className="empty">
                No terminals yet. Start one with “+ New session”.
              </p>
            )}
            {groups.map((g) => (
              <section
                key={g.key}
                className="workbox-group"
                aria-label={g.name}
              >
                <div className="workbox-group-head">
                  <h2 className="workbox-group-name">{g.name}</h2>
                  {g.folder && (
                    <span className="mono muted workbox-group-path">
                      {shortPath(g.folder)}
                    </span>
                  )}
                </div>
                <div className="workbox-terminals">
                  {g.rows.map((row) => (
                    <PaneBox
                      key={row.key}
                      row={row}
                      tail={tails[row.address] ?? null}
                      onOpen={openRow}
                    />
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}
      </>
    );
  }

  // Spec 7.3: "Clear ended" is offered while this workbox lists ended terminals.
  const endedCount = hidden
    ? 0
    : rows.filter((r) => r.status === "ended").length;

  const close = () => setDialog(null);
  const label = machine?.name ?? machineId;

  return (
    <div className="screen">
      <main className="main">
        <div className="workbox-heading">
          <nav className="breadcrumb" aria-label="Breadcrumb">
            <button type="button" className="crumb" onClick={goHome}>
              Workboxes
            </button>
            <span aria-hidden="true">/</span>
            <span className="crumb-current">{label}</span>
          </nav>
          <div className="workbox-heading-actions">
            {endedCount > 0 && (
              <button
                type="button"
                className="btn"
                onClick={() => setClearing(true)}
              >
                Clear ended
              </button>
            )}
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => openNewSession({ machineId })}
            >
              + New session <Kbd id="new-session" />
            </button>
          </div>
        </div>
        {content}
      </main>

      {clearing && (
        <ClearEndedConfirm
          machineId={machineId}
          machineName={label}
          count={endedCount}
          onDone={() => setClearing(false)}
        />
      )}
      <WorkboxDialogs
        dialog={dialog}
        machine={machine}
        onClose={close}
        onRemoved={goHome}
      />
    </div>
  );
}
