import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useEffect, useState } from "react";
import { actionErrorMessage } from "../lib/format";
import { copyText, invokeTyped, toActionError } from "../lib/ipc";
import {
  CORE_INSTALL_LINE,
  CORE_UPDATE_COMMAND,
  openInstallPage,
} from "../lib/uiHelpers";
import { useAppStore } from "../store/appStore";

/** The command a person copies: shown in monospace beside a Copy button. The app never runs it. */
function CopyLine({
  text,
  onCopy,
}: {
  text: string;
  onCopy: (text: string) => void;
}) {
  return (
    <div className="onboarding-line">
      <code className="mono onboarding-command">{text}</code>
      <button type="button" className="btn" onClick={() => onCopy(text)}>
        Copy
      </button>
    </div>
  );
}

/**
 * Shown while herdr-core can't be used: none was found (with a note when only the older herdr
 * 0.9 is installed), or the one found is too old or too new for this app (spec 9.2). Choosing a
 * binary saves it as the core path; the app then finds it and swaps this screen for Home on its
 * own. The app never installs or updates anything: the install line and `hc update` are copied,
 * never run, and the install page opens in the default browser.
 */
export function Onboarding() {
  const core = useAppStore((s) => s.state?.core_state);
  const showToast = useAppStore((s) => s.showToast);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [legacy, setLegacy] = useState<string | null>(null);

  // The older herdr, if one is installed, is only known to `core_status`.
  const incompatible = core?.kind === "incompatible" ? core : null;
  useEffect(() => {
    if (incompatible) return;
    let alive = true;
    invokeTyped("core_status")
      .then((status) => alive && setLegacy(status.legacy_herdr ?? null))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [incompatible]);

  const copy = (text: string) => {
    setError(null);
    copyText(text).then(
      () => showToast("Copied", "info"),
      () => setError("Couldn’t copy to the clipboard."),
    );
  };

  const choose = async () => {
    setError(null);
    let picked: Awaited<ReturnType<typeof openDialog>>;
    try {
      picked = await openDialog({ multiple: false, directory: false });
    } catch (e) {
      setError(actionErrorMessage(toActionError(e)));
      return;
    }
    if (typeof picked !== "string" || !picked) return;
    setBusy(true);
    try {
      await invokeTyped("set_settings", { patch: { core_path: picked } });
    } catch (e) {
      setError(actionErrorMessage(toActionError(e)));
    } finally {
      setBusy(false);
    }
  };

  const openInstall = () => {
    setError(null);
    openInstallPage().catch((e) =>
      setError(actionErrorMessage(toActionError(e))),
    );
  };

  return (
    <div className="app">
      <header className="header" data-tauri-drag-region>
        <div className="brand" data-tauri-drag-region>
          <span className="brand-name" data-tauri-drag-region>
            Crafted Herdr
          </span>
        </div>
      </header>
      <main className="onboarding">
        <div className="onboarding-card">
          {incompatible ? (
            <>
              <h1 className="section-title">
                {incompatible.newer
                  ? "This herdr-core is newer than this Crafted Herdr understands."
                  : "This herdr-core is too old for Crafted Herdr."}
              </h1>
              {incompatible.newer ? (
                <p>Update Crafted Herdr.</p>
              ) : (
                <>
                  <p>Update it with this command, then come back:</p>
                  <CopyLine text={CORE_UPDATE_COMMAND} onCopy={copy} />
                </>
              )}
              {incompatible.reason && (
                <p className="muted onboarding-note">{incompatible.reason}</p>
              )}
            </>
          ) : (
            <>
              <h1 className="section-title">
                Crafted Herdr needs herdr-core (<code>hc</code>).
              </h1>
              {legacy && (
                <p>
                  {`You have herdr ${legacy}, the older CLI. This version of Crafted Herdr works with the new herdr-core.`}
                </p>
              )}
              <p>Install it with this line, then come back:</p>
              <CopyLine text={CORE_INSTALL_LINE} onCopy={copy} />
            </>
          )}
          <div className="onboarding-actions">
            <button type="button" className="btn" onClick={openInstall}>
              Open herdr.dev ↗
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy}
              onClick={() => void choose()}
            >
              Choose binary…
            </button>
          </div>
          {error && (
            <p className="field-error" role="alert">
              {error}
            </p>
          )}
          <p className="muted onboarding-note">
            The app looks in your shell’s PATH, <code>~/.local/bin</code>,{" "}
            <code>/opt/homebrew/bin</code> and <code>/usr/local/bin</code>. It
            never installs or updates anything for you.
          </p>
        </div>
      </main>
    </div>
  );
}
