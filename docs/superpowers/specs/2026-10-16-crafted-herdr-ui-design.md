# crafted-herdr-ui: design

Date: 2026-10-16
Status: draft for review
Visual design: an approved design canvas kept by the maintainer (not public). Section 9 describes every screen in full, so the build does not depend on it.

## 1. Intent

[Herdr](https://herdr.dev) is a terminal workspace manager for AI coding agents. It keeps agents running in persistent panes on local and remote ("workbox") machines. Its only interface is a TUI, and the people using it daily find that painful:

- too many keyboard shortcuts to remember (prefix key, navigate mode, per-action keys);
- moving between sessions inside the same workbox is slow;
- opening or closing a session (a terminal) takes several shortcut steps;
- agents pile up in one place and are hard to split by project or by workbox. A typical case: a workbox has one workspace labelled after project A, and it holds two agents, one of which actually works in project B.

**crafted-herdr-ui** is an open-source macOS desktop app that sits on top of the user's installed `herdr` CLI. It shows every workbox and every agent, grouped by project, with "what needs me" first. It lets you open any session in **your own terminal** (Ghostty, iTerm2, Warp, Terminal, WezTerm, Kitty, or a custom command) with one click, and it can create, rename and close sessions and manage workboxes without shortcuts.

The app is a control plane, not a terminal. Herdr keeps owning the processes; your terminal keeps owning the typing.

## 2. Goals

1. One window shows all machines (Local plus every saved Herdr SSH machine) and all their agents and plain shell panes.
2. Agents that need the user (`blocked`, or `done` and not yet seen) sit at the top, across all machines.
3. Everything else is grouped by project (the agent's working folder). Group by workbox and by status are alternative views.
4. "Open" attaches the chosen pane in the user's preferred terminal app in one click.
5. Create a session (shell or a supported agent) on any workbox, in a chosen folder, optionally in a new git worktree, and optionally open it right away.
6. Rename and close sessions; create, rename and close workspaces and tabs.
7. Add, rename, enable, disable, remove and reconnect workboxes, wrapping `herdr machine …`.
8. A read-only live preview of the selected agent's terminal, and a way to send a prompt to an idle or done agent without opening a terminal.
9. A menu bar item with a compact "needs you / working" list and macOS notifications when an agent becomes blocked or done.
10. Every action is a `herdr` CLI call that the user can see (and copy) in the UI.

## 3. Non-goals (v1)

- No embedded terminal emulator. Typing happens in the user's terminal. (The `herdr terminal session control` bridge makes an embedded view possible later; it is out of scope now.)
- No replacement or fork of the Herdr server, and no private protocol. Only the public CLI.
- No Windows or Linux builds in v1. Nothing in the architecture should rule them out (Tauri), but there's no CI, testing or packaging for them.
- No plugin marketplace, config.toml editor, or keybinding editor.
- No Apple code signing or notarization in v1 (unsigned builds plus documented `xattr` workaround). Signing is a later task.
- No account, telemetry, or network calls other than SSH done by herdr itself.

## 4. Anti-goals (failure even if it "works")

- The app changing remote state without the user asking: installing herdr, stopping or replacing a server, closing panes it did not create, or answering an agent's approval prompt on its own.
- Hiding what it runs. Every mutating action must be traceable to a visible `herdr` command.
- Being slower to "find agent → be typing in it" than the TUI. Target: ≤ 2 clicks and < 1.5 s on a warm SSH connection.
- Storing passwords, keys or tokens. Authentication stays with OpenSSH, as in herdr.
- Feeling like a web page: it must behave like a Mac app (native window chrome, ⌘ shortcuts, menu bar, notifications, light work in background).

## 5. Facts about herdr this design rests on (verified 2026-10-16, herdr 0.9.3 to 0.9.4)

- Hierarchy: **machine** (Local or a saved SSH profile) → **session** (a server namespace; a profile targets exactly one) → **workspace** (`w1`) → **tab** (`w1:t1`) → **pane** (`w1:p1`). An **agent** is a recognized program inside a pane. IDs and agent names are scoped to one server; two machines can both have `w1:p1`.
- Agent states: `blocked`, `working`, `done` (finished, not yet seen), `idle`, `unknown`.
- Most control commands print JSON on stdout. Server errors print JSON on stderr and exit 1; CLI syntax errors exit 2.
- `herdr machine list --json` → `[{id,label,target,session,enabled,selected}]`.
- `herdr machine status [--json]` → `[{id,label,status:"reachable"|…,error}]` (non-interactive).
- `herdr --machine <label-or-id> <api command>` routes any API command to a saved machine over a shared, reused SSH connection. Measured: `agent list` round trip about 0.12 s warm.
- `herdr [--machine X] api snapshot` returns `{result:{snapshot:{agents[], workspaces[], tabs[], panes[], layouts, focused ids, version}}}` in one call. Agent records include `pane_id, tab_id, workspace_id, terminal_id, agent, agent_status, cwd, foreground_cwd, terminal_title_stripped, agent_session`.
- `herdr terminal attach <terminal_id> [--takeover]` and `herdr agent attach <target>` attach ONE pane into the current terminal (Linux/macOS). Detach: `ctrl+b q`. Only one writable attach client owns a terminal; `--takeover` replaces it.
- Interactive attach is **not** forwarded by `--machine`. For a remote machine, run `ssh -t <target> herdr terminal attach <terminal_id>` (verified on a Linux workbox: `~/.local/bin/herdr` is on the non-interactive SSH PATH). `terminal attach` has no `--session` flag. For a non-default session, set the environment variable instead: `ssh -t <target> env HERDR_SESSION=<name> herdr terminal attach <id>`, and locally `HERDR_SESSION=<name> herdr terminal attach <id>`.
- Full UI attach: local `herdr`; remote `herdr --remote <target> [--session <name>]`.
- Creation: `workspace create --cwd --label`, `tab create --workspace --label`, `pane split <pane> --direction right|down --cwd --no-focus`, `worktree create --cwd --branch`, `agent start <name> --kind <kind> --pane <pane_id> [-- args]`. Responses carry new IDs (`.result.workspace`, `.result.tab`, `.result.root_pane`, `.result.pane`).
- Other actions: `pane close`, `pane rename`, `tab close|rename`, `workspace close|rename` (closing a primary workspace with open linked worktrees needs explicit `--group`), `agent prompt <target> "<text>"` (rejects `blocked` agents with `agent_blocked`), `agent read <target> --source recent-unwrapped --lines N`, `agent rename`.
- `herdr machine add <target> [--label] [--remote-session]` is interactive when it needs to install or replace a server and asks for consent (default No). `herdr machine reconnect` needs the user to complete SSH auth in a terminal.
- Remote and local herdr versions can differ (seen in practice: local 0.9.4, remote 0.9.3). Compatibility is negotiated by herdr; the app must not assume identical versions.
- The local socket API also offers `events.subscribe` for push updates, but there is no CLI wrapper for it and it is local-only.

## 6. Decisions made with the maintainer

- **Stack:** Tauri 2, a Rust backend and a React + TypeScript frontend (Vite). The Rust side spawns the user's `herdr` binary; the UI ports the canvas design.
- **Repo / project name:** `crafted-herdr-ui`, at `~/projects/crafted-herdr-ui` (already `git init`ed by the maintainer; the maintainer creates the GitHub remote).
- **Open-source**, macOS first.
- **Bring your own terminal:** the app never draws terminals; "Open" hands off to the chosen terminal app.
- **Use the installed herdr CLI** for everything, including adding machines; support "all CLI commands" the UI needs.
- **Visual direction:** the approved canvas. It's a dark graphite, restrained look where color marks only status, with monospace for anything CLI-derived and visible commands. Influences: t3.codes and reasonmachines.com.
- **Build process:** implementation by Sonnet 5.5 (high effort) subagents, review by Opus.

## 7. Calls made by Claude (the maintainer should check these)

- App display name **"Crafted Herdr"**, bundle id `dev.crafted.herdr-ui`. Earlier mockups said "Herd" as a placeholder.
- License **MIT**; README says it is an unofficial companion, not affiliated with herdr.dev.
- **Updates by polling**, not push: each enabled machine runs `herdr --machine <id> api snapshot` every 2 s while the main window is visible and every 10 s otherwise (menu bar only). Local uses `herdr api snapshot`. A machine whose call fails backs off (2, 4, 8 … up to 60 s) and shows its error. Push events for Local are a later optimization.
- **Project grouping rule** (revised after builder check; real setups often have a shell in `$HOME` and an agent in `~/projects`, which would swallow everything under a naive nesting rule):
  1. Only **agents** create project groups. A group is keyed by (machine, folder), where folder = `foreground_cwd`, falling back to `cwd`.
  2. A folder that is `$HOME` (`/Users/<u>` or `/home/<u>`), an ancestor of `$HOME`, or a direct "container" child of home (`~/projects`, `~/work`, `~/code`, `~/src`, `~/dev`) never forms a group. Agents in such folders go to that machine's **"Loose sessions"** group.
  3. Grouping uses exact folders; there is no nested-parent merging for agents. The one exception: a **shell pane** whose folder is inside an existing agent group's folder on the same machine joins that group. Other shell panes go to "Loose sessions".
  4. The display name is the folder's last path segment. If two groups have the same name on different machines, they stay separate cards, each with its workbox chip.
  5. Sort order: groups containing a "needs you" agent first, then groups with a `working` agent, then the rest. Within each tier, sort by name (A to Z). "Loose sessions" groups come last.
  (Git-root detection over SSH is deferred.)
- **Ages and activity times:** herdr snapshots have no timestamps, only `revision`, `state_change_seq` and `completion_seq` counters. The app records **when it observed** each pane's `agent_status` change. That record is keyed by (machine id, terminal_id) and persisted to `activity.json` in app data, pruned when a terminal disappears. The UI shows ages from these timestamps ("blocked 2m"). When there's no observation yet (first sight after install), it shows no age rather than a guessed one. "Checked Ns ago" uses the poller's last successful call time.
- **Close workspace with linked worktrees:** the herdr 0.9.4 CLI has no `--group` flag. In v1 the app attempts `workspace close`. On `workspace_group_close_required`, it shows herdr's message plus the list of linked worktree workspaces, and offers to close those first one by one, each confirmed. It never bypasses the check.
- **Agent display name:** existing agents often have `name: null`. Fall back to the terminal title (stripped), then `<kind> · <pane_id>`.
- **Worktrees:** never pass `--trust-repository` automatically. If herdr refuses because the repository isn't trusted, show its message and an explicit "Trust this repository and retry" button.
- **"Needs you"** = `blocked` agents (orange, "Needs approval/input") plus `done` agents (light blue, "Done, unseen"). Opening or "Mark seen" on a done agent calls `agent focus` on it, which marks it seen in Herdr. (Verify during build that `agent focus` changes `done` to `idle` without stealing an attached client's view; if it does, use a local "seen" set instead.)
- **Reply** is enabled only for `idle`/`done` agents and uses `agent prompt`. For `blocked` agents the UI offers only "Open" (anti-goal: no auto-answering approvals).
- **Live preview** polls `agent read <pane> --source recent-unwrapped --lines 60 --format text` every 2 s, only for the selected row, and only while visible.
- **Default terminal:** the first installed of Ghostty, iTerm2, Warp, Terminal (Terminal is always present).
- **Open behaviour:** default "new tab/window in the chosen terminal, attach just that pane". Settings also offers "full Herdr UI on that workbox". The attach runs inside the user's terminal, where the app can't see whether it failed. So the command carries its own fallback: if `herdr terminal attach` fails because another client owns the terminal, the shell asks "Take over? [y/N]" and only then reruns it with `--takeover`.
- **Add workbox** runs `herdr machine add` inside a hidden pseudo-terminal and turns its known prompts into native dialogs. If a prompt can't be recognized, the flow falls back to "Continue in terminal", which opens the user's terminal with the same command. `machine reconnect` always goes to the user's terminal (it needs SSH auth).
- **Notifications** fire on a state transition into `blocked` or `done` (not at startup), with the project and workbox in the text; clicking focuses the agent in the app.
- **Fonts:** Geist and Geist Mono, bundled locally in the app (OFL), no network fetch.

## 8. Architecture

```
┌──────────────── Tauri app (crafted-herdr-ui) ─────────────────┐
│ React UI (Vite, TS)                                            │
│  Home · Workbox · New session · Add workbox · Settings         │
│  Menu-bar popover (separate small webview window)              │
│        ▲ tauri events: "state", "preview", "toast"             │
│        │ tauri commands: invoke("create_session", …)           │
│ Rust core                                                      │
│  herdr::Cli      spawn herdr, timeout, parse JSON/errors       │
│  herdr::model    serde types for snapshot/machine/agent        │
│  poller          per-machine loop → merged AppState            │
│  grouping        projects / needs-you derivation (pure)        │
│  actions         typed wrappers for every mutating command     │
│  terminal        launchers per terminal app                    │
│  machine_setup   pty-driven `herdr machine add`                │
│  notify, tray, settings (tauri-plugin-store)                   │
└───────────────────────────┬────────────────────────────────────┘
                            │ std::process::Command
                    user's `herdr` binary ──ssh──▶ workboxes
```

### 8.1 Locating herdr

GUI apps on macOS do not inherit the shell PATH. Resolve in this order: the path saved in Settings; `$SHELL -lc 'command -v herdr'`; `~/.local/bin/herdr`; `/opt/homebrew/bin/herdr`; `/usr/local/bin/herdr`. Cache the result. Run `herdr --version` and `herdr status` at startup. If herdr is missing, the app shows an onboarding screen with the install link and a "Choose binary…" button. If the version is older than 0.9.0, show a warning banner (still try).

Also capture the login-shell environment once (`$SHELL -lc env`) and pass `PATH`, `SSH_AUTH_SOCK` and `HOME` to every herdr spawn, so SSH agent auth works from a GUI-launched app.

### 8.2 Cli runner

- `run(args, machine: Option<MachineId>, timeout) -> Result<serde_json::Value, HerdrError>`.
- Prefixes `--machine <id>` when given (use the profile **id**, not the label).
- Default timeout 10 s; creation calls 30 s; `agent start` 45 s, because herdr itself waits up to 30 s for the agent to be ready; `agent prompt` 30 s.
- Exit 0 → parse stdout JSON. Exit 1 → parse stderr JSON `{error:{code,message}}` into `HerdrError::Server{code,message}`. Exit 2 → `HerdrError::Usage(stderr)`. Timeout → `HerdrError::Timeout` (the UI must say "may have been applied, refreshing" and re-poll; never retry a mutation automatically).
- Every call is appended to an in-memory **command log** (last 200: time, machine, argv, exit, duration), shown in a "Activity" drawer. This is what makes the "visible commands" promise true.
- Concurrency: at most 4 in-flight calls per machine.

### 8.3 State and polling

`AppState { machines: Vec<MachineView>, generated_at }`, where `MachineView { profile, health: Online|Reconnecting{retry_in}|Attention{error}|Disabled, herdr_version, snapshot: Option<Snapshot>, last_ok }`. Local is a synthetic machine with id `local`.

Machine profiles reload from `herdr machine list --json` every 30 s and after any machine action. The poller emits a full `state` event to the UI whenever a machine's snapshot changes (compare on revision/seq fields or a hash). The frontend derives the views (needs-you, project groups) with pure functions that have unit tests. Grouping lives in TypeScript so the UI can switch views instantly; Rust stays a thin data/actions layer. The one exception is that Rust also derives "needs you" for notifications and the tray badge, which needs it without a window.

### 8.4 Actions (Tauri commands)

Each takes a `machine_id` and returns the parsed result or a typed error.

| UI action | herdr call(s) |
|---|---|
| Open (attach pane) | terminal launcher with `herdr terminal attach <terminal_id>` (local) or `ssh -t <target> herdr terminal attach <terminal_id>` (remote) |
| Open full Herdr | `herdr` / `herdr --remote <target> [--session s]` in terminal |
| New session: new tab | `tab create --workspace W --label NAME` → root pane; if agent: `agent start NAME --kind K --pane P` |
| New session: split beside | `pane split <pane> --direction right --cwd DIR --no-focus` → `agent start …` |
| New session: new workspace | `workspace create --cwd DIR --label NAME` → root pane → `agent start …` |
| New session in a worktree | `worktree create --cwd DIR --branch B` → its root pane → `agent start …` |
| Rename session | `agent rename` if it is an agent, else `pane rename` |
| Close session | confirm dialog, then `pane close <pane>` |
| Rename/close tab, workspace | `tab rename/close`, `workspace rename/close` (linked-worktree case: see §7) |
| Reply | `agent prompt <pane> "<text>"` (idle/done only) |
| Mark seen | `agent focus <pane>` (see §7 caveat) |
| Preview | `agent read` / `pane read` for shells |
| Workbox rename/enable/disable/remove | `machine rename <id> --label`, `machine enable|disable|remove <id>` |
| Workbox check | `machine status <id> --json` |
| Reconnect | open terminal with `herdr machine reconnect <id>` |
| Add workbox | pty-driven `machine add` (§8.6) |

Agent kinds offered come from `herdr agent start --help` parsed at startup (fallback list: claude, codex, copilot, opencode, cursor, plain shell). Agent names must match `[a-z][a-z0-9_-]{0,31}` and be unique on that machine; validate in the form.

### 8.5 Terminal launchers

Trait `TerminalLauncher { id, display_name, is_installed() -> bool, open(cmd: &[String], title) -> Result }`. The command is always argv, with shell quoting done by the launcher.

- **Ghostty:** `open -na Ghostty.app --args -e <cmd…>` (new window). If tabs are wanted later, use AppleScript when Ghostty supports it.
- **iTerm2:** AppleScript `create window with default profile command "<cmd>"` (or a new tab in the current window per Settings).
- **Terminal.app:** AppleScript `do script "<cmd>"`.
- **Warp:** open a temporary launch configuration YAML under `~/.warp/launch_configurations/` via `warp://launch/<name>`, or fall back to `open -a Warp` plus the `warp://action/new_tab` URL with the command if supported. Verify during build and document the limitation if Warp cannot run a command.
- **WezTerm:** `wezterm cli spawn --new-window -- <cmd…>` or `open -na WezTerm --args start -- <cmd…>`.
- **Kitty:** `open -na kitty --args <cmd…>`.
- **Custom:** a user template string with `{attach}` replaced by the shell-quoted command, run via `/bin/sh -c`.

Installed detection: `mdfind "kMDItemCFBundleIdentifier == '<bundle id>'"` or check `/Applications` and `~/Applications`. macOS will ask the user to allow Automation (AppleScript) the first time. The README explains this.

### 8.6 Add workbox (pty)

Spawn `herdr machine add <target> [--label L] [--remote-session S]` with `portable-pty`. Stream its output to the UI's "Show herdr output" log. Recognise these steps and map them to the checklist: SSH connection, herdr found / needs install / needs replace, server started, sessions discovered. Map these prompts to native dialogs:

- session picker (Up/Down + Enter): the app sends arrow keys and Enter for the chosen index;
- install/update consent (y/N);
- replace running server consent (y/N, default No; the dialog explains it stops that server's panes).

Unknown output that waits for input for more than 5 s triggers "Continue in terminal". Patterns must be loose and kept in one module. Success is confirmed by re-reading `machine list --json`, not by parsing text.

**Build order and safety:** "Continue in terminal" (open the user's terminal running `herdr machine add …`, then poll `machine list` until the new profile appears) is built **first** and is always available as a button. The native-dialog layer is built second. Its prompt patterns come from herdr's public source (github.com/herdrdev/herdr, at the tag of the installed version) and are written as test transcripts. Running `machine add` against a workbox's live default session is **off-limits** in development and QA, because the replace path can stop live agents. Real-world QA of the native layer targets a dedicated QA session on the test workbox (see §11).

### 8.7 Notifications, tray, windows

- Tray icon with a badge count of "needs you". Clicking it shows a 380×560 popover window (frameless, hides on blur) rendering the MenuBar screen.
- Main window 1280×820 default, min 900×600, `titleBarStyle: Overlay` with traffic lights inset, so the custom header from the design sits in the title bar.
- Closing the main window keeps the app running in the menu bar. Quit is ⌘Q or the tray menu.
- Notifications use `tauri-plugin-notification`.
- Shortcuts: ⌘K search/jump, ⌘N new session, ⌘↩ open the selected session, ⌘, settings, ⌘R refresh, ↑/↓ move selection, ⌫ close the selected session (with confirm). Global ⌃⌥⌘H show/hide (tauri-plugin-global-shortcut, can be turned off).

### 8.8 Settings (tauri-plugin-store, `settings.json` in app data)

`herdr_path`, `terminal` (id), `terminal_custom_template`, `open_mode` (`tab`|`window`), `attach_mode` (`pane`|`full_ui`), `notify_blocked`, `notify_done`, `poll_interval_visible_ms` (2000), `poll_interval_hidden_ms` (10000), `group_by` (`project`|`workbox`|`status`), `global_shortcut_enabled`.

## 9. Screens (from the approved canvas)

Design tokens: background `#0B0C0E`; sidebar and header `#101114`; panel `#0F1013` / `#121317`; raised `#1E2025`; borders `#1F2126` and `#2A2D33`; text `#ECECEF`, `#C9CBD1`, `#A3A5AD`, `#8B8E97`, muted `#7C7F88`; primary button is a light fill `#ECECEF` with dark text. Status colors: needs you `#FFA94D`, done `#8FD3FF`, working `#6E93FF`, idle `#A3A5AD`, online `#7EE0B0`, danger text `#FF9B94`. Radius 6/8/12/14. Geist 13 px body, Geist Mono for IDs, paths, commands and previews. Every status also carries a text label (never color alone). Light mode is out of scope for v1, but tokens must be CSS variables so it can be added.

1. **Home.** Header: app name, herdr version, search field (⌘K), "Opens in <Terminal> ▾" picker, "New session ⌘N". Left sidebar: Needs you (count), All agents, Projects list (status dot plus workbox), Workboxes list (online state, "+ Add workbox"), herdr path/version and Settings at the bottom. Center: "Needs you" cards (status label, project, agent name, workbox chip, last 3 terminal lines in mono, "Open in <Terminal>", "Reply…" or "Mark seen", age). Below: "By project", with a segmented Project / Workbox / Status control. Each project card has a header (folder name, path, workbox chip, "+ Session") and rows (status pill, agent-kind monogram, title = terminal title, agent name, pane id, age, "Open ↗"). Right inspector for the selected row: status, kind, name, project on workbox, a details grid (workbox, session, folder, workspace/tab, pane), live preview, reply box, Open (⌘↩), Rename, Copy command, Close, and a "what Open runs" command box.
2. **Workbox.** Breadcrumb, "Open full Herdr ↗", "+ New session". Summary card: name, Reachable/Attention badge, `ssh target · session · herdr version`, counts (workspaces, sessions, agents, needs you), and Reconnect / Rename / Disable / Remove…, plus a "checked Ns ago" note. Then per workspace: tabs as cards whose panes are drawn as boxes (kind monogram, name, status, last line, pane id); "+ Tab", "+ New tab in …".
3. **New session** sheet: workbox radio cards; project folder (text plus Browse… for Local only, plus recent folders for that machine taken from the snapshot); "Work in a new git worktree" with a branch field; Run: agent kinds plus plain shell; Name; Place it (new tab in workspace X / split beside selected / new workspace); a command preview of the exact herdr calls; "Open in <Terminal> when ready"; Create (⌘↩).
4. **Add workbox** sheet: SSH host field with chips from `~/.ssh/config` `Host` entries (no wildcards); Label; Remote session; setup checklist; consent card for install/replace; collapsible herdr output; footer note "Keys stay with OpenSSH".
5. **Settings** window: General, Terminal, Workboxes, Notifications, herdr CLI, Shortcuts. The Terminal pane has terminal radio cards (installed or not), open mode, attach mode, launch template with a resolved example, and herdr binary status.
6. **Menu bar popover:** Needs you list with Open, Working list, Idle summary, per-workbox online dots, "Open app ⌃⌥⌘H" and "New session".

Empty and error states (not on the canvas; build them in the same style): herdr not found (onboarding); no machines besides Local; a machine in Attention (row turns dim, shows the error and the suggested CLI command); no agents anywhere ("Start one with ⌘N"); stale data when a machine is reconnecting (dim, with "last updated 40s ago").

## 10. Project layout

```
crafted-herdr-ui/
  src-tauri/            Rust: main.rs, herdr/{cli,model,errors}.rs, poller.rs, actions.rs,
                        terminal/{mod,ghostty,iterm,terminal_app,warp,wezterm,kitty,custom}.rs,
                        machine_setup.rs, notify.rs, tray.rs, settings.rs, env.rs
    tests/fixtures/     real JSON captured from herdr 0.9.x (anonymized paths)
  src/                  React: app shell, screens/, components/, lib/{grouping,format,ipc}.ts,
                        styles/tokens.css, fonts/
  scripts/fake-herdr    test double that serves fixtures by argv
  docs/                 specs, plans, screenshots
  .github/workflows/    ci.yml (lint, test, build), release.yml (universal .dmg on tag)
  README.md  LICENSE  CONTRIBUTING.md
```

## 11. Testing

- **Rust:** unit tests for JSON parsing against captured fixtures (snapshot, agent list, machine list/status, error JSON), Cli error mapping, command-argv building for each action, terminal quoting, and pty prompt recognition against transcripts. Integration tests run the real runner against `scripts/fake-herdr`.
- **Frontend:** Vitest for grouping, needs-you, sorting and age formatting; React Testing Library for the Home screen with fixture state, New session form validation, and command preview text.
- **Manual QA checklist** in the plan: against Local plus the developer's own test workbox for open in each installed terminal, create/close a shell and an agent, add a workbox, and notifications. Machine names come from local, uncommitted config (`.env.local`, `HERDR_UI_TEST_MACHINE`).
- Tests must never call a real `herdr` that mutates state.
- **Test workbox for live QA:** a single designated workbox, named only in `HERDR_UI_TEST_MACHINE` in `.env.local`, which is gitignored. Live tests create their own panes in a dedicated workspace labelled `herdr-ui-qa` and close only panes they created. Add-workbox QA uses `--remote-session herdr-ui-qa` on that host, so the default session and its agents are never touched. To exercise the install prompt, use a local Docker container running sshd (Linux arm64, no herdr installed).

## 12. Distribution

- GitHub Actions: `ci.yml` on PRs (cargo fmt/clippy/test, pnpm lint/typecheck/test, `tauri build` on macos-14).
- `release.yml` on `v*` tags: universal (arm64 + x86_64) `.dmg` uploaded to a GitHub Release, unsigned in v1. The README documents `xattr -dr com.apple.quarantine`.
- Homebrew cask later.

## 13. Left to the builder

- Exact component structure, state library (plain React context or Zustand), and CSS approach (CSS modules or vanilla-extract), as long as the tokens are CSS variables.
- Tray icon artwork (simple monochrome template icon) and app icon.
- How to diff snapshots cheaply.
- Warp launch mechanism details, within the constraint "run a given command in a new Warp tab or window" or a documented fallback.
