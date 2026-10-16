# crafted-herdr-ui v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Model routing (maintainer decision):** each task's implementer is a fresh subagent on **Sonnet 5.5 at high effort**; each task's reviewer and the final whole-branch review run on **Opus**.

**Goal:** Build a macOS Tauri 2 app that shows all Herdr machines ("workboxes") and agents grouped by project with "needs you" first, and opens any pane in the user's own terminal, driving everything through the user's installed `herdr` CLI.

**Architecture:** A thin Rust core spawns `herdr` (`--machine <id>` for remote machines), parses its JSON, polls `api snapshot` per machine, and exposes typed Tauri commands and events. The React/TypeScript UI derives every view (needs-you, project groups) with pure, tested functions. Terminal launchers hand `herdr terminal attach` (or `ssh -t … herdr terminal attach`) to Ghostty, iTerm2, Terminal, Warp, WezTerm, Kitty, Alacritty, or a custom command.

**Tech Stack:** Tauri 2 (Rust stable, edition 2021), React 18 + TypeScript + Vite, pnpm, Zustand, Vitest + React Testing Library, `ts-rs` (Rust → TS types), `tokio`, `serde_json`, `portable-pty`, `tauri-plugin-store`, `tauri-plugin-notification`, `tauri-plugin-global-shortcut`, `tauri-plugin-positioner` (tray feature), bundled Geist + Geist Mono (OFL).

**Spec:** `docs/superpowers/specs/2026-10-16-crafted-herdr-ui-design.md` (executors read it; section refs below are "spec §N").

## Global Constraints

- **No personal data in the repo, ever.** No real machine labels, SSH targets, hostnames, usernames, home paths, project names, terminal titles, or session IDs in code, fixtures, tests, docs, screenshots or commit messages. Use the generic examples `buildbox`, `gpubox`, `staging`, and `api-service`, `web-app`, `infra`, with homes `/home/dev` and `/Users/dev`. Real names live only in `.env.local` (gitignored). Before every commit, run `scripts/check-no-personal-data.sh` (Task 0), and it must pass.
- No keys, tokens, `.pem`/`id_*` files, or SSH config contents are committed. The app never reads private keys; it only parses `Host` lines from `~/.ssh/config` at runtime.
- Only the public `herdr` CLI is used; no direct socket protocol. Supported herdr ≥ 0.9.0 (warn below that, still try).
- Every mutating action goes through `HerdrCli::run` so it appears in the command log.
- The app never: installs herdr, stops or replaces a server, closes a pane it was not asked to close, answers a `blocked` agent, or passes `--trust-repository` / `--takeover` without an explicit user click.
- App display name "Crafted Herdr", bundle identifier `dev.crafted.herdr-ui`, MIT license (already in repo).
- Status colors and tokens exactly as spec §9; every status shows a text label as well as color.
- Tests never run a real `herdr` that mutates state. Unit and integration tests use `scripts/fake-herdr`. Live tests are opt-in (`HERDR_UI_LIVE=1`) and may touch only `HERDR_UI_TEST_MACHINE`, inside a workspace labelled `herdr-ui-qa`.
- macOS 13+ target, universal binary.

## Review Focus

1. **A machine that is offline, needs auth, or times out while others are fine.** It must not block or blank other machines. Its row shows cached data dimmed with its error. Test: Task 5 `poller_isolates_failing_machine`.
2. **Agent names, titles and paths with spaces, quotes, `$`, backticks or unicode reaching a shell** (attach command, custom terminal template, AppleScript). They must be quoted, never interpreted. Test: Task 8 `quoting_survives_hostile_strings`.
3. **IDs colliding across machines** (`w1:p1` on two workboxes, the same agent name on two machines). Selection, preview, actions and React keys must be keyed by (machine id, pane id). Test: Task 9 `selection_is_machine_scoped`.
4. **A mutation that times out or errors after possibly being applied** (create session, close pane). It must not retry automatically, must say "may have been applied, refreshing", and must trigger an immediate re-poll. Test: Task 7 `timeout_triggers_refresh_without_retry`.
5. **herdr missing or not on the GUI PATH, or an SSH agent not visible to a Finder-launched app.** The app must find herdr through the login shell and pass `SSH_AUTH_SOCK`, or show onboarding. Test: Task 3 `resolution_order` plus `login_env_forwards_ssh_auth_sock`.

---

## File map

```
src-tauri/
  Cargo.toml, tauri.conf.json, capabilities/default.json, icons/
  src/main.rs                 app setup: plugins, state, tray, windows, command registration
  src/lib.rs                  module tree + `pub fn run()`
  src/herdr/mod.rs            re-exports
  src/herdr/model.rs          serde + ts-rs types for herdr JSON
  src/herdr/errors.rs         HerdrError
  src/herdr/cli.rs            HerdrCli runner + CommandLog
  src/env.rs                  login env capture, herdr resolution, version check
  src/activity.rs             ActivityTracker (observed status-change times, persisted)
  src/poller.rs               per-machine polling loop → AppState → "state" event
  src/state.rs                AppState, MachineView, Health (ts-rs exported)
  src/actions.rs              Action enum, argv builders, composite flows
  src/commands.rs             #[tauri::command] wrappers
  src/terminal/mod.rs         TerminalId, LaunchSpec, attach_command, shell_quote, detect
  src/terminal/{ghostty,iterm,terminal_app,warp,wezterm,kitty,alacritty,custom}.rs
  src/ssh_config.rs           Host alias parsing
  src/machine_setup.rs        pty-driven `machine add` + prompt classifier
  src/settings.rs             Settings struct + store load/save
  src/notify.rs               transition → notification
  src/tray.rs                 tray icon, badge, popover window toggle
  tests/fixtures/*.json       synthetic fixtures (generic names only)
  tests/cli_integration.rs    runner vs fake-herdr
src/
  main.tsx, App.tsx, popover.tsx (menu bar entry)
  styles/tokens.css, styles/global.css, fonts/
  lib/bindings/*.ts           generated by ts-rs (committed)
  lib/ipc.ts                  typed invoke/listen wrappers
  lib/grouping.ts             needs-you, project/workbox/status grouping, sorting
  lib/format.ts               ages, display names, short paths
  store/appStore.ts           Zustand: state, selection, ui
  components/                 Sidebar, Header, NeedsYouCard, ProjectGroup, AgentRow, StatusPill,
                              Inspector, Preview, CommandBox, ConfirmDialog, Sheet, Toast, ActivityDrawer
  screens/                    Home, Workbox, NewSession, AddWorkbox, Settings, MenuBar, Onboarding
scripts/fake-herdr            test double (bash)
scripts/check-no-personal-data.sh
scripts/capture-raw-fixtures.sh   (writes to fixtures-raw/, gitignored)
.github/workflows/ci.yml, release.yml
README.md, CONTRIBUTING.md, docs/qa-checklist.md
```

---

### Task 0: Toolchain, scaffold, guardrails

**Files:** Create the Tauri scaffold at the repo root, `scripts/check-no-personal-data.sh`, `.env.local.example`. Modify `.gitignore` and `README.md` (one-paragraph placeholder).

