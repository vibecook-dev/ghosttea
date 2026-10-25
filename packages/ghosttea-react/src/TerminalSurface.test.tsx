import { isValidElement } from "react";
import { unknownSessionActivity, type SessionSummary, type TerminalKeyEvent } from "@vibecook/ghosttea-protocol";
import { describe, expect, it } from "vitest";
import {
  commitTerminalTextInput,
  focusTakesGeometry,
  handleSurfaceKeyDown,
  handleSurfaceKeyUp,
  isMacCommandText,
  isPlatformPasteChord,
  pressTakesGeometry,
  routeSurfaceKeyDown,
  syncSurfaceFocus,
  syncSurfacePress,
  terminalEffectAvailability,
  TerminalSurface,
  viewportSelection,
  type SurfaceKeyInput,
} from "./TerminalSurface";
import { configuredBindingsForPlatform } from "./bindings/ghostty-bindings";
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

/** A key event's modifiers and key, as Ghostty writes a trigger. */
function chord(event: Pick<TerminalKeyEvent, "meta" | "control" | "alt" | "shift" | "key">): string {
  return [event.meta && "super", event.control && "ctrl", event.alt && "alt", event.shift && "shift", event.key]
    .filter(Boolean)
    .join("+");
}

/**
 * A surface's keys wired as the component wires them: keydowns and keyups
 * through `handleSurfaceKeyDown` and `handleSurfaceKeyUp` over a recording
 * runtime, each binding's effect decided by `terminalEffectAvailability` from
 * whether the surface has a selection, which typing ends.
 */
function keyedSurface({
  platform = "darwin",
  bindings,
  interactive = true,
  selection = false,
  readsClipboard = true,
}: {
  platform?: string;
  bindings?: SurfaceKeyInput["bindings"];
  interactive?: boolean;
  selection?: boolean;
  readsClipboard?: boolean;
} = {}) {
  const calls: unknown[][] = [];
  let hasSelection = selection;
  const input: SurfaceKeyInput = {
    textInput: new TerminalTextInput(),
    platform,
    bindings,
    interactive,
    runtime: {
      sendKey: (sessionId: string, viewId: string, event: TerminalKeyEvent) => {
        calls.push(["sendKey", sessionId, viewId, event.type, chord(event)]);
      },
      interrupt: (sessionId: string, viewId: string) => {
        calls.push(["interrupt", sessionId, viewId]);
      },
    },
    surface: { sessionId: "first", viewId: "view-a" },
    forwardedKeys: new Map(),
    executeEffect: (effect) => {
      const outcome = terminalEffectAvailability(effect, { hasSelection, interactive, readsClipboard });
      calls.push(["effect", effect.type, outcome]);
      return outcome;
    },
    clearSelection: () => {
      hasSelection = false;
      calls.push(["clearSelection"]);
    },
  };
  const event = (overrides: Partial<KeyboardEvent>) => ({
    ...keydown(overrides),
    location: 0,
    repeat: false,
    timeStamp: 7,
  });
  const dispatch = () => {
    const state = { prevented: false, stopped: false };
    return {
      state,
      preventDefault: () => void (state.prevented = true),
      stopPropagation: () => void (state.stopped = true),
    };
  };
  return {
    calls,
    down(overrides: Partial<KeyboardEvent>) {
      const control = dispatch();
      return { outcome: handleSurfaceKeyDown(event(overrides), control, input), ...control.state };
    },
    up(overrides: Partial<KeyboardEvent>) {
      const control = dispatch();
      return { sent: handleSurfaceKeyUp(event(overrides), control, input), ...control.state };
    },
  };
}

