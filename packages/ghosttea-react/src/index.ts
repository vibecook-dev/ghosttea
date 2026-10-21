export { GhostteaProvider, useGhostteaRuntime, type GhostteaProviderProps } from "./context.js";
export {
  TerminalSurface,
  type TerminalInputPolicy,
  type TerminalMenuAction,
  type TerminalSurfaceProps,
} from "./TerminalSurface.js";
export {
  expireRoutedActivationLeases,
  initialRoutedActivation,
  reduceRoutedActivation,
  type RoutedActivationEvent,
  type RoutedActivationPhase,
  type RoutedActivationState,
  type RoutedInputPolicy,
} from "./routed-activation.js";
export { rendererTheme, terminalEffectsFromConfig, terminalThemeFromConfig } from "./config.js";
export {
  GhostteaTerminalRuntime,
  createGhostteaTerminalRuntime,
  waitForGhostteaRendererPorts,
  type GhostteaRendererPlatform,
  type GhostteaRendererPorts,
  type GhostteaPortTerminalRuntimeOptions,
  type GhostteaRoutedHost,
  type GhostteaRoutedTerminalRuntimeOptions,
  type GhostteaTerminalRuntimeOptions,
  type RoutedExtensionMessageContext,
  type RoutedSessionEvent,
  type RoutedTerminalInputContext,
  type RoutedTerminalInputOperation,
  sessionIsFrozen,
  showsStaleScreen,
  type RemoteInputSuppression,
  type RemoteSessionRuntimeState,
  type RoutedGeometryHolderChange,
  type RoutedGeometryHolderState,
  type SelectionScope,
  type TerminalMount,
} from "./runtime.js";
export {
  CELL_WIDTH,
  DEFAULT_EFFECTS,
  DEFAULT_THEME,
  LINE_HEIGHT,
  ORIGIN_X,
  ORIGIN_Y,
  type CellPoint,
  type CellSelection,
  type TerminalEffects,
  type TerminalShaderEffect,
  type TerminalTheme,
} from "./renderers/types.js";
export type {
  TerminalRenderCounterSnapshot,
  TerminalRenderMetrics,
  TerminalRenderPerformanceSnapshot,
} from "./performance.js";
