import { useAppStore } from "../store/appStore";
import type { MachineView } from "./bindings/MachineView";
import type { WorkboxColor } from "./bindings/WorkboxColor";

/** The palette, in auto-pick order. */
export const WORKBOX_COLORS: readonly WorkboxColor[] = [
  "violet",
  "pink",
  "lime",
  "cyan",
  "yellow",
  "magenta",
  "leaf",
  "purple",
];

/** A saved map, where any machine id may be missing. */
export type SavedColors = Partial<Record<string, WorkboxColor>>;

/**
 * Own-key check (`Object.hasOwn` needs ES2022; the tsconfig lib is ES2020). A machine id is
 * user data, so `constructor`, `toString` and `__proto__` are ordinary keys, never inherited ones.
 */
export function hasOwn(map: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(map, key);
}

/**
 * `saved` plus one new entry per id without one. The local machine is assigned first, then the
 * rest in the given order. A new id gets the first palette color no listed id uses; once all are
 * used, the least-used one (ties go to palette order). Only listed ids count as using a color.
 * Entries for ids that are not listed are kept, so removing a workbox never recolors another.
 * The result has no prototype, so every id (even `__proto__`) is a plain key.
 */
export function assignColors(
  machineIds: string[],
  saved: SavedColors,
): Record<string, WorkboxColor> {
  const result: Record<string, WorkboxColor> = Object.create(null);
  const uses = new Map<WorkboxColor, number>(WORKBOX_COLORS.map((c) => [c, 0]));
  const listed = new Set(machineIds);
  for (const [id, color] of Object.entries(saved)) {
    if (color === undefined) continue;
    result[id] = color;
    // An entry for a workbox that is gone is kept but does not use up its color.
    if (listed.has(id)) uses.set(color, (uses.get(color) ?? 0) + 1);
  }
  const ordered = machineIds.includes("local")
    ? ["local", ...machineIds.filter((id) => id !== "local")]
    : machineIds;
  for (const id of ordered) {
    if (hasOwn(result, id)) continue;
    let pick = WORKBOX_COLORS[0];
    let fewest = uses.get(pick) ?? 0;
    for (const color of WORKBOX_COLORS) {
      const n = uses.get(color) ?? 0;
      if (n < fewest) {
        pick = color;
        fewest = n;
      }
    }
    result[id] = pick;
    uses.set(pick, fewest + 1);
  }
  return result;
}

// One memo for every caller: many tiles ask, but the map is built once per change of the saved
// map or the machine list (compared by reference, as the store hands them out).
let memo: {
  saved: SavedColors;
  machines: MachineView[];
  resolved: Record<string, WorkboxColor>;
} | null = null;

/** The saved colors with the missing ones auto-picked; memoized on both references. */
export function resolveColors(
  saved: SavedColors,
  machines: MachineView[],
): Record<string, WorkboxColor> {
  if (memo && memo.saved === saved && memo.machines === machines) {
    return memo.resolved;
  }
  const resolved = assignColors(
    machines.map((m) => m.id),
    saved,
  );
  memo = { saved, machines, resolved };
  return resolved;
}

const NO_MACHINES: MachineView[] = [];

/**
 * The resolved map, or `null` while settings have not arrived (nothing is guessed before then,
 * so a tile never shows one color and then another).
 */
export function useResolvedColors(): Record<string, WorkboxColor> | null {
  const saved = useAppStore(
    (s): SavedColors | undefined => s.settings?.workbox_colors,
  );
  const machines = useAppStore((s) => s.state?.machines) ?? NO_MACHINES;
  return saved === undefined ? null : resolveColors(saved, machines);
}

/** The color of one workbox, or `"none"` (neutral) for no id, an unlisted id or unloaded settings. */
export function useWorkboxColor(
  machineId: string | null,
): WorkboxColor | "none" {
  const resolved = useResolvedColors();
  const machines = useAppStore((s) => s.state?.machines);
  if (machineId === null || resolved === null) return "none";
  if (!machines?.some((m) => m.id === machineId)) return "none";
  return hasOwn(resolved, machineId) ? resolved[machineId] : "none";
}
