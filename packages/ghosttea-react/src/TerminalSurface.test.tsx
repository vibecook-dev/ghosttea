import { isValidElement } from "react";
import { unknownSessionActivity, type SessionSummary, type TerminalKeyEvent } from "@vibecook/ghosttea-protocol";
import { describe, expect, it } from "vitest";
import {
  commitTerminalTextInput,
  focusTakesGeometry,
  pressTakesGeometry,
  routeSurfaceKeyDown,
  syncSurfaceFocus,
  syncSurfacePress,
  TerminalSurface,
  viewportSelection,
} from "./TerminalSurface";
import { DEFAULT_THEME } from "./renderers/types";
import { attachTerminalTextInput, TerminalTextInput, type TerminalTextInputAction } from "./text-input";

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

/** The textarea, as far as text input reads and listens to it. */
class FakeTextarea extends EventTarget {
  value = "";
}

/** The DOM's InputEvent, which Node lacks. */
class FakeInputEvent extends Event {
  readonly inputType: string;
  readonly data: string | null;
  readonly isComposing: boolean;

  constructor(
    type: "beforeinput" | "input",
    init: { inputType: string; data: string | null; isComposing: boolean; cancelable: boolean },
  ) {
    super(type, { cancelable: init.cancelable });
    this.inputType = init.inputType;
    this.data = init.data;
    this.isComposing = init.isComposing;
  }
}

function recordingRuntime(calls: unknown[][]) {
  return {
    setSelection: (...args: unknown[]) => {
      calls.push(["setSelection", ...args]);
    },
    sendText: (...args: unknown[]) => {
      calls.push(["sendText", ...args]);
    },
    paste: (...args: unknown[]) => {
      calls.push(["paste", ...args]);
    },
    sendKey: (sessionId: string, viewId: string, event: TerminalKeyEvent) => {
      calls.push(["sendKey", sessionId, viewId, event.type, event.key]);
    },
  };
}

const keydown = (overrides: Partial<KeyboardEvent> = {}) => ({
  key: "a",
  code: "KeyA",
  keyCode: 65,
  isComposing: false,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...overrides,
});

/**
 * A surface's text input wired as the component wires it: the textarea's
 * events through `attachTerminalTextInput`, its keydowns through
 * `routeSurfaceKeyDown`, and its commits through `commitTerminalTextInput`.
 */
function wiredSurface({ interactive = true }: { interactive?: boolean } = {}) {
  const calls: unknown[][] = [];
  const runtime = recordingRuntime(calls);
  const field = new FakeTextarea();
  const textInput = new TerminalTextInput();
  const sink = {
    interactive,
    commit: (actions: readonly TerminalTextInputAction[]) =>
      commitTerminalTextInput(runtime, { sessionId: "first", sessionHandle: "11", viewId: "view-a" }, actions, 7),
  };
  const detach = attachTerminalTextInput(field, textInput, sink);
  return {
    calls,
    field,
    detach,
    keyDown: (overrides: Partial<KeyboardEvent> = {}) =>
      routeSurfaceKeyDown(keydown(overrides), textInput, "darwin", undefined).type,
    /** An edit as a browser makes it: beforeinput, then, unless that was prevented, the edit lands and input follows. */
    edit(
      inputType: string,
      data: string | null,
      {
        cancelable = true,
        isComposing = false,
        apply = (value: string) => value + (data ?? ""),
      }: { cancelable?: boolean; isComposing?: boolean; apply?: (value: string) => string } = {},
    ): void {
      if (!field.dispatchEvent(new FakeInputEvent("beforeinput", { inputType, data, isComposing, cancelable }))) return;
      field.value = apply(field.value);
      field.dispatchEvent(new FakeInputEvent("input", { inputType, data, isComposing, cancelable: false }));
    },
    dispatch: (type: "compositionstart" | "compositionend" | "blur") => field.dispatchEvent(new Event(type)),
  };
}

