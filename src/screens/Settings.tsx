import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useId, useState, type ReactNode } from "react";
import { StoreToast } from "../components/Toast";
import type { GroupBy } from "../lib/bindings/GroupBy";
import type { HerdrStatus } from "../lib/bindings/HerdrStatus";
import type { OpenMode } from "../lib/bindings/OpenMode";
import type { AttachMode } from "../lib/bindings/AttachMode";
import type { Settings as SettingsData } from "../lib/bindings/Settings";
import type { ShortcutStatus } from "../lib/bindings/ShortcutStatus";
import type { TerminalId } from "../lib/bindings/TerminalId";
import type { TerminalList } from "../lib/bindings/TerminalList";
import {
  HEALTH_LABEL,
  TERMINAL_LABEL,
  actionErrorMessage,
} from "../lib/format";
import { invokeTyped, toActionError } from "../lib/ipc";
import { useAppStore } from "../store/appStore";

type SectionId =
  | "general"
  | "terminal"
  | "workboxes"
  | "notifications"
  | "herdr"
  | "shortcuts";

const SECTIONS: { id: SectionId; label: string }[] = [
  { id: "general", label: "General" },
  { id: "terminal", label: "Terminal" },
  { id: "workboxes", label: "Workboxes" },
  { id: "notifications", label: "Notifications" },
  { id: "herdr", label: "herdr CLI" },
  { id: "shortcuts", label: "Shortcuts" },
];

const TITLES: Record<SectionId, { title: string; blurb: string }> = {
  general: {
    title: "General",
    blurb: "How the app starts out and how often it looks at your workboxes.",
  },
  terminal: {
    title: "Your terminal",
    blurb:
      "Crafted Herdr never draws terminals itself. “Open” hands the session to the app you use every day.",
  },
  workboxes: {
    title: "Workboxes",
    blurb: "Turn a workbox off to stop polling it. Its sessions keep running.",
  },
  notifications: {
    title: "Notifications",
    blurb: "A notification names the agent, its project and its workbox.",
  },
  herdr: {
    title: "herdr CLI",
    blurb: "Everything the app does goes through the herdr command line.",
  },
  shortcuts: {
    title: "Shortcuts",
    blurb:
      "Keyboard shortcuts of the main window, and the one that works anywhere.",
  },
};

/** The terminals in the order they are offered; Custom last. */
const TERMINALS: TerminalId[] = [
  "ghostty",
  "iTerm2",
  "warp",
  "terminalApp",
  "wezTerm",
  "kitty",
  "alacritty",
  "custom",
];

const MIN_INTERVAL_SECONDS = 1;
const TEMPLATE_EXAMPLE = "open -na Ghostty --args -e {attach}";

const SHORTCUTS: [keys: string, what: string][] = [
  ["⌘K", "Search and jump"],
  ["⌘N", "New session"],
  ["⌘↩", "Open the selected session"],
  ["⌘,", "Settings"],
  ["⌘R", "Refresh now"],
  ["↑ ↓", "Move the selection"],
  ["⌫", "Close the selected session (asks first)"],
];

type Update = (patch: Partial<SettingsData>) => Promise<void>;

function Check({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="check settings-check">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="settings-check-text">
        {label}
        {hint && <span className="muted settings-hint">{hint}</span>}
      </span>
    </label>
  );
}

function Field({
  id,
  label,
  children,
}: {
  id: string;
  label: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="settings-field">
      <label htmlFor={id} className="settings-label">
        {label}
      </label>
      {children}
    </div>
  );
}

/** A number of seconds, saved when the field loses focus; under a second is refused here. */
function SecondsField({
  label,
  valueMs,
  onSave,
}: {
  label: string;
  valueMs: number;
  onSave: (ms: number) => void;
}) {
  const id = useId();
  const [draft, setDraft] = useState(String(valueMs / 1000));
  const [error, setError] = useState<string | null>(null);

  const commit = () => {
    const seconds = Number(draft);
    if (!Number.isFinite(seconds) || seconds < MIN_INTERVAL_SECONDS) {
      setError("Use at least 1 second.");
      return;
    }
    setError(null);
    const ms = Math.round(seconds * 1000);
    if (ms !== valueMs) onSave(ms);
  };
  return (
    <Field id={id} label={label}>
      <input
        id={id}
        type="number"
        min={MIN_INTERVAL_SECONDS}
        step={1}
        className="field settings-number"
        value={draft}
        aria-invalid={error !== null}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
        }}
      />
      {error && <p className="field-error">{error}</p>}
    </Field>
  );
}

