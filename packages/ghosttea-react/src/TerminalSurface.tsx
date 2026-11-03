import { useTerminalLinks } from "./use-terminal-links.js";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ClipboardEvent, CSSProperties, KeyboardEvent, PointerEvent, WheelEvent } from "react";
import type { SessionSummary, TerminalKeyEvent, TerminalScrollbarState } from "@vibecook/ghosttea-protocol";
import { useGhostteaRuntime } from "./context.js";
import { terminalKeyboardLayout, terminalKeyDown, terminalKeyUp } from "./keyboard-input.js";
import { bindingKeyDisposition, type TerminalEffect } from "./bindings/action-route.js";
import { resolveTerminalBinding, type ResolvedTerminalBinding } from "./terminal-bindings.js";
import type { GhosttyBindingEntry } from "./bindings/ghostty-bindings.js";
import { parseGhosttyTrigger, triggerMatchesEvent, type KeyEventLike } from "./bindings/ghostty-triggers.js";
import {
  CELL_WIDTH,
  DEFAULT_EFFECTS,
  LINE_HEIGHT,
  ORIGIN_X,
  ORIGIN_Y,
  type CellPoint,
  type TerminalEffects,
  type TerminalTheme,
} from "./renderers/types.js";
import { accumulateWheelRows, wheelDeltaPixels } from "./scroll-input.js";
import { adjustSelectionFocus, usesLocalSelection } from "./selection-input.js";
import {
  attachTerminalTextInput,
  TerminalTextInput,
  terminalEditKeyEvents,
  type TerminalTextInputAction,
  type TerminalTextInputSink,
  type TerminalTextKeyEventLike,
} from "./text-input.js";
import type { GhostteaTerminalRuntime } from "./runtime.js";

export type TerminalMenuAction = "copy" | "paste" | "select-all" | "clear-screen";
export type TerminalInputPolicy = "inherit" | "read-only";

/** What decides whether a surface's focus gain takes the geometry seat. */
export interface SurfaceFocusPolicy {
  /** The host opted in (`takeGeometryOnFocus`). */
  takeGeometryOnFocus: boolean;
  /** The surface controls resize; a mirror does not. */
  controlsResize: boolean;
  /** The surface takes input; a read-only view is never a controller. */
  interactive: boolean;
}

/**
 * Whether a focus change takes the geometry seat: only a focus gain, only when
 * the host opted in, and only for a surface that controls resize and takes
 * input. A `controlsResize: false` mirror never does.
 */
export function focusTakesGeometry(focused: boolean, wasFocused: boolean, policy: SurfaceFocusPolicy): boolean {
  return focused && !wasFocused && policy.takeGeometryOnFocus && policy.controlsResize && policy.interactive;
}

/**
 * Whether a press takes the geometry seat: a press of a surface that already
 * has focus, under a focus gain's own policy. A press of an unfocused surface
 * focuses it, and that gain takes. A press of a focused one changes no focus, so
 * without this a pane whose seat another client took while this window kept its
 * focus (a phone's take) could not be taken back by pressing it.
 */
export function pressTakesGeometry(wasFocused: boolean, policy: SurfaceFocusPolicy): boolean {
  return wasFocused && policy.takeGeometryOnFocus && policy.controlsResize && policy.interactive;
}

/** A press of the surface, reported before it moves focus: the seat is taken at
 * the surface's current grid when `pressTakesGeometry` says so. */
export function syncSurfacePress(
  runtime: Pick<GhostteaTerminalRuntime, "takeResizeControl">,
  surface: { sessionHandle: string; viewId: string; cols: number; rows: number },
  wasFocused: boolean,
  policy: SurfaceFocusPolicy,
): void {
  if (pressTakesGeometry(wasFocused, policy)) {
    runtime.takeResizeControl(surface.sessionHandle, surface.viewId, surface.cols, surface.rows);
  }
}

/**
 * The surface's focus report. Focus always reaches the runtime as a
 * scheduling fact; the seat is taken only when `focusTakesGeometry` says so,
 * at the surface's current grid.
 */
export function syncSurfaceFocus(
  runtime: Pick<GhostteaTerminalRuntime, "setFocused" | "takeResizeControl">,
  surface: { sessionHandle: string; viewId: string; cols: number; rows: number },
  focused: boolean,
  wasFocused: boolean,
  policy: SurfaceFocusPolicy,
): void {
  runtime.setFocused(surface.sessionHandle, surface.viewId, focused, surface.cols, surface.rows);
  if (focusTakesGeometry(focused, wasFocused, policy)) {
    runtime.takeResizeControl(surface.sessionHandle, surface.viewId, surface.cols, surface.rows);
  }
}

/**
 * Who takes a keydown on the surface, in order: the text system when an IME or
 * another text service processed it (its result arrives as composition or
 * input events, so the terminal neither encodes nor prevents it), a terminal
 * binding, or else the terminal, as a key.
 */
export type SurfaceKeyDownRoute =
  | { readonly type: "text-system" }
  | { readonly type: "binding"; readonly binding: ResolvedTerminalBinding }
  | { readonly type: "terminal" };

export function routeSurfaceKeyDown(
  event: TerminalTextKeyEventLike & KeyEventLike,
  textInput: TerminalTextInput,
  platform: string | undefined,
  bindings: readonly GhosttyBindingEntry[] | undefined,
): SurfaceKeyDownRoute {
  if (textInput.keyDown(event)) return { type: "text-system" };
  // Terminal-scoped Ghostty binds only (workspace/platform/unhandled owned by Workspace).
  const binding = resolveTerminalBinding(event, platform, bindings);
  return binding ? { type: "binding", binding } : { type: "terminal" };
}

/**
 * What running a terminal binding's effect did: Ghostty's performed or not,
 * or, for a paste on a host without `readClipboard`, left to the keydown's
 * default action. That is the platform's own paste only when the keydown is
 * one of its paste chords (`isPlatformPasteChord`), and only then is it left
 * unprevented; any other chord counts it unperformed.
 */
export type TerminalEffectOutcome = "performed" | "unperformed" | "default-action";

/** What the surface's effects depend on. */
export interface TerminalEffectState {
  readonly hasSelection: boolean;
  readonly interactive: boolean;
  /** The host gave the surface `readClipboard`. */
  readonly readsClipboard: boolean;
}

