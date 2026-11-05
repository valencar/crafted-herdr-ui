import { formatShortcut } from "../lib/shortcuts";
import { useEffect, useId, useState } from "react";
import type { MachineView } from "../lib/bindings/MachineView";
import { HEALTH_LABEL, shortPath } from "../lib/format";
import type { Row } from "../lib/grouping";
import { invokeTyped } from "../lib/ipc";
import { markSeen } from "../lib/openRow";
import { paneMenuItems } from "../lib/paneMenu";
import { interruptRow, markUnread, setPinned } from "../lib/rowActions";
import { REPLY_BOX_ID } from "../lib/uiHelpers";
import { useAppStore } from "../store/appStore";
import { CommandBox, CopyButton } from "./CommandBox";
import { CloseConfirm } from "./CloseConfirm";
import { KindBadge } from "./KindBadge";
import { OpenButton } from "./OpenButton";
import { PinGlyph } from "./PinGlyph";
import { Preview } from "./Preview";
import { StatusDetail } from "./StatusDetail";
import { StatusPill } from "./StatusPill";

type Props = {
  row: Row;
  machine: MachineView;
  /** The project the row belongs to, when it has one. */
  project?: string | null;
  terminalName?: string;
  /** The agent that started this terminal, when it is a worker and that agent is listed. */
  startedBy?: Row | null;
  /** The workers that report to this terminal. */
  workers?: readonly Row[];
};

/** Everything about the selected row: details, live preview, reply, and its actions. */
export function Inspector({
  row,
  machine,
  project = null,
  terminalName = "terminal",
  startedBy = null,
  workers = [],
}: Props) {
  const reportError = useAppStore((s) => s.reportError);
  const select = useAppStore((s) => s.select);
  const workersId = useId();
  const { machineId, isAgent } = row;
  const target = { machineId, address: row.address };
  // The ⋯ menu's list: what this row can be offered.
  const items = paneMenuItems(row);
  const canAttach = items.includes("copy-attach");

  // What "Open" runs; the text comes from Rust.
  // Rust's refusal is kept too, so "Copy command" can say why there is nothing to copy.
  const [attach, setAttach] = useState<{
    command: string | null;
    refusal: { error: unknown } | null;
  }>({ command: null, refusal: null });
  const command = canAttach ? attach.command : null;
  const refusal = canAttach ? attach.refusal : null;
  useEffect(() => {
    // A finished terminal can't be attached to: there is no command to fetch or show.
    if (!canAttach) return;
    let alive = true;
    invokeTyped("copy_attach_command", {
      machineId,
      address: row.address,
      observe: false,
    })
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
  }, [machineId, row.address, canAttach]);

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

  const [closing, setClosing] = useState(false);

  return (
    <aside className="inspector" aria-label="Selected agent">
      <header className="inspector-head">
        <div className="inspector-badges">
          <StatusPill status={row.status} isWorker={row.isWorker} />
          <KindBadge kind={row.kind} isAgent={isAgent} named />
          <span className="muted">
            {row.kind ?? (isAgent ? "Agent" : "Shell")}
          </span>
        </div>
        <h2 className="inspector-name mono">
          {row.name}
          {row.pinned && <PinGlyph />}
        </h2>
        <span className="inspector-sub">
          {project ? `${project} on ${row.machineLabel}` : row.machineLabel}
        </span>
        <StatusDetail row={row} />
      </header>

      <dl className="inspector-grid" role="group" aria-label="Details">
        <div>
          <dt>Workbox</dt>
          <dd>
            {machine.name} · {HEALTH_LABEL[machine.health.kind]}
          </dd>
        </div>
        <div>
          <dt>Session</dt>
          <dd>{machine.session ?? "default"}</dd>
        </div>
        {row.folder && (
          <div className="span-2">
            <dt>Folder</dt>
            <dd className="mono">{shortPath(row.folder)}</dd>
          </div>
        )}
        <div>
          <dt>Terminal</dt>
          <dd className="mono">{row.address}</dd>
        </div>
        {startedBy && (
          <div className="span-2">
            <dt>Started by</dt>
            <dd>
              <button
                type="button"
                className="link-btn"
                onClick={() => select(startedBy.key)}
              >
                {startedBy.name}
              </button>
            </dd>
          </div>
        )}
        {workers.length > 0 && (
          <div className="span-2">
            <dt id={workersId}>Workers</dt>
            <dd>
              <ul className="inspector-workers" aria-labelledby={workersId}>
                {workers.map((w) => (
                  <li key={w.key}>
                    <button
                      type="button"
                      className="link-btn"
                      onClick={() => select(w.key)}
                    >
                      {w.name}
                    </button>
                    <StatusPill status={w.status} isWorker={w.isWorker} />
                  </li>
                ))}
              </ul>
            </dd>
          </div>
        )}
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
        {/* A finished terminal has nothing to open; its preview above still reads. */}
        {row.status !== "ended" && (
          <OpenButton
            row={row}
            terminalName={terminalName}
            wide
            kbd={formatShortcut("open-selected")}
          />
        )}
        {/* The ⋯ menu's list (`paneMenuItems`), as buttons: what changes the row, apart from
            the two that end it. */}
        <div className="inspector-secondary">
          {items.includes("mark-seen") && (
            <button type="button" className="btn" onClick={() => markSeen(row)}>
              Mark as seen
            </button>
          )}
          {items.includes("mark-unread") && (
            <button
              type="button"
              className="btn"
              onClick={() => markUnread(row)}
            >
              Mark as unread
            </button>
          )}
          {items.includes("interrupt") && (
            <button
              type="button"
              className="btn"
              onClick={() => void interruptRow(row)}
            >
              Interrupt
            </button>
          )}
          {(items.includes("pin") || items.includes("unpin")) && (
            <button
              type="button"
              className="btn"
              onClick={() => setPinned(row, !row.pinned)}
            >
              {items.includes("unpin") ? "Unpin" : "Pin"}
            </button>
          )}
        </div>
        <div className="inspector-secondary">
          {!items.includes("copy-attach") ? null : refusal ? (
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
            {items.includes("remove") ? "Remove" : "Close"}
          </button>
        </div>
      </div>

      {command && <CommandBox command={command} />}

      {closing && <CloseConfirm row={row} onDone={() => setClosing(false)} />}
    </aside>
  );
}