function General({
  settings,
  update,
}: {
  settings: SettingsData;
  update: Update;
}) {
  const groupId = useId();
  return (
    <div className="settings-stack">
      <Field id={groupId} label="Group sessions by">
        <select
          id={groupId}
          className="field"
          value={settings.group_by}
          onChange={(e) => void update({ group_by: e.target.value as GroupBy })}
        >
          <option value="project">Project</option>
          <option value="workbox">Workbox</option>
          <option value="status">Status</option>
        </select>
      </Field>
      <Check
        label="Open a new session in my terminal when it is ready"
        hint="The starting choice in the New session sheet."
        checked={settings.open_after_create}
        onChange={(open_after_create) => void update({ open_after_create })}
      />
      <div className="settings-pair">
        <SecondsField
          key={`visible-${settings.poll_interval_visible_ms}`}
          label="Refresh every, window open (seconds)"
          valueMs={settings.poll_interval_visible_ms}
          onSave={(ms) => void update({ poll_interval_visible_ms: ms })}
        />
        <SecondsField
          key={`hidden-${settings.poll_interval_hidden_ms}`}
          label="Refresh every, window hidden (seconds)"
          valueMs={settings.poll_interval_hidden_ms}
          onSave={(ms) => void update({ poll_interval_hidden_ms: ms })}
        />
      </div>
      <p className="muted settings-hint">
        A workbox that cannot be reached is retried after 2, 4, 8 … up to 60
        seconds, whatever these are.
      </p>
    </div>
  );
}

/** The Custom launch command, saved when the field loses focus, with a resolved example. */
function LaunchCommand({
  saved,
  onSave,
}: {
  saved: string;
  onSave: (template: string) => void;
}) {
  const id = useId();
  const [draft, setDraft] = useState(saved);
  const [example, setExample] = useState<string | null>(null);

  // The resolved example comes from Rust, so it is exactly what a launch would run.
  useEffect(() => {
    if (!draft.trim()) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      invokeTyped("preview_launch_template", { template: draft })
        .then((line) => {
          if (!cancelled) setExample(line);
        })
        .catch(() => {});
    }, 200);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [draft]);

  return (
    <Field
      id={id}
      label={
        <>
          Launch command{" "}
          <span className="muted settings-label-note">· used for Custom</span>
        </>
      }
    >
      <input
        id={id}
        type="text"
        className="field mono"
        value={draft}
        placeholder={TEMPLATE_EXAMPLE}
        spellCheck={false}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          if (draft !== saved) onSave(draft);
        }}
      />
      <p className="muted settings-hint">
        <code>{"{attach}"}</code> is replaced by the command to run,
        already-quoted for the shell. It must not sit inside double quotes.
      </p>
      {draft.trim() && example && (
        <p className="mono muted settings-example">
          <span aria-hidden="true">→ </span>
          {example}
        </p>
      )}
    </Field>
  );
}

