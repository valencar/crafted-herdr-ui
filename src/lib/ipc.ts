import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { AppState } from "./bindings/AppState";
import type { ActionError } from "./bindings/ActionError";
import type { CommandLogEntry } from "./bindings/CommandLogEntry";
import type { CreatedSession } from "./bindings/CreatedSession";
import type { MachineStatusEntry } from "./bindings/MachineStatusEntry";
import type { NewSessionRequest } from "./bindings/NewSessionRequest";
import type { PreviewFrame } from "./bindings/PreviewFrame";
import type { TerminalList } from "./bindings/TerminalList";

/** Every Tauri command the UI may call, mapped to its result. A Rust `()` arrives as `null`. */
export type CommandResults = {
  get_state: AppState;
  create_session: CreatedSession;
  preview_new_session: string[];
  rename_session: null;
  close_pane: null;
  create_tab: CreatedSession;
  rename_tab: null;
  close_tab: null;
  create_workspace: CreatedSession;
  rename_workspace: null;
  close_workspace: null;
  reply_to_agent: null;
  mark_seen: null;
  machine_rename: null;
  machine_set_enabled: null;
  machine_remove: null;
  machine_status: MachineStatusEntry[];
  refresh_now: null;
  get_command_log: CommandLogEntry[];
  list_agent_kinds: string[];
  open_session: null;
  open_full_herdr: null;
  list_terminals: TerminalList;
  copy_attach_command: string;
  start_preview: null;
  stop_preview: null;
};
export type CommandName = keyof CommandResults;

/** The arguments of each command. Keys are camelCase, which is what Tauri expects. */
export type CommandArgs = {
  get_state: undefined;
  create_session: { req: NewSessionRequest };
  preview_new_session: { req: NewSessionRequest };
  rename_session: {
    machineId: string;
    paneId: string;
    isAgent: boolean;
    name: string;
  };
  close_pane: { machineId: string; paneId: string };
  create_tab: { machineId: string; workspaceId: string; label: string };
  rename_tab: { machineId: string; tabId: string; label: string };
  close_tab: { machineId: string; tabId: string };
  create_workspace: { machineId: string; cwd: string; label: string };
  rename_workspace: { machineId: string; workspaceId: string; label: string };
  close_workspace: { machineId: string; workspaceId: string };
  reply_to_agent: { machineId: string; paneId: string; text: string };
  mark_seen: { machineId: string; paneId: string };
  machine_rename: { id: string; label: string };
  machine_set_enabled: { id: string; enabled: boolean };
  machine_remove: { id: string };
  machine_status: { id: string };
  refresh_now: { machineId?: string | null };
  get_command_log: undefined;
  list_agent_kinds: undefined;
  open_session: { machineId: string; paneId: string };
  open_full_herdr: { machineId: string };
  list_terminals: undefined;
  copy_attach_command: { machineId: string; paneId: string };
  start_preview: { machineId: string; paneId: string; isAgent: boolean };
  stop_preview: undefined;
};

const ACTION_ERROR_KINDS: ReadonlySet<string> = new Set([
  "herdr",
  "maybeApplied",
  "invalid",
]);

/**
 * Rust errors arrive as the serialized `ActionError`. Anything else (a string, an `Error`,
 * an unknown shape) becomes `{kind: "invalid", message}`, so callers only ever handle an
 * `ActionError`.
 */
export function toActionError(e: unknown): ActionError {
  if (
    typeof e === "object" &&
    e !== null &&
    typeof (e as { kind?: unknown }).kind === "string" &&
    ACTION_ERROR_KINDS.has((e as { kind: string }).kind)
  ) {
    return e as ActionError;
  }
  if (e instanceof Error) return { kind: "invalid", message: e.message };
  return {
    kind: "invalid",
    message: typeof e === "string" ? e : (JSON.stringify(e) ?? String(e)),
  };
}

type ArgsParam<K extends CommandName> = CommandArgs[K] extends undefined
  ? []
  : [args: CommandArgs[K]];

/** Calls a command. Rejects with an `ActionError`. */
export async function invokeTyped<K extends CommandName>(
  name: K,
  ...rest: ArgsParam<K>
): Promise<CommandResults[K]> {
  try {
    return await invoke<CommandResults[K]>(
      name,
      rest[0] as Record<string, unknown> | undefined,
    );
  } catch (e) {
    throw toActionError(e);
  }
}

/** The current state, for a UI that started after the first `"state"` event. */
export function getState(): Promise<AppState> {
  return invokeTyped("get_state");
}

/** Subscribes to the `"state"` event. Resolves to the unlisten function. */
export function onState(cb: (state: AppState) => void): Promise<() => void> {
  return listen<AppState>("state", (event) => cb(event.payload));
}

/** Subscribes to the `"preview"` event (the live preview of the one active pane). */
export function onPreview(
  cb: (frame: PreviewFrame) => void,
): Promise<() => void> {
  return listen<PreviewFrame>("preview", (event) => cb(event.payload));
}
