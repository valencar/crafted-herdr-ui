import { useEffect } from "react";
import { invokeTyped } from "../lib/ipc";
import { showHomeView } from "../lib/uiHelpers";
import { useAppStore } from "../store/appStore";
import { useTerminalStore } from "../terminal/terminalStore";

/** How often a fresh machine list is asked for while an add is pending. */
const POLL_MS = 3000;
/** The longest a person is given to answer a password, a code or a host key. */
const GIVE_UP_MS = 10 * 60_000;
const TIMEOUT_MESSAGE =
  "Didn’t see the new workbox yet. Finish adding it in the terminal, then check the sidebar.";

/**
 * Waits for the workbox an add is after to show up in the machine list, for up to 10 minutes,
 * on every state push (and a fresh read every 3 s, since the list is polled slowly). Then it says
 * "Added …", opens the new workbox's screen and closes the add's terminal tab. Mounted once by
 * `App`: it has to outlive the Add workbox sheet, which closes so that the terminal tab it opened
 * is not hidden behind it. Closing the add's tab ends the wait.
 */
export function AddWatcher() {
  const pending = useAppStore((s) => s.pendingAdd);
  const machines = useAppStore((s) => s.state?.machines);
  const tabOpen = useTerminalStore((s) =>
    pending?.tabMachineId
      ? s.tabs.some((t) => t.target.machineId === pending.tabMachineId)
      : true,
  );

  useEffect(() => {
    if (!pending) return;
    const poll = window.setInterval(() => {
      // A failed read shows up in the next one; there is nothing to tell the person.
      invokeTyped("refresh_now", {}).catch(() => {});
    }, POLL_MS);
    const giveUp = window.setTimeout(() => {
      const { setPendingAdd, reportError } = useAppStore.getState();
      setPendingAdd(null);
      reportError({ kind: "invalid", message: TIMEOUT_MESSAGE });
    }, GIVE_UP_MS);
    return () => {
      window.clearInterval(poll);
      window.clearTimeout(giveUp);
    };
  }, [pending]);

  // The terminal was closed before the machine showed up: the person has stopped.
  useEffect(() => {
    if (pending && !tabOpen) useAppStore.getState().setPendingAdd(null);
  }, [pending, tabOpen]);

  // The new machine showed up in the state: done.
  useEffect(() => {
    if (!pending || !machines) return;
    const added = machines.find((m) =>
      pending.id !== null
        ? m.id === pending.id
        : m.target === pending.target && !pending.knownIds.includes(m.id),
    );
    if (!added) return;
    const { setPendingAdd, showToast } = useAppStore.getState();
    setPendingAdd(null);
    const terminals = useTerminalStore.getState();
    for (const tab of terminals.tabs) {
      if (tab.target.machineId === pending.tabMachineId) {
        terminals.closeTab(tab.tabKey);
      }
    }
    showToast(`Added ${added.name}`, "info");
    showHomeView({ kind: "workbox", machineId: added.id });
  }, [pending, machines]);

  return null;
}