/**
 * Whether the surface can perform a terminal binding's effect now, as Ghostty
 * decides it for the same actions: copying, adjusting or scrolling to a
 * selection needs one (Surface.zig: "If we don't have a selection we do not
 * perform this action, allowing the keybind to fall through to the terminal"),
 * text and pastes need a surface that takes input, and a host without
 * `readClipboard` leaves its paste to the keydown's default action, which
 * `handleSurfaceKeyDown` honours only for the platform's paste chords.
 */
export function terminalEffectAvailability(effect: TerminalEffect, state: TerminalEffectState): TerminalEffectOutcome {
  switch (effect.type) {
    case "copy":
    case "adjust_selection":
    case "scroll_to_selection":
      return state.hasSelection ? "performed" : "unperformed";
    case "paste":
      if (!state.interactive) return "unperformed";
      return state.readsClipboard ? "performed" : "default-action";
    case "text":
      return state.interactive ? "performed" : "unperformed";
    default:
      return "performed";
  }
}

/** Whether the platform's key bindings are macOS's, as the binding tables choose them: darwin, or unknown. */
function macKeyboard(platform: string | undefined): boolean {
  return platform !== "linux" && platform !== "win32";
}

const MAC_PASTE_CHORDS = ["super+v", "super+shift+v"].map(parseGhosttyTrigger);
const PC_PASTE_CHORDS = ["ctrl+v", "ctrl+shift+v", "shift+insert"].map(parseGhosttyTrigger);

/**
 * Whether a text field's default action for this keydown is a paste: Cmd+V or
 * Cmd+Shift+V on macOS; Ctrl+V, Ctrl+Shift+V or Shift+Insert elsewhere. Only
 * these may be left to the platform when the host gives no `readClipboard`;
 * another chord's default would type its text instead (Option+V types "√").
 */
export function isPlatformPasteChord(event: KeyEventLike, platform: string | undefined): boolean {
  return (macKeyboard(platform) ? MAC_PASTE_CHORDS : PC_PASTE_CHORDS).some((chord) =>
    triggerMatchesEvent(chord, event),
  );
}

/**
 * A macOS Cmd chord that would type its text on a session host that is not
 * macOS. Ghostty on macOS encodes no legacy text for Cmd+key
 * (key_encode.zig:543-545, `builtin.os.tag == .macos and all_mods.super`), but
 * the session's daemon encodes the key, and a remote session's daemon on Linux
 * or Windows types the letter. Ctrl takes Ghostty's CSI u path first, so a
 * chord with Ctrl is not one. A stopgap until a key carries the client's
 * platform to the host.
 */
export function isMacCommandText(
  event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey">,
  platform: string | undefined,
): boolean {
  if (!macKeyboard(platform) || !event.metaKey || event.ctrlKey) return false;
  const chars = [...event.key];
  return chars.length === 1 && !/\p{Cc}/u.test(event.key);
}

/** The keydown fields the surface reads: the text system's, a binding's and the terminal key's. */
export type SurfaceKeyboardEventLike = TerminalTextKeyEventLike &
  KeyEventLike &
  Pick<KeyboardEvent, "code" | "location" | "repeat" | "timeStamp">;

/** The event's dispatch controls. For a React handler, its synthetic event. */
export interface SurfaceKeyDispatch {
  preventDefault(): void;
  stopPropagation(): void;
}

/** What a keydown on the surface reaches. */
export interface SurfaceKeyInput {
  readonly textInput: TerminalTextInput;
  readonly platform: string | undefined;
  readonly bindings: readonly GhosttyBindingEntry[] | undefined;
  /** Whether the surface takes input. A read-only surface sends no key. */
  readonly interactive: boolean;
  readonly runtime: Pick<GhostteaTerminalRuntime, "sendKey" | "interrupt">;
  readonly surface: { readonly sessionId: string; readonly viewId: string };
  /** The presses sent to the terminal, by `code`, so that each one's release follows it. */
  readonly forwardedKeys: Map<string, TerminalKeyEvent>;
  executeEffect(effect: TerminalEffect): TerminalEffectOutcome;
  /** Ends the view's selection, as typing does. */
  clearSelection(): void;
}

/**
 * What became of a keydown: left to the text system, taken by a binding, left
 * to its default action (a binding's paste), withheld (a macOS Cmd chord a
 * performable binding could not act on), prevented on a read-only surface,
 * sent as the interrupt, or sent as a key.
 */
export type SurfaceKeyDownOutcome =
  "text-system" | "binding" | "default-action" | "withheld" | "read-only" | "interrupt" | "key";

/** The physical modifier keys, which Ghostty's `Key.modifier` names. Firefox before 118 called Meta "OS". */
const MODIFIER_CODES: ReadonlySet<string> = new Set([
  "ShiftLeft",
  "ShiftRight",
  "ControlLeft",
  "ControlRight",
  "AltLeft",
  "AltRight",
  "MetaLeft",
  "MetaRight",
  "OSLeft",
  "OSRight",
]);

/** A modifier pressed alone: it is sent to the terminal but, as in Ghostty, it is not typing. */
export function isModifierKey(event: Pick<KeyboardEvent, "code">): boolean {
  return MODIFIER_CODES.has(event.code);
}

/**
 * The keydown the surface sends as the session's interrupt (ETX): Ctrl+C, and
 * only the chord Ghostty encodes as ETX. Alt only prefixes ESC there, but with
 * Shift or Super added Ghostty no longer takes it for a control character and
 * encodes it as a key (CSI u), so Ctrl+Shift+C reaches the encoder.
 */
export function isTerminalInterrupt(
  event: Pick<KeyboardEvent, "key" | "ctrlKey" | "altKey" | "shiftKey" | "metaKey">,
): boolean {
  return event.ctrlKey && !event.altKey && !event.shiftKey && !event.metaKey && event.key.toLowerCase() === "c";
}

