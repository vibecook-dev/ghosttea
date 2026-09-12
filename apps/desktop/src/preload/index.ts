import { contextBridge, ipcRenderer } from "electron";
import { createGhostteaClipboardBridge, createGhostteaLinkBridge } from "@vibecook/ghosttea-electron/preload";
import type { RendererPortBootstrapMessage } from "@vibecook/ghosttea-electron/types";

console.info("[terminal-runtime] preload ready");

function argument(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

const tabId = argument("ghosttea-tab-id") ?? "default";
const claimExistingSessions = argument("ghosttea-tab-claim-existing") !== "0";
const managedConfigEditor = argument("ghosttea-managed-config-editor") === "1";
const encodedInitialCwd = argument("ghosttea-tab-cwd");
let initialCwd: string | undefined;
try {
  initialCwd = encodedInitialCwd ? decodeURIComponent(encodedInitialCwd) : undefined;
} catch {
  initialCwd = undefined;
}

ipcRenderer.on("terminal-ports", (event) => {
  console.info(`[terminal-runtime] preload received ${event.ports.length} ports`);
  window.postMessage({ type: "ghosttea:ports" } satisfies RendererPortBootstrapMessage, "*", event.ports);
});

const clipboardBridge = createGhostteaClipboardBridge(ipcRenderer);

contextBridge.exposeInMainWorld("desktop", {
  platform: process.platform,
  tabId,
  claimExistingSessions,
  initialCwd,
  defaultShell:
    process.platform === "win32" ? (process.env.COMSPEC ?? "powershell.exe") : (process.env.SHELL ?? "/bin/zsh"),
  openExternal: createGhostteaLinkBridge(ipcRenderer).openExternal,
  writeClipboard: clipboardBridge.writeText,
  readClipboard: clipboardBridge.readText,
  setTerminalCanCopy: clipboardBridge.setCanCopy,
  showContextMenu: (canCopy: boolean) => ipcRenderer.send("terminal-context-menu", canCopy),
  toggleFullscreen: () => ipcRenderer.send("terminal-toggle-fullscreen"),
  closeWindow: () => ipcRenderer.send("terminal-close-window"),
  newWindow: (cwd?: string) => ipcRenderer.send("terminal-new-window", cwd),
  quit: () => ipcRenderer.send("terminal-quit"),
  closeAllWindows: () => ipcRenderer.send("terminal-close-all-windows"),
  openConfig: () => ipcRenderer.send("terminal-open-config"),
  reloadConfig: () => ipcRenderer.send("terminal-reload-config"),
  ...(process.platform === "darwin"
    ? {
        backdropBlur: {
          load: () => ipcRenderer.invoke("terminal-backdrop-blur-load") as Promise<boolean>,
          save: (enabled: boolean) => ipcRenderer.invoke("terminal-backdrop-blur-save", enabled) as Promise<boolean>,
          subscribe: (listener: (enabled: boolean) => void) => {
            const handler = (_event: Electron.IpcRendererEvent, enabled: boolean): void => listener(enabled);
            ipcRenderer.on("terminal-backdrop-blur-changed", handler);
            return () => ipcRenderer.removeListener("terminal-backdrop-blur-changed", handler);
          },
        },
      }
    : {}),
  ...(managedConfigEditor
    ? {
        saveAppearance: (update: unknown) => ipcRenderer.invoke("terminal-save-appearance", update) as Promise<void>,
        configEditor: {
          load: () => ipcRenderer.invoke("terminal-config-editor-load") as Promise<unknown>,
          validate: (contents: string) =>
            ipcRenderer.invoke("terminal-config-editor-validate", contents) as Promise<unknown>,
          save: (expectedRevision: string, contents: string) =>
            ipcRenderer.invoke("terminal-config-editor-save", { expectedRevision, contents }) as Promise<unknown>,
          importGhostty: () => ipcRenderer.invoke("terminal-config-editor-import-ghostty") as Promise<unknown>,
          importFile: () => ipcRenderer.invoke("terminal-config-editor-import-file") as Promise<unknown>,
          exportFile: (contents: string) =>
            ipcRenderer.invoke("terminal-config-editor-export-file", contents) as Promise<unknown>,
          openExternal: () => ipcRenderer.send("terminal-open-config"),
          setDirty: (dirty: boolean) => ipcRenderer.send("terminal-config-editor-dirty", dirty),
        },
      }
    : {}),
  newTab: (cwd?: string) => ipcRenderer.send("terminal-new-tab", cwd),
  selectTab: (target: "previous" | "next" | "last" | number) => ipcRenderer.send("terminal-select-tab", target),
  closeTab: () => ipcRenderer.send("terminal-close-tab"),
  closePaneSession: (sessionId: string, remainingSessionIds: readonly string[]) =>
    ipcRenderer.send("terminal-close-pane-session", sessionId, remainingSessionIds),
  updateTabSessions: (sessionIds: readonly string[]) => ipcRenderer.send("terminal-tab-sessions", sessionIds),
  updateActiveCwd: (cwd?: string) => ipcRenderer.send("terminal-tab-active-cwd", cwd),
  onMenuAction: (listener: (action: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, action: string): void => listener(action);
    ipcRenderer.on("terminal-menu-action", handler);
    return () => ipcRenderer.removeListener("terminal-menu-action", handler);
  },
});
