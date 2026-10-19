import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../store/appStore";
import { CommandBox } from "./CommandBox";

vi.mock("../lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/ipc")>()),
  copyText: vi.fn(),
}));
import { copyText } from "../lib/ipc";

const copy = vi.mocked(copyText);
const COMMAND = "herdr machine reconnect gpubox";

beforeEach(() => {
  copy.mockReset().mockResolvedValue(undefined);
  useAppStore.setState({ toast: null });
});

describe("CopyButton", () => {
  it("copy_button_copies_and_says_copied", async () => {
    const user = userEvent.setup();
    render(<CommandBox command={COMMAND} copyable />);
    await user.click(
      screen.getByRole("button", { name: `Copy command: ${COMMAND}` }),
    );
    expect(copy).toHaveBeenCalledWith(COMMAND);
    expect(await screen.findByRole("button", { name: "Copied" })).toBeVisible();
    expect(useAppStore.getState().toast).toBeNull();
  });

  it("a_refused_copy_shows_the_error_toast", async () => {
    copy.mockRejectedValue(new Error("NotAllowedError"));
    const user = userEvent.setup();
    render(<CommandBox command={COMMAND} copyable />);
    await user.click(
      screen.getByRole("button", { name: `Copy command: ${COMMAND}` }),
    );
    await waitFor(() =>
      expect(useAppStore.getState().toast).toBe(
        "Couldn’t copy to the clipboard.",
      ),
    );
    expect(useAppStore.getState().toastTone).toBe("error");
    expect(screen.queryByRole("button", { name: "Copied" })).toBeNull();
  });
});