describe("keys and terminal bindings", () => {
  const sent = (type: "down" | "up", key: string) => ["sendKey", "first", "view-a", type, key];
  const shiftLeft = { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37, shiftKey: true };
  const commandC = { key: "c", code: "KeyC", keyCode: 67, metaKey: true };
  const controlC = { key: "c", code: "KeyC", keyCode: 67, ctrlKey: true };
  const controlShiftC = { key: "C", code: "KeyC", keyCode: 67, ctrlKey: true, shiftKey: true };
  const bound = (trigger: string, action: string) =>
    configuredBindingsForPlatform({ clearKeybindings: false, keybindings: [{ trigger, action }] }, "darwin");

  it("sends an unbound key once, ending the selection, and its release once", () => {
    const surface = keyedSurface({ selection: true });
    expect(surface.down({})).toEqual({ outcome: "key", prevented: true, stopped: true });
    expect(surface.up({})).toEqual({ sent: true, prevented: true, stopped: true });
    expect(surface.up({})).toEqual({ sent: false, prevented: false, stopped: false });
    expect(surface.calls).toEqual([["clearSelection"], sent("down", "a"), sent("up", "a")]);
  });

  it("sends Shift+Arrow with no selection as the arrow key: the performable adjust_selection acts as unbound", () => {
    for (const platform of ["darwin", "linux", "win32"]) {
      const surface = keyedSurface({ platform });
      expect(surface.down(shiftLeft), platform).toEqual({ outcome: "key", prevented: true, stopped: true });
      expect(surface.up({ ...shiftLeft, shiftKey: false }).sent, platform).toBe(true);
      expect(surface.calls, platform).toEqual([
        ["effect", "adjust_selection", "unperformed"],
        ["clearSelection"],
        sent("down", "shift+ArrowLeft"),
        sent("up", "ArrowLeft"),
      ]);
    }
  });

  it("adjusts a selection with Shift+Arrow and sends nothing, the release included", () => {
    const surface = keyedSurface({ selection: true });
    expect(surface.down(shiftLeft)).toEqual({ outcome: "binding", prevented: true, stopped: true });
    expect(surface.up(shiftLeft).sent).toBe(false);
    expect(surface.calls).toEqual([["effect", "adjust_selection", "performed"]]);
  });

  it("keeps the selection for a modifier pressed alone, which is still sent, so Shift+Arrow then adjusts it", () => {
    const surface = keyedSurface({ selection: true });
    expect(surface.down({ key: "Shift", code: "ShiftLeft", keyCode: 16, shiftKey: true }).outcome).toBe("key");
    expect(surface.down(shiftLeft).outcome).toBe("binding");
    expect(surface.calls).toEqual([sent("down", "shift+Shift"), ["effect", "adjust_selection", "performed"]]);
  });

  it("withholds Cmd+C and Cmd+J with no selection on macOS, which a remote host would type, and copies a selection", () => {
    // A macOS host encodes no text for them; a Linux or Windows host types "c" (key_encode.zig:543-545).
    const commandJ = { key: "j", code: "KeyJ", keyCode: 74, metaKey: true };
    const empty = keyedSurface();
    expect(empty.down(commandC)).toEqual({ outcome: "withheld", prevented: true, stopped: true });
    expect(empty.up(commandC).sent).toBe(false);
    expect(empty.down(commandJ)).toEqual({ outcome: "withheld", prevented: true, stopped: true });
    expect(empty.calls).toEqual([
      ["effect", "copy", "unperformed"],
      ["effect", "scroll_to_selection", "unperformed"],
    ]);

    const selected = keyedSurface({ selection: true });
    expect(selected.down(commandC)).toEqual({ outcome: "binding", prevented: true, stopped: true });
    expect(selected.up(commandC).sent).toBe(false);
    expect(selected.calls).toEqual([["effect", "copy", "performed"]]);
  });

  it("still sends a performable macOS Cmd chord without text, and a Cmd chord an unconsumed bind or Linux leaves", () => {
    // performable:super+arrow_left=adjust_selection:left with no selection: an arrow has no text to type.
    const commandLeft = { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37, metaKey: true };
    const arrow = keyedSurface({ bindings: bound("performable:super+arrow_left", "adjust_selection:left") });
    expect(arrow.down(commandLeft).outcome).toBe("key");
    expect(arrow.calls.at(-1)).toEqual(sent("down", "super+ArrowLeft"));

    // An unconsumed bind asks for its key to be sent.
    const unconsumed = keyedSurface({ bindings: bound("performable:unconsumed:super+c", "copy_to_clipboard") });
    expect(unconsumed.down(commandC).outcome).toBe("key");

    // Linux and Windows hosts are where Super+C types "c", as Ghostty there does.
    const linux = configuredBindingsForPlatform(
      { clearKeybindings: false, keybindings: [{ trigger: "performable:super+c", action: "copy_to_clipboard" }] },
      "linux",
    );
    expect(keyedSurface({ platform: "linux", bindings: linux }).down(commandC).outcome).toBe("key");
  });

  it("sends Ctrl+Shift+C with no selection to the encoder on Linux and Windows, not as the interrupt", () => {
    for (const platform of ["linux", "win32"]) {
      const surface = keyedSurface({ platform });
      expect(surface.down(controlShiftC), platform).toEqual({ outcome: "key", prevented: true, stopped: true });
      expect(surface.calls, platform).toEqual([
        ["effect", "copy", "unperformed"],
        ["clearSelection"],
        sent("down", "ctrl+shift+C"),
      ]);
      expect(keyedSurface({ platform, selection: true }).down(controlShiftC).outcome, platform).toBe("binding");
    }
  });

  it("sends only the exact Ctrl+C as the interrupt, with no release to pair", () => {
    const surface = keyedSurface();
    expect(surface.down(controlC)).toEqual({ outcome: "interrupt", prevented: true, stopped: true });
    expect(surface.up(controlC).sent).toBe(false);
    // Caps Lock leaves it Ctrl+C.
    expect(surface.down({ ...controlC, key: "C" }).outcome).toBe("interrupt");
    expect(surface.calls).toEqual([
      ["clearSelection"],
      ["interrupt", "first", "view-a"],
      ["clearSelection"],
      ["interrupt", "first", "view-a"],
    ]);
    // With Shift or Super Ghostty encodes a key (CSI u); with Alt, ESC then ETX.
    expect(keyedSurface().down(controlShiftC).outcome).toBe("key");
    expect(keyedSurface().down({ ...controlC, metaKey: true }).outcome).toBe("key");
    expect(keyedSurface().down({ ...controlC, altKey: true }).outcome).toBe("key");
  });

  it("runs an unconsumed bind's effect, then sends its key once, and its release", () => {
    const surface = keyedSurface({ bindings: bound("unconsumed:ctrl+x", "scroll_to_bottom"), selection: true });
    const controlX = { key: "x", code: "KeyX", keyCode: 88, ctrlKey: true };
    expect(surface.down(controlX)).toEqual({ outcome: "key", prevented: true, stopped: true });
    expect(surface.up(controlX).sent).toBe(true);
    expect(surface.calls).toEqual([
      ["effect", "scroll_to_bottom", "performed"],
      ["clearSelection"],
      sent("down", "ctrl+x"),
      sent("up", "ctrl+x"),
    ]);
  });

  it("copies with an unconsumed Ctrl+C, then interrupts, as Ghostty copies and then encodes", () => {
    const surface = keyedSurface({ bindings: bound("unconsumed:ctrl+c", "copy_to_clipboard"), selection: true });
    expect(surface.down(controlC).outcome).toBe("interrupt");
    expect(surface.calls).toEqual([
      ["effect", "copy", "performed"],
      ["clearSelection"],
      ["interrupt", "first", "view-a"],
    ]);
  });

  it("copies with a performable Ctrl+C when there is a selection, and otherwise interrupts", () => {
    const bindings = bound("performable:ctrl+c", "copy_to_clipboard");
    expect(keyedSurface({ bindings, selection: true }).down(controlC).outcome).toBe("binding");
    expect(keyedSurface({ bindings }).down(controlC).outcome).toBe("interrupt");
  });

  it("consumes the key of a bind that is not performable, performed or not", () => {
    // super+arrow_left=text:\x01 is not performable; a read-only surface cannot send its text.
    const commandLeft = { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37, metaKey: true };
    for (const interactive of [true, false]) {
      const surface = keyedSurface({ interactive });
      expect(surface.down(commandLeft), String(interactive)).toEqual({
        outcome: "binding",
        prevented: true,
        stopped: true,
      });
      expect(surface.up(commandLeft).sent).toBe(false);
      expect(surface.calls).toEqual([["effect", "text", interactive ? "performed" : "unperformed"]]);
    }
  });

  it("sends no key from a read-only surface, after a bind's effect runs where it can", () => {
    const surface = keyedSurface({ interactive: false });
    expect(surface.down({})).toEqual({ outcome: "read-only", prevented: true, stopped: false });
    expect(surface.down(commandC)).toEqual({ outcome: "read-only", prevented: true, stopped: false });
    expect(surface.down(shiftLeft)).toEqual({ outcome: "read-only", prevented: true, stopped: false });
    expect(surface.up({}).sent).toBe(false);
    expect(surface.calls).toEqual([
      ["effect", "copy", "unperformed"],
      ["effect", "adjust_selection", "unperformed"],
    ]);
    // A selection is still copyable from a read-only surface.
    expect(keyedSurface({ interactive: false, selection: true }).down(commandC).outcome).toBe("binding");
  });

  it("leaves a paste to the keydown's default action on a host without readClipboard", () => {
    const commandV = { key: "v", code: "KeyV", keyCode: 86, metaKey: true };
    const browser = keyedSurface({ readsClipboard: false });
    expect(browser.down(commandV)).toEqual({ outcome: "default-action", prevented: false, stopped: false });
    expect(browser.calls).toEqual([["effect", "paste", "default-action"]]);
    // Linux's shift+insert=paste_from_selection is not performable, and must not prevent the platform's paste either.
    const linux = keyedSurface({ platform: "linux", readsClipboard: false });
    expect(linux.down({ key: "Insert", code: "Insert", keyCode: 45, shiftKey: true }).outcome).toBe("default-action");

    expect(keyedSurface().down(commandV)).toEqual({ outcome: "binding", prevented: true, stopped: true });
    expect(keyedSurface({ interactive: false, readsClipboard: false }).down(commandV).outcome).toBe("read-only");
  });

  it("does not leave a paste bound to another chord to its default action, which would type its text", () => {
    // Option+V types "√" unless prevented; with no readClipboard there is nothing to paste.
    const optionV = { key: "√", code: "KeyV", keyCode: 86, altKey: true };
    const plain = keyedSurface({ bindings: bound("alt+v", "paste_from_clipboard"), readsClipboard: false });
    expect(plain.down(optionV)).toEqual({ outcome: "binding", prevented: true, stopped: true });
    expect(plain.calls).toEqual([["effect", "paste", "default-action"]]);

    // A performable one acts as absent, so Option+V reaches the terminal as a key.
    const performable = keyedSurface({
      bindings: bound("performable:alt+v", "paste_from_clipboard"),
      readsClipboard: false,
    });
    expect(performable.down(optionV)).toEqual({ outcome: "key", prevented: true, stopped: true });
    expect(performable.calls.at(-1)).toEqual(sent("down", "alt+√"));
  });

  it("leaves the text system's keydowns to it before any binding", () => {
    const surface = keyedSurface();
    expect(surface.down({ ...shiftLeft, keyCode: 229 })).toEqual({
      outcome: "text-system",
      prevented: false,
      stopped: false,
    });
    expect(surface.calls).toEqual([]);
  });
});

