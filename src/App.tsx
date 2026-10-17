import { useEffect } from "react";
import { getState, onState } from "./lib/ipc";
import { Home } from "./screens/Home";
import { Workbox } from "./screens/Workbox";
import { useAppStore } from "./store/appStore";

function App() {
  const setState = useAppStore((s) => s.setState);
  const reportError = useAppStore((s) => s.reportError);
  const view = useAppStore((s) => s.view);

  useEffect(() => {
    let alive = true;
    let unlisten: (() => void) | undefined;
    // `getState` covers a window that opens after the first push; a late answer must not
    // overwrite a newer pushed state.
    let pushed = false;
    getState()
      .then((s) => {
        if (alive && !pushed) setState(s);
      })
      .catch(() => {});
    onState((s) => {
      pushed = true;
      setState(s);
    })
      .then((un) => {
        if (alive) unlisten = un;
        else un();
      })
      .catch((e) => {
        // Without the event the screen would silently go stale.
        if (alive) reportError(e);
      });
    return () => {
      alive = false;
      unlisten?.();
    };
  }, [setState, reportError]);

  return view.kind === "workbox" ? (
    <Workbox key={view.machineId} machineId={view.machineId} />
  ) : (
    <Home />
  );
}

export default App;
