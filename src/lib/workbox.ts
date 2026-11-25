import type { MachineView } from "./bindings/MachineView";
import { formatAge, isOlderVersion } from "./format";

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
 * there is numerically older than the one running here (`coreVersion`, this computer's).
 * `hc machine update` copies this computer's hc there, so a newer one there is never offered
 * it: that would be a downgrade called Update.
 */
export function updateOffered(
  machine: MachineView,
  coreVersion: string | null,
): boolean {
  if (machine.is_local) return false;
  if (machine.state === "needs_update") return true;
  return isOlderVersion(machine.hc_version, coreVersion);
}

/**
 * What the Update hc there… confirm says: both versions when both are known, so the person sees
 * what replaces what; the one copied when the machine's is unknown; else the plain sentence.
 */
export function updateBody(
  machine: MachineView,
  coreVersion: string | null,
): string {
  const there = machine.hc_version?.trim();
  const here = coreVersion?.trim();
  const after = "and restarts its core. Its terminals keep running.";
  if (there && here) {
    return `Replaces hc ${there} on ${machine.name} with ${here} from this computer ${after}`;
  }
  if (here) {
    return `Copies hc ${here} from this computer to ${machine.name} ${after}`;
  }
  return `Copies this hc there ${after}`;
}

/** The machines the person has not hidden: what the sidebar and the lists show. */
export function shownMachines(machines: MachineView[]): MachineView[] {
  return machines.filter((m) => m.health.kind !== "hidden");
}

/**
 * Whether the workbox's programs end when the last SSH login there closes: only a remote core
 * that says so (`keeps_running_after_logout` is `false`). `null` (unknown, not Linux or systemd,
 * an older core) and a missing field warn about nothing. It changes neither the workbox's state
 * nor its attention.
 */
export function stopsAtLogout(m: MachineView): boolean {
  return !m.is_local && m.keeps_running_after_logout === false;
}

/** A login name that is safe to paste into a shell as it is. */
const SAFE_USER = /^[A-Za-z0-9._-]+$/;

/**
 * The command that keeps the person's programs running after logout, for them to copy and run on
 * the workbox. The app never runs it. A user that is absent or not a plain login name counts as
 * unknown, so the copied line is never odd shell text and `$USER` stands in.
 */
export function lingerCommand(m: MachineView): string {
  const user = m.logout_linger_user;
  const who = user !== null && SAFE_USER.test(user) ? user : "$USER";
  return `sudo loginctl enable-linger -- ${who}`;
}
