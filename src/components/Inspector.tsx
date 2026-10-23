import { formatShortcut } from "../lib/shortcuts";
import { useEffect, useId, useRef, useState } from "react";
import type { MachineView } from "../lib/bindings/MachineView";
import { HEALTH_LABEL, agentNameProblem, shortPath } from "../lib/format";
import type { Row } from "../lib/grouping";
import { invokeTyped } from "../lib/ipc";
import { markSeen } from "../lib/openRow";
import { REPLY_BOX_ID } from "../lib/uiHelpers";
import { useAppStore } from "../store/appStore";
import { CommandBox, CopyButton } from "./CommandBox";
import { CloseConfirm } from "./CloseConfirm";
import { KindBadge } from "./KindBadge";
import { OpenButton } from "./OpenButton";
import { Preview } from "./Preview";
import { StatusPill } from "./StatusPill";

/** Mirrors Rust's `validate_name`; Rust still has the last word. */
function nameProblem(name: string, isAgent: boolean): string | null {
  if (isAgent) return agentNameProblem(name);
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

  // What "Open" runs; the text comes from Rust, and follows the attach mode in Settings.
  const attachMode = useAppStore((s) => s.settings?.attach_mode);
  // Rust's refusal is kept too, so "Copy command" can say why there is nothing to copy.
  const [attach, setAttach] = useState<{
    command: string | null;
    refusal: { error: unknown } | null;
  }>({ command: null, refusal: null });
  const { command, refusal } = attach;
  useEffect(() => {
    let alive = true;
    invokeTyped("copy_attach_command", { machineId, paneId })
      .then(
        (c) =>
          alive &&
          setAttach({
            command: typeof c === "string" ? c : null,
            refusal: null,
          }),
      )
      .catch(
        (error) => alive && setAttach({ command: null, refusal: { error } }),
      );
    return () => {
      alive = false;
    };
  }, [machineId, paneId, row.terminalId, attachMode]);

  // Reply
  const hintId = useId();
  const [reply, setReply] = useState("");
  const [sending, setSending] = useState(false);
  // Spec section 7: reply only to an idle or done agent.
  const canReply = row.status === "idle" || row.status === "done";
  const replyHint =
    row.status === "blocked"
      ? "Answer this in the terminal"
      : "Reply when the agent is idle";
  const send = async () => {
    const text = reply.trim();
    if (!canReply || sending || text === "") return;
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
  const renameId = useId();
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

  const [closing, setClosing] = useState(false);

  return (
    <aside className="inspector" aria-label="Selected agent">
      <header className="inspector-head">
        <div className="inspector-badges">
          <StatusPill status={row.status} />
          <KindBadge kind={row.kind} named />
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
          <label htmlFor={REPLY_BOX_ID} className="inspector-label">
            Reply without opening a terminal
          </label>
          <div className="reply-line">
            <input
              id={REPLY_BOX_ID}
              type="text"
              className="field"
              placeholder={`Send to ${row.name}…`}
              value={reply}
              disabled={!canReply}
              aria-describedby={canReply ? undefined : hintId}
              onChange={(e) => setReply(e.target.value)}
            />
            <button
              type="submit"
              className="btn"
              disabled={!canReply || sending || reply.trim() === ""}
            >
              Send
            </button>
          </div>
          {!canReply && (
            <p id={hintId} className="muted reply-hint">
              {replyHint}
            </p>
          )}
        </form>
      )}

      <div className="inspector-actions">
        <OpenButton
          row={row}
          terminalName={terminalName}
          wide
          kbd={formatShortcut("open-selected")}
        />
        {row.status === "done" && (
          <button type="button" className="btn" onClick={() => markSeen(row)}>
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
            <label htmlFor={renameId} className="inspector-label">
              New name
            </label>
            <div className="reply-line">
              <input
                id={renameId}
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
            {refusal ? (
              <button
                type="button"
                className="btn"
                onClick={() => reportError(refusal.error)}
              >
                Copy command
              </button>
            ) : (
              <CopyButton
                text={command ?? ""}
                disabled={command === null}
                className="btn"
                idleText="Copy command"
                label="Copy command"
              />
            )}
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

      {closing && <CloseConfirm row={row} onDone={() => setClosing(false)} />}
    </aside>
  );
}
