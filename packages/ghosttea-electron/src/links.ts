import type { IpcMain, IpcMainInvokeEvent, IpcRenderer, Shell, WebContents } from "electron";
import { terminalLinkUrl } from "@vibecook/ghosttea-protocol";

const OPEN_LINK_CHANNEL = "ghosttea:links:open";

/** Register only the app's own terminal WebContents; subframes cannot invoke this bridge. */
export function installGhostteaLinkHost(
  ipcMain: IpcMain,
  shell: Pick<Shell, "openExternal">,
  isTrusted: (sender: WebContents) => boolean,
): { dispose(): void } {
  ipcMain.handle(OPEN_LINK_CHANNEL, async (event: IpcMainInvokeEvent, value: unknown) => {
    if (event.senderFrame !== event.sender.mainFrame || !isTrusted(event.sender))
      throw new Error("Untrusted terminal link sender");
    const url = terminalLinkUrl(value);
    if (!url) throw new TypeError("Unsupported terminal link URL");
    await shell.openExternal(url);
  });
  return { dispose: () => ipcMain.removeHandler(OPEN_LINK_CHANNEL) };
}

export function createGhostteaLinkBridge(ipcRenderer: IpcRenderer): { openExternal(url: string): Promise<void> } {
  return {
    openExternal: async (value) => {
      const url = terminalLinkUrl(value);
      if (!url) throw new TypeError("Unsupported terminal link URL");
      await ipcRenderer.invoke(OPEN_LINK_CHANNEL, url);
    },
  };
}
