import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../store/appStore";
import { Header } from "./Header";

vi.mock("../lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/ipc")>()),
  invokeTyped: vi.fn(),
}));

afterEach(() => useAppStore.setState({ paletteOpen: false }));

describe("Header", () => {
  it("palette_launcher_opens_the_palette", async () => {
    const user = userEvent.setup();
    render(
      <Header
        herdrVersion="0.9.4"
        terminal="ghostty"
        installed={["ghostty"]}
        onNewSession={() => {}}
      />,
    );
    const launcher = screen.getByRole("button", {
      name: /Search agents, workboxes, commands/,
    });
    expect(launcher).toHaveClass("palette-launch");
    expect(launcher).toHaveTextContent("⌘K");
    // The list search lives on All agents now.
    expect(screen.queryByRole("searchbox")).toBeNull();

    expect(useAppStore.getState().paletteOpen).toBe(false);
    await user.click(launcher);
    expect(useAppStore.getState().paletteOpen).toBe(true);
  });
});
