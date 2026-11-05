import { cleanup, render, screen, within } from "@testing-library/react";
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

  it("local_down_card_reconnect_button_calls_reconnect_core", async () => {
    const user = userEvent.setup();
    show(
      { kind: "stopped", error: "herdr-core isn't running." },
      local({ kind: "attention", error: "herdr-core isn't running." }),
    );
    const card = screen.getByRole("region", { name: "Local isn’t answering" });
    expect(card).toHaveTextContent("herdr-core isn't running.");
    expect(card).not.toHaveTextContent("hc server status");
    expect(
      within(card).queryByRole("button", { name: "Retry now" }),
    ).toBeNull();
    await user.click(within(card).getByRole("button", { name: "Reconnect" }));
    expect(invoke).toHaveBeenCalledWith("reconnect_core");
    expect(invoke).not.toHaveBeenCalledWith("refresh_now", expect.anything());
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
    show(
      { kind: "stopped", error: " " },
      local({ kind: "attention", error: " " }),
    );
    expect(
      screen.getByRole("region", { name: "Local isn’t answering" }),
    ).toHaveTextContent("herdr-core isn’t answering yet");
  });
});
