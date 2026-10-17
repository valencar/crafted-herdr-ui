import { useEffect, useState } from "react";
import { invokeTyped } from "../lib/ipc";
import { CommandBox } from "./CommandBox";

/**
 * The command that fixes a machine that needs attention, with a Copy button. The text comes
 * from Rust and names the profile id, which is what the Reconnect button runs. Nothing is
 * shown until Rust answers (or at all, for an id it won't put in a command).
 */
export function ReconnectBox({ machineId }: { machineId: string }) {
  const [command, setCommand] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    invokeTyped("preview_reconnect", { id: machineId })
      .then((c) => alive && setCommand(typeof c === "string" ? c : null))
      .catch(() => alive && setCommand(null));
    return () => {
      alive = false;
    };
  }, [machineId]);
  if (!command) return null;
  return (
    <CommandBox
      command={command}
      caption="to reconnect, run this in a terminal"
      copyable
    />
  );
}
