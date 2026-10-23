import { afterEach, describe, expect, it, vi } from "vitest";

async function loadWith(userAgent: string) {
  vi.resetModules();
  vi.stubGlobal("navigator", { userAgent });
  return import("./platform");
}

describe("platform", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete document.documentElement.dataset.platform;
  });

  it("is mac unless the user agent says Windows", async () => {
    const mac = await loadWith("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)");
    expect(mac.platform).toBe("mac");
    const win = await loadWith("Mozilla/5.0 (Windows NT 10.0; Win64; x64)");
    expect(win.platform).toBe("windows");
  });

  it("sets data-platform on the root element", async () => {
    const win = await loadWith("Mozilla/5.0 (Windows NT 10.0; Win64; x64)");
    win.setPlatformAttribute();
    expect(document.documentElement.dataset.platform).toBe("windows");
  });
});
