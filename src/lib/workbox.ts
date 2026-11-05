import type { MachineView } from "./bindings/MachineView";
import { formatAge } from "./format";

/** The core's states for a saved machine, in the words the Workbox screen shows. */
const STATE_WORDS: Record<string, string> = {
  connected: "Connected",
  connecting: "Connecting",
  needs_login: "Needs login",
  needs_update: "Needs an hc update",
  unreachable: "Unreachable",
};

/**
 * "Unreachable · cannot reach buildbox · since 3m": the core's word for the machine, its `why`
 * (only an unreachable machine has one) and when it entered the state. `null` for this computer,
 * whose health follows the event connection, and for a machine with no state yet. A state a
 * newer core invented is shown as it came. Ages the core does not give are left out.
 */
export function stateLine(machine: MachineView, nowMs: number): string | null {
  if (machine.is_local || machine.state === null) return null;
  const parts = [STATE_WORDS[machine.state] ?? machine.state];
  if (
    machine.state === "unreachable" &&
    (machine.health.kind === "attention" ||
      machine.health.kind === "reconnecting") &&
    machine.health.error.trim() !== ""
  ) {
    parts.push(machine.health.error.trim());
  }
  const age = formatAge(machine.state_since_ms, nowMs);
  if (age !== null)
    parts.push(age === "now" ? "since just now" : `since ${age}`);
  return parts.join(" · ");
}

/** Whether the machine waits for the person to log in (Log in… runs `hc machine login`). */
export function needsLogin(machine: MachineView): boolean {
  return !machine.is_local && machine.state === "needs_login";
}

/**
 * Whether Update hc there… is offered: the core says the machine needs an update, or the hc
 * there is not the one running here (`coreVersion`, this computer's).
 */
export function updateOffered(
  machine: MachineView,
  coreVersion: string | null,
): boolean {
  if (machine.is_local) return false;
  if (machine.state === "needs_update") return true;
  const there = machine.hc_version?.trim();
  const here = coreVersion?.trim();
  return !!there && !!here && there !== here;
}

/** The machines the person has not hidden: what the sidebar and the lists show. */
export function shownMachines(machines: MachineView[]): MachineView[] {
  return machines.filter((m) => m.health.kind !== "hidden");
}
