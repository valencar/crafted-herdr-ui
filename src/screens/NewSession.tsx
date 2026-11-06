import { Kbd } from "../components/Kbd";
import { open } from "@tauri-apps/plugin-dialog";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { KindBadge } from "../components/KindBadge";
import { Sheet } from "../components/Sheet";
import { Tooltip } from "../components/Tooltip";
import type { NewSessionRequest } from "../lib/bindings/NewSessionRequest";
import type { RunChoice } from "../lib/bindings/RunChoice";
import type { RunChoices } from "../lib/bindings/RunChoices";
import { actionErrorMessage, plural, terminalNameProblem } from "../lib/format";
import { toRows } from "../lib/grouping";
import { invokeTyped, toActionError } from "../lib/ipc";
import { saveSettings } from "../lib/uiHelpers";
import { useAppStore } from "../store/appStore";

const PREVIEW_DEBOUNCE_MS = 150;
const MAX_RECENT_FOLDERS = 6;

/** An option of the Run list: what it would run, its id, and why it can't be chosen. */
type RunOption = {
  id: string;
  label: string;
  run: RunChoice;
  /** Shown under the name; the radio is described by it. */
  description?: string;
  /** Whether a starting prompt can be typed for it. */
  takesTask: boolean;
  /** Set for a template that can't run: the reason. */
  unavailable?: string;
  /** The agent kind, for the badge and for remembering the choice. */
  kind: string | null;
  /** An agent or a template (an agent's mark, even with no kind); a shell and a command are not. */
  isAgent: boolean;
};

const SHELL_ID = "shell";
const COMMAND_ID = "command";

function nameProblem(name: string): string | null {
  return name === "" ? null : terminalNameProblem(name);
}

/** The core said the name is held by a live terminal. */
function takenMessage(err: { kind: string }): string | null {
  const e = err as {
    kind: string;
    error?: { kind?: string; code?: string; message?: string };
  };
  return e.kind === "core" &&
    e.error?.kind === "rpc" &&
    e.error.code === "name_taken"
    ? (e.error.message ?? "That name is already taken.")
    : null;
}

function baseName(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(value), ms);
    return () => window.clearTimeout(t);
  }, [value, ms]);
  return debounced;
}

type Props = {
  /** The name of the user's terminal, for "Open in <Terminal> when ready". */
  terminalName: string;
};

