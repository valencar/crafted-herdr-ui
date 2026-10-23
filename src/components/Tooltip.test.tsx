import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../store/appStore";
import { Tooltip } from "./Tooltip";

function tip(): HTMLElement | null {
  return document.querySelector<HTMLElement>(".tooltip");
}

function advance(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

// jsdom answers :focus-visible from the events it saw before, so the answer is stubbed.
let focusVisible = true;
const realMatches = Element.prototype.matches;

beforeEach(() => {
  focusVisible = true;
  vi.spyOn(Element.prototype, "matches").mockImplementation(function (
    this: Element,
    selector: string,
  ) {
    return selector === ":focus-visible"
      ? focusVisible
      : realMatches.call(this, selector);
  });
  vi.useFakeTimers();
  useAppStore.setState({ dialogOpen: 0, paletteOpen: false, sheet: null });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Tooltip", () => {
  it("shows_after_the_delay_on_hover", () => {
    render(
      <Tooltip label="Find in terminal">
        <button type="button">Find</button>
      </Tooltip>,
    );
    fireEvent.pointerEnter(screen.getByRole("button"));
    advance(349);
    expect(tip()).toBeNull();
    advance(1);
    const el = tip();
    expect(el).toHaveTextContent("Find in terminal");
    expect(el?.parentElement).toBe(document.body);
    expect(el).toHaveAttribute("aria-hidden", "true");
    fireEvent.pointerLeave(screen.getByRole("button"));
    expect(tip()).toBeNull();
  });

  it("shows_at_once_on_focus", () => {
    render(
      <Tooltip label="Find in terminal">
        <button type="button">Find</button>
      </Tooltip>,
    );
    act(() => screen.getByRole("button").focus());
    expect(tip()).toHaveTextContent("Find in terminal");
    act(() => screen.getByRole("button").blur());
    expect(tip()).toBeNull();
  });

  it("does_not_show_for_a_pointer_focus", () => {
    focusVisible = false;
    render(
      <Tooltip label="Find in terminal">
        <button type="button">Find</button>
      </Tooltip>,
    );
    act(() => screen.getByRole("button").focus());
    expect(tip()).toBeNull();
  });

  it("neighbour_shows_at_once", () => {
    // Earlier tests leave their own hide time behind; move well past it.
    advance(1000);
    render(
      <>
        <Tooltip label="First">
          <button type="button">A</button>
        </Tooltip>
        <Tooltip label="Second">
          <button type="button">B</button>
        </Tooltip>
      </>,
    );
    const [a, b] = screen.getAllByRole("button");
    fireEvent.pointerEnter(a);
    advance(350);
    expect(tip()).toHaveTextContent("First");
    fireEvent.pointerLeave(a);
    advance(100);
    fireEvent.pointerEnter(b);
    expect(tip()).toHaveTextContent("Second");
    fireEvent.pointerLeave(b);
    // Past the grace window the delay is back.
    advance(300);
    fireEvent.pointerEnter(a);
    expect(tip()).toBeNull();
    advance(350);
    expect(tip()).toHaveTextContent("First");
  });

  it("escape_hides", () => {
    const onKeyDown = vi.fn();
    const outer = vi.fn();
    render(
      <div onKeyDown={outer}>
        <Tooltip label="Find in terminal">
          <button type="button" onKeyDown={onKeyDown}>
            Find
          </button>
        </Tooltip>
      </div>,
    );
    const button = screen.getByRole("button");
    act(() => button.focus());
    expect(tip()).not.toBeNull();
    fireEvent.keyDown(button, { key: "Escape" });
    expect(tip()).toBeNull();
    expect(onKeyDown).toHaveBeenCalledTimes(1);
    expect(outer).not.toHaveBeenCalled();
    // With nothing visible the key goes on to whoever wants it.
    fireEvent.keyDown(button, { key: "Escape" });
    expect(outer).toHaveBeenCalledTimes(1);
  });

  it("escape_in_the_terminal_is_not_taken_by_a_tooltip", () => {
    render(
      <>
        <Tooltip label="Find in terminal">
          <button type="button">Find</button>
        </Tooltip>
        <div className="terminal-panel">
          <textarea aria-label="Terminal input" />
        </div>
      </>,
    );
    const seen = vi.fn();
    document.addEventListener("keydown", seen);
    const event = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    const stop = vi.spyOn(event, "stopPropagation");
    screen.getByLabelText("Terminal input").dispatchEvent(event);
    document.removeEventListener("keydown", seen);
    expect(event.defaultPrevented).toBe(false);
    expect(stop).not.toHaveBeenCalled();
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it("suppressed_under_a_dialog", () => {
    useAppStore.setState({ dialogOpen: 1 });
    render(
      <>
        <Tooltip label="Behind">
          <button type="button">Behind</button>
        </Tooltip>
        <div role="dialog" aria-label="Confirm">
          <Tooltip label="Inside">
            <button type="button">Inside</button>
          </Tooltip>
        </div>
      </>,
    );
    fireEvent.pointerEnter(screen.getByRole("button", { name: "Behind" }));
    advance(400);
    act(() => screen.getByRole("button", { name: "Behind" }).focus());
    expect(tip()).toBeNull();

    fireEvent.pointerEnter(screen.getByRole("button", { name: "Inside" }));
    advance(400);
    expect(tip()).toHaveTextContent("Inside");
  });

  it("suppressed_under_the_palette_and_a_sheet", () => {
    render(
      <Tooltip label="Find in terminal">
        <button type="button">Find</button>
      </Tooltip>,
    );
    useAppStore.setState({ paletteOpen: true });
    act(() => screen.getByRole("button").focus());
    expect(tip()).toBeNull();
    act(() => screen.getByRole("button").blur());
    useAppStore.setState({ paletteOpen: false, sheet: "new-session" });
    act(() => screen.getByRole("button").focus());
    expect(tip()).toBeNull();
  });

  it("hides_when_a_dialog_opens_under_a_shown_tooltip", () => {
    render(
      <Tooltip label="Find in terminal">
        <button type="button">Find</button>
      </Tooltip>,
    );
    act(() => screen.getByRole("button").focus());
    expect(tip()).not.toBeNull();
    act(() => useAppStore.setState({ dialogOpen: 1 }));
    expect(tip()).toBeNull();
  });

  it("shows_the_shortcut", () => {
    render(
      <Tooltip label="Find in terminal" shortcut="find">
        <button type="button">Find</button>
      </Tooltip>,
    );
    act(() => screen.getByRole("button").focus());
    const kbd = tip()?.querySelector("kbd");
    expect(kbd).toHaveTextContent("⌘F");
  });

  it("keeps_the_childs_handlers", () => {
    const onFocus = vi.fn();
    const onPointerEnter = vi.fn();
    render(
      <Tooltip label="Find in terminal">
        <button type="button" onFocus={onFocus} onPointerEnter={onPointerEnter}>
          Find
        </button>
      </Tooltip>,
    );
    fireEvent.pointerEnter(screen.getByRole("button"));
    act(() => screen.getByRole("button").focus());
    expect(onFocus).toHaveBeenCalledTimes(1);
    expect(onPointerEnter).toHaveBeenCalledTimes(1);
  });

  it("flips_above_near_the_window_bottom", () => {
    render(
      <Tooltip label="Find in terminal">
        <button type="button">Find</button>
      </Tooltip>,
    );
    const button = screen.getByRole("button");
    vi.spyOn(button, "getBoundingClientRect").mockReturnValue({
      top: window.innerHeight - 30,
      bottom: window.innerHeight - 6,
      left: 10,
      right: 60,
      width: 50,
      height: 24,
      x: 10,
      y: window.innerHeight - 30,
      toJSON: () => ({}),
    });
    act(() => button.focus());
    expect(tip()?.style.bottom).not.toBe("");
    expect(tip()?.style.top).toBe("");
  });

  it("goes_away_with_its_trigger", () => {
    const { unmount } = render(
      <Tooltip label="Find in terminal">
        <button type="button">Find</button>
      </Tooltip>,
    );
    act(() => screen.getByRole("button").focus());
    unmount();
    expect(tip()).toBeNull();
  });
});