describe("the platform's own chords", () => {
  const key = (overrides: Partial<KeyboardEvent>) => keydown(overrides);

  it("knows each platform's paste chords and no other", () => {
    for (const chord of [
      { key: "v", code: "KeyV", metaKey: true },
      { key: "V", code: "KeyV", metaKey: true, shiftKey: true },
    ]) {
      expect(isPlatformPasteChord(key(chord), "darwin"), JSON.stringify(chord)).toBe(true);
      expect(isPlatformPasteChord(key(chord), undefined), JSON.stringify(chord)).toBe(true);
      expect(isPlatformPasteChord(key(chord), "linux"), JSON.stringify(chord)).toBe(false);
    }
    for (const chord of [
      { key: "v", code: "KeyV", ctrlKey: true },
      { key: "V", code: "KeyV", ctrlKey: true, shiftKey: true },
      { key: "Insert", code: "Insert", shiftKey: true },
    ]) {
      for (const platform of ["linux", "win32"]) {
        expect(isPlatformPasteChord(key(chord), platform), `${platform} ${JSON.stringify(chord)}`).toBe(true);
      }
      expect(isPlatformPasteChord(key(chord), "darwin"), JSON.stringify(chord)).toBe(false);
    }
    expect(isPlatformPasteChord(key({ key: "√", code: "KeyV", altKey: true }), "darwin")).toBe(false);
    expect(isPlatformPasteChord(key({ key: "v", code: "KeyV", metaKey: true, altKey: true }), "darwin")).toBe(false);
  });

  it("knows a macOS Cmd chord with text from one with Ctrl, without text, or on another platform", () => {
    expect(isMacCommandText({ key: "c", metaKey: true, ctrlKey: false }, "darwin")).toBe(true);
    expect(isMacCommandText({ key: "ç", metaKey: true, ctrlKey: false }, undefined)).toBe(true);
    expect(isMacCommandText({ key: "c", metaKey: true, ctrlKey: true }, "darwin")).toBe(false);
    expect(isMacCommandText({ key: "ArrowLeft", metaKey: true, ctrlKey: false }, "darwin")).toBe(false);
    expect(isMacCommandText({ key: "c", metaKey: false, ctrlKey: false }, "darwin")).toBe(false);
    expect(isMacCommandText({ key: "c", metaKey: true, ctrlKey: false }, "linux")).toBe(false);
    expect(isMacCommandText({ key: "c", metaKey: true, ctrlKey: false }, "win32")).toBe(false);
  });
});

