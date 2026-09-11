import type { IpcRenderer, IpcRendererEvent } from "electron";
export { createGhostteaClipboardBridge, type GhostteaClipboardBridge } from "./clipboard.js";
import type { RendererPortBootstrapMessage } from "./types.js";

export function forwardGhostteaRendererPorts(ipcRenderer: IpcRenderer, channel = "terminal-ports"): () => void {
  const listener = (event: IpcRendererEvent): void => {
    window.postMessage({ type: "ghosttea:ports" } satisfies RendererPortBootstrapMessage, "*", event.ports);
  };
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

export { createGhostteaLinkBridge } from "./links.js";
