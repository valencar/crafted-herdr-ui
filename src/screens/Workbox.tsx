import { useEffect, useMemo, useState } from "react";
import { PaneBox } from "../components/PaneBox";
import { Sidebar } from "../components/Sidebar";
import { TabCard } from "../components/TabCard";
import { StoreToast } from "../components/Toast";
import {
  WorkboxDialogs,
  type WorkboxDialog,
} from "../components/WorkboxDialogs";
import { WorkboxSummary, type Counts } from "../components/WorkboxSummary";
import type { Pane } from "../lib/bindings/Pane";
import type { Workspace } from "../lib/bindings/Workspace";
import { shortPath } from "../lib/format";
import { groupByProject, isNeedsYou, needsYou, toRows } from "../lib/grouping";
import { invokeTyped, toActionError } from "../lib/ipc";
import { openRow, useOpenWhenListed } from "../lib/openRow";
import { tailTargets, usePaneTails } from "../lib/usePaneTails";
import {
  isEditable,
  scrollToId,
  openSettings,
  terminalName as terminalLabel,
  useTerminals,
  useNow,
} from "../lib/uiHelpers";
import { useAppStore } from "../store/appStore";
import { NewSession } from "./NewSession";

/** herdr's answer when a workspace has linked worktree workspaces (spec section 7). */
const GROUP_CLOSE_CODE = "workspace_group_close_required";

/** Where a workspace was started: the folder of its first pane. */
function workspaceFolder(panes: Pane[], workspaceId: string): string | null {
  const pane = panes.find((p) => p.workspace_id === workspaceId);
  const folder = pane?.cwd ?? pane?.foreground_cwd ?? null;
  return folder ? shortPath(folder) : null;
}

