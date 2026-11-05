import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CoreState } from "../lib/bindings/CoreState";
import type { CoreStatus } from "../lib/bindings/CoreStatus";
import { useAppStore } from "../store/appStore";
import { appState } from "../test/builders";
import { Onboarding } from "./Onboarding";

vi.mock("../lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/ipc")>()),
  invokeTyped: vi.fn(),
  copyText: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { copyText, invokeTyped } from "../lib/ipc";

const invoke = vi.mocked(invokeTyped) as unknown as ReturnType<typeof vi.fn>;
const copy = vi.mocked(copyText);
const chooseFile = vi.mocked(openDialog);
const openInBrowser = vi.mocked(openUrl);

const INSTALL_LINE =
  "curl -fsSL https://releases.herdr.dev/core/install.sh | sh";

const COPY_INSTALL = "Copy install line";
const COPY_UPDATE = "Copy update command";

const NO_CORE: CoreStatus = {
  path: null,
  version: null,
  saved_missing: false,
  legacy_herdr: null,
};

/** The commands the screen asked for, apart from reading the core's status. */
const asked = () =>
  invoke.mock.calls.filter(([name]) => name !== "core_status");

/** The store as it is when the core is missing or incompatible, and what `core_status` says. */
function inState(core: CoreState, status: CoreStatus = NO_CORE) {
  useAppStore.setState({
    state: { ...appState([], { path: null, version: null }), core_state: core },
  });
  invoke.mockImplementation(async (name: string) =>
    name === "core_status" ? status : {},
  );
}

beforeEach(() => {
  invoke.mockReset().mockResolvedValue({});
  copy.mockReset().mockResolvedValue(undefined);
  chooseFile.mockReset();
  openInBrowser.mockReset().mockResolvedValue(undefined);
  useAppStore.setState({ state: null, toast: null });
});

