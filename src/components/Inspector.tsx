import { useEffect, useId, useRef, useState } from "react";
import type { MachineView } from "../lib/bindings/MachineView";
import { shortPath } from "../lib/format";
import type { Row } from "../lib/grouping";
import { invokeTyped } from "../lib/ipc";
import { useAppStore } from "../store/appStore";
import { CommandBox } from "./CommandBox";
import { ConfirmDialog } from "./ConfirmDialog";
import { KindBadge } from "./KindBadge";
import { Preview } from "./Preview";
import { StatusPill } from "./StatusPill";

const AGENT_NAME = /^[a-z][a-z0-9_-]{0,31}$/;
const AGENT_NAME_HELP =
  "Use lowercase letters, digits, - or _, starting with a letter (32 characters at most).";
const COPIED_MS = 1500;

const HEALTH_LABEL = {
  online: "online",
  reconnecting: "reconnecting",
  attention: "needs attention",
  disabled: "disabled",
} as const;

/** Mirrors Rust's `validate_name`; Rust still has the last word. */
function nameProblem(name: string, isAgent: boolean): string | null {
  if (isAgent) return AGENT_NAME.test(name) ? null : AGENT_NAME_HELP;
  return name.trim() === "" ? "Name can’t be empty." : null;
}

type Props = {
  row: Row;
  machine: MachineView;
  /** The project the row belongs to, when it has one. */
  project?: string | null;
  terminalName?: string;
};

