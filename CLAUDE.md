# crafted-herdr-ui

An open-source macOS app (Tauri 2 + React/TypeScript) that gives the [herdr](https://herdr.dev) terminal workspace manager a desktop UI. The app shows every machine ("workbox") and every agent grouped by project, with "needs you" first. It opens any terminal in the user's own terminal, and drives everything through the user's installed herdr-core (`hc`): one JSON-RPC connection (`hc connect`) with an event stream, and `hc attach` for terminals. It also works beside Herdr (herdr's desktop app) on the same core. The retired herdr 0.9 CLI is no longer supported; the app only detects it, to tell the person.

- Spec (the authority): `docs/superpowers/specs/2026-10-16-crafted-herdr-ui-design.md`, extended by the addenda `2026-10-17-v0.2-in-app-terminal-design.md`, `2026-10-17-v0.3-workspace-design.md` (Dashboard home and the tabbed workspace) and `2026-10-19-v0.4-tab-rows-design.md` (two-row tabs, clipboard fix) and `2026-10-20-v0.5-readability-homebrew-design.md` (readability pass, Homebrew install, security hardening) and `2026-10-22-v0.7-ui-polish-design.md` (UI polish: motion, status shapes, palette actions, shortcuts sheet, light theme) and `2026-10-28-v0.8-workbox-colors-design.md` (workbox colors, agent logos) and `2026-11-03-v0.9-herdr-core-design.md` (the move from the herdr 0.9 CLI to herdr-core `hc`: JSON-RPC over `hc connect`, an event stream, `hc attach`; it overrides everything the earlier ones say about the herdr 0.9 CLI); where they disagree, the later one wins. `docs/superpowers/` is local-only (gitignored, not in the repo); the files stay on disk for the maintainer and the agent team
- Plan (tasks 0–17): `docs/superpowers/plans/2026-10-16-crafted-herdr-ui-v1.md` (local-only, gitignored like the specs). The v0.9 plan is `docs/superpowers/plans/2026-11-03-v0.9-herdr-core.md`.
- Area guides: `src-tauri/CLAUDE.md` (Rust core) and `src/CLAUDE.md` (React UI).

## Hard rules (every contributor, human or agent)

1. **No personal data in the repo.** That means no real machine labels, SSH targets, hostnames, usernames, home paths (other than `/home/dev` and `/Users/dev`), project names, terminal titles, or session ids. That covers code, fixtures, tests, docs, screenshots and commit messages. Use the generic examples: machines `buildbox`, `gpubox`, `staging`; projects `api-service`, `web-app`, `infra`. Real values live only in `.env.local`, which is gitignored. Run `scripts/check-no-personal-data.sh` before every commit (it also scans `src-tauri/tests/fixtures/hc/`, the captured and rewritten core fixtures).
2. **No secrets.** Never commit or read private keys, tokens, `.pem`/`id_*` files, or SSH config contents. The app parses only `Host` aliases from `~/.ssh/config` at runtime.
3. **Public herdr-core interfaces only:** the `hc` CLI and its documented JSON-RPC API carried over `hc connect`. Never open the core's socket or pipe directly. Every core call goes through `CoreClient`, so it shows up in the command log. The core's environment (`forwarded_env`: `HC_SESSION`, `HC_SOCKET` and the `XDG_*` dirs that pick the core) is only forwarded to processes that run `hc`, including the terminal launchers that start `hc attach` (`open`, `osascript`, the Custom template's `sh -c`).
4. **Never mutate herdr state outside tests' sandbox.**
   - Unit and integration tests use `scripts/fake-hc`.
   - Live tests (`HERDR_UI_LIVE=1`) run on one of two cores:
     - the local sandbox core: `HC_SESSION=herdr-ui-qa`, with `XDG_STATE_HOME`, `XDG_CONFIG_HOME` and `XDG_RUNTIME_DIR` in a scratch dir;
     - `$HERDR_UI_TEST_MACHINE`, added to that sandbox core with `--session herdr-ui-qa`.
   - On either, they may only create terminals that carry the label `herdr-ui-qa=1`. They may only kill or remove terminals they created. Never run bare `hc` (it opens a picker and attaches), `hc server stop|restart`, `hc update`, `hc machine rm|update`, or anything against terminals the test didn't create.
   - Every sandbox `hc` call runs with `HC_SOCKET`, `HC_TERMINAL_SOCKET`, `HC_TERMINAL_ID` and `HC_SCOPE` unset. A shell inside a core terminal inherits them, and they point at the person's core. The one exception to the `server stop` ban: a test, or the fixture capture, may stop the sandbox core it started itself.
   - The live test is `src-tauri/tests/live.rs` (`#[ignore]`, `HERDR_UI_LIVE=1`). It refuses to run unless `HC_SESSION` is `herdr-ui-qa`, the three XDG dirs are set, and no `HC_SOCKET`/`HC_TERMINAL_*`/`HC_SCOPE` is. Run it only through a wrapper that starts from `env -i` with an explicit list (`PATH`, `HOME`, `USER`, `LANG`, `TERM`, `SSH_AUTH_SOCK` and the sandbox variables), and confirm the sandbox core's state and socket paths lie inside your scratch dirs before it mutates anything.
   - Never touch a herdr 0.9 server either: the app no longer runs `herdr`, except `herdr --version` to detect it (`find_legacy_herdr`).
5. **The app never acts for the user on risky things.** It doesn't install herdr-core, stop or replace a core, or answer `blocked` agents without an explicit click. On herdr-core: never `terminal.send` with `force`; never `hc machine add --install`, `hc machine update` or `hc server stop|restart` without an explicit click.
   - **One stated exception:** on Unix, `hc connect` starts a stopped local core by itself. That's hc's own behavior; every `hc` command does it, `hc server status` included. So connecting at launch may start the core.
   - After the event connection drops, the app retries with backoff for 2 minutes, which covers `hc update` and `server restart` (a restart ends no terminal). Then it stops retrying and shows "herdr-core isn't running" with a **Reconnect** button. A drop that follows local terminals ending with `server_stop` (`hc server stop`) goes there at once, with no retry, so a core the person stopped on purpose stays stopped until they click; a core with no live local terminal ends nothing on stop, so its stop looks like a plain drop and the retry starts it again (Ruling C113). A Reconnect click counts only if it came after the app stopped trying (Ruling C116).
   - While the event connection is down, and from the first local `server_stop` ending on, no background call runs (the preview, tails, templates, layout reads, `herdr.seen` writes, `machine.list`): each would run `hc connect`, which starts the core. The retry itself still runs `hc connect`.
6. **No pushing to `origin`** unless the maintainer asks. Work happens on feature branches; `main` is protected by convention.

## Commands

```bash
pnpm install
pnpm dev            # Vite only
pnpm tauri dev      # full app
pnpm test           # Vitest
pnpm lint && pnpm typecheck
cd src-tauri && cargo test && cargo clippy --all-targets -- -D warnings && cargo fmt --check
scripts/check-no-personal-data.sh
scripts/build-site.sh  # project site (site/) → _site/; deployed to GitHub Pages by .github/workflows/pages.yml
```

## herdr-core facts the code relies on (verified on hc 0.1.18)

- Binary: the installer puts `herdr-core` in `~/.local/bin`, and `hc` beside it only if no other `hc` exists. Another program also ships an `hc` (a window-manager client). A binary counts only if `--version` prints `hc X.Y.Z` (`hc 0.1.18` here, from either name).
- `hc connect` speaks JSON-RPC 2.0, one message per line, over stdin/stdout. `hello {generation: 1}` returns `version`, `core {id, name}`, `methods`, `features`. A connection that calls `events.subscribe` in plain mode then carries only notifications (a call sent on it later is never answered).
- `events.subscribe` returns `{seq, terminals}`, then sends `event` notifications, a `heartbeat` every 15 s, and `missed` with a fresh snapshot. Event types: `created`, `lost`, `restarted`, `keep`, `finished`, `removed`, `status`, `turn`, `title`, `labels`, `size`, `foreground`, `doc`. How each one applies is in `schema/README.md` "Events". Terminals on added machines arrive in the same stream as `name/t7`. `seq` restarts with each core process, and a restarted core numbers new terminals with a suffix (`t1b`).
  - A `status` event carries `{status, records, reported}` and no `status_ms`. Snapshots do carry it, and the core stamps it when the root state word changes. So the app stamps its own time on a root-state change.
  - Adding a machine, or a machine's line coming back, emits a local `missed` (after `created`/`removed` for what changed). Renaming a machine emits `removed` for every old `old/tN` address, then `created` for the new ones. The machine's `id` stays.
  - A kept terminal whose program dies by signal emits `status` (null), `lost {reason: "signaled", signal}`, then `restarted` (the whole record) and `foreground`.
  - `hc server stop` ends every live local terminal before the stream drops: `finished {reason: "server_stop"}`, or `lost` with that reason for a kept one. Only a stop produces it; the one other place it shows up is `terminal.keep {keep: false}` on a kept terminal still pending after a stop, which ends it with its stored reason, so `server_stop` again (upstream `api.rs` `terminal_keep`). The app reads any local `server_stop` ending as a stop, which errs on the safe side. `hc server restart` (which `hc update` sends after swapping the binary) ends none: the programs are handed to the next core.
- `Terminal` fields used: `address`, `name`, `argv`, `cwd`, `foreground {pid, name, argv, cwd}` (optional: absent on freshly created, restarted and finished records), `state` (`live`/`finished`), `status` (root 7501 record `{state, app, kind, msg, progress, title}`), `status_ms`, `reported`, `turn`, `labels`, `title`, `parent`, `keep`, `reason`, `exit_code`, `created_ms`, `finished_ms`. One that never reported has `status: null`.
- `machine.list` returns `MachineView {name, id, host, target, session, version, state, why, since_ms, temporary, via}`.
  - `state` is `connecting`, `connected`, `needs_login`, `needs_update` (the remote hc is incompatible) or `unreachable`.
  - `id` is the other core's permanent id. `name` is what our core calls it, and it can be renamed.
  - `session` is `null` for a default session. `why` and `since_ms` appear only when there's a reason (`since_ms` not while `connecting`).
- Documents: `doc.get {name, on?}` returns `{value, version}`; an unwritten name gives `{value: null, version: 0}`. herdr-app keeps its spaces in the document `herdr-app` on each machine. Snapshots carry terminals only, so documents are re-read after subscribing, after `missed`, and on `doc` events.
- **Plain mode runs one call at a time per connection.** The core finishes a call before it reads the next line. Only framed mode's channel 0 runs calls side by side. A call to a remote machine that is still dialing can hold its connection for about 20 s.
- **Starting:** on Unix, `hc connect` (and every `hc` command) starts a stopped local core.
- **`terminal.read {lines}`** returns `{complete, how, text}`: the screen plus `lines` of history above it. With `lines > 0` on a full-screen program that is idle or done, core scrolls the program to read its history: it holds keystrokes and repaints every viewer while it does (upstream `SKILL.md`: "History reads may scroll a full-screen app, then restore its view"). The app only ever reads with `lines: 0`.
- **`templates.list` is local only** (an `on` param is ignored). A remote machine resolves template names itself. A broken template is listed with an `error`.
- **Names** (terminals, machines): 1–32 of `a-z 0-9 - _ .`, starting with a letter or digit, and not shaped like an address (`t7`, `t1b`).
- **`terminal.kill` ends the terminal's workers too.** Children end with their parent unless started with `outlive_parent`.
- Errors are JSON-RPC errors: code `-32000` (`-32602` for `invalid_params`) and `data {kind, hint}`. `machine.add` also returns `needs_login` when ssh wants a password, and `needs_update` is an error kind on calls to a machine in that state.
- Attach: `hc attach <address>` puts a terminal on a core terminal. `Ctrl+\` detaches. `--observe` never types or resizes. There's no "another client owns this session": several viewers can share one terminal, and the last active one sets the size.
  - It **exits 0** when detached, when the program finishes, and when the core is lost. The reason is only in its last stderr line: `[detached from t7]`, `[t7 finished: <reason>]` (`exited`, `killed`, `server_stop`, and `signaled` for a kept terminal that was lost), `[lost the core; it keeps t7 running: hc attach t7]`.
  - Errors print `error: …` then `hint: …` on stderr, so the last line is the hint, and exit by kind. A usage error (exit 2) is clap's own text instead: `error: …`, a usage block, and last `For more information, try '--help'.` Upstream's `SKILL.md` documents 3 not_found, 7 needs_target, 9 blocked, 10 status_mismatch and 11 finished, and says the list is not complete. Observed here: 2 usage, 4 machine_unknown, 5 unavailable (also "lost, waiting for its new shell" and an unreachable machine), and 1 for `needs_update`. Treat any code not listed as a generic failure and read the `error:`/`hint:` lines.
- 7501 `app` names that differ from the kind (herdr-app `defaults/programs.json`):

  | `app` | kind |
  |---|---|
  | `claude-code` | claude |
  | `cursor-agent` | cursor |
  | `github-copilot` | copilot |
  | `grok-build` | grok |
  | `agy` | antigravity |
  | `kiro-cli` | kiro |
  | `qodercli` | qoder |

  The same file gives each kind's start argv; Codex starts as `codex --no-daemon` per herdr-core's skill.
- Sessions: `HC_SESSION` selects a local core session. `machine add --session` selects one on a remote.
- Timestamps exist now: `created_ms`, `status_ms`, `finished_ms`, `since_ms`.
- herdr-core has no Homebrew formula or cask; it installs with the upstream script. (The `herdr` formula in Homebrew is the old 0.9 CLI.)
- The in-app terminal is just another attach client: a workspace tab runs exactly the argv `open_argv` builds (the same command "Open in {Terminal}" runs) on a pty, and closing a tab ends only that client, never the core terminal.

## Build orchestration (how this repo is being built)

This repo is built by an agent team following the plan:

| Role | Who | Responsibility |
|---|---|---|
| Coordinator | Claude Opus (main session) | Owns the plan, the ledger, task briefs, rulings and dispatches. Never writes product code itself. |
| Implementer | Claude Sonnet 5.5, high effort, one fresh subagent per task | Implements exactly one task brief with TDD, commits, writes a report file, and never spawns subagents. |
| Task reviewer | Claude Opus subagent | Gives spec-compliance and code-quality verdicts on one task's diff. Read-only. |
| Fix rounds | Rounds 1–3 resume the same Sonnet implementer; rounds 4–5 go to a fresh Opus implementer | Max 5 rounds; then the coordinator adjudicates and ledgers a ruling. |
| Final review | Claude Opus | Whole-branch review against spec, Global Constraints and Review Focus. |

How the pieces fit together:

- **Progress ledger:** `.superpowers/sdd/2026-10-16-crafted-herdr-ui-v1/progress.md` (gitignored). The first line names the plan. `Task N: complete` lines are authoritative; after a context reset, trust the ledger and `git log` over memory. Every decision made on the maintainer's behalf is a `Ruling:` line.
- **Briefs, reports and review packages** live in that same workspace folder: `task-N-brief.md`, `task-N-report.md`, and the diff packages.
- **Branch:** `feat/v1`, off `main`. The v0.9 work (herdr-core) ran the same way: plan `docs/superpowers/plans/2026-11-03-v0.9-herdr-core.md`, ledger `.superpowers/sdd/2026-11-03-v0.9-herdr-core/progress.md`, branch `feat/v0.9-herdr-core`.
- **What a dispatch contains:** one line of context, the brief path ("your requirements"), the interfaces from earlier tasks, rulings that apply, and the report path. Never the whole plan, and never pasted history.
- **GUI-only manual checks** (opening real terminal windows, watching the tray, notifications) aren't done by implementers. They're collected in `docs/qa-checklist.md` for a final pass with the maintainer.

## Conventions

- TDD: write a failing test first, then see it pass. Keep test output clean (no warnings).
- Small, single-purpose files that follow the plan's file map. Rust types shared with the UI are exported via `ts-rs` into `src/lib/bindings/` (generated, committed).
- Commit messages: Conventional Commits (`feat(core): …`, `feat(ui): …`, `chore: …`).
