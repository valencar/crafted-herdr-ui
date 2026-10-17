import {
  useEffect,
  useEffectEvent,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { Sheet } from "../components/Sheet";
import type { SetupEvent } from "../lib/bindings/SetupEvent";
import type { SetupPrompt } from "../lib/bindings/SetupPrompt";
import type { SetupStep } from "../lib/bindings/SetupStep";
import type { StepState } from "../lib/bindings/StepState";
import { actionErrorMessage } from "../lib/format";
import { invokeTyped, onMachineSetup, toActionError } from "../lib/ipc";
import { terminalName, useTerminals } from "../lib/uiHelpers";
import { useAppStore, useModalOpen } from "../store/appStore";

const POLL_MS = 2000;
const GIVE_UP_MS = 10 * 60_000;
const TIMEOUT_MESSAGE =
  "Didn't see the new workbox yet. Finish setup in the terminal, then check the sidebar.";
const APP_TIMEOUT_MESSAGE =
  "herdr finished, but the new workbox hasn't shown up yet. Check the sidebar.";
/** The most herdr output kept for the "Show herdr output" log. */
const LOG_LIMIT = 100_000;

const STEP_ORDER: SetupStep[] = [
  "ssh",
  "herdrInstalled",
  "serverStarted",
  "sessionsFound",
];
const STATE_TEXT: Record<StepState | "pending", string> = {
  pending: "Waiting",
  active: "In progress",
  done: "Done",
  failed: "Failed",
};
const STATE_ICON: Record<StepState | "pending", string> = {
  pending: "○",
  active: "…",
  done: "✓",
  failed: "✕",
};

function stepLabel(step: SetupStep, target: string): string {
  switch (step) {
    case "ssh":
      return "SSH connection";
    case "herdrInstalled":
      return `herdr on ${target}`;
    case "serverStarted":
      return "Server started";
    case "sessionsFound":
      return "Sessions found";
  }
}

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

/** The target the sheet is after: it should show up as a profile it did not know before. */
type Run = {
  target: string;
  /** What the success toast calls it. */
  name: string;
  knownIds: ReadonlySet<string>;
};

/** What the sheet is waiting for. `via` is who is doing the setup: the user's terminal, or the app. */
type Waiting = Run & { via: "terminal" | "app" };

type StepInfo = { state: StepState; meta: string | null };

/**
 * The Add workbox sheet. "Add workbox" runs `herdr machine add …` in a hidden terminal and turns
 * the prompts it knows (session picker, install consent, replace consent) into dialogs. Anything
 * else, or a run that goes quiet, is for "Continue in terminal", which hands the same command to
 * the user's own terminal (ssh may ask for a passphrase there). Either way the sheet is done when
 * the new profile shows up in the machine list.
 */
export function AddWorkbox() {
  const state = useAppStore((s) => s.state);
  const setSheet = useAppStore((s) => s.setSheet);
  const setView = useAppStore((s) => s.setView);
  const showToast = useAppStore((s) => s.showToast);
  const { current: terminal } = useTerminals();
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
  const [timedOut, setTimedOut] = useState<string | null>(null);
  // The hidden `machine add` run.
  const [run, setRun] = useState<Run | null>(null);
  const [steps, setSteps] = useState<Partial<Record<SetupStep, StepInfo>>>({});
  const [log, setLog] = useState("");
  const [showLog, setShowLog] = useState(false);
  const [prompt, setPrompt] = useState<SetupPrompt | null>(null);
  const [stalled, setStalled] = useState(false);
  const [runFailure, setRunFailure] = useState<string | null>(null);
  const [started, setStarted] = useState(false);
  // Events arrive while the callbacks below are mid-render, so they read the run from a ref.
  const runRef = useRef<Run | null>(null);

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
  const waitingVia = waiting?.via;
  useEffect(() => {
    if (!waitingTarget) return;
    const poll = window.setInterval(() => {
      // A failed refresh shows up in the next one; there is nothing to tell the user.
      invokeTyped("refresh_now", {}).catch(() => {});
    }, POLL_MS);
    const giveUp = window.setTimeout(() => {
      window.clearInterval(poll);
      setWaiting(null);
      setTimedOut(waitingVia === "app" ? APP_TIMEOUT_MESSAGE : TIMEOUT_MESSAGE);
    }, GIVE_UP_MS);
    return () => {
      window.clearInterval(poll);
      window.clearTimeout(giveUp);
    };
  }, [waitingTarget, waitingVia]);

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

  const running = run !== null;
  const waitingNow = waiting !== null;
  const canContinue = valid && !existing && !busy && !waitingNow;
  const canAdd = canContinue && !running;

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      // Leaving the sheet leaves nothing running in the background.
      if (runRef.current) {
        runRef.current = null;
        invokeTyped("cancel_machine_setup").catch(() => {});
      }
    };
  }, []);

  const close = () => setSheet(null);

  function applyEvent(event: SetupEvent) {
    const current = runRef.current;
    // Events from a run the user already walked away from.
    if (!current) return;
    switch (event.kind) {
      case "output":
        setLog((text) => (text + event.data).slice(-LOG_LIMIT));
        setStalled(false);
        break;
      case "step":
        setSteps((all) => ({
          ...all,
          [event.data.step]: {
            state: event.data.state,
            meta: event.data.meta,
          },
        }));
        break;
      case "prompt":
        setPrompt(event.data);
        setStalled(false);
        break;
      case "stalled":
        setStalled(true);
        break;
      case "finished":
        runRef.current = null;
        setRun(null);
        setPrompt(null);
        setStalled(false);
        if (event.data.ok) {
          // herdr says it saved the machine; the machine list says whether it did.
          setWaiting({ ...current, via: "app" });
        } else {
          setRunFailure(
            "herdr stopped before the workbox was added. See its output below, or continue in the terminal.",
          );
          setShowLog(true);
        }
        break;
    }
  }
  const onSetupEvent = useEffectEvent(applyEvent);

  useEffect(() => {
    let off: (() => void) | undefined;
    let gone = false;
    onMachineSetup((event) => onSetupEvent(event))
      .then((unlisten) => {
        if (gone) unlisten();
        else off = unlisten;
      })
      // Without events the run can't be followed; "Continue in terminal" still works.
      .catch(() => {});
    return () => {
      gone = true;
      off?.();
    };
  }, []);

  function forgetRun() {
    runRef.current = null;
    setRun(null);
    setPrompt(null);
    setStalled(false);
  }

  /** Stops the hidden run, if there is one. */
  async function stopRun() {
    if (!runRef.current) return;
    forgetRun();
    await invokeTyped("cancel_machine_setup").catch(() => {});
  }

  function newRun(): Run {
    return {
      target,
      name: labelText || target,
      knownIds: new Set(machines.map((m) => m.id)),
    };
  }

  async function addHere() {
    if (!canAdd) return;
    setBusy(true);
    setFailure(null);
    setRunFailure(null);
    setTimedOut(null);
    setSteps({});
    setLog("");
    setShowLog(false);
    setStarted(true);
    const next = newRun();
    // The first events come before the call returns.
    runRef.current = next;
    setRun(next);
    try {
      await invokeTyped("start_machine_add", {
        target,
        label: labelText || null,
        session: sessionText || null,
      });
    } catch (e) {
      forgetRun();
      setStarted(false);
      if (mounted.current) setFailure(actionErrorMessage(toActionError(e)));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  async function answer(choice: string) {
    const asked = prompt;
    setPrompt(null);
    setStalled(false);
    try {
      await invokeTyped("answer_machine_setup", { choice });
    } catch (e) {
      if (!mounted.current) return;
      setFailure(actionErrorMessage(toActionError(e)));
      // herdr never got the answer, so it is still asking. Ask again, unless the run is over
      // or a newer question has come in.
      if (runRef.current) setPrompt((current) => current ?? asked);
    }
  }

  async function giveUpOnPrompt() {
    await stopRun();
    setStarted(false);
  }

  async function submit() {
    if (!canContinue) return;
    setBusy(true);
    setFailure(null);
    setRunFailure(null);
    setTimedOut(null);
    try {
      // The hidden run and the terminal must not both answer to the same host.
      await stopRun();
      setStarted(false);
      const fields = {
        target,
        label: labelText || null,
        session: sessionText || null,
      };
      const argv = await invokeTyped("machine_add_argv", fields);
      await invokeTyped("open_in_terminal", { argv });
      if (!mounted.current) return;
      setWaiting({ ...newRun(), via: "terminal" });
    } catch (e) {
      if (mounted.current) setFailure(actionErrorMessage(toActionError(e)));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  const locked = waitingNow || running;
  const promptTarget = run?.target ?? target;

  return (
    <>
      <Sheet
        title="Add workbox"
        subtitle="Any machine you can already SSH into"
        onClose={close}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
            e.preventDefault();
            void addHere();
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
              className="btn"
              disabled={!canContinue}
              onClick={() => void submit()}
            >
              Continue in {terminalLabel}
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={!canAdd}
              onClick={() => void addHere()}
            >
              Add workbox
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
            disabled={locked}
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
                  disabled={locked}
                  onClick={() => setHost(alias)}
                >
                  {alias}
                </button>
              ))}
            </div>
          )}
          {existing && !waitingNow && (
            <p className="muted sheet-note">
              Already added as {existing.label}
            </p>
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
              disabled={locked}
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
              disabled={locked}
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
            <div className="cmdbox-caption">
              Enter a host to see the command.
            </div>
          )}
        </div>

        {failure && (
          <p className="field-error" role="alert">
            {failure}
          </p>
        )}

        {(started || waiting || timedOut || runFailure) && (
          <div className="checklist" aria-live="polite">
            <p className="checklist-title">
              Setting up {run?.target ?? waiting?.target ?? target}
            </p>
            {started &&
              STEP_ORDER.map((step) => {
                const info = steps[step];
                const state = info?.state ?? "pending";
                return (
                  <div className="checklist-row" key={step}>
                    <span
                      className={`checklist-icon checklist-icon-${state}`}
                      aria-hidden="true"
                    >
                      {STATE_ICON[state]}
                    </span>
                    <span className="checklist-row-text">
                      <span>{stepLabel(step, promptTarget)}</span>
                      {info?.state === "failed" && info.meta && (
                        <span className="checklist-note mono">{info.meta}</span>
                      )}
                    </span>
                    <span className="checklist-state">{STATE_TEXT[state]}</span>
                  </div>
                );
              })}
            {waiting && (
              <div className="checklist-row">
                <span className="checklist-icon" aria-hidden="true">
                  !
                </span>
                <span>
                  {waiting.via === "terminal"
                    ? `Waiting for setup in ${terminalLabel}…`
                    : `Waiting for ${waiting.target} to show up…`}
                </span>
              </div>
            )}
            {stalled && (
              <p className="muted sheet-note" role="status">
                herdr has gone quiet. It may be waiting for something this sheet
                can’t answer, like an SSH passphrase. Continue in{" "}
                {terminalLabel} to answer it there.
              </p>
            )}
            {runFailure && (
              <p className="field-error" role="alert">
                {runFailure}
              </p>
            )}
            {timedOut && (
              <p className="field-error" role="alert">
                {timedOut}
              </p>
            )}
            {started && (
              <details
                className="setup-log"
                open={showLog}
                onToggle={(e) => setShowLog(e.currentTarget.open)}
              >
                <summary>Show herdr output</summary>
                <pre aria-label="herdr output">{log || "No output yet."}</pre>
              </details>
            )}
          </div>
        )}
      </Sheet>
      {prompt?.kind === "pickSession" && (
        <SessionPicker
          target={promptTarget}
          options={prompt.options}
          onChoose={(index) => void answer(String(index))}
          onCancel={() => void giveUpOnPrompt()}
        />
      )}
      {prompt?.kind === "confirmInstall" && (
        <ConfirmDialog
          title={`Install herdr on ${promptTarget}?`}
          body={`${prompt.version ? `herdr ${prompt.version}` : "herdr"} needs to be installed on ${promptTarget}${prompt.path ? `, at ${prompt.path}` : ""}. Nothing is installed unless you say so.`}
          detail={prompt.detail ?? undefined}
          confirmLabel="Install herdr"
          danger={false}
          onConfirm={() => void answer("yes")}
          onCancel={() => void answer("no")}
        />
      )}
      {prompt?.kind === "confirmReplace" && (
        <ConfirmDialog
          title={`Stop the herdr server on ${promptTarget}?`}
          body={`This stops the running herdr server on ${promptTarget} and the agents in its panes.`}
          detail={prompt.message}
          confirmLabel="Stop server and continue"
          onConfirm={() => void answer("yes")}
          onCancel={() => void answer("no")}
        />
      )}
    </>
  );
}

