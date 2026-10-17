import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useState } from "react";
import { actionErrorMessage } from "../lib/format";
import { invokeTyped, toActionError } from "../lib/ipc";
import { INSTALL_URL, openInstallPage } from "../lib/uiHelpers";

/**
 * Shown while herdr can't be found. Choosing a binary saves it as the herdr path; the app then
 * finds it, starts polling and swaps this screen for Home on its own. The app never installs
 * herdr and never fetches anything: the install page opens in the default browser.
 */
export function Onboarding() {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
      await invokeTyped("set_settings", { patch: { herdr_path: picked } });
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
          <h1 className="section-title">herdr wasn’t found</h1>
          <p>
            Crafted Herdr shows the agents running in herdr, on this computer
            and on any machine you can reach over SSH. It drives the{" "}
            <code>herdr</code> command you already have, so that has to be
            installed first.
          </p>
          <ol className="onboarding-steps">
            <li>
              Install herdr from{" "}
              <span className="mono onboarding-url">{INSTALL_URL}</span>.
            </li>
            <li>
              Then choose the <code>herdr</code> binary below. The app finds it
              and starts at once.
            </li>
          </ol>
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
            never installs anything for you.
          </p>
        </div>
      </main>
    </div>
  );
}
