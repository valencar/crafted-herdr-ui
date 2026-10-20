//! The app manifest lists every command in `generate_handler!` (src/lib.rs), so each one needs an
//! explicit `allow-<command>` permission in a capability file. A command no capability grants
//! cannot be called from any window. `scripts/capabilities.test.ts` keeps this list, the
//! handler and the capability files in step.

const COMMANDS: &[&str] = &[
    "get_state",
    "create_session",
    "preview_new_session",
    "rename_session",
    "close_pane",
    "create_tab",
    "rename_tab",
    "close_tab",
    "create_workspace",
    "rename_workspace",
    "close_workspace",
    "reply_to_agent",
    "mark_seen",
    "machine_rename",
    "machine_set_enabled",
    "machine_remove",
    "machine_status",
    "refresh_now",
    "get_command_log",
    "list_agent_kinds",
    "open_session",
    "open_full_herdr",
    "open_in_terminal",
    "list_ssh_hosts",
    "machine_add_argv",
    "preview_machine_add",
    "preview_reconnect",
    "start_machine_add",
    "answer_machine_setup",
    "cancel_machine_setup",
    "read_pane_tail",
    "get_terminals",
    "list_terminals",
    "copy_attach_command",
    "start_preview",
    "stop_preview",
    "get_settings",
    "set_settings",
    "herdr_status",
    "shortcut_status",
    "preview_launch_template",
    "show_main",
    "show_main_new_session",
    "open_settings",
    "term_open",
    "term_write",
    "term_resize",
    "term_close",
    "show_main_open_row",
];

fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("failed to run the tauri build script");
}
