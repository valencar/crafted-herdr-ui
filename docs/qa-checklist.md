# Manual QA checklist

GUI-only checks that implementers skip; run them in a final pass with the maintainer.

**v0.9 moved the app from the herdr 0.9 CLI to herdr-core (`hc`).** Start with the [v0.9](#v09) section at the end. The older sections below were written for the retired CLI (snapshots, panes, `agent …` commands, "Open full herdr UI", `ssh -t` attach); where they disagree with v0.9, v0.9 wins, and an item that names a herdr CLI command is covered there instead.

## Before release

Run these first, in order, on the built app (`pnpm tauri build`, then the `.app` or `.dmg`). They cover the highest-risk behavior. Use the sandbox core (`HC_SESSION=herdr-ui-qa`) and, for a remote one, an ssh target in `$HERDR_UI_TEST_MACHINE` that has hc installed (see v0.9), and touch only terminals labelled `herdr-ui-qa=1`. A remote workbox is added only on its `herdr-ui-qa` session, never the remote's default session. The per-task sections below hold the rest.

- [ ] Launch the built `Crafted Herdr.app` from Finder (not from a terminal): herdr-core is found through the login shell, Local shows Online, and every remote workbox shows Online (SSH agent auth works from a GUI-launched app). This verifies the login-shell PATH and environment capture.
- [ ] Login shell that sets PATH/SSH_AUTH_SOCK only in ~/.zshrc, app launched from Finder: herdr-core is still found and remote workboxes still connect. The window shows "Connecting to herdr-core…" (never the "herdr-core wasn't found" screen) until startup finishes.
- [ ] Ghostty `-e` argv is not re-joined into a shell string: an argument with spaces or quotes arrives as one argument and the attach command runs unchanged. (Run this first: it decides whether the Ghostty launcher is right.)
- [ ] Open a session in each installed terminal (Ghostty, iTerm2, Terminal, Warp, WezTerm, Kitty, Alacritty, and a Custom template): each opens a window running the attach command and lands in the pane. iTerm2 and Terminal ask for Automation permission on first use.
- [ ] Remote attach: open a terminal on a remote workbox, then open it again while another client is attached. Both attach with no prompt (several viewers can share a terminal). A normal detach (`Ctrl+\`) shows no prompt.
- [ ] A done agent marks seen when you open it: Open on a done row in your terminal, and the agent shows idle once the terminal opened; Open in an in-app tab, and it shows idle once the tab shows the agent (live and in front; `herdr.seen` is written; see v0.9). An in-app open that fails (for example with 16 tabs already open) leaves it Done.
- [ ] Notifications: an agent that becomes blocked fires one "<agent> needs you" with "<project> · <workbox>"; one that finishes fires "<agent> finished"; nothing fires for agents already blocked or done at startup or on reconnect. Clicking one brings the window forward with that row selected. Check it from the built app, not `tauri dev`.
- [ ] The tray: the monochrome `>_` icon follows light and dark menu bars, the count shows while agents are blocked or done and disappears at 0, left-click opens the popover, right-click shows the menu, and closing the window with the red button leaves the app in the menu bar.

Carried from the reviews (coordinator notes):

- [ ] `env -0` works for the login-shell capture on macOS 13 (the environment is read correctly when launched from Finder there). If `env -0` is not supported, the fallback still yields `PATH` and `SSH_AUTH_SOCK`.
- [ ] iTerm2 parses quoted commands that contain `'\''` (a command with a single quote in an argument, such as a reply or a name, runs as typed).
- [ ] A session name or id with odd characters (spaces, quotes, `;`, `$`, newlines) is refused with a clear message instead of being opened.
- [ ] When a mutating call (close, remove, label, run) times out, the app shows "may have been applied" and refreshes rather than reporting a plain failure, and never retries on its own.
- [ ] The release build renders fonts and styles under the restrictive CSP with no violations in the devtools console, and the app icon (a light `>_` on a graphite rounded square) shows in the Dock, the DMG and the app switcher.

## Task 0

- [ ] `pnpm tauri dev` opens a single window titled "Crafted Herdr" (1280x820, overlay title bar, minimum size 900x600) showing the heading "Crafted Herdr".
- [ ] `pnpm tauri build --debug` (full bundle, including the DMG step) succeeds on a machine with Finder automation permitted. The DMG step needs a GUI session; the automated check uses `--bundles app`.

## Task 5

- [ ] `pnpm tauri dev`, then in devtools run `await window.__TAURI__.event.listen("state", e => console.log(e.payload))` (or `invoke("get_state")`): a `"state"` event arrives with Local and every enabled machine, and its `health` is `online` with a snapshot.
- [ ] With herdr missing from PATH and from the usual locations, `invoke("get_state")` returns `herdr_path: null` and no machines are polled.
- [ ] Minimizing the window or sending it to another Space slows polling to 10 s (watch the Activity drawer or `calls.log`); focusing it again polls within about 2 s. The Task 5 handler reacts to `Focused` and `Resized` only, so check that minimizing is noticed.
- [ ] Turn a machine's network off or break its SSH auth: its card shows Reconnecting (transient) or Attention (auth) with herdr's own message, keeps its last snapshot, and other machines keep updating.
- [ ] After a status change is observed, `activity.json` appears in the app data dir within about 5 s.

## Task 6

- [ ] In `pnpm tauri dev`, body text renders in Geist and paths/ids in Geist Mono (devtools "Rendered Fonts"), with the network disabled.

## Task 7

- [ ] Verify `agent focus` turns done→idle without moving an attached client's view; if it moves, switch markSeen to a local seen-set.
- [ ] On a throwaway machine entry, check that `herdr machine rename|enable|disable|remove` succeed from the app and that the machine list refreshes (these commands print plain text; `Actions` treats non-JSON output on exit 0 as success).
- [ ] Create a session (with a `herdr-ui-qa` name): the command preview matches the calls in the Activity drawer. (Superseded by v0.9: there is no tab, split, workspace or worktree placement any more.)
- [ ] Reply with text that starts with `-` reaches the agent verbatim (the app inserts `--` before it).

## Task 8

- [ ] With `pnpm tauri dev`, run `await window.__TAURI__.core.invoke("open_session", {machineId: "local", paneId: "<a local shell pane>"})` in devtools. The default terminal opens, attached to that pane; `ctrl+b q` detaches. Repeat with iTerm2 and with Terminal.app as the default (first use asks for Automation permission).
- [ ] Open a pane on a remote machine: the terminal runs `ssh -t <target> sh -c '…'` and attaches. With a second client already attached, the shell asks "Another client owns this session. Take over? [y/N]"; `n` leaves it alone and `y` takes over. Check that detaching normally (`ctrl+b q`) does not show the takeover prompt (the command assumes a clean detach exits 0).
- [ ] `invoke("open_full_herdr", {machineId})` opens the full herdr UI, locally and on a remote machine (`herdr --remote <target>`).
- [ ] Warp: confirm `warp://launch/crafted-herdr-<hash>.yaml` really runs the attach command (a window with one tab that attaches). The file lands in `~/.warp/launch_configurations/`. If Warp opens without running it, switch the Warp launcher to opening Warp plus copying the command to the clipboard with a toast.
- [ ] Ghostty, WezTerm, Kitty, Alacritty (whichever are installed): `open -na … --args …` opens a new window that runs the attach command. Ghostty may ask to allow the command the first time.
- [ ] iTerm2 in Tab mode (once Settings exist): adds a tab to the current window, and opens a window when none is open.
- [ ] `invoke("list_terminals")` lists the installed terminals; install or remove one and call it again to see the list refresh. `invoke("copy_attach_command", …)` returns a line that works when pasted into a shell.
- [ ] Set a fish login shell (`chsh -s $(which fish)`, or a fish login on the remote machine) and open a pane from Terminal.app, Warp and a remote machine: each attaches, and the takeover prompt still works. Also try a herdr install path containing a space.
- [ ] First `osascript` use (iTerm2 or Terminal.app) shows the macOS Automation prompt; wait on it for longer than 10 s and then allow it: the pane still opens (the AppleScript launch allows 120 s).

## Task 9

- [ ] `pnpm tauri dev` against live state: the Home window lists every machine's agents, with "Needs you" cards first (blocked, then done), projects grouped by folder, and each shell pane shown as a "Shell" row. The sidebar counts match.
- [ ] Traffic lights sit left of "Crafted Herdr" without overlapping it, and dragging an empty part of the header moves the window (the 78 px inset and `core:window:allow-start-dragging`).
- [ ] Segmented Project / Workbox / Status switches views instantly; clicking a project or workbox in the sidebar scrolls to its group.
- [ ] Arrow keys move the selection through the visible rows and keep it in view; ⌘↩ opens the selection in the terminal shown in "Opens in <Terminal>"; ⌘K focuses search; ⌘R refreshes (the page itself does not reload); ⌘N opens the new-session sheet.
- [ ] ⌫ on a selected row opens "Close <name>?"; Cancel and Escape leave the pane alone; "Close session" on a throwaway pane (named `herdr-ui-qa`) closes it and the row disappears, and the selection clears.
- [ ] A done card's "Mark seen" turns the agent from done to idle on the next poll; a failing open or mark-seen shows an error toast with herdr's own message.
- [ ] Break a machine's connection: its rows dim, show herdr's error and "last updated Ns ago", and the other machines stay normal.
- [ ] The release build (`pnpm tauri build --debug`, then run the .app) renders fonts and styles with the restrictive CSP in `tauri.conf.json` and the devtools console shows no CSP violations.

## Task 10

- [ ] Against a real pane in a `herdr-ui-qa` session, check the live preview shows the same text as `herdr pane read <pane> --source recent-unwrapped --lines 60 --format text` run by hand (plain text on stdout), for both an agent pane and a shell pane, locally and on a remote machine.
- [ ] Select a row: the inspector's Live preview fills with its terminal text within about 2 s and follows new output; selecting another row swaps the text and never shows the old pane's output. Clearing the selection stops the reads (the Activity drawer shows no more `read` calls).
- [ ] Minimize the window or move it to another Space: `read` calls stop; bring it back and the preview refreshes within about 2 s.
- [ ] Reply to an idle agent from the inspector: the text reaches the agent, the field clears, and a blocked agent shows the field disabled with "Answer this in the terminal".
- [ ] Rename an agent (a lowercase name) and a shell pane (any text), then Copy command: the clipboard holds the exact line shown in the "what Open runs" box and the button reads "Copied" briefly.
- [ ] Close from the inspector asks first; "Close session" on a throwaway pane closes it and the selection clears.

## Task 11

- [ ] ⌘N and the "+ New session" / "+ Session" buttons open the sheet over Home; it matches the layout of the design (workbox cards, folder + Recent chips, worktree line, Run grid, Name / Place it, command box, footer). Tab stays inside, Escape and Cancel close it, and focus lands back on the button that opened it (WKWebView does not focus a button on click, so check this one by hand).
- [ ] "Browse…" shows only for Local, opens the native folder picker, and fills the folder field; cancelling leaves the field alone.
- [ ] On a `herdr-ui-qa` workspace: create a shell and an agent (new tab, split beside, new workspace). The command box matches the calls in the Activity drawer, the terminal opens when "Open in <Terminal> when ready" is checked, and the new row is selected once the next poll lists it.
- [ ] Worktree on a repository herdr does not trust: herdr's message shows with "Trust this repository and retry"; nothing is created until that click.

## Task 12

- [ ] Click a workbox in the sidebar: the Workbox screen opens with its workspaces, tabs and pane boxes; the breadcrumb "Workboxes" returns to Home; ⌘N opens New session with that workbox preselected.
- [ ] "Reconnect" on a remote workbox opens the default terminal running `herdr machine reconnect <id>` (SSH auth prompt works there); "Open full Herdr" opens `herdr --remote <target>`.
- [ ] The last line in each pane box updates within about 10 s while the screen is visible, and the app stops calling `pane read` (Activity drawer / `calls.log`) when you go back to Home.
- [ ] Rename, Disable, Enable and Remove on a throwaway workbox; Remove returns to Home and the sessions keep running on the machine.
- [ ] Closing a workspace that has linked worktree workspaces shows herdr's message with the "close its linked worktree workspaces first" note (needs a real worktree setup; use a `herdr-ui-qa` workspace).
- [ ] "Check now" on an unreachable workbox reports herdr's error and shows no "checked" time.

## Task 13

- [ ] "+ Add workbox" (Home sidebar and Workbox screen) opens the sheet. The chips match the `Host` aliases in your `~/.ssh/config` (and files it `Include`s), with no wildcards.
- [ ] A host that is already a profile shows "Already added as <label>" and the button is disabled.

## Task 14

Live QA of the native `machine add` layer was not run by the implementer. Run these by hand; `HERDR_UI_LIVE=1` and `$HERDR_UI_TEST_MACHINE` are for the maintainer's own machine only.



## Task 15

None of these were run by the implementer (tray, popover, notifications and the global shortcut need a GUI session).

- [ ] Close the main window with the red button or ⌘W: the window hides, the app stays in the menu bar, and polling slows to the hidden interval. ⌘Q quits for real. Clicking the Dock icon (or "Open Crafted Herdr" in the tray menu) brings the window back.
- [ ] The tray icon is a monochrome `>_` that turns white in a dark menu bar and black in a light one. With agents that are blocked or done, the number of them shows next to it; it disappears at 0.
- [ ] Left-click the tray icon: the 380x560 popover opens centered under it with no title bar. Click elsewhere and it closes; click the icon while it is open and it closes (it does not flicker open again). Right-click shows Open Crafted Herdr, New session…, Settings…, Quit, and each works.
- [ ] Popover: "Needs you" lists blocked then done agents, each with its status in words, project, workbox and age. "Open" opens the session in the terminal. "Open app ⌃⌥⌘H" shows the main window; "New session" shows it with the New session sheet open.
- [ ] Make an agent on the test machine (a `herdr-ui-qa` pane) go blocked: exactly one notification appears, titled "<agent> needs you" with "<project> · <workbox>" as the body. Let one finish: "<agent> finished". Nothing fires for agents that were already blocked or done when the app started, or when a machine reconnects.
- [ ] Click a notification: the main window comes forward on Home with that row selected. If clicks do nothing on your macOS version (the notification plugin reports clicks only "as far as the server reports it"), note it; the fallback is to emit `focus-row` when the app is next activated.
- [ ] In `pnpm tauri dev` the notification comes from the Terminal app's identity (the plugin does this in dev); check it again from the built .app, where it should carry the Crafted Herdr name and icon.
- [ ] ⌃⌥⌘H hides the main window when it is in front, and brings it to the front when it is hidden, minimized or behind another app. Turning it off in Settings › Shortcuts releases the key at once (another app can use it); turning it on registers it again without a restart. macOS's own "Hide Others" is ⌥⌘H, so the global shortcut includes Control to leave it alone: check that ⌥⌘H still hides other apps.
- [ ] Settings window: ⌘, and the sidebar link open the same 880x640 window (a second click focuses it, not a second window). Each section saves as you change it.
- [ ] Settings › Terminal: uninstalled terminals are disabled and say "Not installed". Choosing another terminal changes "Opens in …" in the main window header at once, and the next Open uses it. The header menu's "Custom…" opens Settings when no launch command is set.
- [ ] Custom terminal: set the launch command to a foreground command such as `open -na Ghostty --args -e {attach}` and open a session: the terminal stays open for longer than 10 seconds (the template is no longer killed). The example line under the field shows the resolved command.
- [ ] Settings › Terminal › Attach as "Full herdr UI on that workbox": Open on any row opens the full herdr UI for that row's workbox. Open mode "New tab" adds a tab in iTerm2 and opens a window elsewhere.
- [ ] Settings › General: set the window-open refresh to 5 s and the hidden one to 30 s; the Activity drawer shows polls at that pace without a restart. Typing 0.5 shows "Use at least 1 second." and saves nothing. "Open a new session in my terminal when it is ready" sets the New session checkbox's starting state.
- [ ] Settings › Workboxes: the switches enable and disable a workbox (the sidebar and the Workbox screen follow); Local's switch is locked on.
- [ ] Settings › herdr-core: "Choose binary…" with another herdr-core install switches to it at once (path and version update). Save a path, then rename that file: restart the app and the section says the saved path is missing while the app keeps working through auto-discovery. "Find it automatically" clears the saved path.
- [ ] With no herdr-core anywhere, launch the app, then choose a binary in Settings: the state arrives without a restart.
- [ ] Occupy ⌃⌥⌘H with another app (or a Shortcuts.app shortcut), then turn the global shortcut on in Settings › Shortcuts: it shows "Couldn't register ⌃⌥⌘H (another app may be using it)". Free the key and toggle it off and on: the message goes away.
- [ ] The popover footer shows the ⌃⌥⌘H hint only while the global shortcut is switched on in Settings.

## Task 16

None of these were run by the implementer (they need a real GUI session and a machine without herdr on its PATH).

- [ ] Launch with no herdr anywhere (rename the binary and clear the saved path): the main window shows "herdr wasn't found" with the install URL as text, "Open herdr.dev ↗" and "Choose binary…". "Open herdr.dev ↗" opens https://herdr.dev in the default browser (the capability allows that one URL; nothing else opens). "Choose binary…" with a real herdr switches to Home at once, without a restart. Choosing a file that is not herdr shows the refusal inline and stays on the screen.
- [ ] ⌘⇧A and the sidebar footer's "Activity ⌘⇧A" open and close the Activity drawer on Home and on a Workbox screen. While open it adds new commands within about 2 s. Poll and preview reads are hidden until "Show reads" is on; a failed read still shows. "Copy" on a row pastes a command that runs in a terminal. Escape closes it and focus goes back to where it was.
- [ ] With a herdr older than 0.9.0 (or one whose `--version` can't be read), Home shows the banner "herdr <version> is older than this app supports (0.9.0+). Some actions may fail." and "Dismiss" hides it until the version changes.
- [ ] Stop reaching a workbox (disconnect the network or use a profile with a wrong target): its rows dim and show the error and "last updated Ns ago". Once the machine is in Attention, one "<label> needs attention" card sits at the top of Home (even when the machine has no rows) with the error and `herdr machine reconnect <id>` (the profile id) with a working Copy; no row repeats the command. The Workbox screen shows the same line under the error.
- [ ] Disable a workbox that has a cached snapshot: it is dimmed in the sidebar and labelled "Disabled", and its Workbox screen shows 0 for all four counts.
- [ ] With only Local, Home shows the "Only this computer so far" card; its "Add workbox" opens the sheet. With no agents anywhere, "No agents yet / Start one with ⌘N." shows.
- [ ] Keyboard: Tab to a row in a project card; the focus ring is fully visible (not clipped by the card's rounded corner). VoiceOver reads a pane box on the Workbox screen as "Open <name>", then its status and last line; a kind badge reads as the full kind name.

## Task 17

- [ ] From a pushed `v*` tag, the Release workflow finishes and publishes a GitHub Release (marked Latest, with generated notes) carrying a universal `.dmg`. On an Apple Silicon Mac, download it, drag the app to Applications, and confirm the first-launch steps in the README (right-click › Open, or `xattr -dr com.apple.quarantine "/Applications/Crafted Herdr.app"`) are enough to start it (the build is ad-hoc signed, not notarized).
- [ ] `pnpm tauri build` (full bundle with the DMG step, in a GUI session) opens the DMG window with the new icon, and `Crafted Herdr.app` inside shows it too.

## Final review fixes

None of these were run by the implementer (they need a GUI session or a real herdr).

- [ ] Open a pane, open the full herdr UI, and run Reconnect and "Continue in <Terminal>" on a test workbox: each appears in the Activity drawer as "opened in <Terminal>" with the machine id, and no exit code.
- [ ] With herdr not running locally (or the binary renamed), Home shows "Local isn't answering" with herdr's error, the hint to start herdr, and "Retry now". Start herdr and press Retry now: the card goes away and Local's rows show.
- [ ] Attach to a pane on a remote workbox whose non-interactive ssh PATH lacks herdr: the terminal prints "herdr not found on <target> (check PATH for non-interactive ssh)" and offers no takeover prompt.
- [ ] Settings › Terminal › Rescan: install or remove a terminal (or move its .app between /Applications and ~/Applications) and press Rescan: the radio list updates. A terminal Spotlight doesn't know (indexing off) is still found in /Applications.
- [ ] Settings › Terminal › "Attach as: Full herdr UI": the inspector's "what Open runs" box shows the full-UI command (`herdr --remote <target>`), and switching back shows the attach command without reselecting.
- [ ] Add workbox for a host that already has a profile, with a different remote session: the button is enabled. With the same session (or none, when the profile is `default`) it says "Already added as <label>".
- [ ] Unplug the network for one poll interval (a blip of 1-2 failed polls) while an agent becomes blocked: a notification fires after the machine recovers. After a longer outage (3 or more failed polls), nothing fires for what changed meanwhile.

## Polish

- [ ] Toggle a notification setting within 2 s of launching the app: it saves at once, instead of waiting for herdr-core to be located. A core path saved in that window is picked up too (Settings › herdr-core shows the saved path as found).
- [ ] With Settings (or the menu-bar popover) open and the main window hidden or behind it, click the Dock icon: the main window comes to the front.

## v0.2

Items marked "replaced by v0.3" describe the v0.2 bottom/right panel; the `## v0.3` section below covers what took its place.

- [ ] ⌘W with no tab open does nothing; the red button still hides the window.
- [ ] ⌘C/⌘V work in text inputs (Edit menu).
- [ ] Menu shortcuts fire while a terminal has focus.
- [ ] ⌘, opens Settings from the menu; ⌘W with the Settings window focused closes it.
- [ ] The menu bar shows App, Edit, View, Terminal and Window with the shortcuts shown in the menus (Dashboard ⌘1, Toggle Terminal ⌃`, Dashboard Beside Terminal ⌘\, Tab 1–8 on ⌘2–⌘9), and no Close Window item.
- [ ] A terminal tab renders with the bundled Geist Mono at the right cell width on first open (no misaligned columns after the font loads) and honours the terminal font-size setting; the 16 ANSI colors read well on the dark background (`ls --color`, a TUI).
- [ ] In a terminal tab, ⌘-click on a URL copies it and shows "Link copied"; a plain click does nothing and no browser opens.
- [ ] An exited or detached tab shows "Detached" with Reattach focused (Enter reattaches); Retry works after a failed open; closing the tab leaves the herdr pane running.
- [ ] Resizing the window or panel reflows the running program in the active tab; inactive tabs catch up when shown. (Panel part replaced by v0.3: the terminal takes the middle, and the ⌘\ column is checked under v0.3.)
- [ ] Typing in a tab: ⌃C, arrows, Backspace and a full-screen agent TUI work, and none of those keys moves Home's selection or opens its Close dialog.
- [ ] ~~Panel resize and placement persist (bottom or right edge).~~ Replaced by v0.3: there is no bottom/right panel; the ⌘\ Dashboard column's width persists (see `## v0.3`).
- [ ] Tabs survive Home ↔ Workbox: scrollback and the running program are intact after switching screens and after ⌃` goes to Home and back. (Replaced by v0.3 for the panel wording: ⌃` now switches between Home and the last terminal tab.)
- [ ] A tab for an agent that needs you is highlighted in the tab strip, and the tab shows "Opening…" until its session is up.
- [ ] ⌘F inside a terminal opens the find bar (Enter next, ⇧Enter previous, Esc closes and returns focus to the terminal); ⌘F elsewhere focuses Home's search box.
- [ ] ⌘+ / ⌘− / ⌘0 change the terminal font size within 9 to 24 and reset to 13, and the size persists.
- [ ] With a terminal tab open, the Close dialog, the New session sheet and the Activity drawer sit above it (dimmed scrim over the terminal, no terminal layer on top).
- [ ] Notification click opens the tab.
- [ ] Popover Open brings the main window with the tab.
- [ ] Open in {Terminal} still launches the external app.
- [ ] ⌘K opens the command palette from Home, the Workbox screen and while a terminal has focus; it sits above the terminal (dimmed scrim over it) and under the Activity drawer; ↑/↓ move, Enter runs, ⌘Enter opens an agent the other way (here vs. the external terminal), Esc closes and returns focus to where it was.
- [ ] In the palette, typing finds agents, projects, workboxes and commands; an empty query lists needs-you agents first, then commands; choosing a project scrolls Home to its group, and a workbox opens its screen. While it is open, typing never reaches the terminal behind it.
- [ ] Compact density and collapsed sidebar look right at 50+ agents.
- [ ] ⌘J cycles through the agents that need you (blocked first), selects each on Home and opens it in a terminal tab; with nobody waiting it shows "Nobody needs you right now."
- [ ] ~~⌘\ moves the terminal panel between the bottom and the right edge.~~ Replaced by v0.3: ⌘\ now shows the Dashboard beside the terminal (see `## v0.3`).
- [ ] ⌘B collapses the sidebar to a 56 px rail (workbox initials with health dots, tooltips naming each workbox and its health) and back, on Home and on the Workbox screen; the rail's expand button works.
- [ ] Window size and position persist across quit and relaunch.
- [ ] Quitting with open terminal tabs leaves every herdr pane running (check `herdr pane list`).
- [ ] ⌘C/⌘V copy and paste work inside a terminal tab.

## v0.3

Dashboard home and the tabbed workspace. Use generic data (buildbox, gpubox, api-service) where you can, and the `herdr-ui-qa` workspace on the test workbox for anything that opens or closes panes.

- [ ] The Dashboard renders with real workboxes: summary line, Needs you, the five Right now tiles, a card per workbox and Working now. It lays out well inside the Home tab at a wide and a narrow window (grids wrap, one column when narrow, no horizontal scroll).
- [ ] With nobody waiting, Needs you says "Nobody needs you right now."; with no agents at all, the usual empty and onboarding states show instead.
- [ ] Open an agent from a card: the terminal takes the middle of the window, and switching to Home (⌘1) and back keeps its scrollback and the running program.
- [ ] (Superseded in v0.4: the grouped strip and folding are gone; see `## v0.4`.) Tabs are grouped by workbox in the sidebar's workbox order. Clicking a group label folds it into a chip ("{workbox} · N tabs", plus "N needs input" when one does) and clicking again unfolds it. ⌘J, a notification, a sidebar terminal row, the palette, ⌘2–⌘9 or ⌃Tab landing on a tab in a folded group unfolds it.
- [ ] Open enough tabs (up to the 16 cap) that the session row no longer fits (v0.4: the workbox's second row; the 16-tab cap is checked here, scrolling in detail under `## v0.4: two-row tabs`): it scrolls sideways, the active tab stays in view, and the "All tabs" menu appears at the end, listing every tab by workbox with its status; arrows move through it, Escape closes it and returns focus to the button, and choosing a tab activates it.
- [ ] (Superseded in v0.4 for the tabs themselves: word chips, the needs-input tint on all needs tabs, workbox group labels and the Home tab's changing label are replaced; see `## v0.4: two-row tabs`.) Sidebar and context-bar visuals look right: the sidebar's nested terminal rows with their status dots, and the Home tab's home icon.
- [ ] The context bar above the terminal shows the agent, status, kind and folder · workbox, with Find, "Open in {Terminal}", Detach and "Close pane…" (a full herdr UI tab shows only Find and Detach). Detach does the same as ⌘W; "Close pane…" still asks first.
- [ ] While the terminal has the keyboard: ⌘1 goes to the Dashboard, ⌘2–⌘9 select terminal tabs in strip order, ⌃` switches between Home and the last terminal tab (with no terminal tab open it shows "Open a session to start a terminal."), ⌃Tab and ⌃⇧Tab cycle all tabs including Home, and ⌘W closes (detaches) the active tab and returns to Home. ⌘W on Home does nothing.
- [ ] On the strip, with a terminal tab active, Backspace, arrows and ⌘↩ do nothing to the hidden Home list (no row selected, opened or "Close…" dialog), and the same holds with focus in the context bar or on the window body.
- [ ] ⌘\ with a terminal tab active shows the Dashboard in a column on the right; pressing it again hides it; on Home it does nothing. Drag the handle and use the arrow keys on it (360 to 1200 px), quit and relaunch, and the width (and whether the column is shown) comes back.
- [ ] The terminal re-fits when the ⌘\ column appears, disappears and while it is dragged (no cut-off lines or stale columns in a full-screen TUI).
- [ ] On a narrow window the ⌘\ column does not hide the terminal: the terminal keeps a usable width.
- [ ] The Open button reads "Open" and follows Settings › Open sessions in; its menu has "Open here", "Open in {Terminal}", "Watch (read-only)", "Open in Herdr" (only while Herdr's window is open) and "Copy attach command". When the row already has a tab it reads "Go to tab" (with ⌘2 to ⌘9 when it has one).
- [ ] The Open menu is placed correctly (it is fixed-position): from the last row of an All agents group, from a Dashboard row at the bottom of the page (Working now), from a needs-you card, and from the Inspector. Near the bottom edge of the window it flips up and is never clipped. Arrow keys move through it, Escape closes it and focus goes back to the chevron.
- [ ] "Copy attach command" shows "Copied", and pasting it into a shell attaches the same terminal as "Open in {Terminal}" (a local terminal, and one on a remote workbox, both `hc attach <address>`).
- [ ] A reconnecting (or needs-attention) workbox card is dimmed and marked "as of {age} ago", shows "Retry now"; a hidden workbox is not listed; the workbox's tab in the workbox row (while it has open tabs) and the Workboxes online tile still render.
- [ ] The Activity log shows no extra core calls while the Dashboard is open beyond the app's normal reads (the machine list every 10 s, which is hidden unless "Show reads" is on); leaving it open for a minute adds nothing, and the "Core response" tile still updates.
- [ ] With a terminal tab active, the Inspector's preview and the Workbox screen's tail reads stop (no `hc read` in the Activity log with "Show reads" on), and resume when Home is shown.
- [ ] ⌘F in a terminal opens its find bar; ⌘F on Home switches to All agents and focuses its search. On All agents, arrows, ⌘↩ and Backspace/Delete still work.
- [ ] ⌘K lists "Go to Dashboard", "All agents" and "Dashboard beside terminal", and each works.
- [ ] The sidebar shows Dashboard, Needs you, All agents, each workbox with its health, agent count and nested open terminals, and the first 3 projects with "{n} more". ⌘B collapses it to the rail (Dashboard, needs-you and workbox icons with health; nested terminals hidden).
- [ ] Settings no longer offers terminal placement or panel size. A `settings.json` from v0.2 (with `terminal_placement` and `terminal_panel_size`) still loads, ignoring the old keys, and the other settings (and the Dashboard column) are intact.

## v0.4: two-row tabs

Two rows replace the grouped strip. Use generic data (buildbox, gpubox, staging; api-service, web-app, infra) and the `herdr-ui-qa` workspace on the test workbox for anything that opens or closes panes. These are the GUI-only checks no automated test covers.

- [ ] Chrome-style joins: the active workbox tab and the active session tab each flow into the surface under them with no seam and no border line at the join, and the inverse (concave) corners at their feet are drawn and not clipped by the scrolling rows. Check Home active (the Home tab and the active Home view) too.
- [ ] Hover fills: hovering an inactive workbox tab, an inactive session tab, a Home view and "New on {workbox}" fills it visibly; hovering a needs-input tab (the light orange tint, blocked tabs only) still shows a hover fill on top of the tint, and the tint stays readable.
- [ ] Dashboard beside a terminal (⌘\): with the column shown and the terminal narrow, look at an active session tab that sits over the column. Note whether its join lands on the column with a seam or looks clean. This is for the record, not a pass/fail gate.
- [ ] Tab width: with a few tabs, each session tab is between about 160 and 228 px wide; opening more makes them shrink to the 160 px minimum before the row starts to scroll, and titles ellipsize without moving the close button.
- [ ] Workbox badges and counts: each workbox tab shows its health dot (with its word in the accessible name), its tab count, and a needs badge (its count, "Needs input" on hover, "{n} needs input" in the accessible name) only while one of its tabs waits on you; a blocked tab on `gpubox` badges `gpubox` while `buildbox` is active. A tab of a workbox that left the machine list still has its workbox tab, with health "Unknown".
- [ ] A workbox tab restores its last tab: open two tabs on `buildbox` and one on `gpubox`, pick the second `buildbox` tab, go to `gpubox`, then back to `buildbox`: the second tab is active again. Close that remembered tab and click `buildbox`: its first remaining tab opens (not Home).
- [ ] The Home views row: with Home active, the second row lists Dashboard and All agents (plus the workbox's name while a workbox screen is shown), the active one is marked, and choosing one changes what Home shows. Going to a terminal tab swaps the row for that workbox's tabs, and back again keeps the terminals' scrollback.
- [ ] The session row scrolls sideways when the tabs outgrow it (up to the 16 cap), the active tab stays in view after ⌘2–⌘9, ⌘J, a notification or a sidebar click, and the "All tabs" menu appears at the end: it lists every tab by workbox with its status, arrows move through it, Escape closes it and returns focus to its button, and choosing a tab switches workbox and activates it.
- [ ] "+ New on {workbox}" opens a menu under the button (not cut off by the row, even with the row scrolled or the Dashboard column open): Terminal (⌘T), a "Start an agent" list of the agents installed on that workbox, each with its logo and a digit 1–9, and New session… (⌘N). While the agents load it says "Checking installed agents…"; Terminal and New session… work meanwhile.
- [ ] Second line of every state: a tab shows its words under the title for Working, Idle, Needs input, Done, unseen, Unknown, Shell, "Opening…", "Detached", "Error" and a combined "Detached · Needs input". No state is shown by colour alone.
- [ ] ⌘2–⌘9 tooltips on session tabs ("{status} (⌘n)") use the flat order across workboxes, not the position inside the row (e.g. the first `gpubox` tab says ⌘4 when `buildbox` has two tabs and comes before `gpubox` in the machine list, Home being ⌘1).
- [ ] Copy through the clipboard plugin: ⌘-click on a URL in a terminal shows "Link copied" and pasting elsewhere gives that URL (the link is never opened); "Copy attach command" shows "Copied" and pastes the command; the other copy sites still copy: the Inspector's command box, the Activity drawer and the reconnect box in the Home notices. No permission prompt appears for the clipboard.

## v0.5

Bigger type, brighter secondary text and roomier rows. Use generic data (buildbox, gpubox, staging; api-service, web-app, infra). These are the GUI-only checks no automated test covers. Text must fit by wrapping, ellipsis or a sensible minimum width, never by shrinking the type back.

- [ ] The 900×600 window (the minimum size): the sidebar, the two tab rows, the Dashboard and All agents all lay out with no clipped text, no overlap and no horizontal page scroll.
- [ ] The ⌘B rail: collapsing and expanding the sidebar keeps every label readable, and the rail's icons and badges are not cut off.
- [ ] Workbox and session tabs at 160 px: with enough tabs open that each session tab sits at its 160 px minimum, titles and second lines ellipsize without moving the close button, and long workbox labels ellipsize with their count and needs badge still visible.
- [ ] The 360 px split column (⌘\ beside a terminal): the narrow Dashboard's tiles, cards and rows wrap or ellipsize, and nothing is clipped at the column's edge.
- [ ] The context bar (agent, status, Find, Open in {Terminal}, Detach, Close pane…), the ⌘K palette, the Activity drawer, the sheets and dialogs, the menu bar popover and Settings: all text is readable at the new sizes, regular buttons are 36 to 38 px tall in Comfortable and small in-row and context-bar buttons 32 px, and long names ellipsize instead of overflowing.
- [ ] Sidebar items and agent rows are at least 40 px tall in Comfortable (a sidebar item with a second line about 48 px), and group headers ("Workboxes", "Projects", the popover's "Needs you · n") read in sentence case, not capitals.
- [ ] Compact vs Comfortable side by side: switch the density in Settings; Compact keeps today's tighter rows, Comfortable is visibly roomier, and neither shrinks the type.
- [ ] Project site: build it (`scripts/build-site.sh 0.4.0`), then open `_site/index.html` through `python3 -m http.server -d _site` at 1440 px and at 375 px. There is no sideways page scroll at either width, the feature rows stack text above picture at 375 px, and the Copy buttons copy their command.
- [ ] Project site install card: the Homebrew, Download and From source tabs switch by mouse; with a tab focused, ArrowLeft, ArrowRight, Home and End move focus and selection; the "Open Anyway" note shows for Homebrew and Download and hides for From source.
- [ ] Per-window commands: the popover, the Settings window and the main window each still do everything they did (rows open, Settings save and detect, every main-window action and terminal tab), and the devtools console of each shows no "not allowed" or "not permitted" errors.
- [ ] Open in each terminal (Ghostty, iTerm2, Terminal, Warp, WezTerm, Kitty, and a Custom template) still launches, through `/usr/bin/open` and `/usr/bin/osascript`, and the first AppleScript launch still shows the Automation hint when permission is missing.
- [ ] The next release run shows the `build` job without write permissions and `SHA256SUMS.txt` among the release assets next to the DMG and `.app.tar.gz`.
- [ ] ⌘T (Terminal > New Tab) on a terminal tab starts a plain shell at once, with no sheet, in that terminal's folder (after a `cd` in a shell, the new one follows the live folder), on the same workbox, and opens it as a new tab that becomes the active one, whatever the "Open sessions" setting says (it never opens your own terminal). Pressing it twice makes two shells. A folder that no longer exists shows the error toast and opens nothing else.
- [ ] ⌘T falls back to the New session sheet, with the workbox filled in when there is one, wherever there is no folder to take: on Home (the Dashboard opens the plain sheet, like ⌘N; a Workbox screen, that workbox; All agents with a row selected, that row's workbox), on a command tab (Log in…, Update hc there…), on a tab whose terminal has left the list, and on a tab of a disabled or removed workbox (the plain sheet). It never creates a session in those cases.
- [ ] The "+" menu's keys and outside click: opening it focuses Terminal; ↑ ↓ Home and End move; Escape closes it and returns focus to "New on {workbox}"; a click anywhere outside closes it; clicking the button again closes it; choosing an item returns focus to the button. Keys typed in the terminal are never taken while it is open.
- [ ] Start an agent from the "+" menu: clicking an agent, or pressing its digit with the menu open, starts that agent in the active terminal's folder on that workbox (no task, no name) and opens it as a new tab here. An agent hidden in Settings (New session) is not listed. With the agents call failing (a workbox that is unreachable) it says "Couldn’t load agents" and the other items still work. New session… opens the full sheet with that workbox and folder filled in.

## v0.7

UI polish: motion, status shapes, the ⋯ menu, palette actions, the ⌘/ sheet, the light theme and a quieter notification rule. Use generic data (buildbox, gpubox, staging; api-service, web-app, infra). Every pull request's CI run attaches a test DMG (the `preview` job summary links it); install it and run this section on that build. These are the GUI-only checks no automated test covers.

- [ ] New session: the first time, Run starts on Plain shell; after creating a session, the next sheet starts on that session's Run choice, also after a relaunch.
- [ ] Settings > General > New session options: unchecking an option removes it from New session's Run list; the last checked option can't be unchecked.
- [ ] Motion: hover and enter animations feel quick, never sluggish, and everything that loops or enters stops under System Settings > Accessibility > Display > Reduce motion (status dots, skeleton shimmer, menus, tooltips, the palette frame).
- [ ] No lag when collapsing the sidebar (⌘B) or dragging the split column's handle, with a terminal open. The terminal never visibly resizes frame by frame.
- [ ] Skeletons on first launch: the first connect shows placeholder rows (Dashboard and All agents) and placeholder lines in a workbox card that is still connecting, never a blank screen. They are replaced with no layout jump, and a reconnecting card keeps its last data, dimmed.
- [ ] Sidebar: long names fade at the edge and the full name shows in a tooltip; the hint slot swaps its count for the shortcut on hover and on keyboard focus without shifting the row; the fade never shows a horizontal scrollbar.
- [ ] Tab activation: no seam or flash on the inverse corners when a tab becomes active.
- [ ] Translucent fills (`--hover`, `--selected`): the active tab's join with the row below still looks seamless, in dark and in light.
- [ ] Overflowing session row: activating an off-screen tab (All tabs menu, ⌘2 to ⌘9, the sidebar) scrolls it in and leaves its × clear of the edge fade. Scrolled to the end, "New on {workbox}" is clear of the fade.
- [ ] Drag reorder: the drop line sits exactly in the gap (no 2 px jump), the dragged tab dims, and a tab opening mid-drag cancels the drag. After a reorder ⌘2 to ⌘9 follow the new order; a drop outside the row moves nothing.
- [ ] Middle-click on a session tab closes it in the real app (WKWebView `auxclick`), with no autoscroll cursor.
- [ ] Tooltips: they appear after a short delay and at once between neighbours, and hide on click, scroll and resize. They show over the terminal panel, and streaming terminal output doesn't make a hovered tooltip vanish. Escape in vim (or any full-screen program) still reaches the terminal while a tooltip is showing.
- [ ] The ⋯ pane menu in the context bar: it opens under ⋯, the arrow keys, Enter and Escape work (Escape returns focus to ⋯), and no tooltip shows over the open menu. Copy attach command, Mark as seen (done agents only) and Show in All agents work; Close pane… still asks first and closes only after Close. A tab with no agent shows only what still applies, or no ⋯ at all.
- [ ] The palette's agent frame: ⇥ on an agent opens its actions, ⌫ on an empty input (or a click on the crumb) goes back to the same query and selection, and the frame slides. "Reply…" never appears for a blocked agent. Close pane… from the palette asks first, and focus goes back to where ⌘K was pressed. ⇥ on a command does nothing, and the matched letters are highlighted.
- [ ] The ⌘/ sheet opens from the View menu ("Keyboard Shortcuts") and from ⌘/, filters as you type, and Escape or a click outside closes it with focus back where it was. It may open under the Activity drawer (known; the palette behaves the same).
- [ ] Mark seen on the Dashboard: a "Finished, not looked at yet" row's button is invisible until hover or keyboard focus, is reachable with Tab, and marks the agent seen without opening it.
- [ ] Status shapes: every status shows its shape and its words together (Needs input, Done, Working, Idle, Unknown, Shell); only the places that loop (the sidebar, both tab rows, the context bar, the palette and the Dashboard's Needs you cards) animate.
- [ ] Theme Light, Dark and System, in the main window, the menu bar popover and Settings. With System selected, switch macOS Appearance while all three are open: each flips live, and open terminal tabs recolor without losing their scrollback. Opening Settings repeatedly in light shows no dark flash (the first launch after upgrading may show one dark frame).
- [ ] Light theme reading: secondary and tertiary text are readable, and status colors are distinguishable together with their shapes.
- [ ] Terminal colors readable in light: a Claude Code prompt, `ls --color` and `git diff`.
- [ ] Reattach: end an attach (close the pane in herdr, or disconnect a remote workbox). The bar docks at the bottom with the attach's own output still readable above it, and its reason names the cause (exit code, herdr not found or ssh unreachable). A second Reattach shows "Reattach failed (attempt 2)". With the network still down, Reattach keeps the bar up saying "Reattaching…" with Close tab enabled (the tab is never left blank with no buttons) until ssh gives up or the pane draws. Every button on the bar takes a mouse click (Reattach, Copy attach command, Open in {Terminal}, Close tab), not only the keyboard: xterm's WebGL layer must stay under the bar. "Copy attach command" and "Open in {Terminal}" work, and a pane that is gone offers only Close tab. Known: a reattach that ends non-zero hours after the click says "Reattach failed (attempt 1)".
- [ ] Notifications: with the main window focused on an agent's terminal tab, no banner for that agent. Switching to another app, another tab or Home, or hiding the window to the tray, brings banners back. The tray badge counts either way.
- [ ] Select and copy in the terminal: in a herdr tab (mouse reporting on), a plain drag goes to herdr (herdr selects and copies over OSC 52, with the "Copied" toast), but ⌥-drag selects text in the app and copies it when the button is released, also with the "Copied" toast; paste it elsewhere to check. A double click on a word and a triple click on a line copy too. Selecting with the keyboard, Select All and a Find hit do not touch the clipboard, and a plain click only clears the selection. In a tab whose session has ended (no mouse reporting) a plain drag selects and copies. ⌘C with an app selection (⌥-drag, then ⌘C) copies it too, with the "Copied" toast; ⌘C with no selection does nothing and types nothing into the terminal. Copying inside herdr with its own selection lands on the Mac clipboard too and shows the "Copied" toast. Inside a tmux pane, copying with tmux's own selection (it sends an OSC 52 with no target) lands on the clipboard too. A program asking to read the clipboard (an OSC 52 query, e.g. `printf '\e]52;c;?\a'`) gets no reply: nothing is typed into the shell. A garbage sequence (`printf '\e]52;c;!\a'`) leaves the clipboard alone and shows no toast.
- [ ] Terminal font: Settings > Terminal > Terminal font (right under Open sessions, with the hint "Font for the terminal tabs in the main window") lists Hack (the default), IBM Plex Mono, Geist Mono and JetBrains Mono. Choosing one changes every open terminal tab at once, with the columns and rows refitted (herdr redraws at the new size) and the scrollback kept; the choice survives a relaunch. The chrome's ids and paths stay Geist Mono.
- [ ] Text weight: body text, labels and terminal output read at normal Mac weight in both themes, not thin (the font smoothing override is gone); compare with another Mac app side by side.
- [ ] Hidden tab cell size on macOS 13.0 to 13.2 (older WebKit measures cells with the DOM, not an OffscreenCanvas; skip this on 13.3 and later): open two terminal tabs, switch to the second, change Settings > Terminal > Terminal font, switch back to the first. Its columns line up, text isn't clipped or spaced for the old font, and a resize (or Reattach) fixes it if not. Known gap: its first refit after being shown may use the old font's cell size.
- [ ] PR preview DMG: install the DMG from a pull request's CI run (the `preview` job summary), run the first-launch steps from the README, and work through this section on it.

## v0.8

Workbox colors and agent logos. Use generic data (buildbox, gpubox, staging; api-service, web-app, infra).

- [ ] All 8 colors (violet, pink, lime, cyan, yellow, magenta, leaf, purple) in Dark, Light and System: set each on a workbox from the picker and switch the theme live in the main window.
- [ ] The tile letter and the tinted text are readable on every color, in both themes.
- [ ] The collapsed rail (⌘B) marks the active tab's workbox.
- [ ] Switching workboxes retints both tab rows with no flicker after the settings load, and a workbox never switches from one color to another; a brief neutral frame at startup is fine.
- [ ] A fresh install (no `workbox_colors` in settings) assigns colors once, Local first, and the same colors are there after a restart.
- [ ] Removing a workbox recolors nobody.
- [ ] The picker and the right-click menu (the sidebar workbox row and the workbox tab), by mouse and by keyboard: arrows, Home, End, Enter and Escape work, focus goes back to where it was, and no tooltip shows over the open menu.
- [ ] Agent logos are crisp at 1x and 2x and in both themes.
- [ ] Violet next to the blue "working" ring, and violet next to purple, side by side in both themes: they read as different.
- [ ] The light-theme tint is 10%: the active workbox band is visible enough.
- [ ] The collapsed rail: the health dot overlaps the tile's corner with no ring; an online dot is visible on the lime and leaf tiles.
- [ ] The 2 px rail beside a workbox's nested tabs lines up under the tile.
- [ ] The health-dot ring on a hovered workbox tab: there may be a faint halo; judge whether it is acceptable.
- [ ] An active tab that needs input shows the orange edge, not the workbox line. This is intended.
- [ ] Yellow next to the orange needs-you badge and edge: a yellow workbox must not read as orange (check a yellow tile beside a blocked agent's badge, in both themes).
- [ ] The health-dot ring on the selected (tinted) sidebar workbox row: the ring takes the row's tint and shows no mismatched halo.
- [ ] The agent badge (logo) in the New session and Settings options, and in agent rows, the Inspector and the context bar: rows keep their height and the chip is not split when it wraps.
- [ ] Codex still shows "CX". This is intended: there is no licensed mark.

## v0.9

herdr-core. Use generic data (buildbox, gpubox, staging; api-service, web-app, infra).

- [ ] Lists fill and statuses move against the sandbox core (`HC_SESSION=herdr-ui-qa`, scratch XDG dirs).
- [ ] Open a Local terminal and a terminal on a second machine (`buildbox`) with "Open in {Terminal}": the window runs `hc attach t7` / `hc attach buildbox/t7` directly (no `ssh -t`, no takeover prompt), in Ghostty, iTerm2 and Terminal.app. The Activity drawer shows the same line, and Copy puts it on the clipboard and it works in a shell. Try a fish login shell and a core path with a space.
- [ ] In an in-app tab press `Ctrl+\` to detach: the bar says "Detached." Kill the terminal's program (`hc kill t7`): "The program ended (killed)." Run `hc server stop` in a scratch session: "herdr-core stopped.", Local says "herdr-core isn't running" at once, and after Reconnect the tab reattaches by itself once the core is back.
- [ ] In the sandbox core, open a kept terminal in an in-app tab and, in that tab, run `kill -KILL $$` (its own shell, so no pid is typed by hand): the tab says "Waiting for a new shell…" and reattaches by itself once, when the new shell starts.
- [ ] Open a tab on a machine that is unreachable: the bar says "Not available right now." and Reattach works once it is back. Remove a terminal from another window: "This terminal is gone."
- [ ] Add workbox, direct: with a reachable target that has hc (a throwaway Docker sshd with hc, or `hc machine add --via` stand-in), give it the remote session `herdr-ui-qa` and the name `herdr-ui-qa`, plus a port if it is not 22. The button reads "Adding…", the sheet closes, "Added herdr-ui-qa" shows and its Workbox screen opens, also when a terminal tab was active behind the sheet. Add it as Temporary: the Activity drawer shows `hc machine add <target>:<port> --name herdr-ui-qa --session herdr-ui-qa --temp`. Clean up by stopping the sandbox core through the `env -i`/`HC_SESSION=herdr-ui-qa` wrapper (`hc server stop`), then deleting the sandbox's scratch `XDG_*` dirs: stopping the core does not delete a temporary machine (herdr-core's `docs/machines.md`: "does not delete anything"), so its record stays in that scratch state until the dirs are gone; never `hc machine rm`.
- [ ] Add workbox, no hc there (a Docker sshd without hc): the sheet says "hc isn't installed on <target>, or it's too old." with "Install hc there…". Nothing is installed or copied by the failure itself. The click asks first, and Cancel or Escape leaves the container without hc. Confirming opens an in-app tab "Install hc" running `hc machine add <target> --install`; its prompts can be answered there. When the machine shows up, "Added <name>" shows and the Workbox screen opens (only if the add tab or Home was in front; from another tab it is just the toast). The add tab stays open with hc's last output until you close it. Remove the container and its key afterwards.
- [ ] Add workbox, real password prompt: against a host that asks for a password or code, the sheet says "<target> needs a login that you type." with the core's words, and "Open in terminal" opens an in-app tab "Add workbox" running `hc machine add <target>` where the password can be typed (the sheet is closed, so the tab is usable). "Open in {Terminal}" runs the same command in the default terminal and shows an "Finish adding … in {Terminal}" toast. Either way, "Added <name>" shows within a few seconds of finishing.
- [ ] Add workbox, real host-key prompt: a host whose key ssh has not seen. The in-app tab shows ssh's "Are you sure you want to continue connecting?" and accepts "yes"; nothing in the sheet answers it for the person.
- [ ] Add workbox, unreachable: a made-up hostname shows "Couldn't reach <target>." with the ssh words and the same terminal buttons. Closing the in-app add tab before the machine shows up ends the wait with no message. With the tab left open and nothing added, the wait ends after 10 minutes with "Didn't see the new workbox yet…".
- [ ] Add workbox with a name that is taken shows the core's message under Name, and an already added core shows it under SSH host. The sheet stays open. A name such as `Build Box` or `t7` is refused before anything is sent.
- [ ] Add workbox through a custom connection: Custom connection takes a command (for example `fly ssh console -a app --pty=false -C`) and needs a name. A command with a backslash is refused. A temporary add shows the "Temporary" badge on the new workbox.
- [ ] Workbox screen on a machine in state `needs_login`: Connect now, Log in…, Rename…, Remove… and Hide show, with "Needs login · since …". Log in… opens a tab "Logging in to buildbox" that runs `hc machine login buildbox`. Type the password or code in it. When it ends the bar offers Close tab only, and a second click on Log in… starts a fresh tab.
- [ ] A machine in state `needs_update`, or one running an older hc than this computer: Update hc there… asks first, naming both versions ("Replaces hc 0.1.16 on buildbox with 0.1.18 from this computer and restarts its core. Its terminals keep running."). A connected machine on the same or a newer hc is not offered it. Confirming opens "Updating hc on buildbox" and runs `hc machine update buildbox`. Its terminals keep running there. Cancel runs nothing. This replaces hc on that machine and restarts that session's core, so run it only on a machine where that is acceptable (the maintainer's call); it can't be sandboxed.
- [ ] Connect now on an `unreachable` machine runs `machine.connect`: the state line moves from "Unreachable · …" to Connecting and then Connected without a restart. The Activity drawer shows the call.
- [ ] Rename… a connected machine (for example to `ci-runner`): its sidebar row, its open tabs and its color stay, and the new name shows everywhere. A name such as `Build Box` or `t7` is refused in the sheet.
- [ ] Remove… asks first ("Forgets this machine here. Its terminals keep running there."). Confirming forgets it here; its terminals are still running on the machine.
- [ ] Hide on the Workbox screen goes back to the Dashboard. The workbox is gone from the sidebar (expanded and rail), the Dashboard, the palette and the lists, and raises no notification. Settings → Workboxes shows it with its switch on, and turning it off brings it back.
- [ ] A temporary workbox (`hc machine add --temp`) shows the word "Temporary" in the sidebar row, the Workbox header and its Dashboard card; the collapsed rail names it "temporary" in its tooltip.
- [ ] A machine added through a custom connection command (`--via`) shows "custom connection" instead of an ssh target.
- [ ] Upgrade from v0.8 with workbox colors saved under machine names: each remote workbox keeps its color after the first launch (the colors are then saved under the machine ids).
- [ ] The Workbox screen groups a machine's terminals by project folder (needs-you groups first, then working, "Loose sessions" last), each box still showing its last line. When that machine has a Herdr layout (Herdr running against it), it groups them by Herdr space instead, with "Not in a space" last; close Herdr's document (no layout) and it goes back to project groups.
- [ ] Shared seen with Herdr (the desktop app) running beside this one against the sandbox core: let a turn end on a Local agent while it is open in an in-app tab of this app. It stays Idle here, and Herdr stops showing it as done too (`herdr.seen` was written once; the Activity drawer hides the write unless it fails). Do the same with the row selected in All agents (the Inspector's preview showing).
- [ ] Shared seen, empty room: with the app in the background (another app in front), minimized, or hidden to the menu bar, a turn that ends on the terminal that was open stays Done here and in Herdr, and the notification shows. Bring the window back with that tab active: the Done clears in both apps, once.
- [ ] Shared seen, locked screen and sleeping display: with the app in front and a terminal tab active, lock the screen (or let the display sleep) and let a turn end on that terminal more than 5 minutes after your last input in the window: it stays Done here and in Herdr, and the notification shows. Within the first 5 minutes after your last input, macOS may still report the window as focused; check what it does there and note it. Unlock and move the pointer or press a key in the window: the Done clears in both apps at once. With the window in front and untouched for 5 minutes (no lock), a turn that ends stays Done until the next input.
- [ ] Mark as unread (here or in Herdr) on the terminal that is open and in front: it stays unread until the next turn ends, and is then marked seen again.
- [ ] After Mark as unread, opening that row in an in-app tab at the same turn leaves it unread until the next turn ends: the seen mark is decided once per turn, and an in-app open marks nothing itself (Rulings C88, C122). Mark as seen clears it at once.
- [ ] Pin an agent here: Herdr shows it pinned too, and the other way round. Pinned rows come first in All agents (inside each group), the sidebar's Needs you list, the palette and the menu bar popover, with a pin glyph beside the name.
- [ ] Watch: on a Needs-input agent (a Local one in the sandbox core) click Watch beside Open, and also try Watch (read-only) in the chevron menu and the ⋯ menu. A tab named "{name} (watching)" opens, its context bar says "Watching (read-only)", and the Activity drawer or `ps` shows `hc attach --observe <address>`. It shows the agent's screen live. Typing in it does nothing (no characters reach the agent), pasting does nothing, and it renders correctly after a window resize and right after open; the remote's size doesn't change (check from a client attached elsewhere). In the Watch tab, "Open in {Terminal}" (in the context bar, and in the bar once its session ends) opens `hc attach --observe <address>` in your terminal, where typing does nothing either, and Copy attach command (⋯ menu and bar) copies the `--observe` line; opening a Done agent from there doesn't mark it seen. Open the same row with Open too: both tabs coexist. An Ended terminal offers no Watch anywhere. With the Watch tab active and live, a turn that ends on that agent clears its Done, as looking at it does.
- [ ] Group by Space with Herdr (the desktop app) running against the sandbox core: make two spaces in Herdr (one named `api-service`, one left unnamed, with its first terminal in a `web-app` folder), each with a terminal, and leave one terminal in neither. The Group by switch in All agents now offers Space (and Settings → General lists it); with Herdr closed and no layout on any machine it is absent. Space groups each terminal under its Herdr space (the unnamed one is named `web-app`), terminals in none go under "Not in a space" last. Rename a space in Herdr: the group is renamed here within a moment. A terminal with no name of its own takes its Herdr tab's name. The app changes nothing in Herdr (the Activity drawer shows `doc.get herdr-app` reads only, no `doc.set`). With a saved "space" and no layout (Herdr's document gone), All agents groups by project meanwhile.
- [ ] Open in Herdr (Herdr, the desktop app, running against the sandbox core): with Herdr's window open, a live row's chevron menu on Open, the ⋯ menu and the palette's action frame each list "Open in Herdr" right after Watch, and choosing it shows that terminal in Herdr's window over its current tab (the Activity drawer shows `herdr-app do terminal.peek '{"terminal":"<address>"}'`, "shown in Herdr"). Close Herdr's window (leave the app running or quit it): within about 10 seconds (a menu asks every 5 s, and the answer is reused for 5 s), and at once after a click that finds no window, the item is gone everywhere. Reopening a menu never shows the item from an earlier answer. An Ended terminal never offers it. With `herdr-app` not installed, it never appears. The app never calls `herdr-app` on its own beyond `--version` while looking for it and `status` while such a menu is open.

### v0.9 additions: install, restart and the live run

- [ ] herdr-core install (onboarding). Rename or hide `herdr-core` and `hc` (a throwaway `PATH`, or Settings › herdr-core › Choose a path that isn't the core) and relaunch: the screen says "Crafted Herdr needs herdr-core (`hc`)." with the line `curl -fsSL https://releases.herdr.dev/core/install.sh | sh` and a Copy button. The app runs nothing; paste it into a terminal yourself and the app finds the core within a moment (or after Choose binary…). herdr.dev is the only link. With only an old `herdr` on the `PATH`, the screen leads with "You have herdr {version}, the older CLI." Another program's `hc` (a window-manager client) is never taken for the core.
- [ ] Core too old: with a core older than 0.1.17 the version banner is advisory only; with one that lacks a method the app needs, the screen says it is too old and offers `hc update` to copy (never run). A newer protocol generation says "Update Crafted Herdr."
- [ ] Local. Launch from Finder with a stopped core: the app starts it (that is `hc`'s own behavior), Local shows Online, and the lists fill.
- [ ] A remote workbox. Set `HERDR_UI_TEST_MACHINE` in `.env.local` to an ssh Host alias (not a herdr 0.9 profile id) of a machine with hc installed, and add it from the sheet (see the Add workbox items above). Add it with the remote session `herdr-ui-qa` (never the default session) and as Temporary. Create a terminal on it with New session (name it `herdr-ui-qa-…`, label `herdr-ui-qa=1` through `hc label` if you want the live test's cleanup to know it): check that the row opens, from the in-app tab and from "Open in {Terminal}", at the machine-local address that `terminal.run` returned (the Activity drawer shows `hc run … --on <name>`; the new row is selected and, with "Open when ready", opens), not at an address from another machine.
- [ ] A core restart, observed when it happens (a note, not a QA step; the restart and update path is covered by the unit tests in `src-tauri/src/sync_tests.rs`). Never run `hc update` or `hc server restart` for QA: the updater rewrites the active install and restarts your own core, and neither can be sandboxed. The next time you run `hc update` yourself with the app open, with a terminal open in an in-app tab and the Dashboard showing: rows go Connecting, then come back without a restart of the app; the open tab reattaches by itself once; and nothing is shown as ended that is still running.
- [ ] Deliberate stop, then Reconnect. First make sure the sandbox core has at least one live Local terminal (start one with New session): a core with none ends nothing when it stops, so its stop looks like a plain drop and the app's retry starts it again. Then, in the sandbox session, run `hc server stop` (never against your own core): Local shows "herdr-core isn't running" at once, with "herdr-core was stopped." under it and a **Reconnect** button. There is no retry: wait a few minutes with the Inspector's preview showing and a Workbox screen open, and the core is still stopped (its socket, `$XDG_RUNTIME_DIR/herdr-core/herdr-ui-qa.sock`, is gone; don't check with an `hc` command, which would start it) and the Activity drawer gains no line (no `terminal.read`, `doc.get`, `templates.list`, `terminal.label` or `machine.list`). Press Reconnect: the core starts, Local is Online and the lists refill. Open tabs say the core was lost and reattach once it is back.
- [ ] The live test, once per release on a sandbox core: `HERDR_UI_LIVE=1 cargo test --test live -- --ignored --nocapture` from `src-tauri/`, under the sandbox environment described at the top of `tests/live.rs`. It prints `created`, `read ok`, `finished` and `removed` for the local leg and either runs the remote leg or prints why it skipped it. The remote leg adds `HERDR_UI_TEST_MACHINE` (an ssh Host alias with hc installed) to the sandbox core as a temporary machine on the remote's `herdr-ui-qa` session, checks that session in `machine.list` before it runs anything there, and never runs `machine rm`. At the end the test stops the sandbox core only if it started it (one already running there is left running, and the test says so), and it prints whether `hc server stop` really stopped one (`{"stopped":false}` is reported as nothing stopped). The temporary machine is not deleted by the stop: its record stays in the sandbox's scratch state until you delete those dirs. Afterwards, when the test started the core, no process of the sandbox core is left, and `~/.local/state/herdr-core/` holds only your own sessions.
- [ ] The window never scrolls as a whole. With enough open terminals that the sidebar's Projects fall below the window, a two-finger scroll anywhere (sidebar, a long All agents list, a terminal) moves only what is under the pointer. The window itself never scrolls or bounces.
