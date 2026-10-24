import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../store/appStore";

vi.mock("../lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/ipc")>()),
  copyText: vi.fn(),
}));
import { copyText } from "../lib/ipc";
import { oscClipboardProvider } from "./oscClipboard";

const copy = vi.mocked(copyText);
// The addon's `ClipboardSelectionType` is an ambient const enum; its values are these strings.
const SYSTEM = "c" as never;
const PRIMARY = "p" as never;

beforeEach(() => {
  copy.mockReset().mockResolvedValue(undefined);
  useAppStore.setState({ toast: null });
});

describe("oscClipboardProvider", () => {
  it("writes_the_clipboard_selection_through_copyText_and_toasts_Copied", async () => {
    await oscClipboardProvider.writeText(SYSTEM, "from herdr");
    expect(copy).toHaveBeenCalledWith("from herdr");
    expect(useAppStore.getState().toast).toBe("Copied");
    expect(useAppStore.getState().toastTone).toBe("info");
  });

  it("a_refused_write_shows_the_error_toast_and_not_Copied", async () => {
    copy.mockRejectedValue(new Error("denied"));
    await oscClipboardProvider.writeText(SYSTEM, "x");
    expect(useAppStore.getState().toast).toBe(
      "Couldn’t copy to the clipboard.",
    );
    expect(useAppStore.getState().toastTone).toBe("error");
  });

  it("ignores_the_primary_selection", async () => {
    await oscClipboardProvider.writeText(PRIMARY, "x");
    expect(copy).not.toHaveBeenCalled();
    expect(useAppStore.getState().toast).toBeNull();
  });

  it("never_lets_a_program_read_the_clipboard", async () => {
    await expect(oscClipboardProvider.readText(SYSTEM)).resolves.toBe("");
    await expect(oscClipboardProvider.readText(PRIMARY)).resolves.toBe("");
    expect(copy).not.toHaveBeenCalled();
  });
});