**Interfaces:**
- Produces: `pnpm dev`, `pnpm test` (Vitest), `pnpm lint`, `pnpm typecheck`, `cargo test` (from `src-tauri`), and `scripts/check-no-personal-data.sh` (exit 0 = clean).

- [ ] **Step 1:** Install Rust if missing: `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y`, then `rustup target add aarch64-apple-darwin x86_64-apple-darwin`. Verify with `cargo --version`. (The maintainer approved toolchain install when choosing Tauri. If the shell can't install it, stop and report.)
- [ ] **Step 2:** Scaffold into a temp dir with `pnpm create tauri-app@latest` (template react-ts, pnpm) and move it into the repo root, keeping the existing `LICENSE`, `README.md` and `.gitignore` (merge, don't overwrite). In `tauri.conf.json`, set `productName` "Crafted Herdr" and `identifier` `dev.crafted.herdr-ui`. Configure the main window as label `main`, 1280×820, minWidth 900, minHeight 600, `titleBarStyle: "Overlay"`, `hiddenTitle: true`, `visible: true`.
- [ ] **Step 3:** Add Vitest + jsdom + @testing-library/react + @testing-library/user-event, ESLint (typescript-eslint, react-hooks), Prettier, and scripts `test`, `lint`, `typecheck`. Add a smoke test `src/App.test.tsx` that renders `<App/>` and finds the text "Crafted Herdr".
- [ ] **Step 4:** Append to `.gitignore`: `.env.local`, `fixtures-raw/`, `src-tauri/target/`, `dist/`, `.superpowers/`. Create `.env.local.example` with `HERDR_UI_TEST_MACHINE=` (empty) and `HERDR_UI_LIVE=0`.
- [ ] **Step 5:** Write `scripts/check-no-personal-data.sh`. It greps all tracked and staged files (`git ls-files -co --exclude-standard`) case-insensitively for patterns read from `.env.local` key `HERDR_UI_PRIVATE_PATTERNS` (comma-separated; the file is absent in CI, so CI checks only the generic rules). It also always checks for `/Users/[a-z]+/` and `/home/[a-z]+/` except `/Users/dev/` and `/home/dev/`, `BEGIN .*PRIVATE KEY`, and `ssh-(rsa|ed25519) AAAA`. It exits 1 and lists hits. Test: run it on the clean tree and expect exit 0. Then `printf '/%s/alice/x\n' Users > ./probe.txt` (built at runtime so this plan doesn't trip the check itself), run it, expect exit 1, and delete `probe.txt`.
- [ ] **Step 6:** Verify `pnpm test`, `pnpm lint`, `pnpm typecheck` and `cd src-tauri && cargo test` all pass, and `pnpm tauri dev` opens a window titled Crafted Herdr (manual).
- [ ] **Step 7:** Commit: `chore: scaffold Tauri 2 + React app with guardrails`.

---

### Task 1: herdr data model and synthetic fixtures

**Files:** Create `src-tauri/src/herdr/{mod,model}.rs`, `src-tauri/tests/fixtures/{snapshot_local.json,snapshot_buildbox.json,machine_list.json,machine_status.json,error_agent_blocked.json,workspace_create.json,tab_create.json,pane_split.json,agent_start.json}`, `scripts/capture-raw-fixtures.sh`. Generated: `src/lib/bindings/*.ts`.

**Interfaces:**
- Produces (all `#[derive(Deserialize, Serialize, Clone, Debug, PartialEq, TS)]`, `#[ts(export, export_to = "../../src/lib/bindings/")]`, unknown fields ignored, missing optional fields defaulted):
  - `enum AgentStatus { Blocked, Working, Done, Idle, Unknown }`, serde `rename_all = "lowercase"`, with `#[serde(other)]` mapping to `Unknown`.
  - `struct Workspace { workspace_id, label, number: u32, active_tab_id: Option<String>, agent_status: AgentStatus, focused: bool, pane_count: u32, tab_count: u32 }`
  - `struct Tab { tab_id, workspace_id, label, number: u32, agent_status: AgentStatus, focused: bool, pane_count: u32 }`
  - `struct Pane { pane_id, tab_id, workspace_id, terminal_id, cwd: Option<String>, foreground_cwd: Option<String>, terminal_title: Option<String>, terminal_title_stripped: Option<String>, agent_status: AgentStatus, focused: bool, revision: u64 }`
  - `struct Agent { pane_id, tab_id, workspace_id, terminal_id, agent: String /* kind */, name: Option<String>, agent_status: AgentStatus, cwd: Option<String>, foreground_cwd: Option<String>, terminal_title_stripped: Option<String>, focused: bool, revision: u64, state_change_seq: u64, completion_seq: u64 }`
  - `struct Snapshot { version: String, protocol: u32, workspaces: Vec<Workspace>, tabs: Vec<Tab>, panes: Vec<Pane>, agents: Vec<Agent>, focused_workspace_id: Option<String>, focused_tab_id: Option<String>, focused_pane_id: Option<String> }` (`layouts` ignored in v1)
  - `struct MachineProfile { id, label, target, session, enabled: bool, selected: bool }`
  - `struct MachineStatusEntry { id, label, status: String, error: Option<String> }`
  - `fn parse_snapshot(v: &serde_json::Value) -> Result<Snapshot, HerdrError>` reads `result.snapshot`.
  - `fn parse_machine_list(v: &Value) -> Result<Vec<MachineProfile>, HerdrError>`: the top-level array.
  - `fn parse_created_pane(v: &Value) -> Result<String, HerdrError>`: returns the new pane id from `result.root_pane.pane_id` (workspace/tab create) or `result.pane.pane_id` (split).
  - (`HerdrError` comes from Task 2. In this task, define `HerdrError::Parse(String)` in `errors.rs`; Task 2 extends it.)

- [ ] **Step 1:** Write `scripts/capture-raw-fixtures.sh`. It runs only read-only commands (`herdr api snapshot`, `herdr machine list --json`, `herdr machine status --json`, and `herdr --machine "$HERDR_UI_TEST_MACHINE" api snapshot` if set) into `fixtures-raw/` (gitignored). Run it. Use the raw files only to learn shapes.
- [ ] **Step 2:** Hand-write the synthetic fixtures in `tests/fixtures/` with generic data. `snapshot_buildbox.json` must contain:
  - 2 workspaces (`w1` "api-service", `w2` "web-app");
  - 5 panes;
  - agents: one `blocked` claude in `/home/dev/projects/api-service`; one `done` codex in `/home/dev/projects/web-app`; one `working` copilot whose `foreground_cwd` is `/home/dev/projects/infra` but which sits in workspace `w1`; one `idle` agent with `name: null` in `/home/dev/projects`;
  - one plain shell pane in `/home/dev/projects/api-service/packages/db` and one in `/home/dev`;
  - one agent `agent_status` value `"thinking"`, to exercise `Unknown`.
  
  Also: `snapshot_local.json` with zero agents and one shell, and the error fixture `{"error":{"code":"agent_blocked","message":"agent is blocked"}}`. Run `scripts/check-no-personal-data.sh` and confirm it's clean.
- [ ] **Step 3:** Write the failing tests in `model.rs` `#[cfg(test)]`:
  - `parses_buildbox_snapshot`: 4 agents, 5 panes; the "thinking" agent maps to `Unknown`; the null name is `None`.
  - `parses_machine_list`: 3 profiles; field `target` == `"buildbox"`.
  - `parse_created_pane_handles_root_and_split`.
  - `raw_fixtures_parse_if_present`: iterates `../fixtures-raw/*.json` and parses snapshots. It passes vacuously if the directory is missing.
- [ ] **Step 4:** Run `cargo test herdr::model`. Expected: FAIL (types missing).
- [ ] **Step 5:** Implement the types and parsers above. Run `cargo test` and confirm `src/lib/bindings/` is generated.
- [ ] **Step 6:** `cargo test herdr::model` passes. Commit: `feat(core): herdr data model with synthetic fixtures`.

---

### Task 2: CLI runner, errors, command log, fake-herdr

**Files:** Create `src-tauri/src/herdr/{errors,cli}.rs`, `scripts/fake-herdr`, `src-tauri/tests/cli_integration.rs`.

**Interfaces:**
- Produces:
  - `enum HerdrError { NotFound, Spawn(String), Timeout { argv: Vec<String> }, Server { code: String, message: String }, Usage(String), Parse(String) }`, which implements `Serialize` + `TS` so the UI gets `{kind, ...}`.
  - `struct HerdrCli { bin: PathBuf, env: Vec<(String,String)>, log: Arc<Mutex<CommandLog>>, limits: Arc<Mutex<HashMap<String, Arc<Semaphore>>>> }`
  - `impl HerdrCli { pub fn new(bin: PathBuf, env: Vec<(String,String)>) -> Self; pub async fn run(&self, machine: Option<&str>, args: &[String], timeout: Duration) -> Result<Value, HerdrError>; pub fn log_snapshot(&self) -> Vec<CommandLogEntry> }`
  - `struct CommandLogEntry { at_ms: u64, machine: Option<String>, argv: Vec<String>, exit_code: Option<i32>, duration_ms: u64, error: Option<String> }` (ts-rs). Ring buffer of 200 entries.
  - Timeout constants: `T_DEFAULT = 10s`, `T_CREATE = 30s`, `T_AGENT_START = 45s`, `T_PROMPT = 30s`.
  - `scripts/fake-herdr`: bash. It reads `FAKE_HERDR_DIR`. It joins argv with `_` (after stripping the leading `--machine <id>` and recording it to `$FAKE_HERDR_DIR/calls.log` as one line per call) to find `<joined>.json`, `<joined>.stderr`, `<joined>.exit` and `<joined>.sleep`. It prints the stdout file, prints the stderr file to stderr, sleeps if asked, and exits with the code (default 0). If there's no match, it exits 2 with `unknown command`.

- [ ] **Step 1:** Write the failing integration tests (each builds a temp `FAKE_HERDR_DIR`):
  - `ok_json_parses`: `api snapshot` → Value with `result.snapshot`.
  - `exit1_maps_server_error`: stderr is the `agent_blocked` fixture → `Server{code:"agent_blocked"}`.
  - `exit2_maps_usage`.
  - `timeout_maps_timeout`: sleep 2, timeout 300 ms → `Timeout`, and the child is killed. Assert with `pgrep -f fake-herdr` that no fake-herdr remains after 1 s.
  - `machine_prefix_first`: `run(Some("p1"), ["agent","list"])` → `calls.log` line `--machine p1 agent list`.
  - `log_records_every_call`: 3 calls → 3 entries with argv and exit codes.
  - `env_is_forwarded`: fake-herdr echoes `$SSH_AUTH_SOCK` into its stdout JSON; assert that the value is passed through.
- [ ] **Step 2:** `cargo test --test cli_integration` fails.
- [ ] **Step 3:** Implement using `tokio::process::Command` with `kill_on_drop(true)`, `env_clear()` then the given env, `tokio::time::timeout`, and a per-machine semaphore of 4 (key `"local"` when there's no machine).
- [ ] **Step 4:** Tests pass. Commit: `feat(core): herdr CLI runner with typed errors and command log`.

---

### Task 3: Login environment and herdr discovery

**Files:** Create `src-tauri/src/env.rs`.

**Interfaces:**
- Produces:
  - `struct LoginEnv { vars: HashMap<String,String> }`
  - `fn parse_env_output(s: &str) -> LoginEnv` (NUL-separated, from `env -0`).
  - `async fn capture_login_env(shell: &str) -> LoginEnv` runs `<shell> -lc 'env -0'` with a 5 s timeout, and falls back to the process env.
  - `fn forwarded_env(login: &LoginEnv) -> Vec<(String,String)>` keeps `PATH, HOME, USER, SSH_AUTH_SOCK, LANG, TERM` (TERM defaults to `xterm-256color`).
  - `fn resolve_herdr(saved: Option<&Path>, login_path_hit: Option<PathBuf>, home: &Path, exists: &dyn Fn(&Path)->bool) -> Option<PathBuf>`. Order: saved, then login-shell `command -v herdr` hit, then `~/.local/bin/herdr`, `/opt/homebrew/bin/herdr`, `/usr/local/bin/herdr`.
  - `fn parse_version(s: &str) -> Option<(u32,u32,u32)>` parses `"herdr 0.9.4"`. `fn is_supported((u32,u32,u32)) -> bool` is ≥ 0.9.0.

- [ ] **Step 1:** Failing tests:
  - `resolution_order`: saved wins even if others exist; with no saved path, the login hit wins; otherwise `~/.local/bin` beats Homebrew; none → `None`.
  - `login_env_forwards_ssh_auth_sock`: `parse_env_output("PATH=/a\0SSH_AUTH_SOCK=/tmp/s\0X=1\0")` → forwarded contains `SSH_AUTH_SOCK=/tmp/s` and drops `X`.
  - `parse_version_variants`: `"herdr 0.9.4"`, `"herdr 0.10.0-preview.2"` → (0,10,0); garbage → None.
  - `support_floor`: 0.8.9 is false, 0.9.0 is true.
- [ ] **Step 2:** Run the tests and see them fail. **Step 3:** Implement. **Step 4:** Run the tests and see them pass. **Step 5:** Commit: `feat(core): login env capture and herdr discovery`.

---

### Task 4: Activity tracker (observed status-change times)

**Files:** Create `src-tauri/src/activity.rs`.

**Interfaces:**
- Produces:
  - `struct ActivityKey { machine_id: String, terminal_id: String }`
  - `struct ActivityRecord { status: AgentStatus, since_ms: Option<u64> }`
  - `struct Transition { machine_id, pane_id, terminal_id, from: AgentStatus, to: AgentStatus }`
  - `struct ActivityTracker { map: HashMap<ActivityKey, ActivityRecord> }` with `fn observe(&mut self, machine_id: &str, snap: &Snapshot, now_ms: u64) -> Vec<Transition>`, `fn since(&self, machine_id, terminal_id) -> Option<u64>`, `fn load(path) -> Self` (corrupt or missing → empty), `fn save(&self, path) -> io::Result<()>` (atomic: write tmp, then rename).
  - Rules: first sight of a key records `since_ms: None` and emits **no** transition. A status change sets `since_ms: Some(now)` and emits a transition. Keys for this machine that are absent from the snapshot are pruned. Keys for other machines are never touched.

- [ ] **Step 1:** Failing tests:
  - `first_sight_has_no_age_and_no_transition`.
  - `change_sets_since_and_emits`: idle → blocked at t=1000 gives `since(…)==Some(1000)` and one transition idle → blocked.
  - `same_status_keeps_since`.
  - `prunes_only_own_machine`.
  - `roundtrip_persist`: save, then load equals the original.
  - `corrupt_file_loads_empty`.
- [ ] **Step 2:** Run the tests and see them fail. **Step 3:** Implement. **Step 4:** Run the tests and see them pass. **Step 5:** Commit: `feat(core): activity tracker for observed status changes`.

---

### Task 5: App state and poller

**Files:** Create `src-tauri/src/{state,poller}.rs`. Modify `lib.rs` and `main.rs` to start the poller on app setup.

**Interfaces:**
- Consumes: `HerdrCli::run`, `parse_snapshot`, `parse_machine_list`, `ActivityTracker`.
- Produces (ts-rs exported):
  - `enum Health { Online, Reconnecting { retry_in_ms: u64, error: String }, Attention { error: String }, Disabled }`
  - `struct MachineView { id: String /* "local" for Local */, label: String, target: Option<String>, session: String, is_local: bool, health: Health, snapshot: Option<Snapshot>, last_ok_ms: Option<u64>, ages: HashMap<String /* terminal_id */, u64 /* since_ms */> }`
  - `struct AppState { machines: Vec<MachineView>, herdr_version: Option<String>, herdr_path: Option<String>, generated_at_ms: u64 }`
  - `fn next_delay(visible: bool, consecutive_failures: u32) -> Duration`: 0 failures → 2000 ms visible / 10000 ms hidden. With failures, backoff is 2 s·2^(n−1) capped at 60 s, regardless of visibility.
  - `fn classify_error(e: &HerdrError) -> Health`: `Server` codes or messages containing `auth`, `host key` or `permission denied` → `Attention`. Timeout or spawn/connection errors → `Reconnecting`.
  - `struct Poller` spawned as a tokio task. One loop per enabled machine plus Local. It reloads `machine list --json` every 30 s and on `Poller::refresh_now(machine_id: Option<&str>)`. It holds `visible: AtomicBool`, set from window focus/visibility events. It emits Tauri event `"state"` with the full `AppState` when any machine's snapshot hash, health or ages change. It feeds `Transition`s to a `tokio::sync::broadcast::Sender<Transition>` (consumed by Task 15). It saves `activity.json` in `app_data_dir` at most every 5 s.
  - Disabled profiles appear with `Health::Disabled` and aren't polled.

- [ ] **Step 1:** Failing unit tests:
  - `next_delay_table`: (true,0) 2 s; (false,0) 10 s; (true,1) 2 s; (true,3) 8 s; (false,10) 60 s.
  - `classify_auth_is_attention`.
  - `classify_timeout_is_reconnecting`.
- [ ] **Step 2:** Failing integration test `poller_isolates_failing_machine` (fake-herdr: `machine list` returns 2 profiles; `--machine good api snapshot` ok; `--machine bad api snapshot` exits 1 with an auth error). Run the poller for about 3 s with a test hook that captures emitted states, instead of Tauri. Assert that `good` is `Online` with a snapshot, `bad` is `Attention` with its previous snapshot preserved (seed one first), and `good` kept updating after `bad` failed. To make it testable, the poller takes an `emit: Arc<dyn Fn(AppState) + Send + Sync>` instead of an `AppHandle`.
- [ ] **Step 3:** Run the tests and see them fail. **Step 4:** Implement. **Step 5:** Run the tests and see them pass, then run `pnpm tauri dev` and check in devtools that `"state"` events arrive. **Step 6:** Commit: `feat(core): per-machine poller emitting app state`.

---

### Task 6: Frontend foundations: tokens, fonts, IPC, grouping

**Files:** Create `src/styles/{tokens,global}.css`, `src/fonts/*` (Geist and Geist Mono woff2 plus `OFL.txt`, from the official vercel/geist-font release or fontsource packages), `src/lib/{ipc,grouping,format}.ts` with tests, and `src/store/appStore.ts`.

**Interfaces:**
- Consumes: ts-rs bindings (`AppState`, `MachineView`, `Agent`, `Pane`, `AgentStatus`, `HerdrError`, `CommandLogEntry`).
- Produces:
  - `tokens.css`: CSS variables `--bg #0B0C0E`, `--bg-sidebar #101114`, `--panel #0F1013`, `--panel-2 #121317`, `--raised #1E2025`, `--border #1F2126`, `--border-strong #2A2D33`, `--text #ECECEF`, `--text-2 #C9CBD1`, `--text-3 #A3A5AD`, `--text-4 #8B8E97`, `--muted #7C7F88`, `--st-needs #FFA94D`, `--st-done #8FD3FF`, `--st-working #6E93FF`, `--st-idle #A3A5AD`, `--online #7EE0B0`, `--danger #FF9B94`, `--radius-s 6px`, `--radius-m 8px`, `--radius-l 12px`, `--radius-xl 14px`, `--font-sans "Geist"`, `--font-mono "Geist Mono"`, body 13px/1.45.
  - `type Row = { key: string /* `${machineId}::${paneId}` */, machineId, machineLabel, paneId, terminalId, kind: string | null /* null = shell */, name: string, title: string, status: AgentStatus | 'shell', folder: string | null, sinceMs: number | null }`
  - `toRows(state: AppState): Row[]`: one row per agent; plus one row per pane without an agent, as `status: 'shell'`.
  - `displayName(a: Agent): string`: name → terminal_title_stripped → `${agent} · ${pane_id}`.
  - `isNeedsYou(r: Row): boolean`: blocked or done.
  - `needsYou(rows): Row[]`: blocked first, then done; within those, `sinceMs` ascending (oldest first, nulls last).
  - `type Group = { key: string, machineId, machineLabel, name: string, folder: string | null, rows: Row[], tier: 0|1|2|3 }`
  - `groupByProject(rows): Group[]` implements spec §7 rules 1–5 exactly. `isHomeLike(path)` = `^/(Users|home)/[^/]+/?$` or `/root`, or an ancestor (`/`, `/Users`, `/home`). Container = `^/(Users|home)/[^/]+/(projects|work|code|src|dev)/?$`. A "Loose sessions" group per machine has key `${machineId}::__loose`, tier 3.
  - `groupByWorkbox(rows)` and `groupByStatus(rows)` (order: blocked, done, working, idle, unknown, shell).
  - `formatAge(sinceMs, nowMs): string | null`: `<60s` → "now", minutes "2m", hours "3h", days "2d"; null → null.
  - `shortPath(path, machine)`: replaces `/home/<u>` or `/Users/<u>` with `~`.
  - `ipc.ts`: `onState(cb)`, `invokeTyped<K extends CommandName>(name, args)`, which wraps errors into `HerdrError`. The command names are listed in Task 7.
  - `appStore.ts` (Zustand): `{ state: AppState | null, selectedKey: string | null, groupBy: 'project'|'workbox'|'status', sheet: null | 'new-session' | 'add-workbox', view: {kind:'home'} | {kind:'workbox', machineId}, activityOpen: boolean }`, plus setters.

- [ ] **Step 1:** Failing Vitest tests in `src/lib/grouping.test.ts`, using a TS fixture equal to Task 1's `snapshot_buildbox.json` (import the JSON directly):
  - `project_groups_follow_foreground_cwd`: the copilot agent in workspace w1 lands in group "infra", not "api-service".
  - `home_and_container_never_group`: the agent in `/home/dev/projects` and the shell in `/home/dev` land in "Loose sessions".
  - `shell_joins_enclosing_agent_group`: the shell in `api-service/packages/db` lands in "api-service".
  - `tier_order`: the api-service (blocked) group comes first, then web-app (done → tier 0 too, sorted by name after api-service), then infra (working), then Loose last.
  - `same_name_other_machine_separate`: a second machine with "api-service" gives two groups with different keys.
  - `needs_you_order`, `display_name_fallbacks`, `format_age_cases`, `unknown_status_kept`.
- [ ] **Step 2:** Run the tests and see them fail. **Step 3:** Implement. **Step 4:** `pnpm test` passes. **Step 5:** Commit: `feat(ui): tokens, fonts, IPC, and pure grouping logic`.

---

### Task 7: Actions and Tauri commands

**Files:** Create `src-tauri/src/{actions,commands}.rs`. Modify `main.rs` (register the commands) and `src/lib/ipc.ts` (`CommandName` union).

**Interfaces:**
- Consumes: `HerdrCli`, `Poller::refresh_now`, `parse_created_pane`, timeouts.
- Produces:
  - `enum Placement { NewTab { workspace_id: String }, SplitBeside { pane_id: String }, NewWorkspace, Worktree { branch: String, trust: bool } }`
  - `struct NewSessionRequest { machine_id: String, cwd: String, kind: Option<String> /* None = shell */, name: String, placement: Placement, agent_args: Vec<String> }`
  - `fn validate_name(name) -> Result<(), String>`: `^[a-z][a-z0-9_-]{0,31}$`.
  - `fn plan_new_session(req) -> Vec<Vec<String>>`: the ordered argv list with `{PANE}` as a placeholder in the `agent start` step. This is the same list the UI shows as the command preview (spec §9.3):
    - NewTab → `["tab","create","--workspace",W,"--cwd",cwd,"--label",name,"--no-focus"]`
    - SplitBeside → `["pane","split",P,"--direction","right","--cwd",cwd,"--no-focus"]`
    - NewWorkspace → `["workspace","create","--cwd",cwd,"--label",name,"--no-focus"]`
    - Worktree → `["worktree","create","--cwd",cwd,"--branch",B,"--label",name,"--no-focus"]` plus `"--trust-repository"` only when `trust`
    - then, if `kind` is set: `["agent","start",name,"--kind",kind,"--pane","{PANE}"]` plus `["--", …agent_args]` when non-empty.
  - `async fn create_session(cli, req) -> Result<CreatedSession { pane_id, terminal_id: Option<String> }, ActionError>`. It runs step 1, extracts the pane via `parse_created_pane`, substitutes `{PANE}`, and runs step 2 with `T_AGENT_START`. If step 2 fails, it returns an error that says the pane was created (pane id included) and does not close it.
  - `enum ActionError { Herdr(HerdrError), MaybeApplied { argv, message }, Invalid(String) }`. A `Timeout` on any mutation becomes `MaybeApplied` and triggers `refresh_now`.
  - Tauri commands (camelCase in TS): `createSession(req)`, `previewNewSession(req) -> string[]` (human-readable command lines, including the `--machine <label>` prefix), `renameSession{machineId,paneId,isAgent,name}` (`agent rename P NAME` or `pane rename P NAME`), `closePane{machineId,paneId}`, `renameTab`, `closeTab`, `renameWorkspace`, `closeWorkspace` (on `Server{code:"workspace_group_close_required"}` it returns `ActionError::Herdr` unchanged; the UI handles it per spec §7), `replyToAgent{machineId,paneId,text}` (refuses locally with `Invalid` if the cached status is blocked), `markSeen{machineId,paneId}` (`agent focus P`; spec §7 caveat: in Task 7 step 5, manually verify on the test machine that `agent focus` turns `done` into `idle` without moving an attached client's view. If it does move it, switch `markSeen` to a local seen-set persisted beside `activity.json` and note it in the spec), `createTab{machineId,workspaceId,label}` (`tab create --workspace W --label L --no-focus`), `createWorkspace{machineId,cwd,label}` (`workspace create --cwd C --label L --no-focus`), `machineRename{id,label}`, `machineSetEnabled{id,enabled}`, `machineRemove{id}`, `machineStatus{id}`, `refreshNow{machineId?}`, `getCommandLog()`, `listAgentKinds()` (parse `herdr agent start --help` "possible values:"; fallback `["claude","codex","copilot","opencode","cursor"]`).
  - Every command resolves a local machine id `"local"` to `None` for `--machine`.

- [ ] **Step 1:** Failing unit tests:
  - `plan_new_tab_agent` exact argv lists.
  - `plan_split_shell`: one step only.
  - `plan_worktree_trust_flag_only_when_true`.
  - `agent_args_after_double_dash`.
  - `validate_name_cases`: `"orders-index"` ok; `"Orders"`, `"1abc"`, and 33 chars rejected.
- [ ] **Step 2:** Failing integration tests with fake-herdr:
  - `create_session_threads_pane_id`: `calls.log` shows `agent start … --pane w1:p5`.
  - `agent_start_failure_reports_created_pane`.
  - `timeout_triggers_refresh_without_retry`: `tab create` sleeps past the timeout → `MaybeApplied`; `calls.log` has exactly one `tab create`; the refresh hook was called.
  - `reply_refused_when_blocked`: no herdr call is made.
- [ ] **Step 3:** Run the tests and see them fail. **Step 4:** Implement. **Step 5:** Run the tests and see them pass, then do the `agent focus` check described under `markSeen`. **Step 6:** Commit: `feat(core): typed actions with command preview`.

---

### Task 8: Terminal launchers

**Files:** Create `src-tauri/src/terminal/*.rs`. Add commands `openSession`, `openFullHerdr`, `listTerminals`, `copyAttachCommand` to `commands.rs`.

**Interfaces:**
- Produces:
  - `enum TerminalId { Ghostty, ITerm2, TerminalApp, Warp, WezTerm, Kitty, Alacritty, Custom }` with bundle ids: `com.mitchellh.ghostty`, `com.googlecode.iterm2`, `com.apple.Terminal`, `dev.warp.Warp-Stable`, `com.github.wez.wezterm`, `net.kovidgoyal.kitty`, `org.alacritty`.
  - `fn shell_quote(s: &str) -> String`: POSIX single-quote escaping.
  - `fn attach_argv(machine: &MachineView, terminal_id: &str) -> Vec<String>`. Local session `default`: `["herdr","terminal","attach",T]`. Local with another session: `["env","HERDR_SESSION=s","herdr","terminal","attach",T]`. Remote: `["ssh","-t",target,"<remote string>"]`, where the remote string is one shell-quoted command implementing the takeover fallback (the decision below).
  - **Decision (spec §7 "Open behaviour"):** the app can't observe an attach that fails inside the user's terminal, so the command itself carries the fallback: `herdr terminal attach T || { printf '\nAnother client owns this session. Take over? [y/N] '; read a; [ "$a" = y ] && exec herdr terminal attach T --takeover; }`, wrapped as `sh -c '<that>'` (with `HERDR_SESSION` exported when non-default). The same wrapper is used locally.
  - `fn full_ui_argv(machine) -> Vec<String>`: local `["herdr"]` (plus `--session s` if non-default); remote `["herdr","--remote",target]` plus `["--session",s]` if non-default.
  - `struct LaunchSpec { program: String, args: Vec<String> }`. AppleScript launchers use `program = "osascript"` with `-e` lines.
  - `trait Launcher { fn id(&self) -> TerminalId; fn spec(&self, cmd: &[String], mode: OpenMode, title: &str) -> LaunchSpec; }` with `enum OpenMode { Tab, Window }`.
    - Ghostty: `open -na Ghostty.app --args -e <cmd…>` (always a window; document it).
    - iTerm2: AppleScript `create window with default profile command "<joined>"`, or in Tab mode `tell current window to create tab with default profile command "<joined>"`.
    - Terminal: AppleScript `do script "<joined>"`.
    - WezTerm: `open -na WezTerm --args start -- <cmd…>`.
    - Kitty: `open -na kitty --args <cmd…>`.
    - Alacritty: `open -na Alacritty --args -e <cmd…>`.
    - Warp: write a launch configuration YAML to `~/.warp/launch_configurations/crafted-herdr-<hash>.yaml` (one window, one tab, commands `[<joined>]`), then `open "warp://launch/crafted-herdr-<hash>.yaml"`. If that proves impossible in manual QA, fall back to opening Warp plus copying the command to the clipboard, with a toast.
    - Custom: `/bin/sh -c <template with {attach} replaced by the joined, quoted command>`.
    - In AppleScript strings, escape `\` and `"`.
  - `fn detect_installed() -> Vec<TerminalId>` via `mdfind "kMDItemCFBundleIdentifier == '<id>'"`. Terminal is always present.
  - `fn default_terminal(installed) -> TerminalId`: Ghostty, then iTerm2, then Warp, then Terminal.

- [ ] **Step 1:** Failing tests:
  - `quoting_survives_hostile_strings`: titles and terminal ids containing `' " $ \` ; |` and `ünïcode` round-trip through `sh -c 'printf %s <quoted>'` unchanged. Run real `/bin/sh` in the test.
  - `remote_attach_shape`: target `buildbox`, session `default` → argv[0..3] == `["ssh","-t","buildbox"]`, and argv[3] contains `herdr terminal attach term_1` and `--takeover` inside the fallback.
  - `non_default_session_exports_env`.
  - `iterm_applescript_escapes_quotes`.
  - `custom_template_substitution`.
  - `default_terminal_preference`.
- [ ] **Step 2:** Run the tests and see them fail. **Step 3:** Implement. **Step 4:** Run the tests and see them pass. **Step 5:** Manual: with `pnpm tauri dev`, call `openSession` from devtools for a local shell pane in iTerm2 and in Terminal. Each opens attached; `ctrl+b q` detaches. **Step 6:** Commit: `feat(core): terminal launchers with safe quoting`.

---

### Task 9: App shell and Home screen

**Files:** Create `src/App.tsx`, `src/components/{Header,Sidebar,NeedsYouCard,ProjectGroup,AgentRow,StatusPill,KindBadge,CommandBox}.tsx`, `src/screens/Home.tsx`, and tests `src/screens/Home.test.tsx`.

**Interfaces:**
- Consumes: `appStore`, `toRows`, `needsYou`, `groupBy*`, `formatAge`, `ipc.onState`, and commands `openSession`, `markSeen`.
- Produces: `<Home/>`, matching spec §9.1. The canvas layout is a sidebar of 220 px, a fluid main column, and a 360 px inspector slot that Task 10 fills. The header sits under the overlay title bar with a 78 px left inset for the traffic lights and is a drag region (`data-tauri-drag-region`). Every interactive element is a real `<button>`/`<a>`/`<input>` with a visible focus ring.
  - Keyboard: ↑/↓ moves selection through visible rows; ⌘↩ runs `openSession` on the selection; ⌘K focuses search, which filters rows by name/title/folder/machine; ⌘R calls `refreshNow`; ⌫ on a selected row opens the close confirmation (Task 10's `ConfirmDialog`). ⌘N opens the new-session sheet.
  - The "Opens in <Terminal>" header picker reads and writes the `terminal` setting (Task 15 provides the settings store; until then, use the default).

- [ ] **Step 1:** Failing RTL tests with a fixture `AppState` built from two machines (`buildbox` and `gpubox`, both containing pane `w1:p1`):
  - `needs_you_section_lists_blocked_then_done` with labels "Needs approval"/"Needs input" and "Done, unseen".
  - `selection_is_machine_scoped`: clicking the gpubox `w1:p1` row selects key `gpubox::w1:p1`, and the buildbox row is not selected.
  - `group_toggle_switches_views`.
  - `open_button_invokes_openSession_with_machine_and_terminal_id` (mock `invokeTyped`).
  - `attention_machine_rows_are_dimmed_with_error`.
  - `search_filters_rows`.
- [ ] **Step 2:** Run the tests and see them fail. **Step 3:** Implement. **Step 4:** Run the tests and see them pass. Do a manual check against live state in `pnpm tauri dev`. **Step 5:** Commit: `feat(ui): home screen with needs-you and project groups`.

---

### Task 10: Inspector: preview, reply, rename, close

**Files:** Create `src/components/{Inspector,Preview,ConfirmDialog,Toast}.tsx` and tests. Rust: add `startPreview{machineId,paneId,isAgent}` / `stopPreview` to `commands.rs`, emitting a `"preview"` event `{key, text}` every 2 s while active (`agent read P --source recent-unwrapped --lines 60 --format text`, or `pane read …` for shells). There's one active preview at a time, and it pauses when the window is hidden.

**Interfaces:**
- Consumes: `replyToAgent`, `renameSession`, `closePane`, `copyAttachCommand`, `openSession`, `markSeen`.
- Produces: `<Inspector row={Row} machine={MachineView}/>`, matching spec §9.1. `<ConfirmDialog title body confirmLabel danger onConfirm/>`, used by all destructive actions. `<Toast>` shows `MaybeApplied` as "May have been applied; refreshing…".

- [ ] **Step 1:** Failing tests:
  - `reply_disabled_for_blocked_with_hint` ("Answer this in the terminal").
  - `reply_sends_and_clears`.
  - `close_requires_confirmation`: no invoke until confirmed.
  - `rename_validates_name` (reuse `validate_name` rules mirrored in TS: `^[a-z][a-z0-9_-]{0,31}$` for agents; anything non-empty for panes).
  - `command_box_shows_exact_attach_argv` from `copyAttachCommand`.
- [ ] **Step 2:** Run the tests and see them fail. **Step 3:** Implement. **Step 4:** Run the tests and see them pass. **Step 5:** Commit: `feat(ui): inspector with live preview and session actions`.

---

### Task 11: New session sheet

**Files:** Create `src/screens/NewSession.tsx`, `src/components/Sheet.tsx`, and tests.

**Interfaces:**
- Consumes: `previewNewSession`, `createSession`, `listAgentKinds`, `openSession`, and settings `terminal`/open-after-create.
- Produces: the sheet per spec §9.3. Recent folders = the distinct agent/pane folders on the selected machine from the current snapshot (max 6). "Browse…" uses the Tauri dialog plugin and is shown for Local only. The Placement select options are built from that machine's workspaces (new tab in each), "Split beside <selected>" when the selection is on that machine, "New workspace", and the worktree checkbox with a branch. The command preview re-renders on every change (debounced 150 ms). Create is disabled until the name is valid and the folder is non-empty. On success, it optionally calls `openSession` for the new pane, closes the sheet, and selects the new row once it appears.
- On `Server` errors mentioning trust (code `repository_not_trusted`, or a message containing "trust"), show herdr's message and a "Trust this repository and retry" button that resubmits with `trust: true`.

- [ ] **Step 1:** Failing tests:
  - `preview_matches_backend_plan`: the mock returns the lines, and they're rendered verbatim.
  - `create_disabled_until_valid`.
  - `shell_kind_omits_agent_start_line`.
  - `trust_retry_flow`.
  - `cmd_enter_submits`.
- [ ] **Step 2:** Run the tests and see them fail. **Step 3:** Implement. **Step 4:** Run the tests and see them pass. **Step 5:** Commit: `feat(ui): new session sheet with command preview`.

---

### Task 12: Workbox screen and machine/workspace management

**Files:** Create `src/screens/Workbox.tsx`, `src/components/{TabCard,PaneBox}.tsx`, and tests.

**Interfaces:**
- Consumes: `createTab`, `createWorkspace`, `machineRename`, `machineSetEnabled`, `machineRemove`, `machineStatus`, `renameTab`/`closeTab`/`renameWorkspace`/`closeWorkspace`, `openFullHerdr`, and `openSession`. Reconnect = `openSession`-style launch of `["herdr","machine","reconnect",id]` via a new command `openInTerminal{argv}`, restricted on the Rust side to an allowlist of argv shapes: `machine reconnect <id>`, `machine add …`, and `--remote …`.
- Produces: the screen per spec §9.2. Pane boxes show the kind badge, name, status label, and the last preview line (a `pane read --lines 1` refresh every 10 s, only for visible tab cards, capped at 12 panes). Remove and Disable confirm first, and the Remove copy says remote sessions keep running. `closeWorkspace` → on `workspace_group_close_required`, open a dialog listing linked worktree workspaces (snapshot workspaces whose label or `worktree` provenance links them; if unknown, show herdr's message only) with per-item Close buttons, each confirmed.

- [ ] **Step 1:** Failing tests:
  - `renders_tabs_with_pane_boxes`.
  - `remove_requires_confirm_and_copy`.
  - `group_close_flow_shows_dialog`.
  - `reconnect_uses_openInTerminal_allowlisted_argv`.
  - Rust: `open_in_terminal_rejects_unlisted_argv`.
- [ ] **Step 2:** Run the tests and see them fail. **Step 3:** Implement. **Step 4:** Run the tests and see them pass. **Step 5:** Commit: `feat(ui): workbox screen with machine and layout management`.

---

### Task 13: Add workbox, part 1: SSH hosts and Continue in terminal

**Files:** Create `src-tauri/src/ssh_config.rs`, `src/screens/AddWorkbox.tsx`, and tests.

**Interfaces:**
- Produces:
  - `fn parse_ssh_hosts(content: &str) -> Vec<String>`: `Host` line tokens without `*`, `?` or `!`. It follows `Include` directives one level, relative to `~/.ssh/`, with globs expanded. It's case-insensitive on keywords and dedupes, preserving order. It's exposed as command `listSshHosts()` and never returns anything except alias names.
  - `fn machine_add_argv(target, label: Option, session: Option) -> Vec<String>` → `["herdr","machine","add",target]` plus `--label L` and `--remote-session S`.
  - The AddWorkbox sheet per spec §9.4 runs "Continue in terminal" as the primary action in this task: `openInTerminal(machine_add_argv…)`, then polls `machine list` every 2 s for up to 10 min until a profile with that target appears, then closes with a success toast. The checklist shows "Waiting for setup in <Terminal>…".
- [ ] **Step 1:** Failing tests:
  - `parses_hosts_skips_wildcards` (input `Host buildbox gpubox\nHost *.internal\nHost !bad\n  HostName 10.0.0.1`).
  - `follows_include_one_level`.
  - `argv_with_label_and_session`.
  - UI: `continue_in_terminal_then_detects_new_profile`.
- [ ] **Step 2:** Run the tests and see them fail. **Step 3:** Implement. **Step 4:** Run the tests and see them pass. **Step 5:** Commit: `feat: add workbox via terminal handoff`.

### Task 14: Add workbox, part 2: native prompts over a pty

**Files:** Create `src-tauri/src/machine_setup.rs` and `src-tauri/tests/fixtures/machine_add/*.txt` (transcripts). Modify `AddWorkbox.tsx`.

**Interfaces:**
- Produces:
  - `enum SetupEvent { Output(String), Step { step: SetupStep, state: StepState, meta: Option<String> }, Prompt(SetupPrompt), Finished { ok: bool }, Stalled }`
  - `enum SetupStep { Ssh, HerdrInstalled, ServerStarted, SessionsFound }`
  - `enum SetupPrompt { PickSession { options: Vec<String> }, ConfirmInstall { version: Option<String>, path: Option<String> }, ConfirmReplace { message: String } }`
  - `fn classify(tail: &str) -> Option<SetupPrompt>` and `fn step_updates(line: &str) -> Vec<(SetupStep, StepState)>`, both pure. Their patterns are taken from herdr's source at the installed version's tag (`github.com/herdrdev/herdr`, files implementing `machine add` / remote setup). Record the source file path and tag in a comment, and write the transcripts as fixtures.
  - Commands `startMachineAdd{target,label,session}` → events `"machine-setup"`; `answerMachineSetup{choice}` sends `y\n` or `n\n` (default No), or arrow keys plus Enter for the session index; `cancelMachineSetup`. No output and no recognized prompt for 5 s while the process is alive → `Stalled`, and the UI offers "Continue in terminal" (Task 13). Success = re-read `machine list`.
- [ ] **Step 1:** Fetch herdr's source at the tag matching `herdr --version` (read-only `git clone --depth 1 --branch v0.9.4` into `fixtures-raw/herdr-src/`, gitignored). Write transcripts for: fresh install consent, replace consent, session picker with 2 sessions, and already-installed success.
- [ ] **Step 2:** Failing tests: `classifies_install_prompt`, `classifies_replace_prompt_default_no`, `classifies_session_picker_options`, `success_transcript_marks_all_steps`, `unknown_text_is_none`.
- [ ] **Step 3:** Run the tests and see them fail. **Step 4:** Implement with `portable-pty` (cols 120, rows 40, env from `forwarded_env`). **Step 5:** Run the tests and see them pass.
- [ ] **Step 6:** Live QA, opt-in only (`HERDR_UI_LIVE=1`): `startMachineAdd` against `$HERDR_UI_TEST_MACHINE`'s SSH target with `--remote-session herdr-ui-qa` and label `herdr-ui-qa`. Confirm the session-start path completes. Clean up with `herdr machine remove <new profile id>`, then `ssh <target> 'herdr session stop herdr-ui-qa && herdr session delete herdr-ui-qa'`. Never answer "replace" for the `default` session. For the install path, use a local Docker container (`linuxserver/openssh-server`, arm64, no herdr), mapped on localhost:2222 with a throwaway key generated in `fixtures-raw/`.
- [ ] **Step 7:** Commit: `feat: native machine-add prompts over pty`.

---

### Task 15: Settings, tray, menu bar popover, notifications, shortcuts

**Files:** Create `src-tauri/src/{settings,notify,tray}.rs`, `src/screens/{Settings,MenuBar}.tsx`, `src/popover.tsx` (second Vite entry `popover.html`), and tests.

**Interfaces:**
- Produces:
  - `struct Settings` with the exact keys and defaults of spec §8.8 plus `open_after_create: bool = true`. It's stored with `tauri-plugin-store` in `settings.json`. Commands are `getSettings()` and `setSettings(patch)` (merge; validate `poll_interval_*` ≥ 1000). Changes apply live: the poller intervals update and the herdr path triggers re-resolution.
  - The Settings window (label `settings`, 880×640, opened by ⌘, and the sidebar link) follows spec §9.5 with sections General, Terminal, Workboxes (list with enable toggles), Notifications, herdr CLI (path, version, Choose binary…), and Shortcuts (read-only list plus the global shortcut toggle).
  - Tray: a monochrome template icon. The title shows the needs-you count when > 0. Left click toggles the `popover` window (380×560, frameless, `alwaysOnTop`, hidden on blur, positioned under the tray via `tauri-plugin-positioner` `TrayCenter`). The right-click menu has Open Crafted Herdr, New session…, Settings…, and Quit. Closing `main` hides it (app keeps running); ⌘Q quits.
  - `notify.rs` consumes `Transition`s. A transition to `blocked` notifies (if `notify_blocked`) with title `"<display name> needs you"` and body `"<project folder name> · <machine label>"`. A transition to `done` notifies (if `notify_done`) with title `"<display name> finished"`. Clicking a notification shows `main` and emits `"focus-row"` with the row key. There are no notifications for first-sight states.
  - Global shortcut ⌥⌘H toggles `main` when `global_shortcut_enabled`.
  - MenuBar screen per spec §9.6, reusing `needsYou`/`toRows`.
- [ ] **Step 1:** Failing tests:
  - Rust: `settings_defaults_match_spec`, `settings_patch_validates_intervals`, `notification_text_for_blocked_and_done`, `no_notification_on_first_sight`.
  - UI: `menubar_lists_needs_you_then_working`, `settings_terminal_radio_disables_missing`.
- [ ] **Step 2:** Run the tests and see them fail. **Step 3:** Implement. **Step 4:** Run the tests and see them pass. Manual: close the window → the tray stays; the popover opens under the tray; triggering a blocked agent on the test machine produces one notification. **Step 5:** Commit: `feat: settings, tray popover, notifications, global shortcut`.

---

### Task 16: Onboarding, empty and error states, activity drawer

**Files:** Create `src/screens/Onboarding.tsx`, `src/components/{EmptyState,ActivityDrawer}.tsx`, and tests.

**Interfaces:**
- Consumes: `AppState.herdr_path` (null → onboarding), `herdr_version` (unsupported → warning banner), `getCommandLog()`.
- Produces: the states listed in spec §9 "Empty and error states", in the canvas style:
  - **Onboarding:** an install link to herdr.dev and "Choose binary…", which sets `herdr_path` and re-resolves.
  - **No workboxes:** a card with "Add workbox".
  - **Attention row:** dimmed, with the error and a suggested CLI command (from Task 5's `classify_error`; for `Attention`, suggest `herdr machine reconnect <label>`).
  - **No agents anywhere:** "Start one with ⌘N".
  - **Stale data:** "last updated 40s ago", from `last_ok_ms`.
  - **Activity drawer:** toggled from the sidebar footer and ⌘⇧A. It lists the command log (time, machine label, argv joined, exit, duration), with copy per line.
- [ ] **Step 1:** Failing tests: `onboarding_when_no_herdr`, `unsupported_version_banner`, `empty_agents_state`, `stale_label_from_last_ok`, `activity_drawer_lists_commands`.
- [ ] **Step 2:** Run the tests and see them fail. **Step 3:** Implement. **Step 4:** Run the tests and see them pass. **Step 5:** Commit: `feat(ui): onboarding, empty/error states, activity drawer`.

---

### Task 17: CI, release, docs, QA checklist

**Files:** Create `.github/workflows/{ci,release}.yml`, `CONTRIBUTING.md`, `docs/qa-checklist.md`, app icons (`pnpm tauri icon` from a simple generated 1024 px SVG: a terminal-chevron mark, monochrome on graphite). Rewrite `README.md`.

**Interfaces:**
- `ci.yml` runs on PRs and on pushes to main, on `macos-14`. It runs pnpm install, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `cargo fmt --check`, `cargo clippy -- -D warnings`, `cargo test`, `scripts/check-no-personal-data.sh`, and `pnpm tauri build --debug`.
- `release.yml` runs on `v*` tags: `pnpm tauri build --target universal-apple-darwin`, uploading the `.dmg` to a draft GitHub Release (`softprops/action-gh-release`), unsigned.
- README sections:
  - what it is (an unofficial companion to herdr, not affiliated);
  - screenshots (generated from fixture data only);
  - requirements (herdr ≥ 0.9, macOS 13+);
  - install from the release plus `xattr -dr com.apple.quarantine "/Applications/Crafted Herdr.app"`;
  - how it uses your herdr CLI (it lists the commands it runs);
  - the terminal support matrix, including Ghostty always opening a window and the AppleScript automation permission prompt;
  - privacy (no network calls of its own, keys stay with OpenSSH);
  - development (`pnpm i && pnpm tauri dev`, fake-herdr, `.env.local`);
  - license MIT.
- `docs/qa-checklist.md`: the manual checks from spec §11, written against generic "test workbox" wording.
- [ ] **Step 1:** Write the workflows and run `act`-free local equivalents: every command listed in ci.yml passes locally.
- [ ] **Step 2:** Write the docs, then run `scripts/check-no-personal-data.sh`; it must exit 0.
- [ ] **Step 3:** `pnpm tauri build` produces `Crafted Herdr.app`. Launch it from Finder (not the terminal) and confirm herdr is found via the login shell and remote machines show Online (verifies Review Focus 5).
- [ ] **Step 4:** Commit: `chore: CI, release workflow, docs, QA checklist`.

---

## Final review (Opus)

Run the whole-branch review against the spec, the Global Constraints and the Review Focus list. Then run the `docs/qa-checklist.md` pass with the maintainer on the real machines. Pushing to `origin` happens only when the maintainer asks.