/**
 * Handles a keydown on the surface as Ghostty's `Surface.keyCallback` does:
 * the text system's keydowns are its own; a terminal binding's effect runs, and
 * the key ends there unless the binding does not consume it. An `unconsumed:`
 * bind's key, after its effect, and a `performable:` bind's whose effect could
 * not be performed (no selection to copy or adjust) go on as the key, exactly
 * as an unbound key does: nothing on a read-only surface, the selection ended
 * unless it is a modifier alone, then the interrupt or the key, its release
 * paired through `forwardedKeys`.
 *
 * One exception: a macOS Cmd chord with text that a performable bind could not
 * act on (Cmd+C or Cmd+J with no selection) is withheld, because
 * the session may live on a host whose encoder types its letter
 * (`isMacCommandText`). A macOS host would encode nothing for it in legacy
 * mode anyway.
 */
export function handleSurfaceKeyDown(
  event: SurfaceKeyboardEventLike,
  dispatch: SurfaceKeyDispatch,
  input: SurfaceKeyInput,
): SurfaceKeyDownOutcome {
  const route = routeSurfaceKeyDown(event, input.textInput, input.platform, input.bindings);
  if (route.type === "text-system") return "text-system";
  let withhold = false;
  if (route.type === "binding") {
    const { effect, flags } = route.binding;
    const outcome = input.executeEffect(effect);
    if (outcome === "default-action" && isPlatformPasteChord(event, input.platform)) return "default-action";
    const performed = outcome === "performed";
    if (bindingKeyDisposition(flags, performed) === "consume") {
      dispatch.preventDefault();
      dispatch.stopPropagation();
      return "binding";
    }
    withhold = flags.performable && !performed && flags.unconsumed !== true && isMacCommandText(event, input.platform);
  }

  if (!input.interactive) {
    dispatch.preventDefault();
    return "read-only";
  }
  if (withhold) {
    dispatch.preventDefault();
    dispatch.stopPropagation();
    return "withheld";
  }
  if (!isModifierKey(event)) input.clearSelection();
  const { sessionId, viewId } = input.surface;
  if (isTerminalInterrupt(event)) {
    input.runtime.interrupt(sessionId, viewId);
    dispatch.preventDefault();
    dispatch.stopPropagation();
    return "interrupt";
  }
  const terminalEvent = terminalKeyDown(event);
  input.runtime.sendKey(sessionId, viewId, terminalEvent);
  input.forwardedKeys.set(event.code, terminalEvent);
  dispatch.preventDefault();
  dispatch.stopPropagation();
  return "key";
}

/** Sends the release of a press the surface sent, once. A release of anything else is not the terminal's. */
export function handleSurfaceKeyUp(
  event: Parameters<typeof terminalKeyUp>[1],
  dispatch: SurfaceKeyDispatch,
  input: Pick<SurfaceKeyInput, "runtime" | "surface" | "forwardedKeys">,
): boolean {
  const pressed = input.forwardedKeys.get(event.code);
  if (!pressed) return false;
  input.forwardedKeys.delete(event.code);
  input.runtime.sendKey(input.surface.sessionId, input.surface.viewId, terminalKeyUp(pressed, event));
  dispatch.preventDefault();
  dispatch.stopPropagation();
  return true;
}

/**
 * Sends the text system's input to the terminal as typing: it clears the
 * view's selection, as a forwarded key does, then sends each action in order
 * through typing's verbs. Committed text is text, a paste or drop is a paste,
 * and an edit key is the press and release the physical key sends.
 */
export function commitTerminalTextInput(
  runtime: Pick<GhostteaTerminalRuntime, "setSelection" | "sendText" | "paste" | "sendKey">,
  surface: { sessionId: string; sessionHandle: string; viewId: string },
  actions: readonly TerminalTextInputAction[],
  timestamp: number,
): void {
  runtime.setSelection(surface.sessionHandle, null, surface.viewId);
  for (const action of actions) {
    if (action.type === "text") {
      runtime.sendText(surface.sessionId, surface.viewId, action.text);
    } else if (action.type === "paste") {
      runtime.paste(surface.sessionId, surface.viewId, action.text);
    } else {
      for (const event of terminalEditKeyEvents(action.key, timestamp)) {
        runtime.sendKey(surface.sessionId, surface.viewId, event);
      }
    }
  }
}

export interface TerminalSurfaceProps {
  session: SessionSummary;
  theme: TerminalTheme;
  effects?: TerminalEffects;
  bindings?: readonly GhosttyBindingEntry[];
  active?: boolean;
  /** Host platform used for Ghostty-compatible application keybindings. */
  platform?: string;
  /** Whether the surface is currently visible enough to spend GPU work painting it. */
  visible?: boolean;
  controlsResize?: boolean;
  /**
   * Take the session's geometry seat each time this surface gains focus, so
   * the pane focused last sizes the PTY, whichever window or device it is on
   * (last write wins). Off by default: focus alone is a scheduling fact and
   * never changes geometry. It applies only while `controlsResize` is true
   * and the surface takes input; a mirror never claims, takes or resizes on
   * focus. The host owns this policy; the runtime verb is
   * `takeResizeControl`.
   */
  takeGeometryOnFocus?: boolean;
  /** Viewer-local input fence. It can make a writable session read-only but never grants server rights. */
  inputPolicy?: TerminalInputPolicy;
  /** Convenience alias for `inputPolicy="read-only"` when false. */
  readWrite?: boolean;
  onActivate?: () => void;
  readClipboard?: () => string | Promise<string>;
  onCopyAvailabilityChange?: (canCopy: boolean) => void;
  onContextMenu?: (canCopy: boolean) => void;
  onToggleFullscreen?: () => void;
  onMenuAction?: (listener: (action: TerminalMenuAction) => void) => () => void;
}

export function viewportSelection(
  selection: { anchor: CellPoint; focus: CellPoint } | null,
  scrollbar: TerminalScrollbarState,
  cols: number,
  rows: number,
): { anchor: CellPoint; focus: CellPoint } | null {
  if (!selection) return null;
  const forward =
    selection.anchor.row < selection.focus.row ||
    (selection.anchor.row === selection.focus.row && selection.anchor.column <= selection.focus.column);
  const start = forward ? selection.anchor : selection.focus;
  const end = forward ? selection.focus : selection.anchor;
  const viewportStart = scrollbar.offset;
  const viewportEnd = viewportStart + rows - 1;
  if (end.row < viewportStart || start.row > viewportEnd) return null;
  return {
    anchor: {
      column: start.row < viewportStart ? 0 : start.column,
      row: Math.max(0, start.row - viewportStart),
    },
    focus: {
      column: end.row > viewportEnd ? Math.max(0, cols - 1) : end.column,
      row: Math.min(rows - 1, end.row - viewportStart),
    },
  };
}

