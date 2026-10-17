# src-tauri: Rust core

A thin data and actions layer between the UI and the user's `herdr` binary. The UI derives the views; Rust fetches, polls, executes and launches.

## Module map (from the plan's file map; keep to it)

| Module | Owns |
|---|---|
| `herdr/model.rs` | serde + ts-rs types for herdr JSON (`Snapshot`, `Agent`, `Pane`, `MachineProfile`, …) and the parsers |
| `herdr/errors.rs` | `HerdrError` (serialized to the UI as `{kind, …}`) |
| `herdr/cli.rs` | `HerdrCli::run(machine, args, timeout)`, the per-machine semaphore (4), and the 200-entry `CommandLog` |
| `env.rs` | login-shell env capture, herdr binary resolution, version floor 0.9.0 (captured and resolved after the window is up; `get_state` answers `null` until then) |
| `activity.rs` | `ActivityTracker`: observed status-change times persisted to `activity.json` |
| `state.rs`, `poller.rs` | `AppState`/`MachineView`/`Health`, per-machine polling, `"state"` event, `Transition` broadcast |
| `actions.rs`, `commands.rs` | argv builders (pure) plus `#[tauri::command]` wrappers |
| `terminal/` | `attach_argv`, `shell_quote`, one launcher per terminal app |
| `ssh_config.rs`, `machine_setup.rs` | Host alias parsing; pty-driven `machine add` |
| `settings.rs` | `Settings` (merge + validation), the `settings.json` store, herdr re-resolution (`HerdrLocator`) |
| `notify.rs`, `tray.rs` | notifications from `Transition`s; tray, badge, popover and Settings windows, global shortcut |

## Rules

- **Every herdr call goes through `HerdrCli::run`.** No other `Command::new("herdr")`, except the plain-text reads `env::herdr_version` (`--version`), `env::herdr_agent_kinds` (`agent start --help`) and `env::herdr_status` (`status`, once at startup, logged by `lib.rs`), all via `env::run_plain_text`; none prints JSON. `machine_setup.rs` also starts `herdr machine add` on a pty (its prompts need a tty), with the argv from `checked_machine_add_argv` and a command-log entry when it ends. The only other processes spawned are terminal launchers (`open`, `osascript`, `/bin/sh -c` for custom templates), the login shell for env capture, `mdfind`, and `ssh` inside attach commands.
- **Pass `--machine <profile id>` first**, before the subcommand. Local is the machine id `"local"`, which maps to no `--machine` flag.
- **Mutations never retry automatically.** A timeout becomes `ActionError::MaybeApplied` and triggers `Poller::refresh_now`.
- **Quoting:** any user- or herdr-derived string that reaches a shell or AppleScript goes through `shell_quote` / AppleScript escaping. Test it with hostile strings (`' " $ \` ; |`, unicode).
- **No `unwrap()`/`expect()` outside tests and startup wiring.** Return typed errors.
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
