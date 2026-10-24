import { formatShortcut, type ShortcutId } from "../lib/shortcuts";

type Props =
  | { id: ShortcutId; enter?: "↩" | "↵"; className?: string }
  | { keys: string; className?: string };

/**
 * The one way a shortcut is drawn: a chip with its label. Pass an `id` from the shortcut table,
 * or `keys` for a key that is not an app shortcut (↑ ↓, esc, ⌫).
 */
export function Kbd(props: Props) {
  const text =
    "id" in props
      ? formatShortcut(props.id, { enter: props.enter })
      : props.keys;
  // An id with no key on this platform draws nothing.
  if (text === "") return null;
  return (
    <kbd className={props.className ? `kbd ${props.className}` : "kbd"}>
      {text}
    </kbd>
  );
}
