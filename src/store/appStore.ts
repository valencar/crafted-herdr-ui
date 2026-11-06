import { useEffect } from "react";
import { create } from "zustand";
import type { AppState } from "../lib/bindings/AppState";
import type { OpenTarget } from "../lib/bindings/OpenTarget";
import type { PreviewFrame } from "../lib/bindings/PreviewFrame";
import type { Settings } from "../lib/bindings/Settings";
import { actionErrorMessage } from "../lib/format";
import type { Row } from "../lib/grouping";
import { toActionError } from "../lib/ipc";

export type GroupBy = "project" | "workbox" | "status" | "space";
export type Sheet = null | "new-session" | "add-workbox";
/** What a "+ Session" button already knows: the project's workbox and folder. */
export type SheetPrefill = { machineId?: string; folder?: string };
/**
 * A just-created terminal to open once the state lists it. `how` says where; without it the
 * "Open sessions" setting does (the New session sheet's way).
 */
export type PendingOpen = {
  key: string;
  machineId: string;
  address: string;
  how?: OpenTarget;
  /** Set by `addPendingOpen`, rising with each add: the order the sessions were created in. */
  seq?: number;
};
/**
 * An add the app is waiting to see in the machine list: either it knows the new machine's `id`
 * (the core said so), or it knows the `target` the machine will have (a terminal is adding it)
 * and that it is none of `knownIds`. `tabMachineId` is the pseudo-machine of the in-app tab
 * that does the adding, if there is one. `awaited`: a direct add that finished while its sheet
 * was still open, so the person is waiting for it wherever the active tab is (Ruling C78).
 */
export type PendingAdd = {
  id: string | null;
  target: string;
  knownIds: string[];
  tabMachineId: string | null;
  awaited: boolean;
};
export type ToastTone = "info" | "error";
/** What the Home tab shows: the Dashboard, the All agents list, or one workbox's screen. */
export type View =
  | { kind: "dashboard" }
  | { kind: "all" }
  | { kind: "workbox"; machineId: string };

const TOAST_MS = 8000;
const PENDING_MS = 10_000;
const PENDING_OPEN_TIMEOUT =
  "The new session hasn't appeared yet; open it from the list when it does.";
let toastTimer: ReturnType<typeof setTimeout> | undefined;
/** The selection's window. */
let pendingSelectTimer: ReturnType<typeof setTimeout> | undefined;
/** Rises with each pending open added: the order the sessions were created in. */
let pendingOpenSeq = 0;
/** One window per pending open, by key: each expires on its own, 10 s after it was added. */
const pendingOpenTimers = new Map<string, ReturnType<typeof setTimeout>>();