describe("text input", () => {
  const clearSelection = ["setSelection", "11", null, "view-a"];

  it("clears the view's selection, then reaches its session through typing's verbs, an edit key as its press and release", () => {
    const calls: unknown[][] = [];
    commitTerminalTextInput(
      recordingRuntime(calls),
      { sessionId: "first", sessionHandle: "11", viewId: "view-a" },
      [
        { type: "text", text: "ls" },
        { type: "key", key: "Enter" },
        { type: "paste", text: "a\nb" },
      ],
      7,
    );

    expect(calls).toEqual([
      clearSelection,
      ["sendText", "first", "view-a", "ls"],
      ["sendKey", "first", "view-a", "down", "Enter"],
      ["sendKey", "first", "view-a", "up", "Enter"],
      ["paste", "first", "view-a", "a\nb"],
    ]);
  });

  it("leaves to the text system the keydowns it processed, before any binding", () => {
    const surface = wiredSurface();
    expect(surface.keyDown()).toBe("terminal");
    // Chromium on macOS: the keydown that starts a composition keeps its key ("n", which encodes as "n") and is not
    // yet composing; only keyCode 229 marks it.
    expect(surface.keyDown({ key: "n", code: "KeyN", keyCode: 229 })).toBe("text-system");
    expect(surface.keyDown({ key: "Process", code: "KeyN", keyCode: 229 })).toBe("text-system");
    // Command-Backspace is a terminal binding on macOS, but not while the IME has the key.
    const commandBackspace = { key: "Backspace", code: "Backspace", keyCode: 8, metaKey: true };
    expect(surface.keyDown(commandBackspace)).toBe("binding");
    expect(surface.keyDown({ ...commandBackspace, keyCode: 229 })).toBe("text-system");
    expect(surface.keyDown({ ...commandBackspace, isComposing: true })).toBe("text-system");
    expect(surface.calls).toEqual([]);
  });

  it("sends an insert with no keydown once, as text, and lands nothing in the field: the macOS Character Viewer", () => {
    const surface = wiredSurface();
    surface.edit("insertText", "😀");
    expect(surface.calls).toEqual([clearSelection, ["sendText", "first", "view-a", "😀"]]);
    expect(surface.field.value).toBe("");
  });

  it("sends an uncancelable insert after a keyCode 229 keydown once, from the field at input", () => {
    const surface = wiredSurface();
    expect(surface.keyDown({ key: "Unidentified", code: "", keyCode: 229 })).toBe("text-system");
    surface.edit("insertText", "é", { cancelable: false });
    expect(surface.calls).toEqual([clearSelection, ["sendText", "first", "view-a", "é"]]);
    expect(surface.field.value).toBe("");
  });

  it("sends a soft keyboard's Enter and its Backspace on the empty field as those keys", () => {
    const surface = wiredSurface();
    surface.edit("insertLineBreak", null, { apply: (value) => `${value}\n` });
    surface.edit("deleteContentBackward", null, { cancelable: false, apply: (value) => value.slice(0, -1) });
    expect(surface.calls).toEqual([
      clearSelection,
      ["sendKey", "first", "view-a", "down", "Enter"],
      ["sendKey", "first", "view-a", "up", "Enter"],
      clearSelection,
      ["sendKey", "first", "view-a", "down", "Backspace"],
      ["sendKey", "first", "view-a", "up", "Backspace"],
    ]);
    expect(surface.field.value).toBe("");
  });

  it("sends a composition once, at compositionend, in Chromium's order", () => {
    const surface = wiredSurface();
    expect(surface.keyDown({ key: "n", code: "KeyN", keyCode: 229 })).toBe("text-system");
    surface.dispatch("compositionstart");
    const composing = { cancelable: false, isComposing: true };
    surface.edit("insertCompositionText", "に", { ...composing, apply: () => "に" });
    surface.edit("insertCompositionText", "日本", { ...composing, apply: () => "日本" });
    expect(surface.calls).toEqual([]);
    expect(surface.field.value).toBe("日本");
    surface.dispatch("compositionend");
    expect(surface.calls).toEqual([clearSelection, ["sendText", "first", "view-a", "日本"]]);
    expect(surface.field.value).toBe("");
  });

  it("leaves the field to a composition until compositionend, in WebKit's order", () => {
    const surface = wiredSurface();
    surface.dispatch("compositionstart");
    surface.edit("insertCompositionText", "にほん", { cancelable: false, isComposing: true, apply: () => "にほん" });
    // WebKit deletes the composition and inserts its commit before compositionend, with no composition left to report.
    surface.edit("deleteCompositionText", null, { cancelable: false, apply: () => "" });
    surface.edit("insertFromComposition", "日本");
    expect(surface.calls).toEqual([]);
    expect(surface.field.value).toBe("日本");
    surface.dispatch("compositionend");
    // WebKit's keydown for the committing Enter follows, and is the text system's.
    expect(surface.keyDown({ key: "Enter", code: "Enter", keyCode: 229 })).toBe("text-system");
    expect(surface.calls).toEqual([clearSelection, ["sendText", "first", "view-a", "日本"]]);
    expect(surface.field.value).toBe("");
  });

  it("ends a composition a missed compositionend left behind at blur", () => {
    const surface = wiredSurface();
    surface.dispatch("compositionstart");
    surface.dispatch("blur");
    surface.edit("insertText", "😀");
    expect(surface.calls).toEqual([clearSelection, ["sendText", "first", "view-a", "😀"]]);
  });

  it("sends nothing from a read-only surface and keeps its field empty", () => {
    const surface = wiredSurface({ interactive: false });
    surface.edit("insertText", "x");
    surface.edit("insertText", "y", { cancelable: false });
    expect(surface.field.value).toBe("");
    surface.dispatch("compositionstart");
    surface.edit("insertCompositionText", "日本", { cancelable: false, isComposing: true, apply: () => "日本" });
    surface.dispatch("compositionend");
    expect(surface.field.value).toBe("");
    expect(surface.calls).toEqual([]);
  });

  it("stops listening when detached", () => {
    const surface = wiredSurface();
    surface.detach();
    surface.edit("insertText", "x");
    expect(surface.field.value).toBe("x");
    expect(surface.calls).toEqual([]);
  });
});
