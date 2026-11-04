import { Kbd } from "../components/Kbd";
import { useEffect, useMemo, useState } from "react";
import { PaneBox } from "../components/PaneBox";
import {
  WorkboxDialogs,
  type WorkboxDialog,
} from "../components/WorkboxDialogs";
import { WorkboxSummary, type Counts } from "../components/WorkboxSummary";
import { isNeedsYou, isShell, toRows } from "../lib/grouping";
import { invokeTyped } from "../lib/ipc";
import { openFull, openRow } from "../lib/openRow";
import { tailTargets, usePaneTails } from "../lib/usePaneTails";
import { isEditable, isInTerminal, saveSettings } from "../lib/uiHelpers";
import { useNow } from "../lib/useNow";
import { useAppStore } from "../store/appStore";

/** The Workbox screen: one machine's health and actions, and its terminals as a flat list. */
export function Workbox({ machineId }: { machineId: string }) {
  const state = useAppStore((s) => s.state);
  const settings = useAppStore((s) => s.settings);
  const sheet = useAppStore((s) => s.sheet);
  const setView = useAppStore((s) => s.setView);
  const openNewSession = useAppStore((s) => s.openNewSession);
  const report = useAppStore((s) => s.reportError);

  const nowMs = useNow(30_000);
  const [dialog, setDialog] = useState<WorkboxDialog | null>(null);
  const [checkedAtMs, setCheckedAtMs] = useState<number | null>(null);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  const machine = state?.machines.find((m) => m.id === machineId) ?? null;
  const online = machine?.health.kind === "online";
  const hidden = machine?.health.kind === "hidden";

  const allRows = useMemo(() => (state ? toRows(state) : []), [state]);
  const rows = useMemo(
    () => allRows.filter((r) => r.machineId === machineId),
    [allRows, machineId],
  );
  // A machine that is not answering is not read; its boxes keep their last line.
  const targets = useMemo(
    () => (online ? tailTargets(rows) : []),
    [online, rows],
  );
  const tails = usePaneTails(machineId, targets);

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

  const check = async () => {
    setChecking(true);
    try {
      const entries = await invokeTyped("machine_status", { id: machineId });
      setCheckedAtMs(Date.now());
      setCheckError(entries.find((e) => e.id === machineId)?.error ?? null);
    } catch (e) {
      // The last check no longer says anything about now.
      setCheckedAtMs(null);
      setCheckError(null);
      report(e);
    } finally {
      setChecking(false);
    }
  };

  // Hide and Show are an app setting with no core call behind them (spec section 7.4).
  const setHidden = (hide: boolean) => {
    const others = (settings?.hidden_workboxes ?? []).filter(
      (id) => id !== machineId,
    );
    saveSettings({ hidden_workboxes: hide ? [...others, machineId] : others });
  };

  // A hidden machine shows no terminals, even when some are still held, so its counts are all
  // zero rather than a mix.
  const counts: Counts = hidden
    ? { sessions: 0, agents: 0, needsYou: 0 }
    : {
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
  } else {
    content = (
      <>
        <WorkboxSummary
          machine={machine}
          counts={counts}
          nowMs={nowMs}
          checkedAtMs={checkedAtMs}
          checkError={checkError}
          checking={checking}
          onCheck={() => void check()}
          onRename={() => setDialog({ kind: "rename-box" })}
          onHide={() => setHidden(true)}
          onShow={() => setHidden(false)}
          onRemove={() => setDialog({ kind: "remove" })}
        />
        {hidden && (
          <p className="empty">
            {machine.name} is hidden. Show it to see its terminals.
          </p>
        )}
        {!hidden && machine.last_ok_ms === null && rows.length === 0 && (
          <p className="empty">
            Waiting for {machine.name} to report its terminals…
          </p>
        )}
        {!hidden && (machine.last_ok_ms !== null || rows.length > 0) && (
          <div className={online ? "workbox-layout" : "workbox-layout is-dim"}>
            {rows.length === 0 && (
              <p className="empty">
                No terminals yet. Start one with “+ New session”.
              </p>
            )}
            {rows.length > 0 && (
              <div className="workbox-terminals">
                {rows.map((row) => (
                  <PaneBox
                    key={row.key}
                    row={row}
                    tail={tails[row.paneId] ?? null}
                    onOpen={openRow}
                  />
                ))}
              </div>
            )}
          </div>
        )}
      </>
    );
  }

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
            <button
              type="button"
              className="btn"
              disabled={machine === null}
              onClick={() => void openFull(machineId, label)}
            >
              Open full Herdr ↗
            </button>
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

      <WorkboxDialogs
        dialog={dialog}
        machine={machine}
        onClose={close}
        onRemoved={goHome}
      />
    </div>
  );
}
