export { GhostteaElectronBackend, type GhostteaElectronBackendOptions } from "./backend.js";
export {
  GhostteaAutomationClient,
  GhostteaConfigDocumentConflictError,
  type AutomationInputResult,
  type GhostteaAutomationClientOptions,
  type GhostteaControlCommand,
  type GhostteaControlConnection,
  type SessionExitedEvent,
} from "./automation.js";
export { GhostteaElectronBridge, type GhostteaElectronBridgeOptions } from "./bridge.js";
export { installGhostteaClipboardHost, type GhostteaClipboardHost } from "./clipboard.js";
export { allSettledWithin } from "./deadline.js";
export {
  ghostteaEditCommand,
  installGhostteaEditShortcuts,
  type GhostteaEditCommand,
  type GhostteaKeyInput,
} from "./edit-commands.js";
export { TerminalSupervisor, type GhostteaBinary, type TerminalSupervisorOptions } from "./supervisor.js";
export type { TerminalDaemonConnection } from "./types.js";

export { installGhostteaLinkHost } from "./links.js";
