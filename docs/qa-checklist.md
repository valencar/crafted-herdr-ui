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
