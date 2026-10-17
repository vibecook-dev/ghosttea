import { isValidElement } from "react";
import { unknownSessionActivity, type SessionSummary } from "@vibecook/ghosttea-protocol";
import { describe, expect, it } from "vitest";
import {
  focusTakesGeometry,
  pressTakesGeometry,
  syncSurfaceFocus,
  syncSurfacePress,
  TerminalSurface,
  viewportSelection,
} from "./TerminalSurface";
import { DEFAULT_THEME } from "./renderers/types";

function session(id: string, handle: string): SessionSummary {
  return {
    id,
    handle,
    executable: "/bin/sh",
    cols: 80,
    rows: 24,
    exited: false,
    readWrite: true,
    title: null,
    cwd: null,
    bellCount: 0,
    pid: 1,
    createdAtMs: 1,
    exitCode: null,
    exitSignal: null,
    requestedTermination: null,
    exitOutcome: null,
    ownerId: null,
    persistence: null,
    activity: unknownSessionActivity(),
  };
}

describe("TerminalSurface session ownership", () => {
  it("gives each session a distinct component boundary", () => {
    const first = TerminalSurface({ session: session("first", "11"), theme: DEFAULT_THEME });
    const second = TerminalSurface({ session: session("second", "22"), theme: DEFAULT_THEME });

    expect(isValidElement(first)).toBe(true);
    expect(isValidElement(second)).toBe(true);
    expect(first.key).toBe("first:11");
    expect(second.key).toBe("second:22");
  });
});

describe("viewportSelection", () => {
  it("keeps absolute selections attached to their scrollback rows", () => {
    const selection = { anchor: { column: 3, row: 40 }, focus: { column: 8, row: 60 } };
    expect(viewportSelection(selection, { total: 100, offset: 50, length: 10 }, 80, 10)).toEqual({
      anchor: { column: 0, row: 0 },
      focus: { column: 79, row: 9 },
    });
    expect(viewportSelection(selection, { total: 100, offset: 70, length: 10 }, 80, 10)).toBeNull();
  });
});

describe("focus and the geometry seat", () => {
  const controller = { takeGeometryOnFocus: true, controlsResize: true, interactive: true };

  it("takes the seat only on a focus gain the host opted into, and never for a mirror", () => {
    expect(focusTakesGeometry(true, false, controller)).toBe(true);
    // Still focused is not a gain; a blur never takes.
    expect(focusTakesGeometry(true, true, controller)).toBe(false);
    expect(focusTakesGeometry(false, true, controller)).toBe(false);
    expect(focusTakesGeometry(false, false, controller)).toBe(false);
    expect(focusTakesGeometry(true, false, { ...controller, takeGeometryOnFocus: false })).toBe(false);
    expect(focusTakesGeometry(true, false, { ...controller, controlsResize: false })).toBe(false);
    expect(focusTakesGeometry(true, false, { ...controller, interactive: false })).toBe(false);
  });

  it("always reports focus as a scheduling fact, and takes the seat at the surface's grid on a gain", () => {
    const calls: unknown[][] = [];
    const runtime = {
      setFocused: (...args: unknown[]) => {
        calls.push(["setFocused", ...args]);
      },
      takeResizeControl: (...args: unknown[]) => {
        calls.push(["takeResizeControl", ...args]);
      },
    };
    const surface = { sessionHandle: "11", viewId: "view-a", cols: 90, rows: 30 };
    syncSurfaceFocus(runtime, surface, true, false, controller);
    syncSurfaceFocus(runtime, surface, true, true, controller);
    syncSurfaceFocus(runtime, surface, false, true, controller);
    syncSurfaceFocus(runtime, surface, true, false, { ...controller, controlsResize: false });

    expect(calls).toEqual([
      ["setFocused", "11", "view-a", true, 90, 30],
      ["takeResizeControl", "11", "view-a", 90, 30],
      ["setFocused", "11", "view-a", true, 90, 30],
      ["setFocused", "11", "view-a", false, 90, 30],
      ["setFocused", "11", "view-a", true, 90, 30],
    ]);
  });

  it("takes the seat on a press of a surface that already has focus, and on no other press", () => {
    expect(pressTakesGeometry(true, controller)).toBe(true);
    // A press of an unfocused surface focuses it, and that gain takes instead.
    expect(pressTakesGeometry(false, controller)).toBe(false);
    expect(pressTakesGeometry(true, { ...controller, takeGeometryOnFocus: false })).toBe(false);
    expect(pressTakesGeometry(true, { ...controller, controlsResize: false })).toBe(false);
    expect(pressTakesGeometry(true, { ...controller, interactive: false })).toBe(false);

    const calls: unknown[][] = [];
    const runtime = {
      takeResizeControl: (...args: unknown[]) => {
        calls.push(["takeResizeControl", ...args]);
      },
    };
    const surface = { sessionHandle: "11", viewId: "view-a", cols: 90, rows: 30 };
    syncSurfacePress(runtime, surface, true, controller);
    syncSurfacePress(runtime, surface, false, controller);
    syncSurfacePress(runtime, surface, true, { ...controller, controlsResize: false });
    expect(calls).toEqual([["takeResizeControl", "11", "view-a", 90, 30]]);
  });
});
