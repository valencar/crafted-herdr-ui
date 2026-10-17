import { useEffect } from "react";
import { create } from "zustand";
import type { AppState } from "../lib/bindings/AppState";
import type { PreviewFrame } from "../lib/bindings/PreviewFrame";
import { actionErrorMessage } from "../lib/format";
import { toActionError } from "../lib/ipc";

export type GroupBy = "project" | "workbox" | "status";
export type Sheet = null | "new-session" | "add-workbox";
/** What a "+ Session" button already knows: the project's workbox and folder. */
export type SheetPrefill = { machineId?: string; folder?: string };
/** A just-created pane to open in the terminal once the state lists it. */
export type PendingOpen = { key: string; machineId: string; paneId: string };
export type View = { kind: "home" } | { kind: "workbox"; machineId: string };

const TOAST_MS = 8000;
const PENDING_MS = 10_000;
const PENDING_OPEN_TIMEOUT =
  "The new session hasn't appeared yet; open it from the list when it does.";
let toastTimer: ReturnType<typeof setTimeout> | undefined;
let pendingTimer: ReturnType<typeof setTimeout> | undefined;

type AppStore = {
  state: AppState | null;
  /** A row key, `${machineId}::${paneId}`. */
  selectedKey: string | null;
  groupBy: GroupBy;
  sheet: Sheet;
  /** Set together with the sheet by `openNewSession`; cleared when the sheet closes. */
  sheetPrefill: SheetPrefill | null;
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
  /**
   * A pane to open in the terminal once its row shows up. Shares the 10 s window of
   * `pendingSelectKey`; if the row never shows up, the user gets an error toast.
   */
  pendingOpen: PendingOpen | null;
  /** The latest live-preview frame for the selected row. */
  preview: PreviewFrame | null;
  setState: (state: AppState) => void;
  select: (key: string | null) => void;
  setGroupBy: (groupBy: GroupBy) => void;
  setSheet: (sheet: Sheet) => void;
  openNewSession: (prefill?: SheetPrefill) => void;
  setView: (view: View) => void;
  setActivityOpen: (open: boolean) => void;
  /** Shows an action error. Every report restarts the auto-dismiss timer. */
  reportError: (e: unknown) => void;
  clearToast: () => void;
  setPreview: (frame: PreviewFrame | null) => void;
  openDialog: () => void;
  closeDialog: () => void;
  setPendingSelectKey: (key: string | null) => void;
  setPendingOpen: (open: PendingOpen | null) => void;
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

type Get = () => AppStore;
type Set = (partial: Partial<AppStore>) => void;

/** (Re)starts the shared window: when it ends, whatever is still pending is dropped. */
function armPending(get: Get, set: Set) {
  clearTimeout(pendingTimer);
  pendingTimer = setTimeout(() => {
    const unopened = get().pendingOpen !== null;
    set({ pendingSelectKey: null, pendingOpen: null });
    if (unopened) {
      get().reportError({ kind: "invalid", message: PENDING_OPEN_TIMEOUT });
    }
  }, PENDING_MS);
}

/** Stops the window once nothing is pending any more. */
function settlePending(get: Get) {
  if (get().pendingSelectKey === null && get().pendingOpen === null) {
    clearTimeout(pendingTimer);
  }
}

export const useAppStore = create<AppStore>((set, get) => ({
  state: null,
  selectedKey: null,
  groupBy: "project",
  sheet: null,
  sheetPrefill: null,
  view: { kind: "home" },
  activityOpen: false,
  toast: null,
  preview: null,
  dialogOpen: 0,
  pendingSelectKey: null,
  pendingOpen: null,
  setState: (state) => set({ state }),
  select: (selectedKey) => set({ selectedKey }),
  setGroupBy: (groupBy) => set({ groupBy }),
  setSheet: (sheet) => set({ sheet, sheetPrefill: null }),
  openNewSession: (prefill) =>
    set({ sheet: "new-session", sheetPrefill: prefill ?? null }),
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
    set({ pendingSelectKey });
    if (pendingSelectKey !== null) armPending(get, set);
    else settlePending(get);
  },
  setPendingOpen: (pendingOpen) => {
    set({ pendingOpen });
    if (pendingOpen !== null) armPending(get, set);
    else settlePending(get);
  },
}));
