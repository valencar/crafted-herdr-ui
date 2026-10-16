import { create } from "zustand";
import type { AppState } from "../lib/bindings/AppState";

export type GroupBy = "project" | "workbox" | "status";
export type Sheet = null | "new-session" | "add-workbox";
export type View = { kind: "home" } | { kind: "workbox"; machineId: string };

type AppStore = {
  state: AppState | null;
  /** A row key, `${machineId}::${paneId}`. */
  selectedKey: string | null;
  groupBy: GroupBy;
  sheet: Sheet;
  view: View;
  activityOpen: boolean;
  setState: (state: AppState) => void;
  select: (key: string | null) => void;
  setGroupBy: (groupBy: GroupBy) => void;
  setSheet: (sheet: Sheet) => void;
  setView: (view: View) => void;
  setActivityOpen: (open: boolean) => void;
};

export const useAppStore = create<AppStore>((set) => ({
  state: null,
  selectedKey: null,
  groupBy: "project",
  sheet: null,
  view: { kind: "home" },
  activityOpen: false,
  setState: (state) => set({ state }),
  select: (selectedKey) => set({ selectedKey }),
  setGroupBy: (groupBy) => set({ groupBy }),
  setSheet: (sheet) => set({ sheet }),
  setView: (view) => set({ view }),
  setActivityOpen: (activityOpen) => set({ activityOpen }),
}));
