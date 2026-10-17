import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Onboarding } from "./Onboarding";

vi.mock("../lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/ipc")>()),
  invokeTyped: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { invokeTyped } from "../lib/ipc";

const invoke = vi.mocked(invokeTyped) as unknown as ReturnType<typeof vi.fn>;
const chooseFile = vi.mocked(openDialog);
const openInBrowser = vi.mocked(openUrl);

beforeEach(() => {
  invoke.mockReset().mockResolvedValue({});
  chooseFile.mockReset();
  openInBrowser.mockReset().mockResolvedValue(undefined);
});

describe("Onboarding", () => {
  it("explains_that_herdr_is_missing_and_offers_both_ways_out", () => {
    render(<Onboarding />);
    expect(
      screen.getByRole("heading", { name: "herdr wasn’t found" }),
    ).toBeInTheDocument();
    // The link is text plus a button, not an anchor the webview would navigate to.
    expect(screen.getByText("https://herdr.dev")).toBeInTheDocument();
    expect(screen.queryByRole("link")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Open herdr.dev ↗" }),
    ).toBeEnabled();
    expect(
      screen.getByRole("button", { name: "Choose binary…" }),
    ).toBeEnabled();
  });

  it("opens_the_install_page_in_the_default_browser", async () => {
    const user = userEvent.setup();
    render(<Onboarding />);
    await user.click(screen.getByRole("button", { name: "Open herdr.dev ↗" }));
    expect(openInBrowser).toHaveBeenCalledTimes(1);
    expect(openInBrowser).toHaveBeenCalledWith("https://herdr.dev");
    // Nothing else is called: no network from the app, no herdr command.
    expect(invoke).not.toHaveBeenCalled();
  });

  it("shows_a_failed_browser_open_inline", async () => {
    openInBrowser.mockRejectedValue(new Error("no default browser"));
    const user = userEvent.setup();
    render(<Onboarding />);
    await user.click(screen.getByRole("button", { name: "Open herdr.dev ↗" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "no default browser",
    );
  });

  it("saves_the_chosen_binary_as_the_herdr_path", async () => {
    chooseFile.mockResolvedValue("/opt/herdr/bin/herdr");
    const user = userEvent.setup();
    render(<Onboarding />);
    await user.click(screen.getByRole("button", { name: "Choose binary…" }));
    expect(chooseFile).toHaveBeenCalledWith({
      multiple: false,
      directory: false,
    });
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("set_settings", {
        patch: { herdr_path: "/opt/herdr/bin/herdr" },
      }),
    );
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("does_nothing_when_the_file_dialog_is_cancelled", async () => {
    chooseFile.mockResolvedValue(null);
    const user = userEvent.setup();
    render(<Onboarding />);
    await user.click(screen.getByRole("button", { name: "Choose binary…" }));
    expect(invoke).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows_a_refused_path_inline_and_clears_it_on_the_next_try", async () => {
    chooseFile.mockResolvedValueOnce("/tmp/not-herdr");
    invoke.mockRejectedValueOnce({
      kind: "invalid",
      message: "That file is not a herdr binary.",
    });
    const user = userEvent.setup();
    render(<Onboarding />);
    await user.click(screen.getByRole("button", { name: "Choose binary…" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "That file is not a herdr binary.",
    );
    expect(
      screen.getByRole("button", { name: "Choose binary…" }),
    ).toBeEnabled();

    chooseFile.mockResolvedValueOnce(null);
    await user.click(screen.getByRole("button", { name: "Choose binary…" }));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows_a_failed_file_dialog_inline", async () => {
    chooseFile.mockRejectedValue(new Error("dialog unavailable"));
    const user = userEvent.setup();
    render(<Onboarding />);
    await user.click(screen.getByRole("button", { name: "Choose binary…" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "dialog unavailable",
    );
  });
});
