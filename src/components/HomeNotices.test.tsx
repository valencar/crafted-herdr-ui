import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppState } from "../lib/bindings/AppState";
import type { CoreState } from "../lib/bindings/CoreState";
import type { Health } from "../lib/bindings/Health";
import { useAppStore } from "../store/appStore";
import { appState, buildboxTerms, machineView } from "../test/builders";
import { MachineNotices, VersionBanner } from "./HomeNotices";

vi.mock("../lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/ipc")>()),
  invokeTyped: vi.fn(),
}));
import { invokeTyped } from "../lib/ipc";

const invoke = vi.mocked(invokeTyped) as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  invoke.mockReset().mockResolvedValue({});
  useAppStore.setState({ state: null, dismissedVersion: null });
});
afterEach(cleanup);

function withState(over: Partial<AppState>) {
  useAppStore.setState({ state: { ...appState([]), ...over } });
}

describe("VersionBanner", () => {
  it("version_banner_below_0_1_17", async () => {
    withState({ core_version: "0.1.16" });
    const user = userEvent.setup();
    render(<VersionBanner />);
    const banner = screen.getByRole("status");
    expect(banner).toHaveTextContent(
      "herdr-core 0.1.16 is older than this app supports (0.1.17+). Some actions may fail.",
    );
    await user.click(within(banner).getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it.each(["0.1.17", "0.1.18", "0.2.0-beta.1", "1.0.0"])(
    "shows_no_banner_for_%s",
    (version) => {
      withState({ core_version: version });
      render(<VersionBanner />);
      expect(screen.queryByRole("status")).toBeNull();
    },
  );

  it("says_nothing_while_the_core_has_not_reported_a_version", () => {
    withState({ core_version: null });
    render(<VersionBanner />);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("an_unrecognised_version_gets_the_banner", () => {
    withState({ core_version: "not-a-version" });
    render(<VersionBanner />);
    expect(screen.getByRole("status")).toHaveTextContent(
      "herdr-core not-a-version is older than this app supports",
    );
  });
});

describe("the Local card", () => {
  const local = (health: Health, withTerms = false) =>
    machineView(
      { id: "local", name: "Local", isLocal: true, health, lastOkMs: null },
      withTerms ? buildboxTerms({}) : null,
    );
  const show = (core: CoreState, machine: ReturnType<typeof local>) => {
    withState({ core_state: core, machines: [machine] });
    return render(<MachineNotices machines={[machine]} nowMs={1} />);
  };

  // Rust's shape once the 2-minute window is over: Local is `attention` with the generic
  // sentence, its rows are kept, and the core state carries the real cause.
  const STOPPED: CoreState = {
    kind: "stopped",
    error: "Could not start herdr-core.",
  };
  const stoppedLocal = () =>
    local({ kind: "attention", error: "herdr-core isn't running." }, true);

  it("local_down_card_reconnect_button_calls_reconnect_core", async () => {
    const user = userEvent.setup();
    show(STOPPED, stoppedLocal());
    const card = screen.getByRole("region", { name: "Local isn’t answering" });
    expect(card).not.toHaveTextContent("hc server status");
    expect(
      within(card).queryByRole("button", { name: "Retry now" }),
    ).toBeNull();
    await user.click(within(card).getByRole("button", { name: "Reconnect" }));
    expect(invoke).toHaveBeenCalledWith("reconnect_core");
    expect(invoke).not.toHaveBeenCalledWith("refresh_now", expect.anything());
  });

  it("stopped_names_the_cause_as_well_as_the_generic_line", () => {
    show(STOPPED, stoppedLocal());
    const card = screen.getByRole("region", { name: "Local isn’t answering" });
    expect(card).toHaveTextContent("herdr-core isn’t running.");
    expect(card).toHaveTextContent("Could not start herdr-core.");
  });

  it("stopped_shows_the_card_even_though_local_kept_its_rows", () => {
    // Only `core_state` says the connection is down here: the old fallback needs no rows.
    show(STOPPED, stoppedLocal());
    expect(
      screen.getByRole("region", { name: "Local isn’t answering" }),
    ).toBeInTheDocument();
    cleanup();
    show({ kind: "ready" }, stoppedLocal());
    expect(screen.queryByText("Local isn’t answering")).toBeNull();
  });

  it("reconnect_is_disabled_while_its_call_is_pending", async () => {
    let finish: () => void = () => {};
    invoke.mockReturnValue(new Promise<void>((r) => (finish = r)));
    const user = userEvent.setup();
    show(STOPPED, stoppedLocal());
    const button = screen.getByRole("button", { name: "Reconnect" });
    await user.click(button);
    expect(button).toBeDisabled();
    await user.click(button);
    expect(invoke).toHaveBeenCalledTimes(1);
    await act(async () => finish());
    expect(screen.getByRole("button", { name: "Reconnect" })).toBeEnabled();
  });

  it("shows_while_the_connection_is_being_remade_with_the_rows_kept", () => {
    show(
      { kind: "connecting" },
      local(
        { kind: "reconnecting", retry_in_ms: 2000, error: "lost it" },
        true,
      ),
    );
    expect(
      screen.getByRole("region", { name: "Local isn’t answering" }),
    ).toHaveTextContent("lost it");
  });

  it("stays_quiet_on_the_first_connect", () => {
    show(
      { kind: "connecting" },
      local({ kind: "reconnecting", retry_in_ms: 0, error: "" }),
    );
    expect(screen.queryByText("Local isn’t answering")).toBeNull();
  });

  it("stays_quiet_when_the_core_is_ready_and_local_is_online", () => {
    show({ kind: "ready" }, local({ kind: "online" }, true));
    expect(screen.queryByText("Local isn’t answering")).toBeNull();
  });

  it("says_so_when_there_is_no_error_text", () => {
    show({ kind: "ready" }, local({ kind: "attention", error: " " }));
    expect(
      screen.getByRole("region", { name: "Local isn’t answering" }),
    ).toHaveTextContent("herdr-core isn’t answering yet");
  });
});

describe("a workbox that needs attention", () => {
  const SENTENCE =
    "herdr-core retries a failed login only every few minutes. Log in to reconnect now.";
  const staging = (state: string, error: string) =>
    machineView(
      {
        id: "staging",
        name: "staging",
        health: { kind: "attention", error },
        state,
        lastOkMs: null,
      },
      null,
    );
  const show = (m: ReturnType<typeof staging>) => {
    withState({ machines: [m] });
    render(<MachineNotices machines={[m]} nowMs={1} />);
    return screen.getByRole("region", { name: "staging needs attention" });
  };

  it("tells_a_needs_login_workbox_to_log_in_now", async () => {
    invoke.mockImplementation(async (name: string) =>
      name === "machine_login_args" ? ["machine", "login", "staging"] : null,
    );
    const card = show(staging("needs_login", "Needs login"));
    expect(card).toHaveTextContent("Needs login");
    expect(within(card).getByText(SENTENCE)).toBeInTheDocument();
    const buttons = within(card).getAllByRole("button");
    expect(buttons.map((b) => b.textContent)).toEqual([
      "Log in…",
      "Connect now",
    ]);
    expect(buttons[0]).toHaveClass("btn-primary");
    expect(buttons[1]).not.toHaveClass("btn-primary");
    await userEvent.setup().click(buttons[0]);
    expect(invoke).toHaveBeenCalledWith("machine_login_args", {
      machineId: "staging",
    });
  });

  it("keeps_other_attention_notices_as_they_were", () => {
    const card = show(staging("unreachable", "ssh: connection refused"));
    expect(within(card).queryByText(SENTENCE)).toBeNull();
    expect(within(card).queryByRole("button", { name: "Log in…" })).toBeNull();
    const buttons = within(card).getAllByRole("button");
    expect(buttons[0]).toHaveTextContent("Connect now");
    expect(buttons[0]).not.toHaveClass("btn-primary");
  });
});
