import { useTerminalLinks } from "./use-terminal-links.js";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ClipboardEvent, CSSProperties, KeyboardEvent, PointerEvent, WheelEvent } from "react";
import type { SessionSummary, TerminalKeyEvent, TerminalScrollbarState } from "@vibecook/ghosttea-protocol";
import { useGhostteaRuntime } from "./context.js";
import { terminalKeyboardLayout, terminalKeyDown, terminalKeyUp } from "./keyboard-input.js";
import { terminalEffectShouldConsume, type TerminalEffect } from "./bindings/action-route.js";
import { resolveTerminalBinding, type ResolvedTerminalBinding } from "./terminal-bindings.js";
import type { GhosttyBindingEntry } from "./bindings/ghostty-bindings.js";
import type { KeyEventLike } from "./bindings/ghostty-triggers.js";
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
    (effect: TerminalEffect): boolean => {
      const { cols, rows } = gridRef.current;
      const total = Math.max(rows, scrollbarRef.current.total);
      const viewportLen = Math.max(1, scrollbarRef.current.length || rows);

      if (effect.type === "copy") {
        if (!selectionRef.current) return false;
        void terminalRuntime
          .copySelection(session.id, viewId, selectionRef.current, selectionAllRef.current)
          .catch((error: unknown) => console.error("[terminal-runtime] clipboard copy failed", error));
        return true;
      }
      if (effect.type === "select_all") {
        setLocalSelection({ anchor: { column: 0, row: 0 }, focus: { column: cols - 1, row: total - 1 } }, true);
        terminalRuntime.setSelection(
          session.handle,
          viewportSelection(selectionRef.current, scrollbarRef.current, cols, rows),
          viewId,
        );
        return true;
      }
      if (effect.type === "paste") {
        if (!interactive || !readClipboard) return false;
        void Promise.resolve(readClipboard())
          .then((text) => {
            if (!text) return;
            selectionAnchorRef.current = null;
            setLocalSelection(null);
            terminalRuntime.setSelection(session.handle, null, viewId);
            terminalRuntime.paste(session.id, viewId, text);
          })
          .catch((error: unknown) => console.error("[terminal-runtime] clipboard paste failed", error));
        return true;
      }
      if (effect.type === "text" || effect.type === "clear_screen") {
        if (!interactive && effect.type === "text") return false;
        selectionAnchorRef.current = null;
        setLocalSelection(null);
        terminalRuntime.setSelection(session.handle, null, viewId);
        terminalRuntime.sendText(session.id, viewId, effect.type === "clear_screen" ? "\u000c" : effect.text);
        return true;
      }
      if (effect.type === "scroll_to_top") {
        terminalRuntime.scrollTo(session.id, viewId, 0);
        return true;
      }
      if (effect.type === "scroll_to_bottom") {
        terminalRuntime.scrollTo(session.id, viewId, Math.max(0, total - viewportLen));
        return true;
      }
      if (effect.type === "scroll_to_row") {
        terminalRuntime.scrollTo(session.id, viewId, Math.max(0, effect.row));
        return true;
      }
      if (effect.type === "scroll_to_selection") {
        const selection = selectionRef.current;
        if (!selection) return false;
        const row = Math.min(selection.anchor.row, selection.focus.row);
        terminalRuntime.scrollTo(session.id, viewId, Math.max(0, row));
        return true;
      }
      if (effect.type === "scroll_page_up") {
        terminalRuntime.scroll(session.id, viewId, -rows);
        return true;
      }
      if (effect.type === "scroll_page_down") {
        terminalRuntime.scroll(session.id, viewId, rows);
        return true;
      }
      if (effect.type === "scroll_page_fractional") {
        const delta = Math.trunc(rows * effect.amount);
        if (delta !== 0) terminalRuntime.scroll(session.id, viewId, delta);
        return true;
      }
      if (effect.type === "scroll_page_lines") {
        if (effect.lines !== 0) terminalRuntime.scroll(session.id, viewId, effect.lines);
        return true;
      }
      if (effect.type === "adjust_selection") {
        const selection = selectionRef.current;
        if (!selection) return false;
        const nextFocus = adjustSelectionFocus(selection.focus, effect.direction, {
          cols,
          rows,
          totalRows: total,
        });
        if (!nextFocus) return false;
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
        return true;
      }
      return false;
    },
    [interactive, readClipboard, session.handle, session.id, setLocalSelection, terminalRuntime, viewId],
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

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    const route = routeSurfaceKeyDown(event.nativeEvent, textInput, platform, bindings);
    if (route.type === "text-system") return;
    if (route.type === "binding") {
      const { effect, flags } = route.binding;
      const applied = executeTerminalEffect(effect);
      // Performable binds only consume when applied (Ghostty Binding.Flags.performable).
      if (terminalEffectShouldConsume(effect, applied, flags)) {
        event.preventDefault();
        event.stopPropagation();
      }
      return;
    }

    if (!interactive) {
      event.preventDefault();
      return;
    }
    selectionAnchorRef.current = null;
    setLocalSelection(null);
    terminalRuntime.setSelection(session.handle, null, viewId);
    if (event.ctrlKey && !event.altKey && event.key.toLowerCase() === "c") {
      terminalRuntime.interrupt(session.id, viewId);
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    const terminalEvent = terminalKeyDown(event.nativeEvent);
    terminalRuntime.sendKey(session.id, viewId, terminalEvent);
    forwardedKeysRef.current.set(event.code, terminalEvent);
    event.preventDefault();
    event.stopPropagation();
  };

  const onKeyUp = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    const pressed = forwardedKeysRef.current.get(event.code);
    if (!pressed) return;
    forwardedKeysRef.current.delete(event.code);
    terminalRuntime.sendKey(session.id, viewId, terminalKeyUp(pressed, event.nativeEvent));
    event.preventDefault();
    event.stopPropagation();
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
        void terminalRuntime
          .copySelection(session.id, viewId, selectionRef.current, selectionAllRef.current)
          .catch((error: unknown) => console.error("[terminal-runtime] clipboard copy failed", error));
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
