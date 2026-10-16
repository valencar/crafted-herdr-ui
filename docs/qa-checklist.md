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
