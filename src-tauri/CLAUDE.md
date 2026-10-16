# src-tauri: Rust core

A thin data and actions layer between the UI and the user's `herdr` binary. The UI derives the views; Rust fetches, polls, executes and launches.

## Module map (from the plan's file map; keep to it)

| Module | Owns |
|---|---|
| `herdr/model.rs` | serde + ts-rs types for herdr JSON (`Snapshot`, `Agent`, `Pane`, `MachineProfile`, …) and the parsers |
| `herdr/errors.rs` | `HerdrError` (serialized to the UI as `{kind, …}`) |
| `herdr/cli.rs` | `HerdrCli::run(machine, args, timeout)`, the per-machine semaphore (4), and the 200-entry `CommandLog` |
| `env.rs` | login-shell env capture, herdr binary resolution, version floor 0.9.0 |
| `activity.rs` | `ActivityTracker`: observed status-change times persisted to `activity.json` |
| `state.rs`, `poller.rs` | `AppState`/`MachineView`/`Health`, per-machine polling, `"state"` event, `Transition` broadcast |
| `actions.rs`, `commands.rs` | argv builders (pure) plus `#[tauri::command]` wrappers |
| `terminal/` | `attach_argv`, `shell_quote`, one launcher per terminal app |
| `ssh_config.rs`, `machine_setup.rs` | Host alias parsing; pty-driven `machine add` |
| `settings.rs`, `notify.rs`, `tray.rs` | store-backed settings, notifications, tray/popover |

## Rules

- **Every herdr call goes through `HerdrCli::run`.** No other `Command::new("herdr")`, except `env::herdr_version` (`herdr --version` prints plain text, not JSON). The only other processes spawned are terminal launchers (`open`, `osascript`, `/bin/sh -c` for custom templates), the login shell for env capture, `mdfind`, and `ssh` inside attach commands.
- **Pass `--machine <profile id>` first**, before the subcommand. Local is the machine id `"local"`, which maps to no `--machine` flag.
- **Mutations never retry automatically.** A timeout becomes `ActionError::MaybeApplied` and triggers `Poller::refresh_now`.
- **Quoting:** any user- or herdr-derived string that reaches a shell or AppleScript goes through `shell_quote` / AppleScript escaping. Test it with hostile strings (`' " $ \` ; |`, unicode).
- **No `unwrap()`/`expect()` outside tests and startup wiring.** Return typed errors.
- **Spawning:** use `tokio::process::Command` with `kill_on_drop(true)`, an explicit env (from `forwarded_env`), and a timeout from the constants (`T_DEFAULT` 10 s, `T_CREATE` 30 s, `T_AGENT_START` 45 s, `T_PROMPT` 30 s).
- **Types shared with the UI** derive `TS` with `#[ts(export, export_to = "../../src/lib/bindings/")]`. Run `cargo test` to regenerate them, and commit the bindings.
- **Testability:** keep logic pure (argv builders, classifiers, parsers, `next_delay`) and inject side effects (`emit` callbacks, `exists` predicates), so tests don't need a Tauri runtime.

## Testing

- **Unit tests** live next to the code in `#[cfg(test)]`. **Integration tests** in `tests/` run the real runner against `../scripts/fake-herdr` with a temp `FAKE_HERDR_DIR`.
- **fake-herdr protocol:** argv after an optional `--machine <id>` is joined with `_` to form `<joined>.json` (stdout), `.stderr`, `.exit` and `.sleep`. Calls are appended to `$FAKE_HERDR_DIR/calls.log`. Files named `<id>@<joined>.*` override the generic ones for that machine.
- **Fixtures** in `tests/fixtures/` are synthetic and generic (`buildbox`, `api-service`, `/home/dev`). Real captures go only to `../fixtures-raw/` (gitignored).
- **Before committing:** `cargo fmt --check && cargo clippy -- -D warnings && cargo test`.