/** The Workbox screen: one machine's health and actions, and its workspaces drawn as tabs. */
export function Workbox({ machineId }: { machineId: string }) {
  const state = useAppStore((s) => s.state);
  const sheet = useAppStore((s) => s.sheet);
  const setView = useAppStore((s) => s.setView);
  const setSheet = useAppStore((s) => s.setSheet);
  const setGroupBy = useAppStore((s) => s.setGroupBy);
  const openNewSession = useAppStore((s) => s.openNewSession);
  const report = useAppStore((s) => s.reportError);
  const activityOpen = useAppStore((s) => s.activityOpen);
  const setActivityOpen = useAppStore((s) => s.setActivityOpen);

  const nowMs = useNow(30_000);
  const { current: terminal } = useTerminals();
  const [dialog, setDialog] = useState<WorkboxDialog | null>(null);
  const [checkedAtMs, setCheckedAtMs] = useState<number | null>(null);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  const machine = state?.machines.find((m) => m.id === machineId) ?? null;
  const snapshot = machine?.snapshot ?? null;
  const online = machine?.health.kind === "online";
  const disabled = machine?.health.kind === "disabled";

  const allRows = useMemo(() => (state ? toRows(state) : []), [state]);
  const rows = useMemo(
    () => allRows.filter((r) => r.machineId === machineId),
    [allRows, machineId],
  );
  const rowByPane = useMemo(
    () => new Map(rows.map((r) => [r.paneId, r])),
    [rows],
  );
  const projects = useMemo(() => groupByProject(allRows), [allRows]);
  // A machine that is not answering is not read; its boxes keep their last line.
  const targets = useMemo(
    () => (online ? tailTargets(rows) : []),
    [online, rows],
  );
  const tails = usePaneTails(machineId, targets);

  useOpenWhenListed(rows);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (sheet || useAppStore.getState().dialogOpen > 0) return;
      if (e.metaKey && e.key === "n" && !isEditable(e.target)) {
        e.preventDefault();
        openNewSession({ machineId });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sheet, machineId, openNewSession]);

  const goHome = () => setView({ kind: "home" });

  const run = (action: Promise<unknown>) => {
    action.catch(report);
  };

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

  const closeWorkspace = async (workspace: Workspace) => {
    try {
      await invokeTyped("close_workspace", {
        machineId,
        workspaceId: workspace.workspace_id,
      });
    } catch (e) {
      const err = toActionError(e);
      if (
        err.kind === "herdr" &&
        err.error.kind === "server" &&
        err.error.code === GROUP_CLOSE_CODE
      ) {
        setDialog({
          kind: "group-close",
          workspace,
          message: err.error.message,
        });
      } else {
        report(err);
      }
    }
  };

  const sidebar = (
    <Sidebar
      needsCount={needsYou(allRows).length}
      agentCount={allRows.filter((r) => r.status !== "shell").length}
      projects={projects}
      machines={state?.machines ?? []}
      herdrPath={state?.herdr_path ?? null}
      herdrVersion={state?.herdr_version ?? null}
      activeWorkbox={machineId}
      onJump={(id) => {
        goHome();
        scrollToId(id);
      }}
      onProject={(g) => {
        goHome();
        setGroupBy("project");
        scrollToId(`group-${g.key}`);
      }}
      onWorkbox={(id) => setView({ kind: "workbox", machineId: id })}
      onAddWorkbox={() => setSheet("add-workbox")}
      onSettings={openSettings}
      activityOpen={activityOpen}
      onActivity={() => setActivityOpen(!activityOpen)}
    />
  );

  // A disabled machine shows no workspaces, even when a snapshot is still cached, so its
  // counts are all zero rather than a mix of cached and empty.
  const counts: Counts = disabled
    ? { workspaces: 0, sessions: 0, agents: 0, needsYou: 0 }
    : {
        workspaces: snapshot?.workspaces.length ?? 0,
        sessions: snapshot?.panes.length ?? 0,
        agents: snapshot?.agents.length ?? 0,
        needsYou: rows.filter(isNeedsYou).length,
      };

  const workspaces = [...(snapshot?.workspaces ?? [])].sort(
    (a, b) => a.number - b.number,
  );

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
          onReconnect={() =>
            run(
              invokeTyped("open_in_terminal", {
                argv: ["machine", "reconnect", machine.id],
              }),
            )
          }
          onCheck={() => void check()}
          onRename={() => setDialog({ kind: "rename-box" })}
          onDisable={() => setDialog({ kind: "disable" })}
          onEnable={() =>
            run(
              invokeTyped("machine_set_enabled", {
                id: machine.id,
                enabled: true,
              }),
            )
          }
          onRemove={() => setDialog({ kind: "remove" })}
        />
        {disabled && (
          <p className="empty">
            {machine.label} is disabled. Enable it to see its workspaces.
          </p>
        )}
        {!disabled && snapshot === null && (
          <p className="empty">
            Waiting for {machine.label} to report its workspaces…
          </p>
        )}
        {snapshot && !disabled && (
          <div className={online ? "workbox-layout" : "workbox-layout is-dim"}>
            {workspaces.length === 0 && (
              <p className="empty">
                No workspaces yet. Start one with “+ New workspace”.
              </p>
            )}
            {workspaces.map((ws) => {
              const headingId = `ws-${ws.workspace_id}`;
              const folder = workspaceFolder(snapshot.panes, ws.workspace_id);
              const tabs = snapshot.tabs
                .filter((t) => t.workspace_id === ws.workspace_id)
                .sort((a, b) => a.number - b.number);
              return (
                <section
                  key={ws.workspace_id}
                  className="workbox-workspace"
                  aria-labelledby={headingId}
                >
                  <div className="workbox-workspace-head">
                    <h2 id={headingId} className="section-sub">
                      {ws.label}
                    </h2>
                    <span className="mono muted workbox-workspace-id">
                      {ws.workspace_id}
                      {folder ? ` · ${folder}` : ""}
                    </span>
                    <span className="workbox-workspace-actions">
                      <button
                        type="button"
                        className="btn btn-small btn-ghost"
                        onClick={() =>
                          setDialog({ kind: "new-tab", workspace: ws })
                        }
                      >
                        + Tab
                      </button>
                      <button
                        type="button"
                        className="btn btn-small btn-ghost"
                        aria-label={`Rename workspace ${ws.label}`}
                        onClick={() =>
                          setDialog({ kind: "rename-workspace", workspace: ws })
                        }
                      >
                        Rename
                      </button>
                      <button
                        type="button"
                        className="btn btn-small btn-ghost btn-danger"
                        aria-label={`Close workspace ${ws.label}`}
                        onClick={() =>
                          setDialog({ kind: "close-workspace", workspace: ws })
                        }
                      >
                        Close
                      </button>
                    </span>
                  </div>
                  <div className="workbox-tabs">
                    {tabs.map((tab) => {
                      const panes = snapshot.panes.filter(
                        (p) => p.tab_id === tab.tab_id,
                      );
                      return (
                        <TabCard
                          key={tab.tab_id}
                          tab={tab}
                          paneCount={panes.length}
                          onRename={() =>
                            setDialog({ kind: "rename-tab", tab })
                          }
                          onClose={() => setDialog({ kind: "close-tab", tab })}
                        >
                          {panes.flatMap((p) => {
                            const row = rowByPane.get(p.pane_id);
                            return row
                              ? [
                                  <PaneBox
                                    key={p.pane_id}
                                    row={row}
                                    tail={tails[p.pane_id] ?? null}
                                    onOpen={openRow}
                                  />,
                                ]
                              : [];
                          })}
                        </TabCard>
                      );
                    })}
                    <button
                      type="button"
                      className="workbox-new-tab"
                      onClick={() =>
                        setDialog({ kind: "new-tab", workspace: ws })
                      }
                    >
                      + New tab in {ws.label}
                    </button>
                  </div>
                </section>
              );
            })}
            <div>
              <button
                type="button"
                className="btn"
                onClick={() => setDialog({ kind: "new-workspace" })}
              >
                + New workspace
              </button>
            </div>
          </div>
        )}
      </>
    );
  }

  const close = () => setDialog(null);
  const label = machine?.label ?? machineId;

  return (
    <div className="app">
      <header className="header" data-tauri-drag-region>
        <nav className="breadcrumb" aria-label="Breadcrumb">
          <button type="button" className="crumb" onClick={goHome}>
            Workboxes
          </button>
          <span aria-hidden="true">/</span>
          <span className="crumb-current">{label}</span>
        </nav>
        <div className="header-actions workbox-header-actions">
          <button
            type="button"
            className="btn"
            disabled={machine === null}
            onClick={() => run(invokeTyped("open_full_herdr", { machineId }))}
          >
            Open full Herdr ↗
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => openNewSession({ machineId })}
          >
            + New session <kbd>⌘N</kbd>
          </button>
        </div>
      </header>
      <div className="body">
        {sidebar}
        <main className="main">{content}</main>
      </div>

      <WorkboxDialogs
        dialog={dialog}
        machine={machine}
        machineId={machineId}
        onClose={close}
        onRemoved={goHome}
        onCloseWorkspace={closeWorkspace}
      />

      {sheet === "new-session" && (
        <NewSession terminalName={terminalLabel(terminal)} />
      )}
      <StoreToast />
    </div>
  );
}
