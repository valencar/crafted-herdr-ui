import { invokeTyped } from "../lib/ipc";
import { useAppStore } from "../store/appStore";
import { commandTabKey, useTerminalStore, type TermTab } from "./terminalStore";

/** The core commands a workbox screen runs in a tab. */
export type MachineVerb = "login" | "update";

/** A command tab's words: the short title for the strip, and what the context bar says. */
export function commandWords(tab: Pick<TermTab, "target" | "machineLabel">): {
  title: string;
  doing: string;
} {
  const args = tab.target.kind === "command" ? tab.target.args : [];
  switch (args[1]) {
    case "login":
      return { title: "Log in", doing: `Logging in to ${tab.machineLabel}` };
    case "update":
      return {
        title: "Update hc",
        doing: `Updating hc on ${tab.machineLabel}`,
      };
    default:
      return {
        title: args.slice(0, 2).join(" ") || "Command",
        doing: `Running a command on ${tab.machineLabel}`,
      };
  }
}

/**
 * Opens `machine login <name>` or `machine update <name>` in an in-app tab. Rust builds the
 * arguments (the machine's current name, checked), and checks them again when the tab starts.
 * A tab of the same command that has already ended is run again in place (`rerunTab`);
 * one still running is shown. For `update`, the caller has asked the person first.
 */
export async function openMachineCommand(
  machine: { id: string; name: string },
  verb: MachineVerb,
): Promise<void> {
  try {
    // Spelled out, so the capability test can see which commands this window calls.
    const args =
      verb === "login"
        ? await invokeTyped("machine_login_args", { machineId: machine.id })
        : await invokeTyped("machine_update_args", { machineId: machine.id });
    const target = {
      kind: "command" as const,
      machineId: machine.id,
      args,
    };
    const tabKey = commandTabKey(machine.id, args);
    const store = useTerminalStore.getState();
    const next = {
      target,
      machineLabel: machine.name,
      title: commandWords({ target, machineLabel: machine.name }).title,
    };
    const old = store.tabs.find((t) => t.tabKey === tabKey);
    if (old && (old.state === "detached" || old.state === "error")) {
      // The same tab starts over with a new session. (Closing it and opening the key again in
      // one go would batch into no change: the view is keyed by the tab key and would stay.)
      store.rerunTab(tabKey, next);
    } else {
      store.openTab({ tabKey, ...next });
    }
  } catch (e) {
    useAppStore.getState().reportError(e);
  }
}
