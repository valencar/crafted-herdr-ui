# src: React UI

The UI renders `AppState` pushed from Rust (`"state"` event) and calls typed Tauri commands. All view logic (needs-you, grouping, sorting, ages, names) is pure TypeScript in `lib/`, and it's unit-tested.

## Layout

| Path | Owns |
|---|---|
| `lib/bindings/` | ts-rs generated types. Never edit by hand. |
| `lib/ipc.ts` | the only place that calls `invoke`/`listen`: `onState`, `onSettings`, `onFocusRow`, `invokeTyped`, and the `CommandName` union |
| `lib/useSync.ts` | `useStateSync` / `useSettingsSync`: every window (main, popover, Settings) keeps its own store current |
| `lib/openRow.ts` | `openRow(row, how?)` and `openFull(machineId, label, how?)` (Open in a terminal tab here, or in the external terminal; `how` defaults to `settings.open_target`; a "done" agent is marked seen after it opened), `markSeen`, `useOpenWhenListed` (opens a row once it shows up in the list, following the same setting) |
| `lib/useHomeShortcuts.ts` | Home's keyboard shortcuts: ⌘N, ⌘R, ⌘↩, the arrow keys, Delete |
| `lib/menuActions.ts` | `runMenuAction(id)`: what each native menu item does; the menu listener in `App` and the command palette both call it; ⌘J, ⌘\ (panel bottom ↔ right) and ⌘B (sidebar rail) live here too, saved through `saveSettings` in `uiHelpers` |
| `lib/nextNeedsYou.ts` | `nextNeedsYou(rows, currentKey)`: the next row in `needsYou` order after the selected one, wrapping round (⌘J) |
| `lib/fuzzy.ts`, `lib/palette.ts` | `fuzzyScore`, and the ⌘K palette's `buildItems` / `rankItems` (pure); `components/CommandPalette.tsx` is the dialog (on `.scrim`, `useModalOpen`) |
| `lib/grouping.ts`, `lib/format.ts` | `toRows`, `needsYou`, `groupByProject/Workbox/Status`, `displayName`, `formatAge`, `shortPath` |
| `terminal/` | the in-app terminal: `terminalStore` (Zustand: tabs, active tab, panel open), `useTermSession` (the Rust session over a `Channel`: write, resize, close, the detached state), `TerminalView` (one xterm instance per tab, kept mounted while hidden), `TerminalPanel` (tab strip, resize handle, find bar), `xtermTheme` (reads the `--ansi-*` and other tokens) |
| `store/appStore.ts` | Zustand: state, `selectedKey`, `groupBy`, sheet, view, `activityOpen` |
| `components/` | presentational pieces (StatusPill, AgentRow, Inspector, ConfirmDialog, EmptyState, ActivityDrawer, …). Pieces split out of the big screens: `HomeNotices` (the version banner and the Local-down card on Home), `WorkboxDialogs` (the dialogs on the Workbox screen), `SessionPicker` and `SetupChecklist` (Add workbox), `StoreToast` in `Toast.tsx` (the store's toast, mounted by every screen that reports errors) |
| `screens/` | Home, Workbox, NewSession, AddWorkbox, Settings, MenuBar, Onboarding. Settings and MenuBar are their own windows (`settings.html`, `popover.html`, entries `settings.tsx`, `popover.tsx`) |
| `styles/tokens.css` | design tokens as CSS variables (spec §9) |

## Rules

- **Identity:** a row key is always `${machineId}::${paneId}`. herdr ids repeat across machines; never key by pane id alone.
- **Status is never color-only.** Every status shows its text label too: "Needs input", "Done, unseen", "Working", "Idle", "Unknown", "Shell".
- **Colors and sizes come from `tokens.css` variables.** No hex literals in components.
- **The one URL:** the app opens `https://herdr.dev` (Onboarding) through `plugin-opener`; the main window's capability allows that URL and no other. No other link, fetch or `<a href>` to the web.
- **Keys typed in `.terminal-panel` belong to the terminal.** Home's list shortcuts and every other key handler skip an event whose target is inside it (`isInTerminal` in `lib/uiHelpers.ts`); only the native menu's accelerators act there. The terminal never takes focus while a sheet or dialog is open.
- **Links in a terminal are copy-only.** ⌘-click copies the URL and shows "Link copied"; xterm's web-links addon never opens one. No terminal text becomes a command: `term_write` carries only keystrokes and pastes.
- **Fonts:** Geist and Geist Mono are bundled under `fonts/`. No network font loading, and no network calls at all.
- **Accessibility:**
  - real `<button>`, `<a>` and `<input>`/`<label>`, with a visible focus ring;
  - `aria-label` on icon-only buttons;
  - destructive actions always go through `ConfirmDialog`.
- **Copy:** monospace for ids, paths, commands and terminal output; sans for everything else.
- **CLI transparency:** show the exact command for an action where the design does (command box, new-session preview). The text comes from Rust (`previewNewSession`, `copyAttachCommand`, `previewReconnect`), never rebuilt in TS.
- **Unknown inputs:**
  - agent names may be `null`, so use `displayName`;
  - ages may be `null`, so render nothing rather than guessing.

## Testing

- **Vitest + React Testing Library.** Mock `lib/ipc.ts`, not Tauri internals.
- **Fixtures** mirror `src-tauri/tests/fixtures/*.json` (import them directly) with generic names only.
- **Before committing:** `pnpm lint && pnpm typecheck && pnpm test`.