/** Everything about the selected row: details, live preview, reply, and its actions. */
export function Inspector({
  row,
  machine,
  project = null,
  terminalName = "terminal",
}: Props) {
  const reportError = useAppStore((s) => s.reportError);
  const { machineId, paneId } = row;
  const isAgent = row.status !== "shell";
  const target = { machineId, paneId };

  const snapshot = machine.snapshot;
  const pane =
    snapshot?.panes.find((p) => p.pane_id === paneId) ??
    snapshot?.agents.find((a) => a.pane_id === paneId) ??
    null;
  const workspace = snapshot?.workspaces.find(
    (w) => w.workspace_id === pane?.workspace_id,
  );
  const tab = snapshot?.tabs.find((t) => t.tab_id === pane?.tab_id);
  const where = [workspace?.label, tab?.label].filter(Boolean).join(" · ");
  const agentName = snapshot?.agents.find((a) => a.pane_id === paneId)?.name;

  // What "Open" runs; the text comes from Rust.
  const [command, setCommand] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    invokeTyped("copy_attach_command", { machineId, paneId })
      .then((c) => alive && setCommand(typeof c === "string" ? c : null))
      .catch(() => alive && setCommand(null));
    return () => {
      alive = false;
    };
  }, [machineId, paneId, row.terminalId]);

  // Reply
  const replyId = useId();
  const hintId = useId();
  const [reply, setReply] = useState("");
  const [sending, setSending] = useState(false);
  const blocked = row.status === "blocked";
  const send = async () => {
    const text = reply.trim();
    if (blocked || sending || text === "") return;
    setSending(true);
    try {
      await invokeTyped("reply_to_agent", { ...target, text });
      setReply("");
    } catch (e) {
      reportError(e);
    } finally {
      setSending(false);
    }
  };

  // Rename
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const renameButton = useRef<HTMLButtonElement>(null);
  const startRename = () => {
    setDraft(isAgent ? (agentName ?? "") : row.name);
    setProblem(null);
    setRenaming(true);
  };
  const stopRename = () => {
    setRenaming(false);
    // The input is gone after this render; give focus back to the button that opened it.
    window.setTimeout(() => renameButton.current?.focus(), 0);
  };
  const saveRename = async () => {
    const name = isAgent ? draft : draft.trim();
    const bad = nameProblem(name, isAgent);
    setProblem(bad);
    if (bad) return;
    try {
      await invokeTyped("rename_session", { ...target, isAgent, name });
      stopRename();
    } catch (e) {
      reportError(e);
    }
  };

  // Copy
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(copiedTimer.current), []);
  const copy = async () => {
    try {
      const line = await invokeTyped("copy_attach_command", target);
      try {
        await navigator.clipboard.writeText(line);
      } catch {
        throw new Error("Couldn’t copy to the clipboard.");
      }
      setCopied(true);
      clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(() => setCopied(false), COPIED_MS);
    } catch (e) {
      reportError(e);
    }
  };

  // Close
  const [closing, setClosing] = useState(false);
  const confirmClose = () => {
    setClosing(false);
    invokeTyped("close_pane", target).catch(reportError);
  };

  return (
    <aside className="inspector" aria-label="Selected agent">
      <header className="inspector-head">
        <div className="inspector-badges">
          <StatusPill status={row.status} />
          <KindBadge kind={row.kind} />
          <span className="muted">{row.kind ?? "Shell"}</span>
        </div>
        <h2 className="inspector-name mono">{row.name}</h2>
        <span className="inspector-sub">
          {project ? `${project} on ${row.machineLabel}` : row.machineLabel}
        </span>
      </header>

      <dl className="inspector-grid" role="group" aria-label="Details">
        <div>
          <dt>Workbox</dt>
          <dd>
            {machine.label} · {HEALTH_LABEL[machine.health.kind]}
          </dd>
        </div>
        <div>
          <dt>Session</dt>
          <dd>{machine.session}</dd>
        </div>
        {row.folder && (
          <div className="span-2">
            <dt>Folder</dt>
            <dd className="mono">{shortPath(row.folder)}</dd>
          </div>
        )}
        {where && (
          <div>
            <dt>Workspace / tab</dt>
            <dd>{where}</dd>
          </div>
        )}
        <div>
          <dt>Pane</dt>
          <dd className="mono">{paneId}</dd>
        </div>
      </dl>

      <Preview row={row} />

      {isAgent && (
        <form
          className="reply"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <label htmlFor={replyId} className="inspector-label">
            Reply without opening a terminal
          </label>
          <div className="reply-line">
            <input
              id={replyId}
              type="text"
              className="field"
              placeholder={`Send to ${row.name}…`}
              value={reply}
              disabled={blocked}
              aria-describedby={blocked ? hintId : undefined}
              onChange={(e) => setReply(e.target.value)}
            />
            <button
              type="submit"
              className="btn"
              disabled={blocked || sending || reply.trim() === ""}
            >
              Send
            </button>
          </div>
          {blocked && (
            <p id={hintId} className="muted reply-hint">
              Answer this in the terminal
            </p>
          )}
        </form>
      )}

      <div className="inspector-actions">
        <button
          type="button"
          className="btn btn-primary btn-wide"
          onClick={() => invokeTyped("open_session", target).catch(reportError)}
        >
          Open in {terminalName} <kbd className="mono">⌘↩</kbd>
        </button>
        {row.status === "done" && (
          <button
            type="button"
            className="btn"
            onClick={() => invokeTyped("mark_seen", target).catch(reportError)}
          >
            Mark seen
          </button>
        )}
        {renaming ? (
          <form
            className="rename"
            onSubmit={(e) => {
              e.preventDefault();
              void saveRename();
            }}
          >
            <label htmlFor="rename-input" className="inspector-label">
              New name
            </label>
            <div className="reply-line">
              <input
                id="rename-input"
                type="text"
                className="field mono"
                value={draft}
                autoFocus
                aria-invalid={problem !== null}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    e.stopPropagation();
                    stopRename();
                  }
                }}
              />
              <button type="submit" className="btn">
                Save
              </button>
              <button type="button" className="btn" onClick={stopRename}>
                Cancel
              </button>
            </div>
            {problem && (
              <p role="alert" className="field-error">
                {problem}
              </p>
            )}
          </form>
        ) : (
          <div className="inspector-secondary">
            <button
              ref={renameButton}
              type="button"
              className="btn"
              onClick={startRename}
            >
              Rename
            </button>
            <button type="button" className="btn" onClick={() => void copy()}>
              {copied ? "Copied" : "Copy command"}
            </button>
            <button
              type="button"
              className="btn btn-danger"
              onClick={() => setClosing(true)}
            >
              Close
            </button>
          </div>
        )}
      </div>

      {command && <CommandBox command={command} />}

      {closing && (
        <ConfirmDialog
          title={`Close ${row.name}?`}
          body={`This closes pane ${paneId} on ${row.machineLabel} and ends whatever is running in it.`}
          confirmLabel="Close session"
          onConfirm={confirmClose}
          onCancel={() => setClosing(false)}
        />
      )}
    </aside>
  );
}
