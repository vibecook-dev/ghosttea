/**
 * Workspace command DTOs and stable `ghosttea.workspace.*` command IDs.
 *
 * Binding match + route live in `../bindings/`. This module is the workspace
 * facade used by GhostteaWorkspace and the desktop/iOS conformance fixture.
 */

import {
  resolveKeyEvent,
  routeConsumesInput,
  workspaceEffectFromAction,
  workspaceEffectFromGhosttyAction,
  type PlatformEffect,
  type RoutedAction,
  type WorkspaceEffect,
} from "../bindings/action-route.js";
import type { GhostteaBindingAction, GhosttyAction } from "../bindings/ghostty-actions.js";
import type { KeyEventLike } from "../bindings/ghostty-triggers.js";
import type { SplitAxis } from "./pane-layout.js";

/** @deprecated Prefer WorkspaceEffect; alias kept for public API stability. */
export type GhosttyHotkey = WorkspaceEffect;

export type { WorkspaceEffect };

export type WorkspaceCommandId =
  | "ghosttea.workspace.remote-sessions"
  | "ghosttea.workspace.new-tab"
  | "ghosttea.workspace.select-tab"
  | "ghosttea.workspace.close-tab"
  | "ghosttea.workspace.split"
  | "ghosttea.workspace.focus-relative"
  | "ghosttea.workspace.focus-direction"
  | "ghosttea.workspace.resize"
  | "ghosttea.workspace.equalize"
  | "ghosttea.workspace.toggle-zoom"
  | "ghosttea.workspace.close-pane";

export function workspaceCommandId(command: WorkspaceEffect): WorkspaceCommandId {
  return `ghosttea.workspace.${command.type}`;
}

export function workspaceHotkeyFromAction(action: GhostteaBindingAction): WorkspaceEffect | null {
  return workspaceEffectFromAction(action);
}

export function workspaceHotkeyFromGhosttyAction(action: GhosttyAction): WorkspaceEffect | null {
  return workspaceEffectFromGhosttyAction(action);
}

/**
 * Resolve a keyboard event to a workspace command only.
 * Terminal/platform/unhandled routes return null (see `resolveKeyEvent`).
 */
export function ghosttyHotkey(event: KeyEventLike, platform: string = "darwin"): WorkspaceEffect | null {
  const routed = resolveKeyEvent(event, {
    extensions: true,
    platform,
    scopes: ["workspace"],
  });
  return routed?.kind === "workspace" ? routed.command : null;
}

/** What decides whether the workspace can perform a binding's command or platform effect now. */
export interface WorkspaceBindingState {
  /** The panes in the layout. */
  readonly panes: number;
  /** Whether the active pane is one of them. */
  readonly activePane: boolean;
  /** Whether the workspace offers remote sessions. */
  readonly remoteSessions: boolean;
  /** Which optional host hooks the platform gives. */
  readonly hooks: Readonly<Record<"newTab" | "selectTab" | "closeTab" | "newWindow" | "openConfig", boolean>>;
}

/**
 * Whether the workspace can perform a command now, as Ghostty's GTK apprt
 * decides it:
 *
 * - A tab command needs its host hook, and `selectTab` may still report that
 *   the tab did not change (GTK window.zig:557).
 * - Going to, resizing or zooming a split needs a split: two or more panes,
 *   one of them active (GTK application.zig:2509, :2691, "If the tree has no
 *   splits (only one leaf), this action is not performable"). With a split a
 *   goto always has a target, because it wraps, and a resize always counts,
 *   even with no split on its axis to move (GTK split_tree.zig:288-330).
 * - Remote sessions need the workspace to offer them.
 *
 * Splitting, equalizing and closing a pane always can.
 */
export function workspaceCommandPerformable(command: WorkspaceEffect, state: WorkspaceBindingState): boolean {
  switch (command.type) {
    case "new-tab":
      return state.hooks.newTab;
    case "select-tab":
      return state.hooks.selectTab;
    case "close-tab":
      return state.hooks.closeTab;
    case "remote-sessions":
      return state.remoteSessions;
    case "focus-relative":
    case "focus-direction":
    case "resize":
    case "toggle-zoom":
      return state.panes >= 2 && state.activePane;
    case "split":
    case "equalize":
    case "close-pane":
      return true;
  }
}

/**
 * Whether the host can perform a platform effect: a new window needs
 * `newWindow` or `newTab`, and opening the config needs `openConfig`. The
 * others fall back to closing the window or to the runtime's config reload.
 */
export function platformEffectPerformable(effect: PlatformEffect, state: WorkspaceBindingState): boolean {
  if (effect.type === "new_window") return state.hooks.newWindow || state.hooks.newTab;
  if (effect.type === "open_config") return state.hooks.openConfig;
  return true;
}

/** Runs what `state` says the workspace can perform. */
export interface WorkspaceBindingHost {
  readonly state: WorkspaceBindingState;
  /** Returns false when the command changed nothing: a `selectTab` that reports the tab did not change. */
  workspace(command: WorkspaceEffect): boolean | void;
  platform(effect: PlatformEffect): void;
}

/**
 * Runs a binding the workspace owns, when it can be performed, and says
 * whether its key is consumed. A key that is not goes on to the focused
 * surface, which sends it to the terminal: an `unconsumed:` bind's, after its
 * action, and a `performable:` bind's whose action was not performed (a single
 * pane, a tab switch to the same tab, a missing host hook). Any other bind
 * consumes its key, performed or not, so app shortcuts never leak to the PTY;
 * an unhandled action is never performed.
 */
export function runWorkspaceBinding(
  routed: Exclude<RoutedAction, { kind: "terminal" }>,
  host: WorkspaceBindingHost,
): boolean {
  let performed = false;
  if (routed.kind === "workspace") {
    performed = workspaceCommandPerformable(routed.command, host.state) && host.workspace(routed.command) !== false;
  } else if (routed.kind === "platform") {
    performed = platformEffectPerformable(routed.effect, host.state);
    if (performed) host.platform(routed.effect);
  }
  return routeConsumesInput(routed, performed);
}

/** Type-level check that workspace axes stay aligned with pane-layout. */
export type _AssertSplitAxis = Extract<WorkspaceEffect, { type: "split" }>["axis"] extends SplitAxis ? true : never;