/** Which of the running sessions on the target to add. */
function SessionPicker({
  target,
  options,
  onChoose,
  onCancel,
}: {
  target: string;
  options: string[];
  onChoose: (index: number) => void;
  onCancel: () => void;
}) {
  useModalOpen();
  const titleId = useId();
  const name = useId();
  const [index, setIndex] = useState(0);
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    panel.current?.querySelector<HTMLElement>("input")?.focus();
    return () => previous?.focus?.();
  }, []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      onCancel();
    } else if (e.key === "Tab" && panel.current) {
      const stops = [
        ...panel.current.querySelectorAll<HTMLElement>("input:checked, button"),
      ];
      const first = stops[0];
      const last = stops[stops.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last?.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first?.focus();
      }
    }
  };

  return (
    <div className="scrim">
      <div
        ref={panel}
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={onKeyDown}
      >
        <h2 id={titleId} className="dialog-title">
          Which session on {target}?
        </h2>
        <fieldset className="session-list">
          <legend className="dialog-body">
            herdr found {options.length} running sessions there.
          </legend>
          {options.map((option, i) => (
            <label key={option} className="session-option">
              <input
                type="radio"
                name={name}
                checked={i === index}
                onChange={() => setIndex(i)}
              />
              {option}
            </label>
          ))}
        </fieldset>
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => onChoose(index)}
          >
            Use this session
          </button>
        </div>
      </div>
    </div>
  );
}
