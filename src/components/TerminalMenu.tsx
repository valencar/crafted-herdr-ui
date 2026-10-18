import { useEffect, useRef, useState } from "react";
import type { TerminalId } from "../lib/bindings/TerminalId";
import { TERMINAL_LABEL } from "../lib/format";
import { invokeTyped } from "../lib/ipc";
import { isKeyForMenu, openSettings } from "../lib/uiHelpers";
import { useAppStore } from "../store/appStore";

type Props = {
  /** `null` until `get_terminals` answers. */
  terminal: TerminalId | null;
  installed: TerminalId[];
};

/**
 * "Opens in <Terminal> ▾": the installed terminals and Custom…. Choosing one saves it as the
 * `terminal` setting, so the next open uses it.
 */
export function TerminalMenu({ terminal, installed }: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const template = useAppStore((s) => s.settings?.terminal_custom_template);
  const setSettings = useAppStore((s) => s.setSettings);
  const report = useAppStore((s) => s.reportError);

  useEffect(() => {
    if (!open) return;
    const items = () => [
      ...(rootRef.current?.querySelectorAll<HTMLElement>(
        '[role="menuitemradio"]',
      ) ?? []),
    ];
    (
      items().find((i) => i.getAttribute("aria-checked") === "true") ??
      items()[0]
    )?.focus();
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      // Not this menu's key: something else already handled it, or it was typed in another
      // control (the palette's input).
      if (!isKeyForMenu(rootRef.current, e)) return;
      if (e.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
      } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const all = items();
        const at = all.indexOf(document.activeElement as HTMLElement);
        const step = e.key === "ArrowDown" ? 1 : -1;
        all[(at + step + all.length) % all.length]?.focus();
      }
    };
    // Focus moving to another control (the palette opening) leaves the menu behind: close it.
    const onFocusIn = (e: FocusEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    document.addEventListener("focusin", onFocusIn);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("focusin", onFocusIn);
    };
  }, [open]);

  const choose = (id: TerminalId) => {
    setOpen(false);
    buttonRef.current?.focus();
    invokeTyped("set_settings", { patch: { terminal: id } })
      .then((saved) => {
        setSettings(saved);
        // A custom terminal does nothing without its launch command.
        if (id === "custom" && !(template ?? "").trim()) openSettings();
      })
      .catch(report);
  };

  const choices: TerminalId[] = [...installed, "custom"];
  return (
    <div className="menu-wrap" data-menu-root ref={rootRef}>
      <button
        ref={buttonRef}
        type="button"
        className="btn picker"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        Opens in {terminal ? TERMINAL_LABEL[terminal] : "your terminal"}
        <span aria-hidden="true">▾</span>
      </button>
      {open && (
        <div className="menu" role="menu" aria-label="Terminal">
          {choices.map((id) => (
            <button
              key={id}
              type="button"
              role="menuitemradio"
              aria-checked={id === terminal}
              className="menu-item"
              onClick={() => choose(id)}
            >
              <span className="menu-check" aria-hidden="true">
                {id === terminal ? "✓" : ""}
              </span>
              {id === "custom" ? "Custom…" : TERMINAL_LABEL[id]}
            </button>
          ))}
          <button
            type="button"
            role="menuitem"
            className="menu-item menu-foot"
            onClick={() => {
              setOpen(false);
              openSettings();
            }}
          >
            <span className="menu-check" aria-hidden="true" />
            Terminal settings…
          </button>
        </div>
      )}
    </div>
  );
}
