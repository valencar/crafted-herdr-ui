import { useEffect } from "react";
import { create } from "zustand";
import type { AppState } from "../lib/bindings/AppState";
import type { PreviewFrame } from "../lib/bindings/PreviewFrame";
import { actionErrorMessage } from "../lib/format";
import { toActionError } from "../lib/ipc";

export type GroupBy = "project" | "workbox" | "status";
export type Sheet = null | "new-session" | "add-workbox";
export type View = { kind: "home" } | { kind: "workbox"; machineId: string };

const TOAST_MS = 8000;
const PENDING_SELECT_MS = 10_000;
let toastTimer: ReturnType<typeof setTimeout> | undefined;
let pendingTimer: ReturnType<typeof setTimeout> | undefined;

type AppStore = {
  state: AppState | null;
  /** A row key, `${machineId}::${paneId}`. */
  selectedKey: string | null;
  groupBy: GroupBy;
  sheet: Sheet;
  view: View;
  activityOpen: boolean;
  /** The error shown in the toast, if any. */
  toast: string | null;
  /** How many modals (confirm dialogs, sheets) are mounted. Above 0 the shortcuts stand down. */
  dialogOpen: number;
  /**
   * A row key to select once the row shows up in the state (a session was just created and
   * the next poll has not listed it yet). Dropped after 10 s.
   */
  pendingSelectKey: string | null;
  /** The latest live-preview frame for the selected row. */
  preview: PreviewFrame | null;
  setState: (state: AppState) => void;
  select: (key: string | null) => void;
  setGroupBy: (groupBy: GroupBy) => void;
  setSheet: (sheet: Sheet) => void;
  setView: (view: View) => void;
  setActivityOpen: (open: boolean) => void;
  /** Shows an action error. Every report restarts the auto-dismiss timer. */
  reportError: (e: unknown) => void;
  clearToast: () => void;
  setPreview: (frame: PreviewFrame | null) => void;
  openDialog: () => void;
  closeDialog: () => void;
  setPendingSelectKey: (key: string | null) => void;
};

/** Marks a modal as open for as long as the calling component is mounted. */
export function useModalOpen(): void {
  const openDialog = useAppStore((s) => s.openDialog);
  const closeDialog = useAppStore((s) => s.closeDialog);
  useEffect(() => {
    openDialog();
    return closeDialog;
  }, [openDialog, closeDialog]);
}

export const useAppStore = create<AppStore>((set, get) => ({
  state: null,
  selectedKey: null,
  groupBy: "project",
  sheet: null,
  view: { kind: "home" },
  activityOpen: false,
  toast: null,
  preview: null,
  dialogOpen: 0,
  pendingSelectKey: null,
  setState: (state) => set({ state }),
  select: (selectedKey) => set({ selectedKey }),
  setGroupBy: (groupBy) => set({ groupBy }),
  setSheet: (sheet) => set({ sheet }),
  setView: (view) => set({ view }),
  setActivityOpen: (activityOpen) => set({ activityOpen }),
  reportError: (e) => {
    clearTimeout(toastTimer);
    set({ toast: actionErrorMessage(toActionError(e)) });
    toastTimer = setTimeout(() => get().clearToast(), TOAST_MS);
  },
  clearToast: () => {
    clearTimeout(toastTimer);
    set({ toast: null });
  },
  setPreview: (preview) => set({ preview }),
  openDialog: () => set((s) => ({ dialogOpen: s.dialogOpen + 1 })),
  closeDialog: () =>
    set((s) => ({ dialogOpen: Math.max(0, s.dialogOpen - 1) })),
  setPendingSelectKey: (pendingSelectKey) => {
    clearTimeout(pendingTimer);
    set({ pendingSelectKey });
    if (pendingSelectKey !== null) {
      pendingTimer = setTimeout(
        () => set({ pendingSelectKey: null }),
        PENDING_SELECT_MS,
      );
    }
  },
}));
