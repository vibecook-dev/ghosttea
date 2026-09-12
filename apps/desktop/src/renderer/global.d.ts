import type {
  GhostteaAppearanceUpdate,
  GhostteaBackdropBlurBridge,
  GhostteaConfigEditorBridge,
} from "@vibecook/ghosttea-react/workspace";

export {};

declare global {
  interface Window {
    desktop: {
      platform: string;
      tabId: string;
      claimExistingSessions: boolean;
      initialCwd?: string;
      defaultShell: string;
      openExternal: (url: string) => Promise<void>;
      writeClipboard: (text: string) => void;
      readClipboard: () => Promise<string>;
      setTerminalCanCopy: (canCopy: boolean) => void;
      showContextMenu: (canCopy: boolean) => void;
      toggleFullscreen: () => void;
      closeWindow: () => void;
      newWindow: (cwd?: string) => void;
      quit: () => void;
      closeAllWindows: () => void;
      openConfig: () => void;
      reloadConfig: () => void;
      saveAppearance?: (update: GhostteaAppearanceUpdate) => Promise<void>;
      configEditor?: GhostteaConfigEditorBridge;
      backdropBlur?: GhostteaBackdropBlurBridge;
      newTab: (cwd?: string) => void;
      selectTab: (target: "previous" | "next" | "last" | number) => void;
      closeTab: () => void;
      closePaneSession: (sessionId: string, remainingSessionIds: readonly string[]) => void;
      updateTabSessions: (sessionIds: readonly string[]) => void;
      updateActiveCwd: (cwd?: string) => void;
      onMenuAction: (listener: (action: "copy" | "paste" | "select-all" | "clear-screen") => void) => () => void;
    };
  }
}
