import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MachineView } from "../lib/bindings/MachineView";
import type { Settings } from "../lib/bindings/Settings";
import { useAppStore } from "../store/appStore";
import { Sidebar } from "./Sidebar";

vi.mock("../lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/ipc")>()),
  invokeTyped: vi.fn(),
}));
import { invokeTyped } from "../lib/ipc";

const invoke = vi.mocked(invokeTyped) as unknown as ReturnType<typeof vi.fn>;

function machine(id: string, kind: MachineView["health"]["kind"]): MachineView {
  const health =
    kind === "attention" || kind === "reconnecting"
      ? { kind, error: "unreachable", attempt: 1 }
      : { kind };
  return {
    id,
    label: id,
    target: id,
    session: "default",
    is_local: false,
    health,
    snapshot: null,
    last_ok_ms: null,
    ages: {},
  } as unknown as MachineView;
}

function renderSidebar(collapsed: boolean, onWorkbox = vi.fn()) {
  useAppStore.setState({
    settings: { sidebar_collapsed: collapsed } as unknown as Settings,
  });
  return render(
    <Sidebar
      needsCount={2}
      agentCount={5}
      projects={[]}
      machines={[machine("buildbox", "online"), machine("gpubox", "attention")]}
      herdrPath="/home/dev/.local/bin/herdr"
      herdrVersion="0.9.4"
      activeWorkbox={null}
      onJump={vi.fn()}
      onProject={vi.fn()}
      onWorkbox={onWorkbox}
      onAddWorkbox={vi.fn()}
      onSettings={vi.fn()}
      activityOpen={false}
      onActivity={vi.fn()}
    />,
  );
}

beforeEach(() => {
  invoke
    .mockReset()
    .mockImplementation(async (_name: string, args?: unknown) => ({
      ...useAppStore.getState().settings,
      ...(args as { patch: object }).patch,
    }));
});

describe("Sidebar", () => {
  it("collapsed rail keeps labels for screen readers", async () => {
    const onWorkbox = vi.fn();
    renderSidebar(true, onWorkbox);
    const rail = screen.getByRole("navigation", { name: "Sidebar" });
    expect(rail).toHaveClass("is-collapsed");

    // Each workbox keeps its name and its health in words, as a name and a tooltip.
    const buildbox = within(rail).getByRole("button", {
      name: "buildbox: Online",
    });
    expect(buildbox).toHaveAttribute("title", "buildbox: Online");
    const gpubox = within(rail).getByRole("button", {
      name: "gpubox: Attention",
    });
    expect(gpubox).toHaveAttribute("title", "gpubox: Attention");
    expect(
      within(rail).getByRole("button", { name: "Needs you: 2 waiting" }),
    ).toBeInTheDocument();
    expect(
      within(rail).getByRole("button", { name: "Add workbox" }),
    ).toBeInTheDocument();
    // The wide layout's text is gone.
    expect(within(rail).queryByText("Projects")).toBeNull();

    const user = userEvent.setup();
    await user.click(buildbox);
    expect(onWorkbox).toHaveBeenCalledWith("buildbox");
    await user.click(
      within(rail).getByRole("button", { name: "Expand sidebar" }),
    );
    expect(invoke).toHaveBeenCalledWith("set_settings", {
      patch: { sidebar_collapsed: false },
    });
  });

  it("the wide sidebar can be collapsed", async () => {
    renderSidebar(false);
    const rail = screen.getByRole("navigation", { name: "Sidebar" });
    expect(rail).not.toHaveClass("is-collapsed");
    await userEvent
      .setup()
      .click(within(rail).getByRole("button", { name: /^Collapse sidebar/ }));
    expect(invoke).toHaveBeenCalledWith("set_settings", {
      patch: { sidebar_collapsed: true },
    });
  });
});
