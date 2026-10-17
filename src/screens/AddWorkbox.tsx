import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Sheet } from "../components/Sheet";
import { actionErrorMessage } from "../lib/format";
import { invokeTyped, toActionError } from "../lib/ipc";
import { terminalName, useDefaultTerminal } from "../lib/uiHelpers";
import { useAppStore } from "../store/appStore";

const POLL_MS = 2000;
const GIVE_UP_MS = 10 * 60_000;
const TIMEOUT_MESSAGE =
  "Didn't see the new workbox yet. Finish setup in the terminal, then check the sidebar.";

// The characters `open_in_terminal` accepts (Rust `is_plain`); a value never starts with "-".
const PLAIN = "A-Za-z0-9_@%+=:,./-";
const VALUE = new RegExp(`^[${PLAIN}]+$`);
// A label may also hold single spaces between words.
const LABEL = new RegExp(`^[${PLAIN}]+( [${PLAIN}]+)*$`);

function valueProblem(
  what: string,
  value: string,
  pattern: RegExp,
): string | null {
  if (value === "") return null;
  if (value.startsWith("-")) return `${what} can’t start with “-”.`;
  return pattern.test(value)
    ? null
    : `${what} may only use letters, digits and _ @ % + = : , . / -`;
}

/** What the sheet is waiting for: the target to show up as a profile it did not know before. */
type Waiting = {
  target: string;
  /** What the success toast calls it. */
  name: string;
  knownIds: ReadonlySet<string>;
};

/**
 * The Add workbox sheet. "Continue in terminal" hands `herdr machine add …` to the user's own
 * terminal (ssh may ask for a passphrase there), then watches the machine list until the new
 * profile appears.
 */
