import { useEffect, useId, useMemo, useRef, useState } from "react";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { Sheet } from "../components/Sheet";
import {
  addAdvice,
  addProblems,
  addPseudoId,
  addRequest,
  addTarget,
  type AddAdvice,
  type AddField,
  type AddFields,
} from "../lib/addWorkbox";
import { actionErrorMessage } from "../lib/format";
import { invokeTyped, toActionError } from "../lib/ipc";
import { terminalName, useTerminals } from "../lib/uiHelpers";
import { useAppStore } from "../store/appStore";
import { openMachineAdd } from "../terminal/commandTabs";

const BLANK: AddFields = {
  host: "",
  port: "",
  via: "",
  name: "",
  session: "",
  temporary: false,
};

/**
 * The Add workbox sheet. "Add workbox" asks herdr-core to add the machine (`machine.add`) and the
 * core answers with a typed error when it can't, and each error has a next step: install hc
 * there (an explicit click, then a confirm, then `hc machine add … --install` in a visible
 * terminal tab), or open the same add in a terminal so the person can type a password, a code or
 * a host key, or fix the name in place. Once a terminal is doing the add, the sheet closes (it
 * would cover the terminal) and `AddWatcher` waits for the machine to show up.
 */
export function AddWorkbox() {
  const state = useAppStore((s) => s.state);
  const setSheet = useAppStore((s) => s.setSheet);
  const { current: terminal } = useTerminals();
  const terminalLabel = terminalName(terminal);

  const hostId = useId();
  const portId = useId();
  const nameId = useId();
  const sessionId = useId();
  const viaId = useId();
  const hostErrorId = useId();
  const portErrorId = useId();
  const nameErrorId = useId();
  const sessionErrorId = useId();
  const viaErrorId = useId();

  const [fields, setFields] = useState<AddFields>(BLANK);
  const [showVia, setShowVia] = useState(false);
  const [aliases, setAliases] = useState<string[]>([]);
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [advice, setAdvice] = useState<AddAdvice | null>(null);
  const [confirmInstall, setConfirmInstall] = useState(false);

  const req = useMemo(() => addRequest(fields), [fields]);
  const problems = addProblems(fields);
  const hasWay = req.target !== null || req.via !== null;
  const valid = hasWay && Object.keys(problems).length === 0;
  const target = fields.host.trim();

  const machines = useMemo(() => state?.machines ?? [], [state]);
  // A machine is a duplicate only when the host and the session both match; an empty session
  // field means the default one.
  const existing =
    req.target !== null
      ? machines.find(
          (m) =>
            m.target === addTarget(req) &&
            (m.session ?? "default") === (req.session ?? "default"),
        )
      : undefined;
  const canAdd = valid && !existing && !busy;
  // Keeps the port: `buildbox:2222` is what is being added.
  const shown = req.target !== null ? addTarget(req) : (req.name ?? "");

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

  // The command line comes from Rust, so it is exactly what the add runs.
  useEffect(() => {
    if (!valid) return;
    let cancelled = false;
    invokeTyped("preview_add_machine", { req })
      .then((line) => {
        if (!cancelled) setPreview(line);
      })
      .catch(() => {
        if (!cancelled) setPreview(null);
      });
    return () => {
      cancelled = true;
    };
  }, [valid, req]);

  // The call goes on in Rust if the sheet is closed meanwhile; its result still reaches the
  // store, so the machine is still welcomed when it shows up.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const close = () => setSheet(null);

  function edit(patch: Partial<AddFields>) {
    setFields((f) => ({ ...f, ...patch }));
    // What the core said was about the old values.
    setAdvice(null);
    setFailure(null);
  }

  /**
   * Hands the wait to `AddWatcher` and gets out of the terminal's way. `direct`: the core added
   * it itself, so a person still in the sheet is waiting for it (Ruling C78).
   */
  function handOver(
    tabMachineId: string | null,
    id: string | null,
    direct = false,
  ) {
    useAppStore.getState().setPendingAdd({
      id,
      target: addTarget(req),
      knownIds: machines.map((m) => m.id),
      tabMachineId,
      awaited: direct && mounted.current,
    });
    if (mounted.current) setSheet(null);
  }

  async function add() {
    if (!canAdd) return;
    setBusy(true);
    setFailure(null);
    setAdvice(null);
    try {
      const id = await invokeTyped("add_machine", { req });
      handOver(null, id, true);
    } catch (e) {
      if (!mounted.current) {
        // The sheet was closed during the call: nobody is left to show it, so the toast does.
        useAppStore.getState().reportError(e);
        return;
      }
      const next = addAdvice(toActionError(e), req.via !== null);
      if (next.kind === "other") setFailure(next.text);
      else setAdvice(next);
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  /** The same add in an in-app tab. `install` is true only after the person confirmed it. */
  async function addInTab(install: boolean) {
    setBusy(true);
    try {
      if (await openMachineAdd(req, install)) {
        handOver(addPseudoId(req), null);
      }
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  /** The same add in the person's own terminal app. */
  async function addInTheirTerminal() {
    setBusy(true);
    try {
      const args = await invokeTyped("machine_add_args", {
        req,
        install: false,
      });
      await invokeTyped("open_in_terminal", { args });
      useAppStore
        .getState()
        .showToast(
          `Finish adding ${shown} in ${terminalLabel}. It shows up here when it’s done.`,
          "info",
        );
      handOver(null, null);
    } catch (e) {
      if (mounted.current) setFailure(actionErrorMessage(toActionError(e)));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  const inlineText = (field: "name" | "host" | "via") =>
    advice?.kind === "inline" && advice.field === field ? advice.text : null;
  const problem = (field: AddField): string | null =>
    problems[field] ??
    (field === "name" || field === "host" || field === "via"
      ? inlineText(field)
      : null);
  const errorProps = (field: AddField, errorId: string) =>
    problem(field)
      ? { "aria-invalid": true as const, "aria-describedby": errorId }
      : {};
  const errorLine = (field: AddField, errorId: string) => {
    const text = problem(field);
    return text ? (
      <p id={errorId} className="field-error" role="alert">
        {text}
      </p>
    ) : null;
  };

  const viaOpen = showVia || fields.via !== "";

  return (
    <>
      <Sheet
        title="Add workbox"
        subtitle="Any machine you can already SSH into"
        onClose={close}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
            e.preventDefault();
            void add();
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
              disabled={!canAdd}
              onClick={() => void add()}
            >
              {busy ? "Adding…" : "Add workbox"}
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
            value={fields.host}
            placeholder="buildbox or dev@build.example"
            spellCheck={false}
            autoCapitalize="off"
            disabled={busy}
            {...errorProps("host", hostErrorId)}
            onChange={(e) => edit({ host: e.target.value })}
          />
          {errorLine("host", hostErrorId)}
          {aliases.length > 0 && (
            <div className="sheet-line sheet-wrap">
              <span className="muted sheet-note">From ~/.ssh/config:</span>
              {aliases.map((alias) => (
                <button
                  key={alias}
                  type="button"
                  className={`btn btn-small mono${alias === target ? " chip-on" : ""}`}
                  aria-pressed={alias === target}
                  disabled={busy}
                  onClick={() => edit({ host: alias })}
                >
                  {alias}
                </button>
              ))}
            </div>
          )}
          {existing && (
            <p className="muted sheet-note">Already added as {existing.name}</p>
          )}
        </div>

        <div className="sheet-pair">
          <div className="sheet-field">
            <label htmlFor={portId} className="sheet-label">
              Port
            </label>
            <input
              id={portId}
              className="field mono add-port"
              type="text"
              inputMode="numeric"
              value={fields.port}
              placeholder="22"
              spellCheck={false}
              disabled={busy}
              {...errorProps("port", portErrorId)}
              onChange={(e) => edit({ port: e.target.value })}
            />
            {errorLine("port", portErrorId)}
          </div>
          <div className="sheet-field">
            <label htmlFor={nameId} className="sheet-label">
              Name
            </label>
            <input
              id={nameId}
              className="field mono"
              type="text"
              value={fields.name}
              placeholder={fields.via ? "required" : "optional"}
              spellCheck={false}
              autoCapitalize="off"
              disabled={busy}
              {...errorProps("name", nameErrorId)}
              onChange={(e) => edit({ name: e.target.value })}
            />
            {errorLine("name", nameErrorId)}
          </div>
        </div>

        <div className="sheet-pair">
          <div className="sheet-field">
            <label htmlFor={sessionId} className="sheet-label">
              Remote session
            </label>
            <input
              id={sessionId}
              className="field mono"
              type="text"
              value={fields.session}
              placeholder="default"
              spellCheck={false}
              autoCapitalize="off"
              disabled={busy}
              {...errorProps("session", sessionErrorId)}
              onChange={(e) => edit({ session: e.target.value })}
            />
            {errorLine("session", sessionErrorId)}
          </div>
          <div className="sheet-field">
            <span className="sheet-label">Lifetime</span>
            <label className="check">
              <input
                type="checkbox"
                checked={fields.temporary}
                disabled={busy}
                onChange={(e) => edit({ temporary: e.target.checked })}
              />
              Temporary: short-lived, shown apart
            </label>
          </div>
        </div>

        <div className="sheet-field">
          <button
            type="button"
            className="btn btn-small btn-ghost"
            aria-expanded={viaOpen}
            disabled={busy}
            onClick={() => setShowVia((v) => !v)}
          >
            Custom connection
          </button>
          {viaOpen && (
            <>
              <label htmlFor={viaId} className="sheet-label">
                Connection command
              </label>
              <input
                id={viaId}
                className="field mono"
                type="text"
                value={fields.via}
                placeholder="fly ssh console -a app --pty=false -C"
                spellCheck={false}
                autoCapitalize="off"
                disabled={busy}
                {...errorProps("via", viaErrorId)}
                onChange={(e) => edit({ via: e.target.value })}
              />
              {errorLine("via", viaErrorId)}
              <p className="muted sheet-note">
                Used instead of an SSH host. It gets a shell line to run there
                as its last argument, like ssh, passes bytes both ways and asks
                nothing. It needs a name.
              </p>
            </>
          )}
        </div>

        <div className="cmdbox" aria-live="polite">
          <div className="cmdbox-caption"># herdr-core will run</div>
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

        {busy && (
          <p className="muted sheet-note" aria-live="polite">
            Reaching {shown}. This can take up to a minute.
          </p>
        )}

        {failure && (
          <p className="field-error" role="alert">
            {failure}
          </p>
        )}

        {advice?.kind === "install" && (
          <div className="add-advice" role="alert">
            <p className="add-advice-lead">
              {`hc isn’t installed on ${shown}, or it’s too old.`}
            </p>
            <p className="add-advice-why">{advice.why}</p>
            <div className="add-advice-actions">
              <button
                type="button"
                className="btn"
                disabled={busy}
                onClick={() => setConfirmInstall(true)}
              >
                Install hc there…
              </button>
            </div>
          </div>
        )}

        {advice?.kind === "terminal" && (
          <div className="add-advice" role="alert">
            <p className="add-advice-lead">
              {advice.code === "needs_login"
                ? `${shown} needs a login that you type.`
                : `Couldn’t reach ${shown}.`}
            </p>
            <p className="add-advice-why">{advice.why}</p>
            {advice.hint && <p className="add-advice-why">{advice.hint}</p>}
            <div className="add-advice-actions">
              <button
                type="button"
                className="btn"
                disabled={busy}
                onClick={() => void addInTab(false)}
              >
                Open in terminal
              </button>
              {terminal !== null && (
                <button
                  type="button"
                  className="btn btn-ghost"
                  disabled={busy}
                  onClick={() => void addInTheirTerminal()}
                >
                  Open in {terminalLabel}
                </button>
              )}
            </div>
          </div>
        )}
      </Sheet>
      {confirmInstall && (
        <ConfirmDialog
          title={`Install hc on ${shown}?`}
          body={`Copies this hc to ${shown} so it can run there. A terminal tab shows every step and any question. Nothing is installed unless you say so.`}
          confirmLabel="Install hc there"
          danger={false}
          onConfirm={() => {
            setConfirmInstall(false);
            void addInTab(true);
          }}
          onCancel={() => setConfirmInstall(false)}
        />
      )}
    </>
  );
}
