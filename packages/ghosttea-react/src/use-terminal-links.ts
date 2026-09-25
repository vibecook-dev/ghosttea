import { useCallback, useEffect, useRef, useState } from "react";
import type { PointerEvent, RefObject } from "react";
import type { TerminalLink } from "@vibecook/ghosttea-frame";
import type { GhostteaTerminalRuntime } from "./runtime.js";
import { CELL_WIDTH, LINE_HEIGHT, ORIGIN_X, ORIGIN_Y } from "./renderers/types.js";
import { linkAtCell, linkModifierPressed, TerminalLinkGesture, type LinkModifiers } from "./link-input.js";

type Pointer = PointerEvent<HTMLTextAreaElement>;

export function useTerminalLinks(
  runtime: GhostteaTerminalRuntime,
  sessionHandle: string,
  input: RefObject<HTMLTextAreaElement | null>,
  grid: RefObject<{ cols: number; rows: number }>,
  platform: string | undefined,
  visible: boolean,
) {
  const [hoveredLink, setHoveredLink] = useState<TerminalLink | null>(null);
  const position = useRef<{ x: number; y: number; modifiers: LinkModifiers } | null>(null);
  const gesture = useRef(new TerminalLinkGesture());
  const hostPlatform = platform ?? (/Mac/.test(navigator.platform) ? "darwin" : "linux");

  const atPosition = useCallback(
    (x: number, y: number, modifiers: LinkModifiers): TerminalLink | null => {
      if (!visible || !linkModifierPressed(modifiers, hostPlatform)) return null;
      const bounds = input.current?.getBoundingClientRect();
      if (!bounds) return null;
      const column = Math.floor((x - bounds.left - ORIGIN_X) / CELL_WIDTH);
      const row = Math.floor((y - bounds.top - ORIGIN_Y) / LINE_HEIGHT);
      if (
        x >= bounds.right ||
        y >= bounds.bottom ||
        column < 0 ||
        column >= grid.current.cols ||
        row < 0 ||
        row >= grid.current.rows
      )
        return null;
      return linkAtCell(runtime.links(sessionHandle), column, row);
    },
    [grid, hostPlatform, input, runtime, sessionHandle, visible],
  );

  const clear = useCallback(() => {
    position.current = null;
    gesture.current.cancel();
    setHoveredLink(null);
  }, []);

  useEffect(() => {
    const refresh = () => {
      const point = position.current;
      setHoveredLink(point ? atPosition(point.x, point.y, point.modifiers) : null);
    };
    const onLinks = (event: Event) => {
      if ((event as CustomEvent<{ sessionHandle: string }>).detail.sessionHandle !== sessionHandle) return;
      // The target changed while a button was held: require a fresh click.
      gesture.current.cancel();
      refresh();
    };
    const onKey = (event: KeyboardEvent) => {
      if (position.current) position.current.modifiers = event;
      if (!linkModifierPressed(event, hostPlatform)) gesture.current.cancel();
      refresh();
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("keyup", onKey, true);
    window.addEventListener("blur", clear);
    runtime.addEventListener("link-targets", onLinks);
    runtime.addEventListener("config-changed", refresh);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("keyup", onKey, true);
      window.removeEventListener("blur", clear);
      runtime.removeEventListener("link-targets", onLinks);
      runtime.removeEventListener("config-changed", refresh);
    };
  }, [atPosition, clear, hostPlatform, runtime, sessionHandle]);

  return {
    hoveredLink: visible ? hoveredLink : null,
    clear,
    move: (event: Pointer) => {
      position.current = { x: event.clientX, y: event.clientY, modifiers: event };
      for (const sample of event.nativeEvent.getCoalescedEvents?.() ?? []) {
        gesture.current.move(event.pointerId, sample.clientX, sample.clientY);
      }
      gesture.current.move(event.pointerId, event.clientX, event.clientY);
      setHoveredLink(event.buttons === 0 ? atPosition(event.clientX, event.clientY, event) : null);
    },
    begin: (event: Pointer): boolean => {
      if (event.button !== 0) return false;
      const link = atPosition(event.clientX, event.clientY, event);
      if (!link) return false;
      position.current = { x: event.clientX, y: event.clientY, modifiers: event };
      gesture.current.begin(event.pointerId, link, event.clientX, event.clientY);
      setHoveredLink(link);
      return true;
    },
    finish: (event: Pointer) => {
      gesture.current.move(event.pointerId, event.clientX, event.clientY);
      const link = event.type === "pointerup" ? atPosition(event.clientX, event.clientY, event) : null;
      const uri = gesture.current.finish(event.pointerId, link);
      setHoveredLink(link);
      if (uri)
        void runtime
          .openLink(uri)
          .catch((error: unknown) => console.error("[terminal-runtime] open link failed", error));
    },
    leave: () => {
      position.current = null;
      setHoveredLink(null);
    },
  };
}
