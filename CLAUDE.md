# crafted-herdr-ui

An open-source macOS app (Tauri 2 + React/TypeScript) that gives the [herdr](https://herdr.dev) terminal workspace manager a desktop UI. The app shows every machine ("workbox") and every agent grouped by project, with "needs you" first. It opens any pane in the user's own terminal, and drives everything through the user's installed `herdr` CLI.

- Spec (the authority): `docs/superpowers/specs/2026-10-16-crafted-herdr-ui-design.md`, extended by the addenda `2026-10-17-v0.2-in-app-terminal-design.md`, `2026-10-17-v0.3-workspace-design.md` (Dashboard home and the tabbed workspace) and `2026-10-19-v0.4-tab-rows-design.md` (two-row tabs, clipboard fix) and `2026-10-20-v0.5-readability-homebrew-design.md` (readability pass, Homebrew install, security hardening) and `2026-10-22-v0.7-ui-polish-design.md` (UI polish: motion, status shapes, palette actions, shortcuts sheet, light theme) and `2026-10-28-v0.8-workbox-colors-design.md` (workbox colors, agent logos); where they disagree, the later one wins. `docs/superpowers/` is local-only (gitignored, not in the repo); the files stay on disk for the maintainer and the agent team
- Plan (tasks 0–17): `docs/superpowers/plans/2026-10-16-crafted-herdr-ui-v1.md` (local-only, gitignored like the specs)
- Area guides: `src-tauri/CLAUDE.md` (Rust core) and `src/CLAUDE.md` (React UI), once those folders exist.

## Hard rules (every contributor, human or agent)

1. **No personal data in the repo.** That means no real machine labels, SSH targets, hostnames, usernames, home paths (other than `/home/dev` and `/Users/dev`), project names, terminal titles, or session ids. That covers code, fixtures, tests, docs, screenshots and commit messages. Use the generic examples: machines `buildbox`, `gpubox`, `staging`; projects `api-service`, `web-app`, `infra`. Real values live only in `.env.local`, which is gitignored. Run `scripts/check-no-personal-data.sh` before every commit (once it exists).
2. **No secrets.** Never commit or read private keys, tokens, `.pem`/`id_*` files, or SSH config contents. The app parses only `Host` aliases from `~/.ssh/config` at runtime.
3. **Public herdr CLI only.** No direct socket protocol. Every mutating call goes through `HerdrCli::run`, so it shows up in the command log.
4. **Never mutate herdr state outside tests' sandbox.**
   - Unit and integration tests use `scripts/fake-herdr`.
   - Live tests are opt-in (`HERDR_UI_LIVE=1`). They may touch only `$HERDR_UI_TEST_MACHINE`, inside a workspace labelled `herdr-ui-qa` or a session named `herdr-ui-qa`.
   - Never run bare `herdr` (it launches the TUI), `herdr server stop`, `machine add` against a default session, or anything that closes panes you didn't create.
5. **The app never acts for the user on risky things.** It doesn't install herdr, stop or replace servers, answer `blocked` agents, or pass `--trust-repository` / `--takeover` without an explicit click.
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

## herdr facts the code relies on (verified on 0.9.3 and 0.9.4)

- Hierarchy: machine → session → workspace `w1` → tab `w1:t1` → pane `w1:p1`. An agent lives inside a pane. IDs are scoped to one server, so always key by (machine id, pane id).
- `herdr [--machine <profile-id>] api snapshot` returns the full state. `machine list --json` and `machine status --json` cover machine profiles.
- Errors: stderr JSON `{error:{code,message}}` with exit 1; usage errors exit 2.
- Attach: `herdr terminal attach <terminal_id>` locally. For remote machines, `ssh -t <target> …`, because `--machine` doesn't forward attach. A non-default session needs `HERDR_SESSION=<name>`.
- Snapshots carry no timestamps; the app records the times it observes changes itself.
- The in-app terminal is just another attach client: a workspace tab runs exactly the argv `open_argv` builds (the same command "Open in {Terminal}" runs) on a pty, and closing a tab ends only that client, never the herdr pane.

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
- **Branch:** `feat/v1`, off `main`.
- **What a dispatch contains:** one line of context, the brief path ("your requirements"), the interfaces from earlier tasks, rulings that apply, and the report path. Never the whole plan, and never pasted history.
- **GUI-only manual checks** (opening real terminal windows, watching the tray, notifications) aren't done by implementers. They're collected in `docs/qa-checklist.md` for a final pass with the maintainer.

## Conventions

- TDD: write a failing test first, then see it pass. Keep test output clean (no warnings).
- Small, single-purpose files that follow the plan's file map. Rust types shared with the UI are exported via `ts-rs` into `src/lib/bindings/` (generated, committed).
- Commit messages: Conventional Commits (`feat(core): …`, `feat(ui): …`, `chore: …`).
