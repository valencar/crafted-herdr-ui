import { HOME, useTerminalStore } from "./terminalStore";

/**
 * Whether the Home tab is the one showing. The home screen stays mounted (hidden) under a
 * terminal tab, so anything on it that polls herdr must pause while this is false.
 */
export function useHomeVisible(): boolean {
  return useTerminalStore((s) => s.activeKey === HOME);
}