describe("Onboarding", () => {
  it("onboarding_without_core", async () => {
    inState({ kind: "notFound" });
    render(<Onboarding />);
    expect(
      screen.getByRole("heading", {
        name: "Crafted Herdr needs herdr-core (hc).",
      }),
    ).toBeInTheDocument();
    expect(screen.getByText(INSTALL_LINE)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: COPY_INSTALL })).toBeEnabled();
    // The link is text plus a button, not an anchor the webview would navigate to.
    expect(screen.queryByRole("link")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Open herdr.dev ↗" }),
    ).toBeEnabled();
    expect(
      screen.getByRole("button", { name: "Choose binary…" }),
    ).toBeEnabled();
    // No Homebrew formula exists for herdr-core, so none is mentioned.
    expect(screen.queryByText(/brew install|formula/i)).toBeNull();
    // Without an older herdr the lead line is absent.
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("core_status"));
    expect(screen.queryByText(/You have herdr/)).toBeNull();
  });

  it("is_the_same_before_the_first_state_arrives", () => {
    render(<Onboarding />);
    expect(
      screen.getByRole("heading", {
        name: "Crafted Herdr needs herdr-core (hc).",
      }),
    ).toBeInTheDocument();
  });

  it("onboarding_names_legacy_herdr_version", async () => {
    inState({ kind: "notFound" }, { ...NO_CORE, legacy_herdr: "0.9.4" });
    render(<Onboarding />);
    expect(
      await screen.findByText(
        "You have herdr 0.9.4, the older CLI. This version of Crafted Herdr works with the new herdr-core.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", {
        name: "Crafted Herdr needs herdr-core (hc).",
      }),
    ).toBeInTheDocument();
    expect(screen.getByText(INSTALL_LINE)).toBeInTheDocument();
  });

  it("the_legacy_line_leads_the_screen_before_the_heading", async () => {
    inState({ kind: "notFound" }, { ...NO_CORE, legacy_herdr: "0.9.4" });
    render(<Onboarding />);
    const lead = await screen.findByText(/^You have herdr 0\.9\.4/);
    const heading = screen.getByRole("heading", { level: 1 });
    expect(
      lead.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("the_footer_lists_the_places_the_search_looks", () => {
    inState({ kind: "notFound" });
    render(<Onboarding />);
    const note = screen.getByText(/The app looks in/);
    for (const where of [
      "~/.local/bin",
      "/opt/homebrew/bin",
      "/usr/local/bin",
      "~/.local/share/mise/shims",
      "~/.nix-profile/bin",
      "~/.cargo/bin",
    ]) {
      expect(note).toHaveTextContent(where);
    }
  });

  it("install_line_copies_not_runs", async () => {
    inState({ kind: "notFound" });
    const user = userEvent.setup();
    render(<Onboarding />);
    await user.click(screen.getByRole("button", { name: COPY_INSTALL }));
    expect(copy).toHaveBeenCalledTimes(1);
    expect(copy).toHaveBeenCalledWith(INSTALL_LINE);
    expect(useAppStore.getState().toast).toBe("Copied");
    // Nothing ran: no command, no browser.
    expect(asked()).toEqual([]);
    expect(openInBrowser).not.toHaveBeenCalled();
  });

  it("shows_a_refused_clipboard_inline_and_runs_nothing", async () => {
    inState({ kind: "notFound" });
    copy.mockRejectedValue(new Error("denied"));
    const user = userEvent.setup();
    render(<Onboarding />);
    await user.click(screen.getByRole("button", { name: COPY_INSTALL }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Couldn’t copy to the clipboard.",
    );
    expect(asked()).toEqual([]);
  });

  it("older_core_offers_copy_update", async () => {
    inState({
      kind: "incompatible",
      reason: "The core has no method terminal.read.",
      newer: false,
    });
    const user = userEvent.setup();
    render(<Onboarding />);
    expect(
      screen.getByRole("heading", {
        name: "This herdr-core is too old for Crafted Herdr.",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("The core has no method terminal.read."),
    ).toBeInTheDocument();
    expect(screen.getByText("hc update")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: COPY_UPDATE }));
    expect(copy).toHaveBeenCalledWith("hc update");
    expect(asked()).toEqual([]);
    // The install line is for a computer with no core; this one has one.
    expect(screen.queryByText(INSTALL_LINE)).toBeNull();
    expect(
      screen.getByRole("button", { name: "Choose binary…" }),
    ).toBeEnabled();
  });

  it("newer_core_says_update_crafted_herdr", () => {
    inState({
      kind: "incompatible",
      reason: "unsupported_generation",
      newer: true,
    });
    render(<Onboarding />);
    expect(
      screen.getByRole("heading", {
        name: "This herdr-core is newer than this Crafted Herdr understands.",
      }),
    ).toBeInTheDocument();
    expect(screen.getByText("Update Crafted Herdr.")).toBeInTheDocument();
    // hc update won't downgrade, so it is not suggested.
    expect(screen.queryByText("hc update")).toBeNull();
    expect(screen.queryByRole("button", { name: /^Copy/ })).toBeNull();
    expect(screen.queryByText(INSTALL_LINE)).toBeNull();
  });

  it("opens_the_install_page_in_the_default_browser", async () => {
    inState({ kind: "notFound" });
    const user = userEvent.setup();
    render(<Onboarding />);
    await user.click(screen.getByRole("button", { name: "Open herdr.dev ↗" }));
    expect(openInBrowser).toHaveBeenCalledTimes(1);
    expect(openInBrowser).toHaveBeenCalledWith("https://herdr.dev");
    // Nothing else is called: no network from the app, no core command.
    expect(asked()).toEqual([]);
  });

  it("shows_a_failed_browser_open_inline", async () => {
    inState({ kind: "notFound" });
    openInBrowser.mockRejectedValue(new Error("no default browser"));
    const user = userEvent.setup();
    render(<Onboarding />);
    await user.click(screen.getByRole("button", { name: "Open herdr.dev ↗" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "no default browser",
    );
  });

  it("saves_the_chosen_binary_as_the_core_path", async () => {
    inState({ kind: "notFound" });
    chooseFile.mockResolvedValue("/opt/herdr/bin/hc");
    const user = userEvent.setup();
    render(<Onboarding />);
    await user.click(screen.getByRole("button", { name: "Choose binary…" }));
    expect(chooseFile).toHaveBeenCalledWith({
      multiple: false,
      directory: false,
    });
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("set_settings", {
        patch: { core_path: "/opt/herdr/bin/hc" },
      }),
    );
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("does_nothing_when_the_file_dialog_is_cancelled", async () => {
    inState({ kind: "notFound" });
    chooseFile.mockResolvedValue(null);
    const user = userEvent.setup();
    render(<Onboarding />);
    await user.click(screen.getByRole("button", { name: "Choose binary…" }));
    expect(asked()).toEqual([]);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows_a_refused_path_inline_and_clears_it_on_the_next_try", async () => {
    inState({ kind: "notFound" });
    chooseFile.mockResolvedValueOnce("/tmp/not-herdr");
    invoke.mockImplementation(async (name: string) => {
      if (name === "core_status") return NO_CORE;
      throw { kind: "invalid", message: "That file is not herdr-core." };
    });
    const user = userEvent.setup();
    render(<Onboarding />);
    await user.click(screen.getByRole("button", { name: "Choose binary…" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "That file is not herdr-core.",
    );
    expect(
      screen.getByRole("button", { name: "Choose binary…" }),
    ).toBeEnabled();

    chooseFile.mockResolvedValueOnce(null);
    await user.click(screen.getByRole("button", { name: "Choose binary…" }));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows_a_failed_file_dialog_inline", async () => {
    inState({ kind: "notFound" });
    chooseFile.mockRejectedValue(new Error("dialog unavailable"));
    const user = userEvent.setup();
    render(<Onboarding />);
    await user.click(screen.getByRole("button", { name: "Choose binary…" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "dialog unavailable",
    );
  });

  describe("Try again", () => {
    const cases: Array<[string, CoreState, CoreStatus]> = [
      ["no_core", { kind: "notFound" }, NO_CORE],
      [
        "old_herdr",
        { kind: "notFound" },
        { ...NO_CORE, legacy_herdr: "0.9.4" },
      ],
      [
        "older_core",
        { kind: "incompatible", reason: "no method", newer: false },
        NO_CORE,
      ],
      [
        "newer_core",
        { kind: "incompatible", reason: "unsupported_generation", newer: true },
        NO_CORE,
      ],
    ];

    it.each(cases)(
      "%s_try_again_invokes_retry_core",
      async (_n, core, status) => {
        inState(core, status);
        const user = userEvent.setup();
        render(<Onboarding />);
        await user.click(screen.getByRole("button", { name: "Try again" }));
        expect(invoke).toHaveBeenCalledWith("retry_core");
        // It only reconnects: nothing is copied, opened or run.
        expect(asked()).toEqual([["retry_core"]]);
        expect(copy).not.toHaveBeenCalled();
        expect(openInBrowser).not.toHaveBeenCalled();
      },
    );

    it("says_so_when_nothing_was_found_and_shows_a_failure_inline", async () => {
      inState({ kind: "notFound" });
      const user = userEvent.setup();
      render(<Onboarding />);
      invoke.mockImplementation(async () => NO_CORE);
      await user.click(screen.getByRole("button", { name: "Try again" }));
      expect(await screen.findByRole("status")).toHaveTextContent(
        "No herdr-core found yet.",
      );

      invoke.mockImplementation(async () => {
        throw { kind: "invalid", message: "Could not look." };
      });
      await user.click(screen.getByRole("button", { name: "Try again" }));
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "Could not look.",
      );
    });

    it("is_disabled_while_the_call_is_pending", async () => {
      inState({ kind: "notFound" });
      let finish: (s: CoreStatus) => void = () => {};
      invoke.mockImplementation((name: string) =>
        name === "retry_core"
          ? new Promise<CoreStatus>((r) => (finish = r))
          : Promise.resolve(NO_CORE),
      );
      const user = userEvent.setup();
      render(<Onboarding />);
      const button = screen.getByRole("button", { name: "Try again" });
      await user.click(button);
      expect(button).toBeDisabled();
      await act(async () => finish(NO_CORE));
      expect(screen.getByRole("button", { name: "Try again" })).toBeEnabled();
    });
  });
});
