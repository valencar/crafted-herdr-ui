import { useEffect, useMemo, useState } from "react";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { NameSheet } from "../components/NameSheet";
import { PaneBox } from "../components/PaneBox";
import { Sidebar } from "../components/Sidebar";
import { TabCard } from "../components/TabCard";
import { Toast } from "../components/Toast";
import { WorkboxSummary, type Counts } from "../components/WorkboxSummary";
import type { Pane } from "../lib/bindings/Pane";
import type { Tab } from "../lib/bindings/Tab";
import type { Workspace } from "../lib/bindings/Workspace";
import { shortPath } from "../lib/format";
import { groupByProject, isNeedsYou, needsYou, toRows } from "../lib/grouping";
import { invokeTyped, toActionError } from "../lib/ipc";
import { openRow } from "../lib/openRow";
import { tailTargets, usePaneTails } from "../lib/usePaneTails";
import {
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
const GROUP_CLOSE_NOTE =
  "Close its linked worktree workspaces first, then try again.";

type Dialog =
  | { kind: "rename-box" }
  | { kind: "remove" }
  | { kind: "disable" }
  | { kind: "new-workspace" }
  | { kind: "new-tab"; workspace: Workspace }
  | { kind: "rename-workspace"; workspace: Workspace }
  | { kind: "close-workspace"; workspace: Workspace }
  | { kind: "group-close"; workspace: Workspace; message: string }
  | { kind: "rename-tab"; tab: Tab }
  | { kind: "close-tab"; tab: Tab };

function sentence(text: string): string {
  const t = text.trim();
  return /[.!?]$/.test(t) ? t : `${t}.`;
}

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)
  );
}

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
  const toast = useAppStore((s) => s.toast);
  const toastTone = useAppStore((s) => s.toastTone);
  const setView = useAppStore((s) => s.setView);
  const setSheet = useAppStore((s) => s.setSheet);
  const setGroupBy = useAppStore((s) => s.setGroupBy);
  const openNewSession = useAppStore((s) => s.openNewSession);
  const report = useAppStore((s) => s.reportError);
  const dismissToast = useAppStore((s) => s.clearToast);
  const pendingOpen = useAppStore((s) => s.pendingOpen);
  const setPendingOpen = useAppStore((s) => s.setPendingOpen);

  const nowMs = useNow(30_000);
  const { current: terminal } = useTerminals();
  const [dialog, setDialog] = useState<Dialog | null>(null);
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

  // A session was just created with "Open when ready": open it once its row is listed.
  useEffect(() => {
    if (
      pendingOpen &&
      pendingOpen.machineId === machineId &&
      rowByPane.has(pendingOpen.paneId)
    ) {
      setPendingOpen(null);
      invokeTyped("open_session", {
        machineId: pendingOpen.machineId,
        paneId: pendingOpen.paneId,
      }).catch(report);
    }
  }, [pendingOpen, rowByPane, machineId, setPendingOpen, report]);

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
    />
  );

  const counts: Counts = {
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

      {machine && dialog?.kind === "rename-box" && (
        <NameSheet
          title="Rename workbox"
          fields={[{ key: "name", label: "Name", initial: machine.label }]}
          submitLabel="Rename"
          onSubmit={(v) =>
            invokeTyped("machine_rename", { id: machine.id, label: v.name })
          }
          onClose={close}
        />
      )}
      {machine && dialog?.kind === "remove" && (
        <ConfirmDialog
          title={`Remove ${machine.label}?`}
          body="Removing forgets this workbox here. Its sessions and agents keep running on the machine."
          confirmLabel="Remove workbox"
          danger
          onConfirm={() => {
            close();
            invokeTyped("machine_remove", { id: machine.id })
              .then(goHome)
              .catch(report);
          }}
          onCancel={close}
        />
      )}
      {machine && dialog?.kind === "disable" && (
        <ConfirmDialog
          title={`Disable ${machine.label}?`}
          body={`Crafted Herdr stops checking ${machine.label}. Its sessions and agents keep running on the machine, and you can enable it again here.`}
          confirmLabel="Disable workbox"
          danger={false}
          onConfirm={() => {
            close();
            run(
              invokeTyped("machine_set_enabled", {
                id: machine.id,
                enabled: false,
              }),
            );
          }}
          onCancel={close}
        />
      )}
      {dialog?.kind === "new-workspace" && (
        <NameSheet
          title="New workspace"
          fields={[
            {
              key: "cwd",
              label: "Folder",
              placeholder: "/home/dev/projects/api-service",
              mono: true,
            },
            { key: "name", label: "Name" },
          ]}
          submitLabel="Create workspace"
          onSubmit={(v) =>
            invokeTyped("create_workspace", {
              machineId,
              cwd: v.cwd,
              label: v.name,
            })
          }
          onClose={close}
        />
      )}
      {dialog?.kind === "new-tab" && (
        <NameSheet
          title={`New tab in ${dialog.workspace.label}`}
          fields={[{ key: "name", label: "Name" }]}
          submitLabel="Create tab"
          onSubmit={(v) =>
            invokeTyped("create_tab", {
              machineId,
              workspaceId: dialog.workspace.workspace_id,
              label: v.name,
            })
          }
          onClose={close}
        />
      )}
      {dialog?.kind === "rename-workspace" && (
        <NameSheet
          title="Rename workspace"
          fields={[
            { key: "name", label: "Name", initial: dialog.workspace.label },
          ]}
          submitLabel="Rename"
          onSubmit={(v) =>
            invokeTyped("rename_workspace", {
              machineId,
              workspaceId: dialog.workspace.workspace_id,
              label: v.name,
            })
          }
          onClose={close}
        />
      )}
      {dialog?.kind === "close-workspace" && (
        <ConfirmDialog
          title={`Close workspace ${dialog.workspace.label}?`}
          body={`This closes workspace ${dialog.workspace.workspace_id} on ${label}, with its ${dialog.workspace.tab_count} ${dialog.workspace.tab_count === 1 ? "tab" : "tabs"} and ${dialog.workspace.pane_count} ${dialog.workspace.pane_count === 1 ? "session" : "sessions"}, and ends whatever is running in them.`}
          confirmLabel="Close workspace"
          onConfirm={() => {
            const { workspace } = dialog;
            close();
            void closeWorkspace(workspace);
          }}
          onCancel={close}
        />
      )}
      {dialog?.kind === "group-close" && (
        <ConfirmDialog
          title={`${dialog.workspace.label} can’t be closed yet`}
          body={`${sentence(dialog.message)} ${GROUP_CLOSE_NOTE}`}
          confirmLabel="OK"
          danger={false}
          onConfirm={close}
          onCancel={close}
        />
      )}
      {dialog?.kind === "rename-tab" && (
        <NameSheet
          title="Rename tab"
          fields={[{ key: "name", label: "Name", initial: dialog.tab.label }]}
          submitLabel="Rename"
          onSubmit={(v) =>
            invokeTyped("rename_tab", {
              machineId,
              tabId: dialog.tab.tab_id,
              label: v.name,
            })
          }
          onClose={close}
        />
      )}
      {dialog?.kind === "close-tab" && (
        <ConfirmDialog
          title={`Close tab ${dialog.tab.label}?`}
          body={`This closes tab ${dialog.tab.tab_id} on ${label} and ends whatever is running in its ${dialog.tab.pane_count} ${dialog.tab.pane_count === 1 ? "session" : "sessions"}.`}
          confirmLabel="Close tab"
          onConfirm={() => {
            const { tab } = dialog;
            close();
            run(invokeTyped("close_tab", { machineId, tabId: tab.tab_id }));
          }}
          onCancel={close}
        />
      )}

      {sheet === "new-session" && (
        <NewSession terminalName={terminalLabel(terminal)} />
      )}
      {toast && (
        <Toast message={toast} tone={toastTone} onDismiss={dismissToast} />
      )}
    </div>
  );
}
