import { create } from "zustand";
import type { AppState } from "../lib/bindings/AppState";
import type { PreviewFrame } from "../lib/bindings/PreviewFrame";
import { actionErrorMessage } from "../lib/format";
import { toActionError } from "../lib/ipc";

export type GroupBy = "project" | "workbox" | "status";
export type Sheet = null | "new-session" | "add-workbox";
export type View = { kind: "home" } | { kind: "workbox"; machineId: string };

const TOAST_MS = 8000;
let toastTimer: ReturnType<typeof setTimeout> | undefined;

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
};

export const useAppStore = create<AppStore>((set, get) => ({
  state: null,
  selectedKey: null,
  groupBy: "project",
  sheet: null,
  view: { kind: "home" },
  activityOpen: false,
  toast: null,
  preview: null,
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
}));