function TerminalSection({
  settings,
  update,
}: {
  settings: SettingsData;
  update: Update;
}) {
  const [list, setList] = useState<TerminalList | null>(null);
  const targetId = useId();
  const whereId = useId();
  const attachId = useId();
  useEffect(() => {
    let cancelled = false;
    invokeTyped("get_terminals")
      .then((l) => {
        if (!cancelled) setList(l);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  // Detects again, for a terminal installed while Settings was open.
  const [scanning, setScanning] = useState(false);
  const rescan = async () => {
    setScanning(true);
    try {
      setList(await invokeTyped("list_terminals"));
    } catch {
      // The list from before stays.
    } finally {
      setScanning(false);
    }
  };

  const selected = settings.terminal ?? list?.default ?? null;
  const installed = (id: TerminalId) =>
    id === "custom" || (list?.installed.includes(id) ?? false);

  const terminalLabel = selected ? TERMINAL_LABEL[selected] : "your terminal";

  return (
    <div className="settings-stack">
      <div
        role="group"
        aria-labelledby={targetId}
        className="settings-fieldset"
      >
        <div id={targetId} className="settings-label">
          Open sessions
        </div>
        <div className="segmented settings-segmented">
          {(
            [
              ["app", "In Crafted Herdr"],
              ["external", `In ${terminalLabel}`],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              aria-pressed={settings.open_target === value}
              onClick={() => void update({ open_target: value })}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <fieldset className="settings-fieldset">
        <legend className="settings-label">Open sessions in</legend>
        <div className="opt-grid opt-grid-4">
          {TERMINALS.map((id) => {
            const here = installed(id);
            return (
              <label
                key={id}
                className="opt"
                data-on={selected === id}
                aria-disabled={!here}
              >
                <span className="opt-line">
                  <input
                    type="radio"
                    name="terminal"
                    checked={selected === id}
                    disabled={!here}
                    onChange={() => void update({ terminal: id })}
                  />
                  <span className="opt-name">
                    {id === "custom" ? "Custom…" : TERMINAL_LABEL[id]}
                  </span>
                </span>
                <span className="muted opt-meta">
                  {id === "custom"
                    ? "Your own command"
                    : here
                      ? "Installed"
                      : "Not installed"}
                </span>
              </label>
            );
          })}
        </div>
        <div>
          <button
            type="button"
            className="btn btn-small btn-ghost"
            disabled={scanning}
            onClick={() => void rescan()}
          >
            {scanning ? "Scanning…" : "Rescan"}
          </button>
        </div>
      </fieldset>

      <div className="settings-pair">
        <Field id={whereId} label="Each session opens in a">
          <select
            id={whereId}
            className="field"
            value={settings.open_mode}
            onChange={(e) =>
              void update({ open_mode: e.target.value as OpenMode })
            }
          >
            <option value="window">New window</option>
            <option value="tab">New tab (iTerm2; others open a window)</option>
          </select>
        </Field>
        <Field id={attachId} label="Attach as">
          <select
            id={attachId}
            className="field"
            value={settings.attach_mode}
            onChange={(e) =>
              void update({ attach_mode: e.target.value as AttachMode })
            }
          >
            <option value="pane">Just that session (terminal attach)</option>
            <option value="full_ui">Full herdr UI on that workbox</option>
          </select>
        </Field>
      </div>

      <LaunchCommand
        key={settings.terminal_custom_template}
        saved={settings.terminal_custom_template}
        onSave={(terminal_custom_template) =>
          void update({ terminal_custom_template })
        }
      />
    </div>
  );
}

function Workboxes() {
  const state = useAppStore((s) => s.state);
  const report = useAppStore((s) => s.reportError);
  const toggle = (id: string, enabled: boolean) =>
    invokeTyped("machine_set_enabled", { id, enabled }).catch(report);
  if (state === null) return <p className="empty">Connecting to herdr…</p>;
  return (
    <div className="settings-stack">
      <ul className="settings-list">
        {state.machines.map((m) => {
          const label = `Enable ${m.label}`;
          return (
            <li key={m.id} className="settings-list-row">
              <span className="settings-list-text">
                <span>{m.label}</span>
                <span className="mono muted settings-hint">
                  {m.is_local
                    ? "This computer"
                    : `${m.target ?? m.id} · ${m.session}`}
                </span>
              </span>
              <span className="health" data-health={m.health.kind}>
                <span className="dot" aria-hidden="true" />
                {HEALTH_LABEL[m.health.kind]}
              </span>
              <input
                type="checkbox"
                role="switch"
                aria-label={label}
                checked={m.health.kind !== "disabled"}
                disabled={m.is_local}
                onChange={(e) => void toggle(m.id, e.target.checked)}
              />
            </li>
          );
        })}
      </ul>
      {state.machines.length === 1 && (
        <p className="muted settings-hint">
          Only this computer so far. Add a workbox from the sidebar of the main
          window.
        </p>
      )}
    </div>
  );
}

function Notifications({
  settings,
  update,
}: {
  settings: SettingsData;
  update: Update;
}) {
  return (
    <div className="settings-stack">
      <Check
        label="An agent needs you"
        hint="Blocked and waiting for approval or input."
        checked={settings.notify_blocked}
        onChange={(notify_blocked) => void update({ notify_blocked })}
      />
      <Check
        label="An agent finishes"
        hint="Done and not yet seen."
        checked={settings.notify_done}
        onChange={(notify_done) => void update({ notify_done })}
      />
      <p className="muted settings-hint">
        Nothing is sent for agents already waiting when the app starts. macOS
        asks permission the first time; you can change it later in System
        Settings › Notifications.
      </p>
    </div>
  );
}

function HerdrCli({
  settings,
  update,
}: {
  settings: SettingsData;
  update: Update;
}) {
  const [status, setStatus] = useState<HerdrStatus | null>(null);
  const refresh = useCallback(() => {
    invokeTyped("herdr_status")
      .then(setStatus)
      .catch(() => {});
  }, []);
  useEffect(refresh, [refresh]);

  const change = async (path: string | null) => {
    await update({ herdr_path: path });
    refresh();
  };
  const choose = async () => {
    const picked = await openDialog({ multiple: false, directory: false });
    if (typeof picked === "string" && picked) await change(picked);
  };

  return (
    <div className="settings-stack">
      <div className="settings-status">
        <span
          className="health"
          data-health={status?.path ? "online" : "attention"}
        >
          <span className="dot" aria-hidden="true" />
          <span className="sr-only">
            {status?.path ? "Found" : "Not found"}
          </span>
        </span>
        {status === null ? (
          <span className="muted">Looking for herdr…</span>
        ) : status.path ? (
          <span className="mono">
            <span>{status.path}</span> ·{" "}
            <span>{status.version ?? "version unknown"}</span>
          </span>
        ) : (
          <span>herdr was not found. Install it, or choose the binary.</span>
        )}
      </div>
      {status?.saved_missing && (
        <p className="settings-warn" role="status">
          {status.path
            ? `Saved herdr binary not found; using ${status.path}`
            : "Saved herdr binary not found, and herdr was not found on this computer."}
        </p>
      )}
      {settings.herdr_path && (
        <p className="muted settings-hint">
          Saved path: <code>{settings.herdr_path}</code>
        </p>
      )}
      <div className="settings-actions">
        <button type="button" className="btn" onClick={() => void choose()}>
          Choose binary…
        </button>
        {settings.herdr_path && (
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => void change(null)}
          >
            Find it automatically
          </button>
        )}
      </div>
    </div>
  );
}

function Shortcuts({
  settings,
  update,
}: {
  settings: SettingsData;
  update: Update;
}) {
  const [status, setStatus] = useState<ShortcutStatus | null>(null);
  const refresh = useCallback(() => {
    invokeTyped("shortcut_status")
      .then(setStatus)
      .catch(() => {});
  }, []);
  useEffect(refresh, [refresh]);

  return (
    <div className="settings-stack">
      <ul className="settings-list">
        {SHORTCUTS.map(([keys, what]) => (
          <li key={keys} className="settings-list-row">
            <span className="settings-list-text">{what}</span>
            <kbd>{keys}</kbd>
          </li>
        ))}
      </ul>
      <Check
        label="Show or hide Crafted Herdr from anywhere"
        hint="⌃⌥⌘H, even when another app is in front."
        checked={settings.global_shortcut_enabled}
        onChange={(global_shortcut_enabled) =>
          void update({ global_shortcut_enabled }).then(refresh)
        }
      />
      {settings.global_shortcut_enabled && status?.error && (
        <p className="settings-warn" role="status">
          Couldn’t register ⌃⌥⌘H (another app may be using it)
        </p>
      )}
    </div>
  );
}

/** The Settings window (spec section 9.5): six sections, each change saved as it is made. */
export function Settings() {
  const settings = useAppStore((s) => s.settings);
  const setSettings = useAppStore((s) => s.setSettings);
  const [section, setSection] = useState<SectionId>("general");
  const [error, setError] = useState<string | null>(null);

  const update: Update = useCallback(
    async (patch) => {
      setError(null);
      try {
        setSettings(await invokeTyped("set_settings", { patch }));
      } catch (e) {
        setError(actionErrorMessage(toActionError(e)));
      }
    },
    [setSettings],
  );

  const { title, blurb } = TITLES[section];
  return (
    <div className="settings">
      <nav className="settings-nav" aria-label="Settings sections">
        {SECTIONS.map((s) => (
          <button
            key={s.id}
            type="button"
            className="settings-nav-item"
            aria-current={s.id === section ? "page" : undefined}
            onClick={() => setSection(s.id)}
          >
            {s.label}
          </button>
        ))}
      </nav>
      <main className="settings-main">
        <div>
          <h1 className="settings-title">{title}</h1>
          <p className="muted settings-blurb">{blurb}</p>
        </div>
        {error && (
          <p className="field-error" role="alert">
            {error}
          </p>
        )}
        {settings === null ? (
          <p className="empty">Loading settings…</p>
        ) : section === "general" ? (
          <General settings={settings} update={update} />
        ) : section === "terminal" ? (
          <TerminalSection settings={settings} update={update} />
        ) : section === "workboxes" ? (
          <Workboxes />
        ) : section === "notifications" ? (
          <Notifications settings={settings} update={update} />
        ) : section === "herdr" ? (
          <HerdrCli settings={settings} update={update} />
        ) : (
          <Shortcuts settings={settings} update={update} />
        )}
      </main>
      <StoreToast />
    </div>
  );
}
