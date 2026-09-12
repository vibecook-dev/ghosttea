import { describe, expect, it, vi } from "vitest";
import type { IpcMain, IpcMainInvokeEvent, IpcRenderer, WebContents } from "electron";
import { createGhostteaLinkBridge, installGhostteaLinkHost } from "./links.js";

describe("terminal link bridge", () => {
  it("validates URLs and sender identity in the main process", async () => {
    let handler!: (event: IpcMainInvokeEvent, value: unknown) => Promise<void>;
    const ipc = {
      handle: vi.fn((_channel, callback) => {
        handler = callback;
      }),
      removeHandler: vi.fn(),
    };
    const openExternal = vi.fn(async () => {});
    const sender = { mainFrame: {} } as WebContents;
    const event = { sender, senderFrame: sender.mainFrame } as IpcMainInvokeEvent;
    const host = installGhostteaLinkHost(ipc as unknown as IpcMain, { openExternal }, (value) => value === sender);
    await handler(event, "https://example.com/path");
    expect(openExternal).toHaveBeenCalledExactlyOnceWith("https://example.com/path");
    for (const value of ["javascript:alert(1)", "data:text/html,hello", "https://example.com/\n", 42]) {
      await expect(handler(event, value)).rejects.toThrow();
    }
    await expect(handler({ ...event, senderFrame: {} } as IpcMainInvokeEvent, "https://example.com")).rejects.toThrow(
      "Untrusted",
    );
    await expect(
      handler({ ...event, sender: { mainFrame: event.senderFrame } } as IpcMainInvokeEvent, "https://example.com"),
    ).rejects.toThrow("Untrusted");
    expect(openExternal).toHaveBeenCalledTimes(1);
    await handler(event, "file:///tmp/my%20project/source.ts#L42");
    expect(openExternal).toHaveBeenLastCalledWith("file:///tmp/my%20project/source.ts#L42");
    host.dispose();
    expect(ipc.removeHandler).toHaveBeenCalledWith("ghosttea:links:open");
  });
  it("exposes a narrow preload callback and propagates opener failures", async () => {
    const invoke = vi.fn(async () => {});
    const bridge = createGhostteaLinkBridge({ invoke } as unknown as IpcRenderer);
    await bridge.openExternal("https://example.com");
    expect(invoke).toHaveBeenCalledWith("ghosttea:links:open", "https://example.com/");
    await bridge.openExternal("file:///tmp/source.ts");
    expect(invoke).toHaveBeenLastCalledWith("ghosttea:links:open", "file:///tmp/source.ts");
    await expect(bridge.openExternal("javascript:alert(1)")).rejects.toThrow();
    invoke.mockRejectedValueOnce(new Error("opener failed"));
    await expect(bridge.openExternal("mailto:team@example.com")).rejects.toThrow("opener failed");
  });
});
