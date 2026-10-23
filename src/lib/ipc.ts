import { Channel, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import type { AppState } from "./bindings/AppState";
import type { ActionError } from "./bindings/ActionError";
import type { CommandLogEntry } from "./bindings/CommandLogEntry";
import type { CreatedSession } from "./bindings/CreatedSession";
import type { HerdrStatus } from "./bindings/HerdrStatus";
import type { MenuId } from "./bindings/MenuId";
import type { MachineStatusEntry } from "./bindings/MachineStatusEntry";
import type { NewSessionRequest } from "./bindings/NewSessionRequest";
import type { PreviewFrame } from "./bindings/PreviewFrame";
import type { SetupEvent } from "./bindings/SetupEvent";
import type { Settings } from "./bindings/Settings";
import type { ShortcutStatus } from "./bindings/ShortcutStatus";
import type { TermEvent } from "./bindings/TermEvent";
import type { TermTarget } from "./bindings/TermTarget";
import type { TerminalList } from "./bindings/TerminalList";

/** Every Tauri command the UI may call, mapped to its result. A Rust `()` arrives as `null`. */
export type CommandResults = {
  /** `null` while startup is still looking for herdr; a "state" event follows. */
  get_state: AppState | null;
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
  open_in_terminal: null;
  list_ssh_hosts: string[];
  machine_add_argv: string[];
  preview_machine_add: string;
  preview_reconnect: string;
  start_machine_add: null;
  answer_machine_setup: null;
  cancel_machine_setup: null;
  read_pane_tail: string;
  get_terminals: TerminalList;
  list_terminals: TerminalList;
  copy_attach_command: string;
  start_preview: null;
  stop_preview: null;
  get_settings: Settings;
  set_settings: Settings;
  herdr_status: HerdrStatus;
  shortcut_status: ShortcutStatus;
  preview_launch_template: string;
  show_main: null;
  show_main_new_session: null;
  open_settings: null;
  /** The new terminal's id, for `term_write`, `term_resize` and `term_close`. */
  term_open: number;
  term_write: null;
  term_resize: null;
  term_close: null;
  show_main_open_row: null;
};
export type CommandName = keyof CommandResults;

/** The Add workbox form's fields; an empty or missing option is left out of the command. */
export type MachineAddFields = {
  target: string;
  label?: string | null;
  session?: string | null;
};

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
  /** What follows the herdr binary; the Rust side allows only a few shapes. */
  open_in_terminal: { argv: string[] };
  list_ssh_hosts: undefined;
  /** What follows the herdr binary in `machine add`: the argv `open_in_terminal` expects. */
  machine_add_argv: MachineAddFields;
  /** The `machine add` command line, as text. */
  preview_machine_add: MachineAddFields;
  /** `herdr machine reconnect <id>` as text, for the cards that suggest it. */
  preview_reconnect: { id: string };
  /** Runs `machine add` in a hidden terminal; progress arrives as `"machine-setup"` events. */
  start_machine_add: MachineAddFields;
  /** `"yes"` or `"no"` for a confirmation, the session's index (as text) for the picker. */
  answer_machine_setup: { choice: string };
  cancel_machine_setup: undefined;
  read_pane_tail: { machineId: string; paneId: string };
  get_terminals: undefined;
  list_terminals: undefined;
  copy_attach_command: { machineId: string; paneId: string };
  start_preview: { machineId: string; paneId: string; isAgent: boolean };
  stop_preview: undefined;
  get_settings: undefined;
  /** Merged over the current settings; refused as a whole if any value is invalid. */
  set_settings: { patch: Partial<Settings> };
  herdr_status: undefined;
  shortcut_status: undefined;
  /** The script a Custom launch command runs for a sample pane. */
  preview_launch_template: { template: string };
  show_main: undefined;
  show_main_new_session: undefined;
  open_settings: undefined;
  /** `onEvent` (the output channel) is added by `openTerm`; callers don't pass it. */
  term_open: { target: TermTarget; cols: number; rows: number };
  /** Keystrokes and pastes only; the command a tab runs is built on the Rust side. */
  term_write: { id: number; data: string };
  term_resize: { id: number; cols: number; rows: number };
  /** Kills the attach client; the herdr pane keeps running. */
  term_close: { id: number };
  show_main_open_row: { machineId: string; paneId: string };
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

/**
 * Puts `text` on the clipboard through the Tauri clipboard plugin. WebKit refuses the web
 * clipboard API outside a user gesture it accepts, so this is the only clipboard write in
 * the UI. Rejects with the plugin's error.
 */
export function copyText(text: string): Promise<void> {
  return writeText(text);
}

/**
 * Tells the OS the window's theme, so native pieces (context menus, the title bar) match the
 * page. Failures are ignored: the page itself is already drawn in the theme.
 */
export async function setWindowTheme(theme: "dark" | "light"): Promise<void> {
  try {
    await getCurrentWindow().setTheme(theme);
  } catch {
    // No window API (a test, a browser) or the grant is missing.
  }
}

/** The current state, for a UI that started after the first `"state"` event. */
export function getState(): Promise<AppState | null> {
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

/** Subscribes to the `"machine-setup"` event (the hidden `machine add` run). */
export function onMachineSetup(
  cb: (event: SetupEvent) => void,
): Promise<() => void> {
  return listen<SetupEvent>("machine-setup", (event) => cb(event.payload));
}

/** The current settings, for a window that opened after the last change. */
export function getSettings(): Promise<Settings> {
  return invokeTyped("get_settings");
}

/** Subscribes to the `"settings"` event, sent after every successful change. */
export function onSettings(
  cb: (settings: Settings) => void,
): Promise<() => void> {
  return listen<Settings>("settings", (event) => cb(event.payload));
}

/** Subscribes to `"focus-row"`: a notification was clicked; the payload is the row key. */
export function onFocusRow(cb: (key: string) => void): Promise<() => void> {
  return listen<string>("focus-row", (event) => cb(event.payload));
}

/** Subscribes to `"new-session"`: the tray or the popover asked for the New session sheet. */
export function onNewSession(cb: () => void): Promise<() => void> {
  return listen("new-session", () => cb());
}

/** Subscribes to `"menu"`: a native menu item was chosen; the payload is its id. */
export function onMenu(cb: (id: MenuId) => void): Promise<() => void> {
  return listen<MenuId>("menu", (event) => cb(event.payload));
}

/** Subscribes to `"open-row"`: the popover asked the main window to open a row (its key). */
export function onOpenRow(cb: (key: string) => void): Promise<() => void> {
  return listen<string>("open-row", (event) => cb(event.payload));
}

/**
 * Opens a terminal tab on `target` and streams its output to `onEvent`. Resolves to the id the
 * `term_*` commands take. Rejects with an `ActionError`.
 */
export async function openTerm(
  target: TermTarget,
  cols: number,
  rows: number,
  onEvent: (e: TermEvent) => void,
): Promise<number> {
  const channel = new Channel<TermEvent>();
  channel.onmessage = onEvent;
  try {
    return await invoke<number>("term_open", {
      target,
      cols,
      rows,
      onEvent: channel,
    });
  } catch (e) {
    throw toActionError(e);
  }
}
