import { Channel, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import type { ActionError } from "./bindings/ActionError";
import type { AddMachineRequest } from "./bindings/AddMachineRequest";
import type { AppState } from "./bindings/AppState";
import type { CommandLogEntry } from "./bindings/CommandLogEntry";
import type { CreatedSession } from "./bindings/CreatedSession";
import type { CoreStatus } from "./bindings/CoreStatus";
import type { MenuId } from "./bindings/MenuId";
import type { NewSessionRequest } from "./bindings/NewSessionRequest";
import type { PreviewFrame } from "./bindings/PreviewFrame";
import type { RunChoices } from "./bindings/RunChoices";
import type { Settings } from "./bindings/Settings";
import type { ShortcutStatus } from "./bindings/ShortcutStatus";
import type { TermEvent } from "./bindings/TermEvent";
import type { TermTarget } from "./bindings/TermTarget";
import type { TerminalList } from "./bindings/TerminalList";

/** Every Tauri command the UI may call, mapped to its result. A Rust `()` arrives as `null`. */
export type CommandResults = {
  /** `null` while startup is still looking for herdr-core; a "state" event follows. */
  get_state: AppState | null;
  create_session: CreatedSession;
  /** The `hc run …` line, built in Rust. */
  preview_new_session: string;
  reply_to_agent: null;
  mark_seen: null;
  /** The text the core observed after the stop key, for a toast. */
  interrupt_terminal: string;
  close_terminal: null;
  remove_terminal: null;
  /** How many ended terminals were removed. */
  clear_ended: number;
  set_keep: null;
  mark_unread: null;
  set_pinned: null;
  machine_connect: null;
  machine_rename: null;
  machine_remove: null;
  /** The settings after the change. */
  set_workbox_hidden: Settings;
  /** What follows the core in `machine login <name>`, for a command tab. */
  machine_login_args: string[];
  /** What follows the core in `machine update <name>`, for a command tab. */
  machine_update_args: string[];
  refresh_now: null;
  reconnect_core: null;
  get_command_log: CommandLogEntry[];
  /** The kinds (installed ones when the check worked) and, on Local, the templates. */
  list_run_choices: RunChoices;
  open_session: null;
  open_in_terminal: null;
  list_ssh_hosts: string[];
  /** `machine.add`: the new machine's id. */
  add_machine: string;
  /** What follows the core in `machine add …`, for a command tab. */
  machine_add_args: string[];
  /** The `hc machine add …` line, built in Rust. */
  preview_add_machine: string;
  read_tail: string;
  get_terminals: TerminalList;
  list_terminals: TerminalList;
  copy_attach_command: string;
  start_preview: null;
  stop_preview: null;
  get_settings: Settings;
  set_settings: Settings;
  core_status: CoreStatus;
  /** Locates the core again with the settings as they are, rewires and reconnects. */
  retry_core: CoreStatus;
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
  set_looking: null;
  /** Whether Herdr's window is open (`herdr-app status` exits 0); reused for 5 s in Rust. */
  herdr_app_status: boolean;
  open_in_herdr: null;
};
export type CommandName = keyof CommandResults;

/** The arguments of each command. Keys are camelCase, which is what Tauri expects. */
export type CommandArgs = {
  get_state: undefined;
  create_session: { req: NewSessionRequest };
  preview_new_session: { req: NewSessionRequest };
  reply_to_agent: { machineId: string; address: string; text: string };
  mark_seen: { machineId: string; address: string };
  interrupt_terminal: { machineId: string; address: string };
  /** `terminal.kill`; the UI confirms first. */
  close_terminal: { machineId: string; address: string };
  /** `terminal.rm` of an ended terminal; the UI confirms first. */
  remove_terminal: { machineId: string; address: string };
  /** Removes every ended terminal of one workbox; the UI confirms first. */
  clear_ended: { machineId: string };
  set_keep: { machineId: string; address: string; keep: boolean };
  /** Goes back one turn; refused at turn 0. */
  mark_unread: { machineId: string; address: string };
  set_pinned: { machineId: string; address: string; pinned: boolean };
  /** `machine.connect`: dial the workbox now. */
  machine_connect: { machineId: string };
  /** `machine.rename`; the name is checked in Rust like a terminal's. */
  machine_rename: { machineId: string; newName: string };
  /** `machine.rm`; the UI confirms first. */
  machine_remove: { machineId: string };
  /** An app setting (`hidden_workboxes`); no core call. */
  set_workbox_hidden: { machineId: string; hidden: boolean };
  machine_login_args: { machineId: string };
  /** The UI confirms first: it copies hc to the machine and restarts its core. */
  machine_update_args: { machineId: string };
  refresh_now: { machineId?: string | null };
  reconnect_core: undefined;
  get_command_log: undefined;
  list_run_choices: { machineId: string };
  /** Opens `hc attach` for the terminal in the user's terminal; `observe` is Watch (never types or resizes). */
  open_session: { machineId: string; address: string; observe: boolean };
  /** What follows the herdr-core binary, which Rust takes from the resolved core; only a few shapes are allowed. */
  open_in_terminal: { args: string[] };
  list_ssh_hosts: undefined;
  /** `machine.add`. A refusal the core types (`hc_missing`, `needs_login`, …) arrives as a `core` error with its `code`. */
  add_machine: { req: AddMachineRequest };
  /** `install` is true only after the person confirmed Install hc there…. */
  machine_add_args: { req: AddMachineRequest; install: boolean };
  preview_add_machine: { req: AddMachineRequest };
  read_tail: { machineId: string; address: string };
  get_terminals: undefined;
  list_terminals: undefined;
  copy_attach_command: { machineId: string; address: string };
  start_preview: { machineId: string; address: string };
  stop_preview: undefined;
  get_settings: undefined;
  /** Merged over the current settings; refused as a whole if any value is invalid. */
  set_settings: { patch: Partial<Settings> };
  core_status: undefined;
  retry_core: undefined;
  shortcut_status: undefined;
  /** The script a Custom launch command runs for a sample pane. */
  preview_launch_template: { template: string };
  show_main: undefined;
  show_main_new_session: undefined;
  open_settings: undefined;
  /** `onEvent` (the output channel) is added by `openTerm`; callers don't pass it. */
  term_open: {
    target: TermTarget;
    observe: boolean;
    cols: number;
    rows: number;
  };
  /** Keystrokes and pastes only; the command a tab runs is built on the Rust side. */
  term_write: { id: number; data: string };
  term_resize: { id: number; cols: number; rows: number };
  /** Kills the attach client; the core's terminal keeps running. */
  term_close: { id: number };
  show_main_open_row: { machineId: string; address: string };
  /** The rows drawn right now (`${machineId}::${address}`; none while the window is away): Rust skips their notifications and writes `herdr.seen` for them. */
  set_looking: { keys: string[] };
  herdr_app_status: undefined;
  /** `herdr-app do terminal.peek`: shows the terminal in Herdr's window; only on the person's click. */
  open_in_herdr: { machineId: string; address: string };
};

const ACTION_ERROR_KINDS: ReadonlySet<string> = new Set([
  "launch",
  "core",
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
 * Tells the OS the theme, so native pieces (context menus, the title bar) match the page.
 * `null` follows the system. On macOS the theme is app-wide, and an explicit one pins the
 * appearance of every window. Failures are ignored: the page itself is already drawn.
 */
export async function setWindowTheme(
  theme: "dark" | "light" | null,
): Promise<void> {
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
 * `term_*` commands take. `observe` is Watch. Rejects with an `ActionError`.
 */
export async function openTerm(
  target: TermTarget,
  cols: number,
  rows: number,
  onEvent: (e: TermEvent) => void,
  observe = false,
): Promise<number> {
  const channel = new Channel<TermEvent>();
  channel.onmessage = onEvent;
  try {
    return await invoke<number>("term_open", {
      target,
      observe,
      cols,
      rows,
      onEvent: channel,
    });
  } catch (e) {
    throw toActionError(e);
  }
}
