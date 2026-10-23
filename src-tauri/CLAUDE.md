# src-tauri: Rust core

A thin data and actions layer between the UI and the user's `herdr` binary. The UI derives the views; Rust fetches, polls, executes and launches.

## Module map (from the plan's file map; keep to it)

| Module | Owns |
|---|---|
| `herdr/model.rs` | serde + ts-rs types for herdr JSON (`Snapshot`, `Agent`, `Pane`, `MachineProfile`, …) and the parsers |
| `herdr/errors.rs` | `HerdrError` (serialized to the UI as `{kind, …}`) |
| `herdr/cli.rs` | `HerdrCli::run(machine, args, timeout)`, the per-machine semaphore (4), and the 200-entry `CommandLog` |
| `env.rs` | login-shell env capture, herdr binary resolution, the plain-text herdr reads (captured and resolved after the window is up; `get_state` answers `null` until then). The 0.9.0 version floor lives in the UI (`lib/format.ts`) |
| `activity.rs` | `ActivityTracker`: observed status-change times persisted to `activity.json` |
| `state.rs`, `poller.rs` | `AppState`/`MachineView`/`Health`, per-machine polling, `"state"` event, `Transition` broadcast |
| `actions.rs`, `commands.rs` | argv builders (pure) plus `#[tauri::command]` wrappers (`commands.rs` holds only the wrappers and their small helpers) |
| `terminal/` | `attach_argv`, `shell_quote`, one launcher per terminal app; `open.rs` is what "Open" runs (attach or full UI, the launch spec, the command-log entry) and takes the home dir, so it knows nothing of Tauri; `session.rs` is `TermSessions`: the in-app terminal's open sessions (writer, `PtyControl`, a reader thread that decodes UTF-8 incrementally and pushes `TermEvent::Data`/`Exit` to a sink) |
| `preview.rs` | `PreviewManager` (the live preview, emitting only changed frames), `PreviewFrame`, the one-line pane read |
| `ssh_config.rs`, `machine_setup/` | Host alias parsing; pty-driven `machine add` (`transcript.rs` is the pure prompt/step parser and `SetupRun`; `mod.rs` the thread driver over `pty.rs`) |
| `pty.rs` | the shared pseudo-terminal spawner: `TermSize`, `PtySpawner`/`PortablePty` (spawns at a size), `PtyControl` (kill, wait, try_wait, resize), `SpawnedPty`; used by `machine_setup/` and the in-app terminal |
| `menu.rs` | the native app menu: `MenuId`, the `items()` table (id, label, accelerator; the accelerators come from `accelerator(id)`, which reads `src/lib/shortcuts.json`, the file the UI's labels and `tray::global_shortcut` use too), the `build` of the App, Edit, View, Terminal and Window menus (Dashboard ⌘1, Keyboard Shortcuts ⌘/ in View, Toggle Terminal ⌃`, "Dashboard Beside Terminal" ⌘\, New Session in Workbox ⌘T and Tab 1–8 on ⌘2–⌘9 in the Terminal menu), and `on_event`, which forwards a chosen item to the main window as a `"menu"` event |
| `settings.rs` | `Settings` (merge + validation; `dashboard_split` and `dashboard_split_width`, 360–1200, for the Dashboard column; the v0.2 `terminal_placement` and `terminal_panel_size` keys are gone and ignored if a stored file still has them), the `settings.json` store, herdr re-resolution (`HerdrLocator`) |
| `notify.rs`, `tray.rs` | notifications from `Transition`s; tray, badge, popover and Settings windows, global shortcut |

## Rules

- **Every herdr call goes through `HerdrCli::run`.** No other `Command::new("herdr")`, except the plain-text reads `env::herdr_version` (`--version`), `env::herdr_agent_kinds` (`agent start --help`) and `env::herdr_status` (`status`, once at startup, logged by `lib.rs`), all via `env::run_plain_text`; none prints JSON. `machine_setup/mod.rs` also starts `herdr machine add` on a pty (its prompts need a tty), with the argv from `checked_machine_add_argv` and a command-log entry when it ends. The only other processes spawned are terminal launchers (`open`, `osascript`, `/bin/sh -c` for custom templates), the login shell for env capture, `mdfind`, and `ssh` inside attach commands. `open`, `osascript` and `mdfind` are run by absolute path (`/usr/bin/…`, the constants in `terminal/mod.rs`), so a hijacked `PATH` can't swap them; `ssh` and `herdr` stay on the `PATH` on purpose (the user's own installs and ssh setup).
- **A new app command goes in three places**, or it is refused at runtime: `generate_handler!` in `lib.rs`, `COMMANDS` in `build.rs`, and the capability JSON (`capabilities/*.json`) of each window that calls it. Windows get exactly the commands their code invokes; `scripts/capabilities.test.ts` enforces the exact per-window grants.
- **Pass `--machine <profile id>` first**, before the subcommand. Local is the machine id `"local"`, which maps to no `--machine` flag.
- **Mutations never retry automatically.** A timeout becomes `ActionError::MaybeApplied` and triggers `Poller::refresh_now`.
- **Quoting:** any user- or herdr-derived string that reaches a shell or AppleScript goes through `shell_quote` / AppleScript escaping. Test it with hostile strings (`' " $ \` ; |`, unicode).
- **No `unwrap()`/`expect()` outside tests and startup wiring.** Return typed errors.
- **Terminal sessions run only `open_argv` output.** `term_open` takes a target (a pane or a full-UI machine), never a command line; Rust builds the argv with `open_argv` and spawns it on a pty with the captured env plus `TERM=xterm-256color` and `COLORTERM=truecolor`. `term_write` carries only keystrokes and pastes. `term_close` kills only the attach client, never a herdr pane; all sessions are killed when the app exits. `TermSessions` allows at most 16 sessions (`MAX_SESSIONS`) and answers the 17th with "Close a terminal tab first (16 open)."
- **Spawning:** use `tokio::process::Command` with `kill_on_drop(true)`, an explicit env (from `forwarded_env`), and a timeout from the constants (`T_DEFAULT` 10 s, `T_CREATE` 30 s, `T_AGENT_START` 45 s, `T_PROMPT` 30 s). The one exception is the Custom terminal template (`LaunchSpec::detached`): it may stay in the foreground, so it is started without a wait or a kill.
- **The poller's `emit` runs under its core lock.** Anything that reacts to the state (tray badge, notifications) reads the `watch` channel that `emit` fills, on its own task. Never call `Poller` methods or `get_state` from inside `emit`.
- **Settings** are read at the moment of use (`SharedSettings::get`), so a change applies to the next open without a restart. Only intervals, the herdr path and the global shortcut need work when they change (`settings::changes`).
- **Types shared with the UI** derive `TS` with `#[ts(export, export_to = "../../src/lib/bindings/")]`. Run `cargo test` to regenerate them, and commit the bindings.
- **Testability:** keep logic pure (argv builders, classifiers, parsers, `next_delay`) and inject side effects (`emit` callbacks, `exists` predicates), so tests don't need a Tauri runtime.

## Testing

- **Unit tests** live next to the code in `#[cfg(test)]`. **Integration tests** in `tests/` run the real runner against `../scripts/fake-herdr` with a temp `FAKE_HERDR_DIR`.
- **fake-herdr protocol:** argv after an optional `--machine <id>` is joined with `_` to form `<joined>.json` (stdout), `.stderr`, `.exit` and `.sleep`. Calls are appended to `$FAKE_HERDR_DIR/calls.log`. Files named `<id>@<joined>.*` override the generic ones for that machine.
- **Fixtures** in `tests/fixtures/` are synthetic and generic (`buildbox`, `api-service`, `/home/dev`). Real captures go only to `../fixtures-raw/` (gitignored).
- **Before committing:** `cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test`.