/** The New session sheet: where to start what, and the exact `hc run` line it will use. */
export function NewSession({ terminalName }: Props) {
  const state = useAppStore((s) => s.state);
  const selectedKey = useAppStore((s) => s.selectedKey);
  const setSheet = useAppStore((s) => s.setSheet);
  const reportError = useAppStore((s) => s.reportError);
  const setPendingSelectKey = useAppStore((s) => s.setPendingSelectKey);
  const addPendingOpen = useAppStore((s) => s.addPendingOpen);
  const openTarget = useAppStore((s) => s.settings?.open_target ?? "app");
  const savedKind = useAppStore((s) => s.settings?.new_session_kind ?? null);
  const hiddenKinds = useAppStore((s) => s.settings?.new_session_hidden_kinds);
  const hideShell = useAppStore((s) => s.settings?.new_session_hide_shell);
  // Read once: the prefill only seeds the form.
  const [prefill] = useState(() => useAppStore.getState().sheetPrefill);

  const folderId = useId();
  const nameId = useId();
  const taskId = useId();
  const commandId = useId();
  const machineGroup = useId();
  const runGroup = useId();

  const [machineChoice, setMachineChoice] = useState<string | null>(
    prefill?.machineId ?? null,
  );
  const [folder, setFolder] = useState(prefill?.folder ?? "");
  // What a workbox can run, with the workbox it was asked for.
  const [loaded, setLoaded] = useState<{
    machineId: string;
    choices: RunChoices;
    /** The call itself failed, so nothing was asked of the workbox. */
    failed: boolean;
  } | null>(null);
  // `undefined` = the default (the saved Run choice, else a plain shell).
  const [runChoice, setRunChoice] = useState<string | undefined>();
  const [name, setName] = useState("");
  const [task, setTask] = useState("");
  const [commandLine, setCommandLine] = useState("");
  const [keep, setKeep] = useState(false);
  const [openAfter, setOpenAfter] = useState(
    () => useAppStore.getState().settings?.open_after_create ?? true,
  );
  const [busy, setBusy] = useState(false);
  // The last create failure. It only shows while the form still matches what was sent.
  const [failure, setFailure] = useState<{
    message: string;
    /** The create may have partly happened: stays until dismissed, whatever the form says. */
    sticky: boolean;
    forRequest: string;
  } | null>(null);
  // The name the core said is taken, with its words.
  const [taken, setTaken] = useState<{
    machineId: string;
    name: string;
    message: string;
  } | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [preview, setPreview] = useState<{
    line: string;
    error: string | null;
  }>({ line: "", error: null });

  const rows = useMemo(() => (state ? toRows(state) : []), [state]);
  const machines = useMemo(
    () => (state?.machines ?? []).filter((m) => m.health.kind !== "hidden"),
    [state],
  );
  const selectedRow = rows.find((r) => r.key === selectedKey) ?? null;
  const defaultMachineId =
    machines.find((m) => m.id === selectedRow?.machineId)?.id ??
    machines.find((m) => m.health.kind === "online")?.id ??
    machines[0]?.id ??
    null;
  const machine =
    machines.find((m) => m.id === machineChoice) ??
    machines.find((m) => m.id === defaultMachineId) ??
    null;
  const machineId = machine?.id ?? null;

  // `null` while the chosen workbox is being asked (an answer for another one doesn't count).
  const current = loaded?.machineId === machineId ? loaded : null;
  const choices = current?.choices ?? null;
  useEffect(() => {
    if (machineId === null) return;
    let cancelled = false;
    (async () => {
      try {
        const list = await invokeTyped("list_run_choices", { machineId });
        if (!cancelled) setLoaded({ machineId, choices: list, failed: false });
      } catch (e) {
        if (cancelled) return;
        reportError(e);
        setLoaded({
          machineId,
          choices: { kinds: [], templates: [], kindsChecked: false },
          failed: true,
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [machineId, reportError]);

  // The Run options: the agents minus the hidden ones, the templates, then Plain shell unless
  // hidden, then Custom command. Never without a way to run something: with no agent or
  // template left, Plain shell is offered anyway.
  const runOptions = useMemo<RunOption[]>(() => {
    const agents: RunOption[] = (choices?.kinds ?? [])
      .filter((k) => !hiddenKinds?.includes(k.kind))
      .map((k) => ({
        id: `agent:${k.kind}`,
        label: k.kind,
        run: { type: "agent", kind: k.kind },
        takesTask: k.takesTask,
        kind: k.kind,
        isAgent: true,
      }));
    const templates: RunOption[] = (choices?.templates ?? []).map((tpl) => ({
      id: `template:${tpl.name}`,
      label: tpl.name,
      run: { type: "template", name: tpl.name },
      description: tpl.description ?? undefined,
      takesTask: true,
      unavailable: tpl.error
        ? tpl.error
        : tpl.command
          ? undefined
          : "It has no command.",
      kind: null,
      isAgent: true,
    }));
    const shell: RunOption = {
      id: SHELL_ID,
      label: "Plain shell",
      run: { type: "shell" },
      takesTask: false,
      kind: null,
      isAgent: false,
    };
    const command: RunOption = {
      id: COMMAND_ID,
      label: "Custom command",
      run: { type: "command", line: "" },
      takesTask: false,
      kind: null,
      isAgent: false,
    };
    const withShell =
      !hideShell || (agents.length === 0 && templates.length === 0);
    return [...agents, ...templates, ...(withShell ? [shell] : []), command];
  }, [choices, hiddenKinds, hideShell]);
  const offered = runOptions.filter((o) => o.unavailable === undefined);
  // A click wins while its option is still offered. Otherwise: the saved choice if it is
  // offered, else Plain shell, else the first option.
  const option: RunOption | undefined =
    offered.find((o) => o.id === runChoice) ??
    offered.find((o) => o.kind !== null && o.kind === savedKind) ??
    offered.find((o) => o.id === SHELL_ID) ??
    offered[0];

  const recentFolders = useMemo(() => {
    const seen = new Set<string>();
    for (const r of rows) {
      if (r.machineId === machineId && r.folder) seen.add(r.folder);
    }
    return [...seen].slice(0, MAX_RECENT_FOLDERS);
  }, [rows, machineId]);

  const cwd = folder.trim();
  const trimmedName = name.trim();
  const trimmedTask = task.trim();
  const isCommand = option?.id === COMMAND_ID;
  const nameHint = nameProblem(trimmedName);
  const nameTaken =
    taken !== null &&
    taken.machineId === machineId &&
    taken.name === trimmedName;
  const canCreate =
    machineId !== null &&
    choices !== null &&
    option !== undefined &&
    cwd !== "" &&
    !cwd.startsWith("-") &&
    (!isCommand || commandLine.trim() !== "") &&
    nameHint === null &&
    !busy;

  const run: RunChoice | null = !option
    ? null
    : option.run.type === "command"
      ? { type: "command", line: commandLine.trim() }
      : option.run;
  const request: NewSessionRequest | null =
    machineId === null || run === null
      ? null
      : {
          machineId,
          cwd,
          run,
          name: trimmedName === "" ? null : trimmedName,
          task: option?.takesTask && trimmedTask !== "" ? trimmedTask : null,
          keep,
        };
  const requestJson = request ? JSON.stringify(request) : null;
  // Only ask Rust for the command once there is a folder to run it in (and, for a custom
  // command, the command).
  const previewJson =
    cwd !== "" &&
    choices !== null &&
    nameHint === null &&
    (!isCommand || commandLine.trim() !== "")
      ? requestJson
      : null;
  const debouncedPreview = useDebounced(previewJson, PREVIEW_DEBOUNCE_MS);
  // Why there is no command line yet.
  const previewHint =
    cwd === ""
      ? "Pick a folder to see the command."
      : nameHint !== null
        ? "Fix the name to see the command."
        : isCommand && commandLine.trim() === ""
          ? "Type the command to see it."
          : "Waiting for this workbox to answer.";

  useEffect(() => {
    if (debouncedPreview === null) return;
    let cancelled = false;
    (async () => {
      try {
        const line = await invokeTyped("preview_new_session", {
          req: JSON.parse(debouncedPreview) as NewSessionRequest,
        });
        if (!cancelled) setPreview({ line, error: null });
      } catch (e) {
        if (!cancelled) {
          setPreview({
            line: "",
            error: actionErrorMessage(toActionError(e)),
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [debouncedPreview]);

  const close = () => setSheet(null);

  async function submit() {
    if (!request || !canCreate) return;
    setBusy(true);
    setFailure(null);
    setTaken(null);
    const sent: NewSessionRequest = request;
    try {
      const created = await invokeTyped("create_session", { req: sent });
      // The address is local to its machine, like every row key.
      const key = `${sent.machineId}::${created.address}`;
      setPendingSelectKey(key);
      if (openAfter) {
        // `open_session` needs the terminal in the state, which the event stream brings; Home
        // opens it then. There is nothing to mark seen for a new session.
        addPendingOpen({
          key,
          machineId: sent.machineId,
          address: created.address,
        });
      }
      // Remember the Run choice only now that it made a session. A template or a custom
      // command leaves the saved choice (an agent or a plain shell) alone.
      const remembered = rememberedKind(sent.run);
      const current = useAppStore.getState().settings?.new_session_kind ?? null;
      if (remembered !== undefined && remembered !== current) {
        saveSettings({ new_session_kind: remembered });
      }
      // Closing a sheet the user already left could close the next one they opened.
      if (mounted.current) close();
    } catch (e) {
      const err = toActionError(e);
      if (!mounted.current) {
        reportError(err);
        return;
      }
      const takenWords = takenMessage(err);
      if (takenWords !== null) {
        setTaken({
          machineId: sent.machineId,
          name: sent.name ?? "",
          message: takenWords,
        });
        return;
      }
      setFailure({
        message: actionErrorMessage(err),
        sticky: err.kind === "maybeApplied",
        forRequest: requestJson ?? "",
      });
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  async function browse() {
    try {
      const picked = await open({
        directory: true,
        multiple: false,
        defaultPath: cwd || undefined,
      });
      if (typeof picked === "string") setFolder(picked);
    } catch (e) {
      reportError(e);
    }
  }

  const shownFailure =
    failure && (failure.sticky || failure.forRequest === requestJson)
      ? failure
      : null;
  const nameError = nameHint ?? (nameTaken ? taken.message : null);

  return (
    <Sheet
      title="New session"
      subtitle="Start a terminal or an agent on any workbox"
      onClose={close}
      onKeyDown={(e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
          e.preventDefault();
          void submit();
        }
      }}
      footer={
        <>
          <label className="check">
            <input
              type="checkbox"
              checked={openAfter}
              onChange={(e) => setOpenAfter(e.target.checked)}
            />
            {openTarget === "app"
              ? "Open here when ready"
              : `Open in ${terminalName} when ready`}
          </label>
          <button type="button" className="btn sheet-cancel" onClick={close}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!canCreate}
            onClick={() => void submit()}
          >
            Create session <Kbd id="create-session" />
          </button>
        </>
      }
    >
      <fieldset className="sheet-field">
        <legend className="sheet-label">Workbox</legend>
        {machines.length === 0 ? (
          <p className="muted">No workboxes are available.</p>
        ) : (
          <div className="opt-grid opt-grid-4">
            {machines.map((m) => {
              const agents = m.terminals.filter((t) => t.is_agent).length;
              const meta =
                m.health.kind === "online"
                  ? plural(agents, "agent", "agents")
                  : "not reachable";
              return (
                <label key={m.id} className="opt" data-on={m.id === machineId}>
                  <span className="opt-line">
                    <input
                      type="radio"
                      name={machineGroup}
                      checked={m.id === machineId}
                      onChange={() => setMachineChoice(m.id)}
                    />
                    <span className="opt-name">{m.name}</span>
                  </span>
                  <span className="mono muted opt-meta">
                    {m.is_local ? `local · ${meta}` : meta}
                  </span>
                </label>
              );
            })}
          </div>
        )}
      </fieldset>

      <div className="sheet-field">
        <label htmlFor={folderId} className="sheet-label">
          Project folder
        </label>
        <div className="sheet-line">
          <input
            id={folderId}
            data-autofocus
            className="field mono"
            type="text"
            value={folder}
            placeholder="/home/dev/projects/api-service"
            spellCheck={false}
            onChange={(e) => setFolder(e.target.value)}
          />
          {machine?.is_local && (
            <button type="button" className="btn" onClick={() => void browse()}>
              Browse…
            </button>
          )}
        </div>
        {recentFolders.length > 0 && (
          <div className="sheet-line sheet-wrap">
            <span className="muted sheet-note">Recent:</span>
            {recentFolders.map((f) => (
              <Tooltip key={f} label={f}>
                <button
                  type="button"
                  className="btn btn-small mono"
                  onClick={() => setFolder(f)}
                >
                  {baseName(f)}
                </button>
              </Tooltip>
            ))}
          </div>
        )}
      </div>

      <fieldset className="sheet-field">
        <legend className="sheet-label">Run</legend>
        {choices === null ? (
          <p className="muted">Looking for agents on this workbox…</p>
        ) : (
          <>
            <div className="opt-grid opt-grid-3">
              {runOptions.map((o) => {
                const describedBy = `${runGroup}-${o.id}`;
                const note = o.unavailable
                  ? `Unavailable: ${o.unavailable}`
                  : o.description;
                return (
                  <label
                    key={o.id}
                    className="opt opt-row"
                    data-on={o.id === option?.id}
                    data-unavailable={o.unavailable !== undefined || undefined}
                  >
                    <input
                      type="radio"
                      name={runGroup}
                      checked={o.id === option?.id}
                      aria-label={o.label}
                      disabled={o.unavailable !== undefined}
                      aria-describedby={note ? describedBy : undefined}
                      onChange={() => setRunChoice(o.id)}
                    />
                    <span aria-hidden="true">
                      <KindBadge kind={o.kind} isAgent={o.isAgent} named />
                    </span>
                    <span className="opt-text">
                      <span className="opt-name">{o.label}</span>
                      {note && (
                        <span id={describedBy} className="muted opt-meta">
                          {note}
                        </span>
                      )}
                    </span>
                  </label>
                );
              })}
            </div>
            {current?.failed ? (
              <p className="muted sheet-note">
                Couldn’t load the agents for this workbox. Plain shell and
                Custom command still work.
              </p>
            ) : (
              !choices.kindsChecked && (
                <p className="muted sheet-note">
                  Couldn’t check which agents are installed here, so every known
                  agent is listed.
                </p>
              )
            )}
          </>
        )}
      </fieldset>

      {isCommand && (
        <div className="sheet-field">
          <label htmlFor={commandId} className="sheet-label">
            Command
          </label>
          <input
            id={commandId}
            className="field mono"
            type="text"
            value={commandLine}
            placeholder="npm run dev"
            spellCheck={false}
            onChange={(e) => setCommandLine(e.target.value)}
          />
          <p className="muted sheet-note">
            Run by the workbox’s shell, in the folder above.
          </p>
        </div>
      )}

      <div className="sheet-pair">
        <div className="sheet-field">
          <label htmlFor={nameId} className="sheet-label">
            Name
          </label>
          <input
            id={nameId}
            className="field mono"
            type="text"
            value={name}
            placeholder="optional"
            spellCheck={false}
            aria-invalid={nameError ? true : undefined}
            onChange={(e) => setName(e.target.value)}
          />
          {nameError && <p className="field-error">{nameError}</p>}
        </div>
        {option?.takesTask && (
          <div className="sheet-field">
            <label htmlFor={taskId} className="sheet-label">
              Task
            </label>
            <input
              id={taskId}
              className="field"
              type="text"
              value={task}
              placeholder="optional"
              onChange={(e) => setTask(e.target.value)}
            />
          </div>
        )}
      </div>

      <label className="check">
        <input
          type="checkbox"
          checked={keep}
          onChange={(e) => setKeep(e.target.checked)}
        />
        Keep this terminal if its program is lost
      </label>

      <div className="cmdbox" aria-live="polite">
        <div className="cmdbox-caption"># herdr-core will run</div>
        {previewJson === null ? (
          <div className="cmdbox-caption">{previewHint}</div>
        ) : (
          preview.line !== "" && (
            <div>
              <code className="cmdbox-line">
                <span className="cmdbox-prompt">$</span> {preview.line}
              </code>
            </div>
          )
        )}
      </div>
      {previewJson !== null && preview.error && (
        <p className="field-error" role="alert">
          {preview.error}
        </p>
      )}

      {shownFailure && (
        <div className="sheet-failure" role="alert">
          <p className="field-error">{shownFailure.message}</p>
          {shownFailure.sticky && (
            <button
              type="button"
              className="btn btn-small btn-ghost"
              onClick={() => setFailure(null)}
            >
              Dismiss
            </button>
          )}
        </div>
      )}
    </Sheet>
  );
}

/**
 * The Run choice to remember after a session was made: the agent kind, `null` for a plain
 * shell, `undefined` for a template or a custom command (the saved choice stays).
 */
function rememberedKind(run: RunChoice): string | null | undefined {
  switch (run.type) {
    case "agent":
      return run.kind;
    case "shell":
      return null;
    default:
      return undefined;
  }
}
