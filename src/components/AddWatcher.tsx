import { useEffect } from "react";
import { invokeTyped } from "../lib/ipc";
import { showHomeView } from "../lib/uiHelpers";
import { useAppStore } from "../store/appStore";
import { HOME, useTerminalStore } from "../terminal/terminalStore";

/** The longest a person is given to answer a password, a code or a host key. */
const GIVE_UP_MS = 10 * 60_000;
const TIMEOUT_MESSAGE =
  "Didn’t see the new workbox yet. Finish adding it in the terminal, then check the sidebar.";

/**
 * Waits for the workbox an add is after to show up in the machine list, for up to 10 minutes.
 * It looks at every `"state"` push; the sync reads the machine list on its own every 10 s, and
 * the watcher asks for one more read when the add's terminal tab ends (it never polls). Then it
 * says "Added …" and, when the add's tab or Home is what the person is looking at, opens the new
 * workbox's screen; anywhere else (another tab, typing) it only shows the toast. It leaves the
 * add's tab alone, so hc's last output stays readable. Mounted once by `App`: it has to outlive
 * the Add workbox sheet, which closes so that the terminal tab it opened is not hidden behind
 * it. Closing the add's tab ends the wait.
 */
export function AddWatcher() {
  const pending = useAppStore((s) => s.pendingAdd);
  const machines = useAppStore((s) => s.state?.machines);
  const tabId = pending?.tabMachineId ?? null;
  const tabOpen = useTerminalStore((s) =>
    tabId ? s.tabs.some((t) => t.target.machineId === tabId) : true,
  );
  const tabEnded = useTerminalStore((s) =>
    tabId
      ? s.tabs.some(
          (t) =>
            t.target.machineId === tabId &&
            (t.state === "detached" || t.state === "error"),
        )
      : false,
  );

  useEffect(() => {
    if (!pending) return;
    const giveUp = window.setTimeout(() => {
      const { setPendingAdd, reportError } = useAppStore.getState();
      setPendingAdd(null);
      reportError({ kind: "invalid", message: TIMEOUT_MESSAGE });
    }, GIVE_UP_MS);
    return () => window.clearTimeout(giveUp);
  }, [pending]);

  // hc has finished in the add's tab: the machine is saved by now, so read the list once.
  useEffect(() => {
    if (!pending || !tabEnded) return;
    // A failed read shows up in the next one; there is nothing to tell the person.
    invokeTyped("refresh_now", {}).catch(() => {});
  }, [pending, tabEnded]);

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
    showToast(`Added ${added.name}`, "info");
    // Pull the person to the new workbox only from where they were waiting for it.
    const { tabs, activeKey } = useTerminalStore.getState();
    const active = tabs.find((t) => t.tabKey === activeKey);
    const here =
      activeKey === HOME ||
      (active !== undefined &&
        pending.tabMachineId !== null &&
        active.target.machineId === pending.tabMachineId);
    if (here) showHomeView({ kind: "workbox", machineId: added.id });
  }, [pending, machines]);

  return null;
}
