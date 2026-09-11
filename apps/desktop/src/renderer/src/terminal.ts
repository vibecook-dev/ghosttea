import { createGhostteaTerminalRuntime, waitForGhostteaRendererPorts } from "@vibecook/ghosttea-react";

export const terminalRuntime = createGhostteaTerminalRuntime({
  ports: waitForGhostteaRendererPorts(),
  clientBuild: "ghosttea-desktop",
  sessionOwnerId: window.desktop.tabId,
  platform: {
    openExternal: (url) => window.desktop.openExternal(url),
    writeClipboard: (text) => window.desktop.writeClipboard(text),
    forceCanvasFallback: () => sessionStorage.getItem("ghosttea:force-canvas-fallback") === "1",
    setForceCanvasFallback: (enabled) => {
      if (enabled) sessionStorage.setItem("ghosttea:force-canvas-fallback", "1");
      else sessionStorage.removeItem("ghosttea:force-canvas-fallback");
    },
    reload: () => window.location.reload(),
  },
});

window.addEventListener("beforeunload", () => terminalRuntime.dispose(), { once: true });
