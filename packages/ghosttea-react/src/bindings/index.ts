export {
  formatGhosttyAction,
  parseGhosttyAction,
  parseGhostteaBindingAction,
  decodeZigStringLiteral,
  type GhostteaBindingAction,
  type GhostteaExtensionAction,
  type GhosttyAction,
} from "./ghostty-actions.js";

export {
  GHOSTTEA_BINDING_EXTENSIONS,
  GHOSTTY_LINUX_DEFAULT_BINDINGS,
  GHOSTTY_MACOS_DEFAULT_BINDINGS,
  defaultBindingsForPlatform,
  configuredBindingsForPlatform,
  keyboardDefaultBindings,
  matchGhostteaBinding,
  matchGhostteaBindingEntry,
  matchGhosttyBinding,
  matchGhosttyBindingEntry,
  isKeyboardBinding,
  synthesizeEventForBinding,
  type BindingPlatform,
  type GhostteaBindingMatch,
  type GhostteaExtensionEntry,
  type GhosttyBindingEntry,
  type GhosttyBindingFlags,
  type MatchBindingOptions,
} from "./ghostty-bindings.js";

export {
  formatGhosttyTrigger,
  parseGhosttyTrigger,
  synthesizeKeyEvent,
  triggerMatchesEvent,
  eventMods,
  type GhosttyMods,
  type GhosttyTrigger,
  type KeyEventLike,
} from "./ghostty-triggers.js";

export {
  bindingKeyDisposition,
  platformEffectFromAction,
  resolveKeyEvent,
  routeBindingAction,
  routeConsumesInput,
  terminalEffectFromAction,
  workspaceEffectFromAction,
  workspaceEffectFromGhosttyAction,
  type BindingKeyDisposition,
  type PlatformEffect,
  type ResolveKeyEventOptions,
  type RoutedAction,
  type TerminalEffect,
  type WorkspaceEffect,
  type WorkspaceSplitAxis,
} from "./action-route.js";
