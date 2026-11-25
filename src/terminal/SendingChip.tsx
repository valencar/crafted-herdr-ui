import type { PutProgress } from "../lib/bindings/PutProgress";

/** "Sending b.txt… · 2 of 3": which file is on its way, and where it is in a batch. */
export function SendingChip({ sending }: { sending: PutProgress | null }) {
  if (!sending) return null;
  const count =
    sending.total > 1 ? ` · ${sending.index + 1} of ${sending.total}` : "";
  return (
    <div className="sending-chip" role="status">
      {`Sending ${sending.name}…${count}`}
    </div>
  );
}
