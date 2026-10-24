import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../store/appStore";

vi.mock("../lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/ipc")>()),
  copyText: vi.fn(),
}));
import { copyText } from "../lib/ipc";
import { registerOscClipboard } from "./oscClipboard";

const copy = vi.mocked(copyText);

type Handler = (data: string) => boolean | Promise<boolean>;
let handlers: Map<number, Handler>;
let disposed: boolean;
/** A terminal that only has the parser; any other use of it would throw. */
const fakeTerm = {
  parser: {
    registerOscHandler(ident: number, fn: Handler) {
      handlers.set(ident, fn);
      return {
        dispose: () => {
          disposed = true;
        },
      };
    },
  },
};
const send = (data: string) => handlers.get(52)!(data);
const b64 = (text: string) =>
  btoa(String.fromCharCode(...new TextEncoder().encode(text)));

beforeEach(() => {
  handlers = new Map();
  disposed = false;
  copy.mockReset().mockResolvedValue(undefined);
  useAppStore.setState({ toast: null, toastTone: "error" });
  registerOscClipboard(fakeTerm);
});

describe("registerOscClipboard", () => {
  it("registers_one_handler_for_OSC_52_and_returns_its_disposable", () => {
    expect([...handlers.keys()]).toEqual([52]);
    const disposable = registerOscClipboard(fakeTerm);
    disposable.dispose();
    expect(disposed).toBe(true);
  });

  it("a_write_copies_the_decoded_text_and_toasts_Copied", async () => {
    await expect(send(`c;${b64("from herdr")}`)).resolves.toBe(true);
    expect(copy).toHaveBeenCalledWith("from herdr");
    expect(useAppStore.getState().toast).toBe("Copied");
    expect(useAppStore.getState().toastTone).toBe("info");
  });

  it("decodes_the_payload_as_UTF_8", async () => {
    await send(`c;${b64("naïve → ❯ 日本")}`);
    expect(copy).toHaveBeenCalledWith("naïve → ❯ 日本");
  });

  it.each(["c", "s", "p", "", "cs", "pc", "sc", "cps"])(
    "accepts_the_targets_%j",
    async (targets) => {
      await expect(send(`${targets};${b64("x")}`)).resolves.toBe(true);
      expect(copy).toHaveBeenCalledWith("x");
    },
  );

  it.each(["0", "c0", "x", "cut", "C"])(
    "swallows_a_write_to_the_unknown_target_%j_without_copying",
    async (targets) => {
      expect(send(`${targets};${b64("x")}`)).toBe(true);
      expect(copy).not.toHaveBeenCalled();
      expect(useAppStore.getState().toast).toBeNull();
    },
  );

  it("a_write_from_a_tab_that_is_not_the_visible_one_is_swallowed", async () => {
    let visible = false;
    handlers.clear();
    registerOscClipboard(fakeTerm, () => visible);
    expect(send(`c;${b64("x")}`)).toBe(true);
    expect(copy).not.toHaveBeenCalled();
    expect(useAppStore.getState().toast).toBeNull();
    visible = true;
    await send(`c;${b64("x")}`);
    expect(copy).toHaveBeenCalledWith("x");
  });

  it("a_failed_copy_shows_the_error_toast_and_not_Copied", async () => {
    copy.mockRejectedValue(new Error("denied"));
    await expect(send(`c;${b64("x")}`)).resolves.toBe(true);
    expect(useAppStore.getState().toast).toBe(
      "Couldn’t copy to the clipboard.",
    );
    expect(useAppStore.getState().toastTone).toBe("error");
  });

  it.each(["c;?", ";?", "s;?", "cps;?", "p;?"])(
    "a_read_query_%j_is_swallowed_and_neither_copies_nor_toasts",
    async (data) => {
      expect(send(data)).toBe(true);
      expect(copy).not.toHaveBeenCalled();
      expect(useAppStore.getState().toast).toBeNull();
    },
  );

  it.each([
    ["c;", "an empty payload"],
    ["c;!!!", "invalid base64"],
    ["c;" + b64("x") + "!", "base64 with a stray character"],
    ["c;/w==", "bytes that are not UTF-8"],
    ["c", "no separator"],
    ["", "nothing at all"],
    ["c;" + b64("x") + ";y", "an extra field"],
  ])("swallows_%j_(%s)_without_copying_or_toasting", async (data) => {
    expect(send(data)).toBe(true);
    expect(copy).not.toHaveBeenCalled();
    expect(useAppStore.getState().toast).toBeNull();
  });

  it("an_ignored_sequence_answers_true_at_once_and_only_a_copy_returns_a_promise", async () => {
    // The parser can finish an ignored sequence without a microtask round trip.
    expect(send("c;?")).toBe(true);
    expect(send(`c;${b64("")}`)).toBe(true);
    const copying = send(`c;${b64("x")}`);
    expect(copying).toBeInstanceOf(Promise);
    await expect(copying).resolves.toBe(true);
  });
});
