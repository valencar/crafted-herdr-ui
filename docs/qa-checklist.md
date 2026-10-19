# Manual QA checklist

GUI-only checks that implementers skip; run them in a final pass with the maintainer.

## Before release

Run these first, in order, on the built app (`pnpm tauri build`, then the `.app` or `.dmg`). They cover the highest-risk behavior. Use the test workbox (`$HERDR_UI_TEST_MACHINE`) and only the `herdr-ui-qa` workspace or session on it. The per-task sections below hold the rest.

- [ ] Launch the built `Crafted Herdr.app` from Finder (not from a terminal): herdr is found through the login shell, Local shows Online, and every remote workbox shows Online (SSH agent auth works from a GUI-launched app). This verifies the login-shell PATH and environment capture.
- [ ] Login shell that sets PATH/SSH_AUTH_SOCK only in ~/.zshrc, app launched from Finder: herdr is still found and remote workboxes still connect. The window shows "Connecting to herdr…" (never the "herdr wasn't found" screen) until startup finishes, and `herdr status` appears once in the Activity drawer.
- [ ] Ghostty `-e` argv is not re-joined into a shell string: an argument with spaces or quotes arrives as one argument and the attach command runs unchanged. (Run this first: it decides whether the Ghostty launcher is right.)
- [ ] Open a session in each installed terminal (Ghostty, iTerm2, Terminal, Warp, WezTerm, Kitty, Alacritty, and a Custom template): each opens a window running the attach command and lands in the pane. iTerm2 and Terminal ask for Automation permission on first use.
- [ ] Remote attach plus takeover: open a pane on a remote workbox, then open it again while another client is attached. The shell asks "Another client owns this session. Take over? [y/N]"; `n` leaves it alone and `y` takes over. A normal detach (`ctrl+b q`) shows no prompt.
- [ ] A done agent marks seen when you open it: Open on a done row, and on the next poll the agent shows idle (see the Task 7 `agent focus` check).
- [ ] Notifications: an agent that becomes blocked fires one "<agent> needs you" with "<project> · <workbox>"; one that finishes fires "<agent> finished"; nothing fires for agents already blocked or done at startup or on reconnect. Clicking one brings the window forward with that row selected. Check it from the built app, not `tauri dev`.
- [ ] The tray: the monochrome `>_` icon follows light and dark menu bars, the count shows while agents are blocked or done and disappears at 0, left-click opens the popover, right-click shows the menu, and closing the window with the red button leaves the app in the menu bar.
- [ ] Add workbox via terminal on the test workbox: "Add workbox", remote session `herdr-ui-qa`, label `herdr-ui-qa`, then "Continue in <Terminal>" and finish setup there. The sheet closes and "Added herdr-ui-qa" shows. Clean up with `herdr machine remove <new profile id>` and stop and delete the `herdr-ui-qa` session on the target.

Carried from the reviews (coordinator notes):