export function TerminalSurface(props: TerminalSurfaceProps) {
  const { session } = props;
  return <TerminalSurfaceSession key={`${session.id}:${session.handle}`} {...props} />;
}

function TerminalSurfaceSession({
  session,
  theme,
  effects = DEFAULT_EFFECTS,
  bindings,
  active = true,
  platform,
  visible = true,
  controlsResize = active,
  takeGeometryOnFocus = false,
  inputPolicy = "inherit",
  readWrite = true,
  onActivate,
  readClipboard,
  onCopyAvailabilityChange,
  onContextMenu,
  onToggleFullscreen: _onToggleFullscreen,
  onMenuAction,
}: TerminalSurfaceProps) {
  // Fullscreen is owned by Workspace platform routing (toggle_fullscreen).
  void _onToggleFullscreen;
  const terminalRuntime = useGhostteaRuntime();
  const clientReadWrite = readWrite && inputPolicy !== "read-only";
  const interactive = session.readWrite && clientReadWrite;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const gridRef = useRef({ cols: session.cols, rows: session.rows });
  const links = useTerminalLinks(terminalRuntime, session.handle, inputRef, gridRef, platform, visible);
  const controlsResizeRef = useRef(controlsResize);
  const clientReadWriteRef = useRef(clientReadWrite);
  // Read by the focus sync, so that a policy change does not re-run it and
  // flap focus at the runtime.
  const interactiveRef = useRef(interactive);
  const takeGeometryOnFocusRef = useRef(takeGeometryOnFocus);
  // The focus last reported, so that only a gain can take the seat.
  const focusedRef = useRef(false);
  const [viewId] = useState(() => crypto.randomUUID());
  const [inputFocused, setInputFocused] = useState(false);
  const [copyError, setCopyError] = useState<string>();
  useEffect(() => {
    if (!copyError) return;
    const timer = setTimeout(() => setCopyError(undefined), 5_000);
    return () => clearTimeout(timer);
  }, [copyError]);
  const reportCopyError = useCallback((error: unknown) => {
    setCopyError(error instanceof Error ? error.message : "Terminal copy failed. Try again.");
  }, []);
  const selectionAnchorRef = useRef<CellPoint | null>(null);
  const selectionRef = useRef<{ anchor: CellPoint; focus: CellPoint } | null>(null);
  const selectionAllRef = useRef(false);
  const pointerModeRef = useRef<"mouse" | "selection" | "link" | null>(null);
  const wheelDeltaRef = useRef(0);
  const pendingScrollRowsRef = useRef(0);
  const scrollFrameRef = useRef<number | null>(null);
  const pendingScrollToRef = useRef<number | null>(null);
  const scrollToFrameRef = useRef<number | null>(null);
  const scrollbarHideTimerRef = useRef<number | null>(null);
  const selectionAutoScrollTimerRef = useRef<number | null>(null);
  const selectionAutoScrollEdgeRef = useRef<{ direction: -1 | 1; column: number } | null>(null);
  const scrollbarDragRef = useRef<{
    pointerId: number;
    startY: number;
    startOffset: number;
    maxOffset: number;
    travel: number;
  } | null>(null);
  const forwardedKeysRef = useRef(new Map<string, TerminalKeyEvent>());
  // What the platform's text system puts in the textarea: IME commits, the
  // emoji pickers, voice typing, soft keyboards, drops.
  const [textInput] = useState(() => new TerminalTextInput());
  const restoreInputFocusRef = useRef(false);
  const [scrollbar, setScrollbar] = useState<TerminalScrollbarState>(
    () =>
      terminalRuntime.scrollbar(session.handle) ?? {
        total: session.rows,
        offset: 0,
        length: session.rows,
      },
  );
  const scrollbarRef = useRef(scrollbar);
  const [scrollbarVisible, setScrollbarVisible] = useState(false);

  useEffect(() => {
    controlsResizeRef.current = controlsResize;
    clientReadWriteRef.current = clientReadWrite;
    interactiveRef.current = interactive;
    takeGeometryOnFocusRef.current = takeGeometryOnFocus;
  }, [clientReadWrite, controlsResize, interactive, takeGeometryOnFocus]);

  const setLocalSelection = useCallback(
    (selection: { anchor: CellPoint; focus: CellPoint } | null, selectAll = false): void => {
      selectionRef.current = selection;
      selectionAllRef.current = selection !== null && selectAll;
      onCopyAvailabilityChange?.(selection !== null);
    },
    [onCopyAvailabilityChange],
  );

  useEffect(() => {
    if (!onCopyAvailabilityChange) return;
    onCopyAvailabilityChange(selectionRef.current !== null);
    return () => onCopyAvailabilityChange(false);
  }, [onCopyAvailabilityChange]);

  const releaseForwardedKeys = useCallback((): void => {
    for (const event of forwardedKeysRef.current.values()) {
      terminalRuntime.sendKey(session.id, viewId, {
        ...event,
        type: "up",
        repeat: false,
        timestamp: performance.now(),
      });
    }
    forwardedKeysRef.current.clear();
  }, [session.id, terminalRuntime, viewId]);

  useEffect(() => {
    terminalRuntime.setTheme(session.handle, theme, viewId);
  }, [session.handle, terminalRuntime, theme, viewId]);

  useEffect(() => {
    terminalRuntime.setEffects(session.handle, effects, viewId);
  }, [effects, session.handle, terminalRuntime, viewId]);

  useEffect(() => {
    void terminalKeyboardLayout.refresh();
  }, []);

  const executeTerminalEffect = useCallback(
    (effect: TerminalEffect): TerminalEffectOutcome => {
      const { cols, rows } = gridRef.current;
      const total = Math.max(rows, scrollbarRef.current.total);
      const viewportLen = Math.max(1, scrollbarRef.current.length || rows);
      const selection = selectionRef.current;
      const availability = terminalEffectAvailability(effect, {
        hasSelection: selection !== null,
        interactive,
        readsClipboard: readClipboard !== undefined,
      });
      if (availability !== "performed") return availability;

      if (effect.type === "copy" && selection) {
        setCopyError(undefined);
        void terminalRuntime
          .copySelection(session.id, viewId, selection, selectionAllRef.current)
          .catch(reportCopyError);
        return "performed";
      }
      if (effect.type === "select_all") {
        setLocalSelection({ anchor: { column: 0, row: 0 }, focus: { column: cols - 1, row: total - 1 } }, true);
        terminalRuntime.setSelection(
          session.handle,
          viewportSelection(selectionRef.current, scrollbarRef.current, cols, rows),
          viewId,
        );
        return "performed";
      }
      if (effect.type === "paste") {
        void Promise.resolve(readClipboard?.())
          .then((text) => {
            if (!text) return;
            selectionAnchorRef.current = null;
            setLocalSelection(null);
            terminalRuntime.setSelection(session.handle, null, viewId);
            terminalRuntime.paste(session.id, viewId, text);
          })
          .catch((error: unknown) => console.error("[terminal-runtime] clipboard paste failed", error));
        return "performed";
      }
      if (effect.type === "text" || effect.type === "clear_screen") {
        selectionAnchorRef.current = null;
        setLocalSelection(null);
        terminalRuntime.setSelection(session.handle, null, viewId);
        terminalRuntime.sendText(session.id, viewId, effect.type === "clear_screen" ? "\u000c" : effect.text);
        return "performed";
      }
      if (effect.type === "scroll_to_top") {
        terminalRuntime.scrollTo(session.id, viewId, 0);
        return "performed";
      }
      if (effect.type === "scroll_to_bottom") {
        terminalRuntime.scrollTo(session.id, viewId, Math.max(0, total - viewportLen));
        return "performed";
      }
      if (effect.type === "scroll_to_row") {
        terminalRuntime.scrollTo(session.id, viewId, Math.max(0, effect.row));
        return "performed";
      }
      if (effect.type === "scroll_to_selection" && selection) {
        const row = Math.min(selection.anchor.row, selection.focus.row);
        terminalRuntime.scrollTo(session.id, viewId, Math.max(0, row));
        return "performed";
      }
      if (effect.type === "scroll_page_up") {
        terminalRuntime.scroll(session.id, viewId, -rows);
        return "performed";
      }
      if (effect.type === "scroll_page_down") {
        terminalRuntime.scroll(session.id, viewId, rows);
        return "performed";
      }
      if (effect.type === "scroll_page_fractional") {
        const delta = Math.trunc(rows * effect.amount);
        if (delta !== 0) terminalRuntime.scroll(session.id, viewId, delta);
        return "performed";
      }
      if (effect.type === "scroll_page_lines") {
        if (effect.lines !== 0) terminalRuntime.scroll(session.id, viewId, effect.lines);
        return "performed";
      }
      if (effect.type === "adjust_selection" && selection) {
        const nextFocus = adjustSelectionFocus(selection.focus, effect.direction, {
          cols,
          rows,
          totalRows: total,
        });
        if (!nextFocus) return "unperformed";
        setLocalSelection({ anchor: selection.anchor, focus: nextFocus });
        // Keep keyboard-adjusted focus visible (Ghostty scrolls selection into view).
        const offset = scrollbarRef.current.offset;
        if (nextFocus.row < offset) {
          terminalRuntime.scrollTo(session.id, viewId, nextFocus.row);
        } else if (nextFocus.row >= offset + rows) {
          terminalRuntime.scrollTo(session.id, viewId, Math.max(0, nextFocus.row - rows + 1));
        }
        terminalRuntime.setSelection(
          session.handle,
          viewportSelection(selectionRef.current, scrollbarRef.current, cols, rows),
          viewId,
        );
        return "performed";
      }
      return "unperformed";
    },
    [
      interactive,
      readClipboard,
      reportCopyError,
      session.handle,
      session.id,
      setLocalSelection,
      terminalRuntime,
      viewId,
    ],
  );

  // Text input is typing: it ends the local selection, as a forwarded key does.
  const commitTextInput = useCallback(
    (actions: readonly TerminalTextInputAction[]): void => {
      selectionAnchorRef.current = null;
      setLocalSelection(null);
      commitTerminalTextInput(
        terminalRuntime,
        { sessionId: session.id, sessionHandle: session.handle, viewId },
        actions,
        performance.now(),
      );
    },
    [session.handle, session.id, setLocalSelection, terminalRuntime, viewId],
  );
  const textInputSink = useMemo<TerminalTextInputSink>(
    () => ({ interactive, commit: commitTextInput }),
    [commitTextInput, interactive],
  );

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    return attachTerminalTextInput(input, textInput, textInputSink);
  }, [textInput, textInputSink]);

  useEffect(() => {
    if (!onMenuAction) return;
    return onMenuAction((action) => {
      const focused = document.activeElement;
      const editingAnotherControl =
        focused !== inputRef.current &&
        (focused instanceof HTMLInputElement ||
          focused instanceof HTMLTextAreaElement ||
          (focused instanceof HTMLElement && focused.isContentEditable));
      if (!active || editingAnotherControl) return;
      const effect: TerminalEffect | null =
        action === "copy"
          ? { type: "copy" }
          : action === "paste"
            ? { type: "paste" }
            : action === "select-all"
              ? { type: "select_all" }
              : action === "clear-screen"
                ? { type: "clear_screen" }
                : null;
      if (effect) executeTerminalEffect(effect);
    });
  }, [active, executeTerminalEffect, onMenuAction]);

  useEffect(() => {
    if (active && document.hasFocus()) inputRef.current?.focus({ preventScroll: true });
  }, [active]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const surface = canvas?.parentElement;
    if (!canvas || !surface) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.style.setProperty("--ghosttea-canvas-scale", `${1 / dpr}`);
    const handle = terminalRuntime.mount(session.id, session.handle, viewId, canvas, {
      width: surface.clientWidth,
      height: surface.clientHeight,
      dpr,
    });
    terminalRuntime.setViewInputPolicy(viewId, clientReadWriteRef.current);
    let { cols, rows } = gridRef.current;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry || entry.contentRect.width <= 0 || entry.contentRect.height <= 0) return;
      const dpr = window.devicePixelRatio || 1;
      canvas.style.setProperty("--ghosttea-canvas-scale", `${1 / dpr}`);
      handle.resize(entry.contentRect.width, entry.contentRect.height, dpr);
      const nextCols = Math.max(2, Math.floor((entry.contentRect.width - ORIGIN_X * 2) / CELL_WIDTH));
      const nextRows = Math.max(1, Math.floor((entry.contentRect.height - ORIGIN_Y * 2) / LINE_HEIGHT));
      if (nextCols !== cols || nextRows !== rows) {
        cols = nextCols;
        rows = nextRows;
        gridRef.current = { cols, rows };
        if (controlsResizeRef.current) terminalRuntime.resize(session.id, viewId, cols, rows);
      }
    });
    observer.observe(surface);
    return () => {
      observer.disconnect();
      handle.dispose();
    };
  }, [session.handle, session.id, terminalRuntime, viewId]);

  useEffect(() => {
    terminalRuntime.setViewInputPolicy(viewId, clientReadWrite);
  }, [clientReadWrite, terminalRuntime, viewId]);

  useEffect(() => {
    terminalRuntime.setVisible(session.handle, visible, viewId);
  }, [session.handle, terminalRuntime, viewId, visible]);

  useEffect(() => {
    const onScrollbar = (event: Event): void => {
      const detail = (event as CustomEvent<{ sessionHandle: string; scrollbar: TerminalScrollbarState }>).detail;
      if (detail.sessionHandle !== session.handle) return;
      scrollbarRef.current = detail.scrollbar;
      setScrollbar(detail.scrollbar);
      const { cols, rows } = gridRef.current;
      const edge = selectionAutoScrollEdgeRef.current;
      const anchor = selectionAnchorRef.current;
      if (edge && anchor && pointerModeRef.current === "selection") {
        setLocalSelection({
          anchor,
          focus: {
            column: edge.column,
            row: detail.scrollbar.offset + (edge.direction < 0 ? 0 : rows - 1),
          },
        });
      }
      terminalRuntime.setSelection(
        session.handle,
        viewportSelection(selectionRef.current, detail.scrollbar, cols, rows),
        viewId,
      );
    };
    terminalRuntime.addEventListener("scrollbar-state", onScrollbar);
    return () => terminalRuntime.removeEventListener("scrollbar-state", onScrollbar);
  }, [session.handle, setLocalSelection, terminalRuntime, viewId]);

  useEffect(
    () => () => {
      if (scrollFrameRef.current !== null) window.cancelAnimationFrame(scrollFrameRef.current);
      if (scrollToFrameRef.current !== null) window.cancelAnimationFrame(scrollToFrameRef.current);
      if (scrollbarHideTimerRef.current !== null) window.clearTimeout(scrollbarHideTimerRef.current);
      if (selectionAutoScrollTimerRef.current !== null) window.clearInterval(selectionAutoScrollTimerRef.current);
    },
    [],
  );

  useEffect(() => {
    if (!controlsResize || !interactive) {
      terminalRuntime.releaseResizeControl(viewId);
      return;
    }
    const { cols, rows } = gridRef.current;
    terminalRuntime.claimResizeControl(session.handle, viewId, cols, rows);
    return () => terminalRuntime.releaseResizeControl(viewId);
  }, [controlsResize, interactive, session.handle, terminalRuntime, viewId]);

  useEffect(() => {
    const syncFocus = (): void => {
      const { cols, rows } = gridRef.current;
      const focused = active && inputFocused && document.hasFocus() && document.activeElement === inputRef.current;
      syncSurfaceFocus(
        terminalRuntime,
        { sessionHandle: session.handle, viewId, cols, rows },
        focused,
        focusedRef.current,
        {
          takeGeometryOnFocus: takeGeometryOnFocusRef.current,
          controlsResize: controlsResizeRef.current,
          interactive: interactiveRef.current,
        },
      );
      focusedRef.current = focused;
    };
    const onWindowBlur = (): void => {
      restoreInputFocusRef.current = restoreInputFocusRef.current || document.activeElement === inputRef.current;
      releaseForwardedKeys();
      const { cols, rows } = gridRef.current;
      terminalRuntime.setFocused(session.handle, viewId, false, cols, rows);
      focusedRef.current = false;
    };
    const onWindowFocus = (): void => {
      if (active && restoreInputFocusRef.current) inputRef.current?.focus({ preventScroll: true });
      syncFocus();
    };
    window.addEventListener("blur", onWindowBlur);
    window.addEventListener("focus", onWindowFocus);
    syncFocus();
    return () => {
      window.removeEventListener("blur", onWindowBlur);
      window.removeEventListener("focus", onWindowFocus);
      releaseForwardedKeys();
      const { cols, rows } = gridRef.current;
      terminalRuntime.setFocused(session.handle, viewId, false, cols, rows);
    };
  }, [active, inputFocused, releaseForwardedKeys, session.handle, terminalRuntime, viewId]);

  const keyInput = (): SurfaceKeyInput => ({
    textInput,
    platform,
    bindings,
    interactive,
    runtime: terminalRuntime,
    surface: { sessionId: session.id, viewId },
    forwardedKeys: forwardedKeysRef.current,
    executeEffect: executeTerminalEffect,
    clearSelection: () => {
      selectionAnchorRef.current = null;
      setLocalSelection(null);
      terminalRuntime.setSelection(session.handle, null, viewId);
    },
  });

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    handleSurfaceKeyDown(event.nativeEvent, event, keyInput());
  };

  const onKeyUp = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    handleSurfaceKeyUp(event.nativeEvent, event, keyInput());
  };

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>): void => {
    if (!interactive) {
      event.preventDefault();
      return;
    }
    const text = event.clipboardData.getData("text/plain");
    if (!text) return;
    terminalRuntime.paste(session.id, viewId, text);
    event.preventDefault();
  };

  const pointFromPointer = (event: PointerEvent<HTMLTextAreaElement>): CellPoint => {
    const bounds = event.currentTarget.getBoundingClientRect();
    const { cols, rows } = gridRef.current;
    return {
      column: Math.max(0, Math.min(cols - 1, Math.floor((event.clientX - bounds.left - ORIGIN_X) / CELL_WIDTH))),
      row:
        scrollbarRef.current.offset +
        Math.max(0, Math.min(rows - 1, Math.floor((event.clientY - bounds.top - ORIGIN_Y) / LINE_HEIGHT))),
    };
  };

  const sendMouse = (
    event: PointerEvent<HTMLTextAreaElement> | WheelEvent<HTMLTextAreaElement>,
    action: "press" | "release" | "motion",
    button: number,
  ): void => {
    const bounds = event.currentTarget.getBoundingClientRect();
    terminalRuntime.sendMouse(session.id, viewId, {
      action,
      button,
      x: Math.max(0, event.clientX - bounds.left),
      y: Math.max(0, event.clientY - bounds.top),
      screenWidth: Math.max(1, Math.round(bounds.width)),
      screenHeight: Math.max(1, Math.round(bounds.height)),
      cellWidth: Math.max(1, Math.round(CELL_WIDTH)),
      cellHeight: LINE_HEIGHT,
      paddingLeft: ORIGIN_X,
      paddingTop: ORIGIN_Y,
      shift: event.shiftKey,
      control: event.ctrlKey,
      alt: event.altKey,
      meta: event.metaKey,
    });
  };

  const mouseButton = (button: number): number => (button === 0 ? 1 : button === 1 ? 3 : button === 2 ? 2 : 0);

  const revealScrollbar = (): void => {
    setScrollbarVisible(true);
    if (scrollbarHideTimerRef.current !== null) window.clearTimeout(scrollbarHideTimerRef.current);
    scrollbarHideTimerRef.current = window.setTimeout(() => {
      scrollbarHideTimerRef.current = null;
      if (!scrollbarDragRef.current) setScrollbarVisible(false);
    }, 850);
  };

  const queueScrollRows = (rows: number): void => {
    pendingScrollRowsRef.current += rows;
    if (scrollFrameRef.current !== null) return;
    scrollFrameRef.current = window.requestAnimationFrame(() => {
      scrollFrameRef.current = null;
      const pending = pendingScrollRowsRef.current;
      pendingScrollRowsRef.current = 0;
      if (pending !== 0) terminalRuntime.scroll(session.id, viewId, Math.max(-1_000, Math.min(1_000, pending)));
    });
  };

  const queueScrollTo = (row: number): void => {
    pendingScrollToRef.current = row;
    if (scrollToFrameRef.current !== null) return;
    scrollToFrameRef.current = window.requestAnimationFrame(() => {
      scrollToFrameRef.current = null;
      const pending = pendingScrollToRef.current;
      pendingScrollToRef.current = null;
      if (pending !== null) terminalRuntime.scrollTo(session.id, viewId, pending);
    });
  };

  const stopSelectionAutoScroll = (): void => {
    selectionAutoScrollEdgeRef.current = null;
    if (selectionAutoScrollTimerRef.current !== null) {
      window.clearInterval(selectionAutoScrollTimerRef.current);
      selectionAutoScrollTimerRef.current = null;
    }
  };

  const updateSelectionAutoScroll = (direction: -1 | 0 | 1, column: number): void => {
    if (direction === 0) {
      stopSelectionAutoScroll();
      return;
    }
    selectionAutoScrollEdgeRef.current = { direction, column };
    if (selectionAutoScrollTimerRef.current !== null) return;
    selectionAutoScrollTimerRef.current = window.setInterval(() => {
      const edge = selectionAutoScrollEdgeRef.current;
      if (edge) queueScrollRows(edge.direction);
    }, 40);
  };

  const onPointerDown = (event: PointerEvent<HTMLTextAreaElement>): void => {
    syncSurfacePress(
      terminalRuntime,
      { sessionHandle: session.handle, viewId, ...gridRef.current },
      focusedRef.current,
      {
        takeGeometryOnFocus: takeGeometryOnFocusRef.current,
        controlsResize: controlsResizeRef.current,
        interactive: interactiveRef.current,
      },
    );
    onActivate?.();
    event.currentTarget.focus({ preventScroll: true });
    if (links.begin(event)) {
      pointerModeRef.current = "link";
      event.currentTarget.setPointerCapture(event.pointerId);
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    const mouseTracking = terminalRuntime.isMouseTracking(session.handle);
    const localSelection = !interactive || usesLocalSelection(mouseTracking, event.shiftKey);
    if (event.button === 2 && localSelection) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
    if (!localSelection) {
      pointerModeRef.current = "mouse";
      selectionAnchorRef.current = null;
      setLocalSelection(null);
      terminalRuntime.setSelection(session.handle, null, viewId);
      sendMouse(event, "press", mouseButton(event.button));
      return;
    }
    pointerModeRef.current = "selection";
    const point = pointFromPointer(event);
    selectionAnchorRef.current = point;
    setLocalSelection({ anchor: point, focus: point });
    const { cols, rows } = gridRef.current;
    terminalRuntime.setSelection(
      session.handle,
      viewportSelection(selectionRef.current, scrollbarRef.current, cols, rows),
      viewId,
    );
  };

  const onPointerMove = (event: PointerEvent<HTMLTextAreaElement>): void => {
    links.move(event);
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    if (pointerModeRef.current === "mouse") {
      const button = event.buttons & 1 ? 1 : event.buttons & 4 ? 3 : event.buttons & 2 ? 2 : 0;
      sendMouse(event, "motion", button);
      return;
    }
    const anchor = selectionAnchorRef.current;
    if (!anchor || pointerModeRef.current !== "selection") return;
    const point = pointFromPointer(event);
    const bounds = event.currentTarget.getBoundingClientRect();
    updateSelectionAutoScroll(event.clientY < bounds.top ? -1 : event.clientY > bounds.bottom ? 1 : 0, point.column);
    setLocalSelection({ anchor, focus: point });
    const { cols, rows } = gridRef.current;
    terminalRuntime.setSelection(
      session.handle,
      viewportSelection(selectionRef.current, scrollbarRef.current, cols, rows),
      viewId,
    );
  };

  const onPointerUp = (event: PointerEvent<HTMLTextAreaElement>): void => {
    stopSelectionAutoScroll();
    if (pointerModeRef.current === "link") {
      links.finish(event);
      event.preventDefault();
      event.stopPropagation();
    } else if (pointerModeRef.current === "mouse") {
      sendMouse(event, "release", mouseButton(event.button));
    } else if (pointerModeRef.current === "selection" && selectionRef.current) {
      const { anchor, focus } = selectionRef.current;
      if (anchor.row === focus.row && anchor.column === focus.column) {
        setLocalSelection(null);
        terminalRuntime.setSelection(session.handle, null, viewId);
      } else {
        setCopyError(undefined);
        void terminalRuntime
          .copySelection(session.id, viewId, selectionRef.current, selectionAllRef.current)
          .catch(reportCopyError);
      }
    }
    pointerModeRef.current = null;
    selectionAnchorRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const onWheel = (event: WheelEvent<HTMLTextAreaElement>): void => {
    event.preventDefault();
    const accumulated = accumulateWheelRows(
      wheelDeltaRef.current,
      wheelDeltaPixels(event.deltaY, event.deltaMode, gridRef.current.rows, LINE_HEIGHT),
      LINE_HEIGHT,
    );
    wheelDeltaRef.current = accumulated.remainder;
    const { rows } = accumulated;
    if (rows === 0) return;
    if (terminalRuntime.isMouseTracking(session.handle) && !event.shiftKey) {
      const button = rows < 0 ? 4 : 5;
      for (let count = 0; count < Math.min(12, Math.abs(rows)); count += 1) {
        sendMouse(event, "press", button);
      }
    } else {
      revealScrollbar();
      queueScrollRows(rows);
    }
  };

  const scrollbarScrollable = scrollbar.total > scrollbar.length;
  const scrollbarMaxOffset = Math.max(0, scrollbar.total - scrollbar.length);
  const scrollbarPosition = scrollbarMaxOffset === 0 ? 0 : Math.min(1, scrollbar.offset / scrollbarMaxOffset);
  const scrollbarSize = scrollbar.total === 0 ? 1 : Math.min(1, scrollbar.length / scrollbar.total);

  const onScrollbarPointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    if (!scrollbarScrollable) return;
    event.preventDefault();
    event.stopPropagation();
    onActivate?.();
    const track = event.currentTarget;
    const bounds = track.getBoundingClientRect();
    const thumbHeight = Math.max(24, bounds.height * scrollbarSize);
    const travel = Math.max(1, bounds.height - thumbHeight);
    const thumb = (event.target as HTMLElement).closest(".terminal-scrollbar-thumb");
    let startOffset = scrollbar.offset;
    if (!thumb) {
      startOffset = Math.round(
        Math.max(0, Math.min(1, (event.clientY - bounds.top - thumbHeight / 2) / travel)) * scrollbarMaxOffset,
      );
      queueScrollTo(startOffset);
    }
    scrollbarDragRef.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startOffset,
      maxOffset: scrollbarMaxOffset,
      travel,
    };
    track.setPointerCapture(event.pointerId);
    revealScrollbar();
  };

  const onScrollbarPointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    const drag = scrollbarDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const row = Math.round(
      Math.max(
        0,
        Math.min(drag.maxOffset, drag.startOffset + ((event.clientY - drag.startY) / drag.travel) * drag.maxOffset),
      ),
    );
    queueScrollTo(row);
    revealScrollbar();
  };

  const onScrollbarPointerUp = (event: PointerEvent<HTMLDivElement>): void => {
    const drag = scrollbarDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    scrollbarDragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    revealScrollbar();
  };

  return (
    <div className="terminal-surface">
      {copyError ? (
        <div className="terminal-operation-error" role="status">
          {copyError}
        </div>
      ) : null}
      <canvas
        ref={canvasRef}
        aria-label={`Terminal session ${session.id}`}
        style={
          {
            "--ghosttea-canvas-scale": 1 / (typeof window === "undefined" ? 1 : window.devicePixelRatio || 1),
          } as CSSProperties
        }
      />
      <textarea
        ref={inputRef}
        className="terminal-input"
        style={links.hoveredLink ? { cursor: "pointer" } : undefined}
        title={links.hoveredLink?.uri}
        data-terminal-link={links.hoveredLink?.uri}
        autoCapitalize="off"
        autoComplete="off"
        spellCheck={false}
        readOnly={!interactive}
        aria-label="Terminal input"
        onFocus={() => {
          onActivate?.();
          restoreInputFocusRef.current = true;
          setInputFocused(true);
        }}
        onBlur={() => {
          links.clear();
          restoreInputFocusRef.current = !document.hasFocus();
          setInputFocused(false);
          releaseForwardedKeys();
        }}
        onKeyDown={onKeyDown}
        onKeyUp={onKeyUp}
        onPaste={onPaste}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerLeave={links.leave}
        onLostPointerCapture={() => {
          if (pointerModeRef.current === "link") links.clear();
        }}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onWheel={onWheel}
        onContextMenu={(event) => {
          event.preventDefault();
          onContextMenu?.(selectionRef.current !== null);
        }}
      />
      {links.hoveredLink ? (
        <div className="terminal-link-overlay" aria-hidden="true">
          {links.hoveredLink.spans.map((span, index) => (
            <span
              key={index}
              style={{
                left: ORIGIN_X + span.startColumn * CELL_WIDTH,
                top: ORIGIN_Y + (span.row + 1) * LINE_HEIGHT - 3,
                width: (span.endColumn - span.startColumn) * CELL_WIDTH,
                backgroundColor: `rgb(${theme.foreground
                  .slice(0, 3)
                  .map((channel) => Math.round(channel * 255))
                  .join(" ")})`,
              }}
            />
          ))}
        </div>
      ) : null}
      {scrollbarScrollable ? (
        <div
          className={`terminal-scrollbar${scrollbarVisible ? " is-visible" : ""}`}
          role="scrollbar"
          aria-label="Terminal scrollback"
          aria-orientation="vertical"
          aria-valuemin={0}
          aria-valuemax={scrollbarMaxOffset}
          aria-valuenow={scrollbar.offset}
          onPointerDown={onScrollbarPointerDown}
          onPointerMove={onScrollbarPointerMove}
          onPointerUp={onScrollbarPointerUp}
          onPointerCancel={onScrollbarPointerUp}
        >
          <div
            className="terminal-scrollbar-thumb"
            style={{
              height: `${scrollbarSize * 100}%`,
              top: `${scrollbarPosition * 100}%`,
              transform: `translateY(-${scrollbarPosition * 100}%)`,
            }}
          />
        </div>
      ) : null}
    </div>
  );
}
