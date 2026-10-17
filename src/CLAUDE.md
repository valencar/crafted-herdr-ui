# src: React UI

The UI renders `AppState` pushed from Rust (`"state"` event) and calls typed Tauri commands. All view logic (needs-you, grouping, sorting, ages, names) is pure TypeScript in `lib/`, and it's unit-tested.

## Layout

| Path | Owns |
|---|---|
| `lib/bindings/` | ts-rs generated types. Never edit by hand. |
| `lib/ipc.ts` | the only place that calls `invoke`/`listen`: `onState`, `onSettings`, `onFocusRow`, `invokeTyped`, and the `CommandName` union |
| `lib/useSync.ts` | `useStateSync` / `useSettingsSync`: every window (main, popover, Settings) keeps its own store current |
| `lib/grouping.ts`, `lib/format.ts` | `toRows`, `needsYou`, `groupByProject/Workbox/Status`, `displayName`, `formatAge`, `shortPath` |
| `store/appStore.ts` | Zustand: state, `selectedKey`, `groupBy`, sheet, view, `activityOpen` |
| `components/` | presentational pieces (StatusPill, AgentRow, Inspector, ConfirmDialog, …) |
| `screens/` | Home, Workbox, NewSession, AddWorkbox, Settings, MenuBar, Onboarding. Settings and MenuBar are their own windows (`settings.html`, `popover.html`, entries `settings.tsx`, `popover.tsx`) |
| `styles/tokens.css` | design tokens as CSS variables (spec §9) |

## Rules

- **Identity:** a row key is always `${machineId}::${paneId}`. herdr ids repeat across machines; never key by pane id alone.
- **Status is never color-only.** Every status shows its text label too: "Needs input", "Done, unseen", "Working", "Idle", "Unknown", "Shell".
- **Colors and sizes come from `tokens.css` variables.** No hex literals in components.
- **Fonts:** Geist and Geist Mono are bundled under `fonts/`. No network font loading, and no network calls at all.
- **Accessibility:**
  - real `<button>`, `<a>` and `<input>`/`<label>`, with a visible focus ring;
  - `aria-label` on icon-only buttons;
  - destructive actions always go through `ConfirmDialog`.
- **Copy:** monospace for ids, paths, commands and terminal output; sans for everything else.
- **CLI transparency:** show the exact command for an action where the design does (command box, new-session preview). The text comes from Rust (`previewNewSession`, `copyAttachCommand`), never rebuilt in TS.
- **Unknown inputs:**
  - agent names may be `null`, so use `displayName`;
  - ages may be `null`, so render nothing rather than guessing.

## Testing

- **Vitest + React Testing Library.** Mock `lib/ipc.ts`, not Tauri internals.
- **Fixtures** mirror `src-tauri/tests/fixtures/*.json` (import them directly) with generic names only.
- **Before committing:** `pnpm lint && pnpm typecheck && pnpm test`.