- [ ] `env -0` works for the login-shell capture on macOS 13 (the environment is read correctly when launched from Finder there). If `env -0` is not supported, the fallback still yields `PATH` and `SSH_AUTH_SOCK`.
- [ ] iTerm2 parses quoted commands that contain `'\''` (a command with a single quote in an argument, such as a reply or a name, runs as typed).
- [ ] A session name or id with odd characters (spaces, quotes, `;`, `$`, newlines) is refused with a clear message instead of being opened.
- [ ] Mutating herdr commands (rename, close, focus) return JSON on success; when one does not (plain text, or a timeout), the app shows "may have been applied" and refreshes rather than reporting a plain failure, and never retries on its own.
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
- [ ] Create a session in a new tab, as a split, in a new workspace and in a worktree (with `herdr-ui-qa` names): the command preview matches the calls in the Activity drawer, and a failed `agent start` leaves the new pane open with an error naming it.
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
- [ ] "Continue in <Terminal>" opens the default terminal running `herdr machine add <target> …` (use a throwaway target and give it the remote session `herdr-ui-qa` in the sheet's "Remote session" field, never a live default session). Finish setup there: within about 2 s the sheet closes, "Added <label>" shows as a toast, and the new workbox opens.
- [ ] Cancel while waiting stops the polling (no more `machine list` calls in the Activity drawer). After 10 minutes with nothing new, the "Didn't see the new workbox yet…" message shows.
- [ ] A host that is already a profile shows "Already added as <label>" and the button is disabled.

## Task 14

Live QA of the native `machine add` layer was not run by the implementer. Run these by hand; `HERDR_UI_LIVE=1` and `$HERDR_UI_TEST_MACHINE` are for the maintainer's own machine only.

- [ ] Test workbox: on `$HERDR_UI_TEST_MACHINE`'s SSH target, "Add workbox" with Remote session `herdr-ui-qa` and label `herdr-ui-qa`. The checklist advances, the sheet closes within a few seconds of herdr finishing, and "Added herdr-ui-qa" shows. Clean up with `herdr machine remove <new profile id>`, then `ssh <target> 'herdr session stop herdr-ui-qa && herdr session delete herdr-ui-qa'`.
- [ ] Install prompt: start a Docker sshd container (`linuxserver/openssh-server`, arm64, no herdr) on localhost:2222 with a throwaway key generated in `fixtures-raw/`. "Add workbox" for it shows "Install herdr on <target>?" and nothing is installed until "Install herdr" is clicked; Cancel (or Escape) leaves the container without herdr and the sheet shows "herdr stopped before the workbox was added". Remove the container and the key afterwards.
- [ ] Never answer "Stop server and continue" for a `default` session on a machine with live agents: the dialog says "This stops the running herdr server on <target> and the agents in its panes.", Cancel is focused first, and Enter or Escape answers no. Check this only with the `herdr-ui-qa` session or a throwaway container.
- [ ] Session picker: with two running sessions on the target and no Remote session given, the "Which session on <target>?" dialog lists them in herdr's order, and choosing the second one adds that session (check `herdr machine list`). Cancel in the dialog stops the run and adds nothing.
- [ ] A host that asks something the app does not know (an unknown host key, an ssh passphrase): after about 5 s the sheet says herdr has gone quiet. "Continue in <Terminal>" stops the hidden run first (no stray `herdr machine add` process is left, check `ps`), then opens the terminal and the existing waiting flow.
- [ ] Closing the sheet or "Cancel" while a hidden run is under way leaves no `herdr machine add` process behind.
- [ ] After a native run finishes, "machine add" shows in the Activity drawer with exit 0 (or 1 for a failure).


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
- [ ] Settings › herdr CLI: "Choose binary…" with another herdr install switches to it at once (path and version update, polling continues). Save a path, then rename that file: restart the app and the section says "Saved herdr binary not found; using <path>" while the app keeps working through auto-discovery. "Find it automatically" clears the saved path.
- [ ] With no herdr anywhere, launch the app, then choose a binary in Settings: polling starts without a restart.
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

- [ ] Toggle a notification setting within 2 s of launching the app: it saves at once, instead of waiting for herdr to be located. A herdr path saved in that window is picked up too (Settings › herdr CLI shows the saved path as found).
- [ ] With Settings (or the menu-bar popover) open and the main window hidden or behind it, click the Dock icon: the main window comes to the front.

## v0.2

Items marked "replaced by v0.3" describe the v0.2 bottom/right panel; the `## v0.3` section below covers what took its place.

- [ ] ⌘W with no tab open does nothing; the red button still hides the window.
- [ ] ⌘C/⌘V work in text inputs (Edit menu).
- [ ] Menu shortcuts fire while a terminal has focus.
- [ ] ⌘, opens Settings from the menu; ⌘W with the Settings window focused closes it.
- [ ] The menu bar shows App, Edit, View, Terminal and Window with the shortcuts of spec §2.4, and no Close Window item.
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
- [ ] Open enough tabs (up to the 16 cap) that the strip no longer fits: it scrolls sideways, the active tab stays in view, and the "All tabs" menu appears at the end, listing every tab by workbox with its status; arrows move through it, Escape closes it and returns focus to the button, and choosing a tab activates it.
- [ ] Tab-strip, sidebar and context-bar visuals look right: status dots with their words ("Needs input", "Done, unseen") on the tabs that need them, the light orange tint for needs-input, "Opening…", "Detached" and "Error" chips, workbox group labels with a health dot, the sidebar's nested terminal rows, and the Home tab's home icon and label ("Dashboard", "All agents" or the workbox name).
- [ ] The context bar above the terminal shows the agent, status, kind and folder · workbox, with Find, "Open in {Terminal}", Detach and "Close pane…" (a full herdr UI tab shows only Find and Detach). Detach does the same as ⌘W; "Close pane…" still asks first.
- [ ] While the terminal has the keyboard: ⌘1 goes to the Dashboard, ⌘2–⌘9 select terminal tabs in strip order, ⌃` switches between Home and the last terminal tab (with no terminal tab open it shows "Open a session to start a terminal."), ⌃Tab and ⌃⇧Tab cycle all tabs including Home, and ⌘W closes (detaches) the active tab and returns to Home. ⌘W on Home does nothing.
- [ ] On the strip, with a terminal tab active, Backspace, arrows and ⌘↩ do nothing to the hidden Home list (no row selected, opened or "Close…" dialog), and the same holds with focus in the context bar or on the window body.
- [ ] ⌘\ with a terminal tab active shows the Dashboard in a column on the right; pressing it again hides it; on Home it does nothing. Drag the handle and use the arrow keys on it (360 to 1200 px), quit and relaunch, and the width (and whether the column is shown) comes back.
- [ ] The terminal re-fits when the ⌘\ column appears, disappears and while it is dragged (no cut-off lines or stale columns in a full-screen TUI).
- [ ] On a narrow window the ⌘\ column does not hide the terminal: the terminal keeps a usable width.
- [ ] The Open button reads "Open" and follows Settings › Open sessions in; its menu has "Open here", "Open in {Terminal}", "Open full herdr UI" and "Copy attach command". When the row already has a tab it reads "Go to tab" (with ⌘2 to ⌘9 when it has one).
- [ ] The Open menu is placed correctly (it is fixed-position): from the last row of an All agents group, from a Dashboard row at the bottom of the page (Working now), from a needs-you card, and from the Inspector. Near the bottom edge of the window it flips up and is never clipped. Arrow keys move through it, Escape closes it and focus goes back to the chevron.
- [ ] "Copy attach command" shows "Copied", and pasting it into a terminal attaches the same pane as "Open in {Terminal}" (a local pane, and a remote one over `ssh -t`).
- [ ] A reconnecting (or needs-attention) workbox card is dimmed and marked "as of {age} ago", shows "Retry now" and no "Open herdr"; a disabled workbox shows no action; the workbox's tab group and the Workboxes online tile still render.
- [ ] The Activity log shows no extra herdr calls while the Dashboard is open beyond the app's normal polling (snapshots and machine status); leaving it open for a minute adds nothing, and the "herdr response" tile still updates.
- [ ] With a terminal tab active, the Inspector's preview and the Workbox screen's pane-tail reads stop (no `agent read` or `pane read` in the Activity log), and resume when Home is shown.
- [ ] ⌘F in a terminal opens its find bar; ⌘F on Home switches to All agents and focuses its search. On All agents, arrows, ⌘↩ and Backspace/Delete still work.
- [ ] ⌘K lists "Go to Dashboard", "All agents" and "Dashboard beside terminal", and each works.
- [ ] The sidebar shows Dashboard, Needs you, All agents, each workbox with its health, agent count and nested open terminals, and the first 3 projects with "{n} more". ⌘B collapses it to the rail (Dashboard, needs-you and workbox icons with health; nested terminals hidden).
- [ ] Settings no longer offers terminal placement or panel size. A `settings.json` from v0.2 (with `terminal_placement` and `terminal_panel_size`) still loads, ignoring the old keys, and the other settings (and the Dashboard column) are intact.

## v0.4: two-row tabs

Two rows replace the grouped strip. Use generic data (buildbox, gpubox, staging; api-service, web-app, infra) and the `herdr-ui-qa` workspace on the test workbox for anything that opens or closes panes. These are the GUI-only checks no automated test covers.

- [ ] Chrome-style joins: the active workbox tab and the active session tab each flow into the surface under them with no seam and no border line at the join, and the inverse (concave) corners at their feet are drawn and not clipped by the scrolling rows. Check Home active (the Home tab and the active Home view) too.
- [ ] Hover fills: hovering an inactive workbox tab, an inactive session tab, a Home view and "New on {workbox}" fills it visibly; hovering a needs-input tab (the light orange tint, blocked tabs only) still shows a hover fill on top of the tint, and the tint stays readable.
- [ ] Tab width: with a few tabs, each session tab is between about 160 and 228 px wide; opening more makes them shrink to the 160 px minimum before the row starts to scroll, and titles ellipsize without moving the close button.
- [ ] Workbox badges and counts: each workbox tab shows its health dot (with its word in the accessible name), its tab count, and a needs badge (its count, "Needs input" on hover, "{n} needs input" in the accessible name) only while one of its tabs waits on you; a blocked tab on `gpubox` badges `gpubox` while `buildbox` is active. A tab of a workbox that left the machine list still has its workbox tab, with health "Unknown".
- [ ] A workbox tab restores its last tab: open two tabs on `buildbox` and one on `gpubox`, pick the second `buildbox` tab, go to `gpubox`, then back to `buildbox`: the second tab is active again. Close that remembered tab and click `buildbox`: its first remaining tab opens (not Home).
- [ ] The Home views row: with Home active, the second row lists Dashboard and All agents (plus the workbox's name while a workbox screen is shown), the active one is marked, and choosing one changes what Home shows. Going to a terminal tab swaps the row for that workbox's tabs, and back again keeps the terminals' scrollback.
- [ ] The session row scrolls sideways when the tabs outgrow it (up to the 16 cap), the active tab stays in view after ⌘2–⌘9, ⌘J, a notification or a sidebar click, and the "All tabs" menu appears at the end: it lists every tab by workbox with its status, arrows move through it, Escape closes it and returns focus to its button, and choosing a tab switches workbox and activates it.
- [ ] "+ New on {workbox}" opens the new-session sheet with that workbox already chosen; Cancel returns focus to the button.
- [ ] Second line of every state: a tab shows its words under the title for Working, Idle, Needs input, Done, unseen, Unknown, Shell, "Opening…", "Detached", "Error" and a combined "Detached · Needs input". No state is shown by colour alone.
- [ ] ⌘2–⌘9 tooltips on session tabs ("{status} (⌘n)") use the flat order across workboxes, not the position inside the row (e.g. the first `gpubox` tab says ⌘4 when `buildbox` has two tabs, Home being ⌘1).
- [ ] Copy through the clipboard plugin: ⌘-click on a URL in a terminal shows "Link copied" and pasting elsewhere gives that URL (the link is never opened); "Copy attach command" shows "Copied" and pastes the command; the Settings and sheet command boxes still copy. No permission prompt appears for the clipboard.
