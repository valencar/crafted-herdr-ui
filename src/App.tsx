import { useEffect } from "react";
import { getState, onState } from "./lib/ipc";
import { Home } from "./screens/Home";
import { useAppStore } from "./store/appStore";

function App() {
  const setState = useAppStore((s) => s.setState);

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
      .catch(() => {});
    return () => {
      alive = false;
      unlisten?.();
    };
  }, [setState]);

  return <Home />;
}

export default App;
