# Manual QA checklist

GUI-only checks that implementers skip; run them in a final pass with the maintainer.

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
- [ ] "Continue in <Terminal>" opens the default terminal running `herdr machine add <target> …` (use a throwaway target, never a live default session). Finish setup there: within about 2 s the sheet closes, "Added <label>" shows as a toast, and the new workbox opens.
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

