import { describe, expect, it } from "vitest";
import type { MachineView } from "./bindings/MachineView";
import { canOpenNewSession, newSessionTarget } from "./newSessionTarget";

const HOME = "home";
const tabs = [
  { tabKey: "buildbox::w1:p1", target: { machineId: "buildbox" } },
  { tabKey: "gpubox::w1:p1", target: { machineId: "gpubox" } },
];
const yes = () => true;
const base = {
  activeKey: HOME,
  tabs,
  view: { kind: "dashboard" } as const,
  selectedKey: null,
  canOpenOn: yes,
};

describe("newSessionTarget", () => {
  it("uses_the_active_terminal_tabs_workbox", () => {
    expect(
      newSessionTarget({
        ...base,
        activeKey: "buildbox::w1:p1",
        view: { kind: "workbox", machineId: "gpubox" },
        selectedKey: "staging::w2:p3",
      }),
    ).toEqual({ machineId: "buildbox" });
  });

  it("uses_the_workbox_screen_on_home", () => {
    expect(
      newSessionTarget({
        ...base,
        view: { kind: "workbox", machineId: "gpubox" },
      }),
    ).toEqual({ machineId: "gpubox" });
  });

  it("uses_the_selected_agents_workbox_on_all_agents", () => {
    expect(
      newSessionTarget({
        ...base,
        view: { kind: "all" },
        selectedKey: "staging::w2:p3",
      }),
    ).toEqual({ machineId: "staging" });
  });

  it("plain_sheet_on_all_agents_without_a_selection", () => {
    expect(
      newSessionTarget({ ...base, view: { kind: "all" } }),
    ).toBeUndefined();
  });

  it("plain_sheet_on_the_dashboard", () => {
    expect(
      newSessionTarget({ ...base, selectedKey: "staging::w2:p3" }),
    ).toBeUndefined();
  });

  it("plain_sheet_when_the_workbox_cant_take_a_session", () => {
    expect(
      newSessionTarget({
        ...base,
        activeKey: "buildbox::w1:p1",
        canOpenOn: () => false,
      }),
    ).toBeUndefined();
  });

  it("a_tab_that_cant_take_a_session_does_not_fall_through_to_the_view", () => {
    expect(
      newSessionTarget({
        ...base,
        activeKey: "buildbox::w1:p1",
        view: { kind: "workbox", machineId: "gpubox" },
        canOpenOn: (id) => id === "gpubox",
      }),
    ).toBeUndefined();
  });
});

describe("canOpenNewSession", () => {
  const machine = (kind: "online" | "disabled") =>
    ({ id: "buildbox", health: { kind } }) as unknown as MachineView;

  it("offers_known_workboxes_that_are_not_disabled", () => {
    expect(canOpenNewSession(machine("online"))).toBe(true);
    expect(canOpenNewSession(machine("disabled"))).toBe(false);
    expect(canOpenNewSession(null)).toBe(false);
    expect(canOpenNewSession(undefined)).toBe(false);
  });
});
