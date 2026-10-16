import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { AppState } from "./bindings/AppState";
import type { HerdrError } from "./bindings/HerdrError";

/** Every Tauri command the UI may call, mapped to its result. Task 7 adds the actions. */
export type CommandResults = {
  get_state: AppState;
};
export type CommandName = keyof CommandResults;

const ERROR_KINDS: ReadonlySet<string> = new Set([
  "notFound",
  "spawn",
  "timeout",
  "server",
  "usage",
  "parse",
]);

/**
 * Rust errors arrive as the serialized `HerdrError`. Anything else (a string, an `Error`,
 * an unknown shape) is wrapped so callers only ever handle a `HerdrError`.
 */
export function toHerdrError(e: unknown): HerdrError {
  if (
    typeof e === "object" &&
    e !== null &&
    typeof (e as { kind?: unknown }).kind === "string" &&
    ERROR_KINDS.has((e as { kind: string }).kind)
  ) {
    return e as HerdrError;
  }
  if (e instanceof Error) return { kind: "spawn", message: e.message };
  return {
    kind: "spawn",
    message: typeof e === "string" ? e : (JSON.stringify(e) ?? String(e)),
  };
}

export async function invokeTyped<K extends CommandName>(
  name: K,
  args?: Record<string, unknown>,
): Promise<CommandResults[K]> {
  try {
    return await invoke<CommandResults[K]>(name, args);
  } catch (e) {
    throw toHerdrError(e);
  }
}

/** The current state, for a UI that started after the first `"state"` event. */
export function getState(): Promise<AppState> {
  return invokeTyped("get_state");
}

/** Subscribes to the `"state"` event. Resolves to the unlisten function. */
export function onState(cb: (state: AppState) => void): Promise<() => void> {
  return listen<AppState>("state", (event) => cb(event.payload));
}
