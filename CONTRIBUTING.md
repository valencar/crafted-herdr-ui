# Contributing to Crafted Herdr

Thanks for helping. This is a small macOS app (Tauri 2, Rust core, React UI) that drives the public `herdr` CLI. The design specs are kept locally by the maintainer (`docs/superpowers/`, not in the repo); ask in an issue if you need context on a design decision.

## Dev setup

Requirements: macOS 13+, Node 24+, pnpm 10, a stable Rust toolchain, and herdr 0.9+ if you want to run against real state.

```bash
pnpm install
pnpm tauri dev      # the full app
pnpm dev            # the Vite UI only
```

Machine names, hosts and test settings that are personal to you go in `.env.local` (copy `.env.local.example`). It is gitignored.

## Tests

Run all of these before opening a pull request. CI runs the same on macOS, plus a Windows job (lint, typecheck, the Vitest tests without `scripts/**`, clippy, `cargo test`, an NSIS debug build).

```bash
pnpm lint && pnpm typecheck && pnpm test
cd src-tauri && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test
scripts/check-no-personal-data.sh
```

- Write the failing test first, then make it pass. Keep test output clean (no warnings).
- Tests never run a real `herdr` that mutates state. Use `scripts/fake-herdr`.
- `scripts/fake-herdr` is a bash script, so the tests that need it (and any that write `#!/bin/sh` fakes or run `/bin/sh`) are Unix-only: gate them with `#[cfg(unix)]` (`#![cfg(unix)]` for a whole file in `src-tauri/tests/`). Tests that pin the Mac terminal catalog or default use the second gate, `#[cfg(not(windows))]`; their Windows equivalents arrive with the Windows Terminal launcher. You can't run the Windows job locally; the PR's Windows check is where its failures show.
- `cargo test --features trace` runs the tests of the `trace` feature (timing logs for instrumented builds; off by default). CI runs it on macOS too.
- Live tests are opt-in (`HERDR_UI_LIVE=1`) and may touch only the machine named in `HERDR_UI_TEST_MACHINE`, inside a workspace or session named `herdr-ui-qa`.
- Rust types shared with the UI are exported with `ts-rs` into `src/lib/bindings/` (generated, committed).

## No personal data

The rule that matters most: no real machine labels, SSH targets, hostnames, usernames, home paths, project names, terminal titles or session ids anywhere in the repo. That covers code, fixtures, tests, docs, screenshots and commit messages. Use `buildbox`, `gpubox`, `staging` for machines and `api-service`, `web-app`, `infra` for projects. Never commit secrets. Read the full [Hard rules in CLAUDE.md](CLAUDE.md#hard-rules-every-contributor-human-or-agent) and run `scripts/check-no-personal-data.sh` before every commit.

## Commits and pull requests

- Use [Conventional Commits](https://www.conventionalcommits.org): `feat(core): …`, `feat(ui): …`, `fix: …`, `docs: …`, `chore: …`.
- Work on a feature branch; keep a pull request to one purpose.
- If you changed behavior that needs a real window, terminal, tray or notification to check, add a line to [`docs/qa-checklist.md`](docs/qa-checklist.md).

## QA checklist

Some behavior can only be checked by hand: opening real terminals, the tray, notifications, launching from Finder. [`docs/qa-checklist.md`](docs/qa-checklist.md) lists them, with a "Before release" section first. Work through it against Local plus a test workbox before a release.

## Working with AI agents

Much of this repo was built by an agent team (a coordinator plus one implementer per task, with reviews). If you use an AI coding agent here, point it at [CLAUDE.md](CLAUDE.md): its Hard rules bind agents the same as people, and its "Build orchestration" section describes the roles and the `.superpowers/` workspace (gitignored).
