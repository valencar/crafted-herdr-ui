import type { MachineView } from "../lib/bindings/MachineView";
import type { Tab } from "../lib/bindings/Tab";
import type { Workspace } from "../lib/bindings/Workspace";
import { plural } from "../lib/format";
import { invokeTyped } from "../lib/ipc";
import { useAppStore } from "../store/appStore";
import { ConfirmDialog } from "./ConfirmDialog";
import { NameSheet } from "./NameSheet";

const GROUP_CLOSE_NOTE =
  "Close its linked worktree workspaces first, then try again.";

/** Which dialog the Workbox screen has open. */
export type WorkboxDialog =
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

type Props = {
  dialog: WorkboxDialog | null;
  machine: MachineView | null;
  machineId: string;
  onClose: () => void;
  /** The workbox was removed: leave its screen. */
  onRemoved: () => void;
  onCloseWorkspace: (workspace: Workspace) => Promise<void>;
};

/** Every confirm and name sheet the Workbox screen can open, one at a time. */
export function WorkboxDialogs({
  dialog,
  machine,
  machineId,
  onClose: close,
  onRemoved: goHome,
  onCloseWorkspace: closeWorkspace,
}: Props) {
  const report = useAppStore((s) => s.reportError);
  // The workbox's name for messages: its label, or its id before it is listed.
  const label = machine?.label ?? machineId;
  return (
    <>
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
            invokeTyped("machine_set_enabled", {
              id: machine.id,
              enabled: false,
            }).catch(report);
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
          body={`This closes workspace ${dialog.workspace.workspace_id} on ${label}, with its ${plural(dialog.workspace.tab_count, "tab", "tabs")} and ${plural(dialog.workspace.pane_count, "session", "sessions")}, and ends whatever is running in them.`}
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
          body={`This closes tab ${dialog.tab.tab_id} on ${label} and ends whatever is running in its ${plural(dialog.tab.pane_count, "session", "sessions")}.`}
          confirmLabel="Close tab"
          onConfirm={() => {
            const { tab } = dialog;
            close();
            invokeTyped("close_tab", { machineId, tabId: tab.tab_id }).catch(
              report,
            );
          }}
          onCancel={close}
        />
      )}
    </>
  );
}
