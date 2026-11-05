//! The app manifest lists every command in `generate_handler!` (src/lib.rs), so each one needs an
//! explicit `allow-<command>` permission in a capability file. A command no capability grants
//! cannot be called from any window. `scripts/capabilities.test.ts` keeps this list, the
//! handler and the capability files in step.

const COMMANDS: &[&str] = &[
    "get_state",
    "create_session",
    "preview_new_session",
    "reply_to_agent",
    "interrupt_terminal",
    "close_terminal",
    "remove_terminal",
    "clear_ended",
    "set_keep",
    "mark_seen",
    "mark_unread",
    "set_pinned",
    "machine_connect",
    "machine_rename",
    "machine_remove",
    "set_workbox_hidden",
    "machine_login_args",
    "machine_update_args",
    "refresh_now",
    "reconnect_core",
    "get_command_log",
    "list_run_choices",
    "open_session",
    "open_in_terminal",
    "list_ssh_hosts",
    "add_machine",
    "machine_add_args",
    "preview_add_machine",
    "read_tail",
    "get_terminals",
    "list_terminals",
    "copy_attach_command",
    "start_preview",
    "stop_preview",
    "get_settings",
    "set_settings",
    "core_status",
    "retry_core",
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
    "set_looking",
    "herdr_app_status",
    "open_in_herdr",
];

fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("failed to run the tauri build script");
}