describe("terminalEffectAvailability", () => {
  const state = { hasSelection: false, interactive: true, readsClipboard: true };

  it("needs a selection to copy, adjust or scroll to it, on any surface", () => {
    for (const effect of [
      { type: "copy" },
      { type: "scroll_to_selection" },
      { type: "adjust_selection", direction: "left" },
    ] as const) {
      expect(terminalEffectAvailability(effect, state), effect.type).toBe("unperformed");
      expect(terminalEffectAvailability(effect, { ...state, hasSelection: true }), effect.type).toBe("performed");
      expect(
        terminalEffectAvailability(effect, { ...state, hasSelection: true, interactive: false }),
        effect.type,
      ).toBe("performed");
    }
  });

  it("needs a surface that takes input to send text or paste, and leaves a paste without readClipboard to the platform", () => {
    expect(terminalEffectAvailability({ type: "text", text: "x" }, state)).toBe("performed");
    expect(terminalEffectAvailability({ type: "text", text: "x" }, { ...state, interactive: false })).toBe(
      "unperformed",
    );
    expect(terminalEffectAvailability({ type: "paste" }, state)).toBe("performed");
    expect(terminalEffectAvailability({ type: "paste" }, { ...state, readsClipboard: false })).toBe("default-action");
    expect(terminalEffectAvailability({ type: "paste" }, { ...state, interactive: false })).toBe("unperformed");
    expect(terminalEffectAvailability({ type: "select_all" }, state)).toBe("performed");
    expect(terminalEffectAvailability({ type: "scroll_page_up" }, { ...state, interactive: false })).toBe("performed");
  });
});
