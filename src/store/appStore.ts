import { useEffect } from "react";
import { create } from "zustand";
import type { AppState } from "../lib/bindings/AppState";
import type { PreviewFrame } from "../lib/bindings/PreviewFrame";
import type { Settings } from "../lib/bindings/Settings";
import { actionErrorMessage } from "../lib/format";
import { toActionError } from "../lib/ipc";

export type GroupBy = "project" | "workbox" | "status";
export type Sheet = null | "new-session" | "add-workbox";
/** What a "+ Session" button already knows: the project's workbox and folder. */
export type SheetPrefill = { machineId?: string; folder?: string };
/** A just-created pane to open in the terminal once the state lists it. */
export type PendingOpen = { key: string; machineId: string; paneId: string };
export type ToastTone = "info" | "error";
export type View = { kind: "home" } | { kind: "workbox"; machineId: string };

const TOAST_MS = 8000;
const PENDING_MS = 10_000;
const PENDING_OPEN_TIMEOUT =
  "The new session hasn't appeared yet; open it from the list when it does.";
let toastTimer: ReturnType<typeof setTimeout> | undefined;
let pendingTimer: ReturnType<typeof setTimeout> | undefined;

type AppStore = {
  state: AppState | null;
  /** The saved settings; `null` until they have been read (screens then use the defaults). */
  settings: Settings | null;
  /** A row key, `${machineId}::${paneId}`. */
  selectedKey: string | null;
  groupBy: GroupBy;
  sheet: Sheet;
  /** Set together with the sheet by `openNewSession`; cleared when the sheet closes. */
  sheetPrefill: SheetPrefill | null;
  view: View;
  activityOpen: boolean;
  /** The ⌘K command palette is showing. */
  paletteOpen: boolean;
  /**
   * The herdr version whose "older than supported" banner was dismissed (`""` for an unreadable
   * one). Kept here so it survives going between Home and a Workbox screen.
   */
  dismissedVersion: string | null;
  /** The message shown in the toast, if any: an error unless `toastTone` says otherwise. */
  toast: string | null;
  toastTone: ToastTone;
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
  setSettings: (settings: Settings) => void;
  /** A notification was clicked: show Home with that row selected. */
  focusRow: (key: string) => void;
  select: (key: string | null) => void;
  setGroupBy: (groupBy: GroupBy) => void;
  setSheet: (sheet: Sheet) => void;
  openNewSession: (prefill?: SheetPrefill) => void;
  setView: (view: View) => void;
  setActivityOpen: (open: boolean) => void;
  setPaletteOpen: (open: boolean) => void;
  dismissVersionBanner: (version: string) => void;
  /** Shows an action error. Every report restarts the auto-dismiss timer. */
  reportError: (e: unknown) => void;
  /** Shows a message in the toast; the tone defaults to `"error"`. Restarts the timer. */
  showToast: (message: string, tone?: ToastTone) => void;
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
  settings: null,
  selectedKey: null,
  groupBy: "project",
  sheet: null,
  sheetPrefill: null,
  view: { kind: "home" },
  activityOpen: false,
  paletteOpen: false,
  dismissedVersion: null,
  toast: null,
  toastTone: "error",
  preview: null,
  dialogOpen: 0,
  pendingSelectKey: null,
  pendingOpen: null,
  setState: (state) => set({ state }),
  setSettings: (settings) => set({ settings }),
  focusRow: (selectedKey) => set({ selectedKey, view: { kind: "home" } }),
  select: (selectedKey) => set({ selectedKey }),
  setGroupBy: (groupBy) => set({ groupBy }),
  setSheet: (sheet) => set({ sheet, sheetPrefill: null }),
  openNewSession: (prefill) =>
    set({ sheet: "new-session", sheetPrefill: prefill ?? null }),
  setView: (view) => set({ view }),
  setActivityOpen: (activityOpen) => set({ activityOpen }),
  setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
  dismissVersionBanner: (dismissedVersion) => set({ dismissedVersion }),
  reportError: (e) => {
    get().showToast(actionErrorMessage(toActionError(e)), "error");
  },
  showToast: (toast, toastTone = "error") => {
    clearTimeout(toastTimer);
    set({ toast, toastTone });
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