type AppStore = {
  state: AppState | null;
  /** The saved settings; `null` until they have been read (screens then use the defaults). */
  settings: Settings | null;
  /** A row key, `${machineId}::${address}`. */
  selectedKey: string | null;
  groupBy: GroupBy;
  /** What the header's search box holds. Home filters its list by it; the box is the app's. */
  query: string;
  sheet: Sheet;
  /** Set together with the sheet by `openNewSession`; cleared when the sheet closes. */
  sheetPrefill: SheetPrefill | null;
  view: View;
  activityOpen: boolean;
  /** The ⌘K command palette is showing. */
  paletteOpen: boolean;
  /** The ⌘/ keyboard shortcuts sheet is showing. */
  shortcutsOpen: boolean;
  /**
   * A terminal the user asked to close from somewhere that unmounts as it asks (the palette). `App`
   * renders the confirmation for it (`ClosePaneHost`), so the dialog outlives the asker.
   */
  closeRow: Row | null;
  /** The workbox whose "Clear ended" was asked for from the palette; `App` confirms it the same way. */
  clearEndedId: string | null;
  /** Where focus goes when that confirmation ends: the control the asker was opened from. */
  closeReturn: HTMLElement | null;
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
  /**
   * Created terminals to open once the state lists them, in the order they were added: several
   * can wait at once (⌘T pressed twice), and each opens when its own row is listed.
   */
  pendingOpens: PendingOpen[];
  /** The latest live-preview frame for the selected row. */
  preview: PreviewFrame | null;
  /** The add `AddWatcher` is waiting for; it outlives the Add workbox sheet. */
  pendingAdd: PendingAdd | null;
  setState: (state: AppState) => void;
  setSettings: (settings: Settings) => void;
  /** A notification was clicked: show All agents with that row selected. */
  focusRow: (key: string) => void;
  select: (key: string | null) => void;
  setGroupBy: (groupBy: GroupBy) => void;
  setQuery: (query: string) => void;
  setSheet: (sheet: Sheet) => void;
  openNewSession: (prefill?: SheetPrefill) => void;
  setView: (view: View) => void;
  setActivityOpen: (open: boolean) => void;
  setPaletteOpen: (open: boolean) => void;
  setShortcutsOpen: (open: boolean) => void;
  setCloseRow: (row: Row | null, returnTo?: HTMLElement | null) => void;
  setClearEnded: (
    machineId: string | null,
    returnTo?: HTMLElement | null,
  ) => void;
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
  /** Adds one (a second entry for the same key replaces the first) and starts its 10 s window. */
  addPendingOpen: (open: Omit<PendingOpen, "seq">) => void;
  removePendingOpen: (key: string) => void;
  clearPendingOpens: () => void;
  setPendingAdd: (add: PendingAdd | null) => void;
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

/** (Re)starts the selection's window: when it ends, the selection is dropped. */
function armSelect(set: Set) {
  clearTimeout(pendingSelectTimer);
  pendingSelectTimer = setTimeout(() => {
    set({ pendingSelectKey: null });
  }, PENDING_MS);
}

/** Starts one pending open's window: if it is still waiting when it ends, it is dropped and reported. */
function armOpen(key: string, get: Get, set: Set) {
  clearTimeout(pendingOpenTimers.get(key));
  pendingOpenTimers.set(
    key,
    setTimeout(() => {
      pendingOpenTimers.delete(key);
      if (!get().pendingOpens.some((p) => p.key === key)) return;
      set({ pendingOpens: get().pendingOpens.filter((p) => p.key !== key) });
      get().reportError({ kind: "invalid", message: PENDING_OPEN_TIMEOUT });
    }, PENDING_MS),
  );
}

export const useAppStore = create<AppStore>((set, get) => ({
  state: null,
  settings: null,
  selectedKey: null,
  groupBy: "project",
  query: "",
  sheet: null,
  sheetPrefill: null,
  view: { kind: "dashboard" },
  activityOpen: false,
  paletteOpen: false,
  shortcutsOpen: false,
  closeRow: null,
  clearEndedId: null,
  closeReturn: null,
  dismissedVersion: null,
  toast: null,
  toastTone: "error",
  preview: null,
  dialogOpen: 0,
  pendingSelectKey: null,
  pendingOpens: [],
  pendingAdd: null,
  setState: (state) => set({ state }),
  setSettings: (settings) => set({ settings }),
  // The saved search goes too: a row it filters out would be selected but not on the page.
  focusRow: (selectedKey) =>
    set({ selectedKey, view: { kind: "all" }, query: "" }),
  select: (selectedKey) => set({ selectedKey }),
  setGroupBy: (groupBy) => set({ groupBy }),
  setQuery: (query) => set({ query }),
  setSheet: (sheet) => set({ sheet, sheetPrefill: null }),
  openNewSession: (prefill) =>
    set({ sheet: "new-session", sheetPrefill: prefill ?? null }),
  setView: (view) => set({ view }),
  setActivityOpen: (activityOpen) => set({ activityOpen }),
  setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
  setShortcutsOpen: (shortcutsOpen) => set({ shortcutsOpen }),
  setCloseRow: (closeRow, returnTo = null) =>
    set({ closeRow, closeReturn: closeRow ? returnTo : null }),
  setClearEnded: (clearEndedId, returnTo = null) =>
    set({ clearEndedId, closeReturn: clearEndedId ? returnTo : null }),
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
    if (pendingSelectKey !== null) armSelect(set);
    else clearTimeout(pendingSelectTimer);
  },
  addPendingOpen: (open) => {
    set({
      pendingOpens: [
        ...get().pendingOpens.filter((p) => p.key !== open.key),
        { ...open, seq: ++pendingOpenSeq },
      ],
    });
    armOpen(open.key, get, set);
  },
  removePendingOpen: (key) => {
    clearTimeout(pendingOpenTimers.get(key));
    pendingOpenTimers.delete(key);
    set({ pendingOpens: get().pendingOpens.filter((p) => p.key !== key) });
  },
  clearPendingOpens: () => {
    for (const t of pendingOpenTimers.values()) clearTimeout(t);
    pendingOpenTimers.clear();
    set({ pendingOpens: [] });
  },
  setPendingAdd: (pendingAdd) => set({ pendingAdd }),
}));