export function AddWorkbox() {
  const state = useAppStore((s) => s.state);
  const setSheet = useAppStore((s) => s.setSheet);
  const setView = useAppStore((s) => s.setView);
  const showToast = useAppStore((s) => s.showToast);
  const terminal = useDefaultTerminal();
  const terminalLabel = terminalName(terminal);

  const hostId = useId();
  const labelId = useId();
  const sessionId = useId();

  const [host, setHost] = useState("");
  const [label, setLabel] = useState("");
  const [session, setSession] = useState("");
  const [aliases, setAliases] = useState<string[]>([]);
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [waiting, setWaiting] = useState<Waiting | null>(null);
  const [timedOut, setTimedOut] = useState(false);

  const target = host.trim();
  const labelText = label.trim();
  const sessionText = session.trim();
  const hostProblem = valueProblem("The SSH host", target, VALUE);
  const sessionProblem = valueProblem("The remote session", sessionText, VALUE);
  const labelProblem = valueProblem("The label", labelText, LABEL);
  const valid =
    target !== "" && !hostProblem && !sessionProblem && !labelProblem;

  const machines = useMemo(() => state?.machines ?? [], [state]);
  const existing = target
    ? machines.find((m) => m.target === target)
    : undefined;

  useEffect(() => {
    let cancelled = false;
    invokeTyped("list_ssh_hosts")
      .then((list) => {
        if (!cancelled) setAliases(list);
      })
      // Without the list the field still takes any host.
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // The command line comes from Rust, so it is exactly what the button runs.
  useEffect(() => {
    if (!valid) return;
    let cancelled = false;
    invokeTyped("preview_machine_add", {
      target,
      label: labelText || null,
      session: sessionText || null,
    })
      .then((line) => {
        if (!cancelled) setPreview(line);
      })
      .catch(() => {
        if (!cancelled) setPreview(null);
      });
    return () => {
      cancelled = true;
    };
  }, [valid, target, labelText, sessionText]);

  // Ask for a fresh machine list every 2 s, for up to 10 minutes. Leaving the sheet (Cancel,
  // Escape, success) unmounts this effect, which stops both timers.
  const waitingTarget = waiting?.target;
  useEffect(() => {
    if (!waitingTarget) return;
    const poll = window.setInterval(() => {
      // A failed refresh shows up in the next one; there is nothing to tell the user.
      invokeTyped("refresh_now", {}).catch(() => {});
    }, POLL_MS);
    const giveUp = window.setTimeout(() => {
      window.clearInterval(poll);
      setWaiting(null);
      setTimedOut(true);
    }, GIVE_UP_MS);
    return () => {
      window.clearInterval(poll);
      window.clearTimeout(giveUp);
    };
  }, [waitingTarget]);

  // The new profile showed up in the state: done.
  useEffect(() => {
    if (!waiting) return;
    const added = machines.find(
      (m) => m.target === waiting.target && !waiting.knownIds.has(m.id),
    );
    if (!added) return;
    setSheet(null);
    showToast(`Added ${waiting.name}`, "info");
    setView({ kind: "workbox", machineId: added.id });
  }, [waiting, machines, setSheet, setView, showToast]);

  const close = () => setSheet(null);
  const waitingNow = waiting !== null;
  const canContinue = valid && !existing && !busy && !waitingNow;

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  async function submit() {
    if (!canContinue) return;
    setBusy(true);
    setFailure(null);
    setTimedOut(false);
    try {
      const fields = {
        target,
        label: labelText || null,
        session: sessionText || null,
      };
      const argv = await invokeTyped("machine_add_argv", fields);
      await invokeTyped("open_in_terminal", { argv });
      if (!mounted.current) return;
      setWaiting({
        target,
        name: labelText || target,
        knownIds: new Set(machines.map((m) => m.id)),
      });
    } catch (e) {
      if (mounted.current) setFailure(actionErrorMessage(toActionError(e)));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  return (
    <Sheet
      title="Add workbox"
      subtitle="Any machine you can already SSH into"
      onClose={close}
      onKeyDown={(e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
          e.preventDefault();
          void submit();
        }
      }}
      footer={
        <>
          <span className="sheet-foot-note">
            Keys stay with OpenSSH. Crafted Herdr never stores passwords.
          </span>
          <button type="button" className="btn sheet-cancel" onClick={close}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!canContinue}
            onClick={() => void submit()}
          >
            Continue in {terminalLabel}
          </button>
        </>
      }
    >
      <div className="sheet-field">
        <label htmlFor={hostId} className="sheet-label">
          SSH host
        </label>
        <input
          id={hostId}
          data-autofocus
          className="field mono"
          type="text"
          value={host}
          placeholder="buildbox or dev@build.example"
          spellCheck={false}
          autoCapitalize="off"
          disabled={waitingNow}
          aria-invalid={hostProblem ? true : undefined}
          onChange={(e) => setHost(e.target.value)}
        />
        {hostProblem && (
          <p className="field-error" role="alert">
            {hostProblem}
          </p>
        )}
        {aliases.length > 0 && (
          <div className="sheet-line sheet-wrap">
            <span className="muted sheet-note">From ~/.ssh/config:</span>
            {aliases.map((alias) => (
              <button
                key={alias}
                type="button"
                className={`btn btn-small mono${alias === target ? " chip-on" : ""}`}
                aria-pressed={alias === target}
                disabled={waitingNow}
                onClick={() => setHost(alias)}
              >
                {alias}
              </button>
            ))}
          </div>
        )}
        {existing && !waitingNow && (
          <p className="muted sheet-note">Already added as {existing.label}</p>
        )}
      </div>

      <div className="sheet-pair">
        <div className="sheet-field">
          <label htmlFor={labelId} className="sheet-label">
            Label
          </label>
          <input
            id={labelId}
            className="field"
            type="text"
            value={label}
            placeholder="optional"
            spellCheck={false}
            disabled={waitingNow}
            aria-invalid={labelProblem ? true : undefined}
            onChange={(e) => setLabel(e.target.value)}
          />
          {labelProblem && <p className="field-error">{labelProblem}</p>}
        </div>
        <div className="sheet-field">
          <label htmlFor={sessionId} className="sheet-label">
            Remote session
          </label>
          <input
            id={sessionId}
            className="field mono"
            type="text"
            value={session}
            placeholder="default"
            spellCheck={false}
            autoCapitalize="off"
            disabled={waitingNow}
            aria-invalid={sessionProblem ? true : undefined}
            onChange={(e) => setSession(e.target.value)}
          />
          {sessionProblem && <p className="field-error">{sessionProblem}</p>}
        </div>
      </div>

      <div className="cmdbox" aria-live="polite">
        <div className="cmdbox-caption">
          # Opens in {terminalLabel}, using your herdr CLI
        </div>
        {valid && preview ? (
          <div>
            <code className="cmdbox-line">
              <span className="cmdbox-prompt">$</span> {preview}
            </code>
          </div>
        ) : (
          <div className="cmdbox-caption">Enter a host to see the command.</div>
        )}
      </div>

      {failure && (
        <p className="field-error" role="alert">
          {failure}
        </p>
      )}

      {(waiting || timedOut) && (
        <div className="checklist" aria-live="polite">
          <p className="checklist-title">Setting up {target}</p>
          {waiting && (
            <div className="checklist-row">
              <span className="checklist-icon" aria-hidden="true">
                !
              </span>
              <span>Waiting for setup in {terminalLabel}…</span>
            </div>
          )}
          {timedOut && (
            <p className="field-error" role="alert">
              {TIMEOUT_MESSAGE}
            </p>
          )}
        </div>
      )}
    </Sheet>
  );
}
