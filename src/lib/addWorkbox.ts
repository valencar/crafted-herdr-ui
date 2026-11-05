import type { ActionError } from "./bindings/ActionError";
import type { AddMachineRequest } from "./bindings/AddMachineRequest";
import { actionErrorMessage, terminalNameProblem } from "./format";

/** The Add workbox sheet's fields, as typed. */
export type AddFields = {
  host: string;
  port: string;
  via: string;
  name: string;
  session: string;
  temporary: boolean;
};

export type AddField = "host" | "port" | "via" | "name" | "session";

const orNull = (text: string): string | null => {
  const t = text.trim();
  return t === "" ? null : t;
};

/** The port as a number, or `null` when blank or not a number (`addProblems` says why). */
function portOf(text: string): number | null {
  const t = text.trim();
  return /^\d{1,5}$/.test(t) ? Number(t) : null;
}

/** What the sheet sends: trimmed, with an empty field left out. */
export function addRequest(f: AddFields): AddMachineRequest {
  return {
    target: orNull(f.host),
    port: portOf(f.port),
    via: orNull(f.via),
    name: orNull(f.name),
    session: orNull(f.session),
    temporary: f.temporary,
  };
}

// The same rules as Rust `check_add`, which still answers after submit.
const HOST = /^[A-Za-z0-9._@:-]+$/;
const SESSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const HOST_HELP =
  "The SSH host may only use letters, digits and . _ @ : -, and can’t start with “-”.";
const SESSION_HELP =
  "The remote session may only use letters, digits and . _ - (up to 64), starting with a letter or digit.";
const VIA_HELP =
  "The custom connection can’t start with “-”, or hold a backslash or a control character.";

/** A control character (NUL, a newline, a tab, DEL, the C1 range) or a backslash. */
function hasUnsafeChar(text: string): boolean {
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0;
    if (c < 0x20 || (c >= 0x7f && c <= 0x9f) || ch === "\\") return true;
  }
  return false;
}

/**
 * Why a field is refused as typed, by field. Nothing for an empty field: the Add button waits
 * for a host instead of scolding. Mirrors Rust `check_add`.
 */
export function addProblems(f: AddFields): Partial<Record<AddField, string>> {
  const out: Partial<Record<AddField, string>> = {};
  const host = f.host.trim();
  const via = f.via.trim();
  const name = f.name.trim();
  const session = f.session.trim();
  const port = f.port.trim();
  if (host && via) {
    out.via = "Use an SSH host or a custom connection, not both.";
  } else if (via) {
    if (via.startsWith("-") || hasUnsafeChar(via)) out.via = VIA_HELP;
    if (!name) out.name = "A custom connection needs a name.";
  }
  if (host && (host.startsWith("-") || !HOST.test(host))) out.host = HOST_HELP;
  if (port) {
    const n = portOf(port);
    if (n === null || n < 1 || n > 65535) {
      out.port = "The port must be between 1 and 65535.";
    } else if (via) {
      out.port = "A port goes with an SSH host, not a custom connection.";
    } else if (host.includes(":")) {
      out.port = "The host already names a port.";
    }
  }
  if (name) {
    const problem = terminalNameProblem(name);
    if (problem) out.name = problem;
  }
  if (session && !SESSION.test(session)) out.session = SESSION_HELP;
  return out;
}

/** The host the request is after, `host:port`: how the core's machine list shows the target. */
export function addTarget(req: AddMachineRequest): string {
  if (req.via) return req.via;
  const host = req.target ?? "";
  return req.port ? `${host}:${req.port}` : host;
}

/** What the machine is called until the core names it: the name, else the host. */
export function addLabel(req: AddMachineRequest): string {
  return req.name ?? req.target ?? "";
}

/**
 * The machine id a command tab of this request goes under. The machine is not added yet, so it
 * has no id: `add:` and every argument that makes the command what it is (the way in, the name,
 * the session, temporary). A retry with any of them changed is a different command, so it gets a
 * tab of its own instead of showing the still-running old one. (`--install` is told apart by
 * `commandTabKey`.) It never equals a machine id (`local`, or 32 hex digits).
 */
export function addPseudoId(req: AddMachineRequest): string {
  const parts = [req.via ? `--via ${req.via}` : addTarget(req)];
  if (req.name) parts.push(`--name ${req.name}`);
  if (req.session) parts.push(`--session ${req.session}`);
  if (req.temporary) parts.push("--temp");
  return `add:${parts.join(" ")}`;
}

/** What the sheet does about a refused add. */
export type AddAdvice =
  /** hc is missing or too old there: offer Install hc there…. */
  | { kind: "install"; why: string }
  /** ssh wants a person (a login, a host key) or cannot reach it: offer a terminal. */
  | {
      kind: "terminal";
      code: "needs_login" | "unreachable";
      why: string;
      /** The core's own next step, for `unreachable` only; `null` otherwise. */
      hint: string | null;
    }
  /** The name or the machine is already taken: say so by the field the person used. */
  | { kind: "inline"; field: "name" | "host" | "via"; text: string }
  | { kind: "other"; text: string };

/** The core's words as a sentence: first letter up, a full stop at the end. */
function sentence(text: string): string {
  const t = text.trim();
  if (t === "") return t;
  const up = t.charAt(0).toUpperCase() + t.slice(1);
  return /[.!?]$/.test(up) ? up : `${up}.`;
}

/**
 * The next step for a failed `add_machine`, by the core's typed error (spec 7.5). `viaAdd` is
 * whether the add used a custom connection, so a message about the machine is shown by that field.
 */
export function addAdvice(e: ActionError, viaAdd = false): AddAdvice {
  if (e.kind === "core" && e.error.kind === "rpc") {
    const { code, message, hint } = e.error;
    switch (code) {
      case "hc_missing":
      case "incompatible":
        return { kind: "install", why: message };
      case "needs_login":
        return { kind: "terminal", code, why: message, hint: null };
      case "unreachable":
        return { kind: "terminal", code, why: message, hint };
      case "name_taken":
        return {
          kind: "inline",
          field: "name",
          text: `${sentence(message)} Pick another name.`,
        };
      case "already_added":
        return {
          kind: "inline",
          field: viaAdd ? "via" : "host",
          text: sentence(message),
        };
    }
  }
  return { kind: "other", text: actionErrorMessage(e) };
}
