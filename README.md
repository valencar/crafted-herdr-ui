# Crafted Herdr

A desktop home for your Herdr agents: every workbox, every agent, grouped by project, with what needs you first.

Crafted Herdr is a macOS app (Tauri 2, React and TypeScript). It shows all your [herdr](https://herdr.dev) machines ("workboxes") and every agent on them in one window, opens any pane in the terminal you already use, and puts a menu bar item and notifications on top. It does everything by running your own installed `herdr` CLI.

> **Unofficial.** Crafted Herdr is an independent community project. It is not affiliated with, endorsed by, or part of herdr.dev or its authors.

## Screenshots

Screenshots coming soon.

## Features

- **Needs you first.** Blocked and done agents sit at the top of Home, ahead of everything else.
- **Group by project, workbox or status.** Switch views instantly; the sidebar jumps to any group.
- **Terminal inside the app.** One click (or ⌘↩) attaches the pane in a tab at the bottom or right of the window, with several tabs open at once. If you would rather use another terminal, "Open in {Terminal}" attaches it in Ghostty, iTerm2, Terminal, Warp, WezTerm, Kitty, Alacritty, or a command of your own.
- **Command palette and fast navigation.** ⌘K finds agents, projects, workboxes and commands; ⌘J jumps to the next agent that needs you.
- **Split view and a native menu.** ⌘\ moves the terminal panel between the bottom and the right edge. The macOS menu bar carries every shortcut, and they work while a terminal has the keyboard.
- **Live preview and reply.** The inspector follows a pane's recent output and lets you answer an idle agent. A blocked agent is never answered for you.
- **New session.** Start a shell or an agent in a new tab, a split, a new workspace or a worktree, with the exact commands shown before you run them.
- **Workbox management.** Check, reconnect, rename, enable, disable and remove workboxes. Add one through a guided sheet around `herdr machine add`.
- **Menu bar and notifications.** A tray icon with a count, a compact "Needs you" popover, and a notification when an agent becomes blocked or done.
- **Activity drawer.** The `herdr` commands the app runs are listed, with a Copy button. That includes the attach commands it runs in a tab of its own window ("opened in Crafted Herdr") and the ones it hands to your terminal. Quiet probes (`herdr --version` and `agent start --help`) are not logged.

## Requirements

- macOS 13 or later.
- [herdr](https://herdr.dev) 0.9 or later, reachable on your `PATH` (the app also looks in `~/.local/bin`, `/opt/homebrew/bin` and `/usr/local/bin`, and lets you choose a binary in Settings).
- For remote workboxes: machines saved with `herdr machine add`. The app lists the ones herdr already knows.

## Install

1. Download the latest `.dmg` from the [Releases](../../releases) page and drag **Crafted Herdr** to Applications.
2. Builds are not notarized yet, so macOS blocks the first launch.
   - On macOS 15 and later: try to open the app once, then go to System Settings › Privacy & Security, scroll to the message about Crafted Herdr and choose **Open Anyway**.
   - On older versions: right-click the app and choose **Open**, then confirm.
   - On any version, you can instead clear the quarantine flag once:

   ```bash
   xattr -dr com.apple.quarantine "/Applications/Crafted Herdr.app"
   ```

### Optional: Developer ID signing and notarization

Release builds are ad-hoc signed and not notarized. This is planned future work, and it needs no code change: `tauri-apps/tauri-action` signs and notarizes when it finds these environment variables (as repository secrets) in the release workflow:

- `APPLE_CERTIFICATE` and `APPLE_CERTIFICATE_PASSWORD` (a base64 Developer ID Application certificate and its password)
- `APPLE_SIGNING_IDENTITY`
- `APPLE_ID`, `APPLE_PASSWORD` (an app-specific password) and `APPLE_TEAM_ID`, or an App Store Connect API key (`APPLE_API_ISSUER`, `APPLE_API_KEY`, `APPLE_API_KEY_PATH`)

## How it uses your herdr CLI

Crafted Herdr talks to herdr only through its public CLI. It has no private protocol and no socket access. For a remote workbox it passes `--machine <profile-id>`. These are the commands it runs:

| What you do | What it runs |
|---|---|
| Keep state fresh | `herdr api snapshot`, `herdr machine list --json`, `herdr machine status <id> --json`, `herdr --version` |
| Open a pane | a tab in the app, or your terminal, runs `herdr terminal attach <terminal_id>`, or `ssh -t <target> …` for a remote workbox |
| Open full Herdr | `herdr`, or `herdr --remote <target> [--session <name>]`, in a tab or your terminal |
| New session | `tab create`, `pane split`, `workspace create` or `worktree create`, then `agent start` |
| Rename | `agent rename` (agents) or `pane rename` (shells); `tab rename`, `workspace rename` |
| Close | `pane close`, `tab close`, `workspace close`, always after a confirmation |
| Reply | `agent prompt <pane> "<text>"`, only for idle or done agents |
| Mark seen | `agent focus <pane>` |
| Preview | `agent read` or `pane read` |
| Manage workboxes | `machine rename`, `machine enable`, `machine disable`, `machine remove`, `machine reconnect` |
| Add a workbox | `machine add <target> [--label …] [--remote-session …]` |

The commands are visible in the **Activity drawer** (⌘⇧A): the calls the app runs itself, and the ones it opens in a tab of its own window (marked "opened in Crafted Herdr") or in your terminal (marked "opened in …", since the app can't see how they end). The version and help probes (`herdr --version`, `herdr agent start --help`) are not logged. The app never installs herdr, stops or replaces a server, answers a blocked agent, or passes `--takeover` or `--trust-repository` without an explicit click from you.

## Terminal inside the app

"Open" attaches the pane in a terminal tab inside the window. The tab runs the same command "Open in {Terminal}" runs: `herdr terminal attach <terminal_id>` for a local pane, `ssh -t <target> …` for a remote one, or the full herdr UI when Settings › Terminal › "Attach as" is "Full herdr UI on that workbox". The app only ever runs the command it builds itself; nothing you type is turned into a command.

- **Panel and tabs.** The panel sits at the bottom of the window or on its right (⌘\ switches). Drag its edge to resize it, and show or hide it with ⌃`. Each tab shows the agent's name, the workbox and the live status with its text label, and a tab whose agent needs you is highlighted. Tabs stay open when you move between Home and a Workbox screen. Opening a pane that already has a tab focuses that tab. At most 16 tabs can be open at once.
- **Closing only detaches.** Closing a tab (⌘W), quitting the app or a crash ends the attach client and nothing else: your herdr pane and agent keep running. "Close pane" is a separate action and always asks first. When an attach ends by itself (herdr's detach key, an SSH drop, another client taking the session), the tab stays open as "Detached", with **Reattach** (Enter) and **Close tab** (⌘W).
- **Tabs are not restored at launch.** The app never reattaches by itself, so it never takes a session over without you.
- **Takeover prompts and "herdr not found"** appear inside the tab, and you answer them there.
- **Typing belongs to the terminal.** Keys typed in the panel (Backspace, arrows, ⌃C and the rest) never trigger Home's list shortcuts. Menu shortcuts still work. ⌘C and ⌘V copy and paste. ⌘F finds in the active tab, and ⌘+, ⌘− and ⌘0 change the font size (saved).
- **Links are copy-only.** ⌘-click on a URL copies it and shows "Link copied". The app opens no web link other than https://herdr.dev.
- **Open in still available.** Settings › Terminal › "Open sessions" (In Crafted Herdr, or in your terminal app) chooses what "Open" does everywhere (rows, needs-you cards, the Inspector, ⌘↩, the palette, notifications and the menu-bar popover): open here, or in your terminal app. The Inspector and the needs-you cards always offer the other choice as a second button, and ⌘↩ in the palette opens the other way.
- **Layout settings.** Window size and position, panel placement and size, terminal font size, the collapsed sidebar and row density (comfortable or compact, in Settings › Appearance) are remembered.

## Terminal support

These are the external terminals "Open in {Terminal}" can use.

| Terminal | How a session opens |
|---|---|
| Ghostty | `open -na Ghostty --args -e …`; always a new window |
| iTerm2 | AppleScript; a new window, or a new tab in the current window (Settings) |
| Terminal | AppleScript (`do script`) |
| Warp | A launch configuration in `~/.warp/launch_configurations/` (kept on disk, see Privacy), opened through `warp://launch/…` |
| WezTerm | `open -na WezTerm --args start -- …` |
| Kitty | `open -na kitty --args …` |
| Alacritty | `open -na Alacritty --args -e …` |
| Custom | Your own command template; `{attach}` is replaced by the attach command |

iTerm2 and Terminal are driven with AppleScript, so macOS asks for **Automation** permission the first time. Allow it in the prompt, or later in System Settings › Privacy & Security › Automation.

## Keyboard shortcuts

The native menu bar owns these, so they work while a terminal has the keyboard, and you can find them in the menus.

| Shortcut | Menu | Action |
|---|---|---|
| ⌘K | View | Command palette |
| ⌃` | View | Show or hide the terminal panel |
| ⌘\ | View | Move the terminal panel between the bottom and the right |
| ⌘B | View | Collapse or expand the sidebar |
| ⌘J | View | Open the next agent that needs you |
| ⌘F | View | Find: searches the active terminal tab when the terminal has focus, otherwise focuses Home's search |
| ⌘= / ⌘− / ⌘0 | View | Bigger, smaller, reset terminal font |
| ⇧⌘A | View | Activity drawer |
| ⌘W | Terminal | Close (detach) the active tab |
| ⌃Tab / ⌃⇧Tab | Terminal | Next / previous tab |
| ⌘1 … ⌘9 | Terminal | Go to tab 1 … 9 |
| ⌘, | Crafted Herdr | Settings |

Edit has the usual Undo, Redo, Cut, Copy, Paste and Select All. Crafted Herdr has About, Hide, Hide Others, Show All and Quit (⌘H, ⌥⌘H, ⌘Q), and Window has Minimize and Bring All to Front (⌘M for Minimize). There is no Close Window item, so ⌘W with no tab open does nothing; the red button still hides the window.

These work on Home when the focus is not in a terminal:

| Shortcut | Action |
|---|---|
| ⌘N | New session |
| ⌘↩ | Open the selected row (here or in your terminal, by your Settings choice) |
| ⌘R | Refresh |
| ⌫ | Close the selected session (asks first) |

One shortcut is global rather than in a menu: ⌃⌥⌘H shows or hides the app from anywhere (it can be turned off in Settings).

## Privacy

- Warp is opened through a launch configuration the app writes to `~/.warp/launch_configurations/crafted-herdr-*.yaml`. These files stay on disk and contain the attach command (the terminal id and, for a remote workbox, the SSH target). Delete them if you don't want them kept.
- The app makes no network calls of its own. Everything goes through your `herdr` CLI, and SSH is done by herdr and OpenSSH.
- Your SSH keys and agent stay with OpenSSH. The app stores no passwords, keys or tokens, and only reads `Host` aliases from `~/.ssh/config` to suggest targets.
- No telemetry, no analytics, no accounts.
- The one link it can open is https://herdr.dev, from the "herdr wasn't found" screen. Links in a terminal tab are copied, never opened.
- The terminal fonts and code are bundled with the app; nothing is loaded from the web.

## Development

Requirements: Node 24 or later, pnpm 10, a stable Rust toolchain.

```bash
pnpm i && pnpm tauri dev     # run the app
pnpm test                    # Vitest
pnpm lint && pnpm typecheck
cd src-tauri && cargo test && cargo clippy --all-targets -- -D warnings && cargo fmt --check
```

- **fake-herdr.** `scripts/fake-herdr` is a test double for the herdr CLI. Unit and integration tests run against it, so no test ever touches real herdr state.
- **`.env.local`.** Copy `.env.local.example` to `.env.local` (gitignored) for anything personal: the opt-in live tests (`HERDR_UI_LIVE=1`, `HERDR_UI_TEST_MACHINE`) and private patterns for the data check. Real machine names, hosts and paths live only there.
- **Personal-data check.** Run `scripts/check-no-personal-data.sh` before every commit. It fails if a home path, key or any of your private patterns is in the repo.

Examples in the code, tests and docs use generic names only: workboxes `buildbox` and `gpubox`, project `api-service`. See [CONTRIBUTING.md](CONTRIBUTING.md) and [CLAUDE.md](CLAUDE.md). The design is in `docs/superpowers/specs/`.

## License

[MIT](LICENSE)
