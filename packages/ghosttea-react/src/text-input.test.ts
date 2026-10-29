import { describe, expect, it } from "vitest";
import { KeyboardLayoutResolver, terminalKeyDown, terminalKeyUp } from "./keyboard-input";
import {
  committedTextActions,
  TerminalTextInput,
  terminalBeforeInputActions,
  terminalEditKeyEvents,
  terminalInputActions,
  type TerminalBeforeInputEventLike,
  type TerminalTextInputAction,
  type TerminalTextInputSink,
  type TerminalTextKeyEventLike,
} from "./text-input";

const text = (value: string): TerminalTextInputAction => ({ type: "text", text: value });
const paste = (value: string): TerminalTextInputAction => ({ type: "paste", text: value });
const ENTER: TerminalTextInputAction = { type: "key", key: "Enter" };
const BACKSPACE: TerminalTextInputAction = { type: "key", key: "Backspace" };
const DELETE: TerminalTextInputAction = { type: "key", key: "Delete" };

const edit = (inputType: string, data: string | null = null, isComposing = false) => ({ inputType, data, isComposing });

describe("committed text", () => {
  it("is text between line breaks and the Enter key for each break, as on iOS", () => {
    expect(committedTextActions("")).toEqual([]);
    expect(committedTextActions("日本語")).toEqual([text("日本語")]);
    expect(committedTextActions("ls\n")).toEqual([text("ls"), ENTER]);
    expect(committedTextActions("\r\n")).toEqual([ENTER]);
    expect(committedTextActions("a\r\n\rb\nc")).toEqual([text("a"), ENTER, ENTER, text("b"), ENTER, text("c")]);
  });
});

describe("terminalBeforeInputActions", () => {
  it("takes what the text system inserts without a usable keydown", () => {
    expect(terminalBeforeInputActions(edit("insertText", "😀"), "")).toEqual([text("😀")]);
    expect(terminalBeforeInputActions(edit("insertText", " "), "")).toEqual([text(" ")]);
    expect(terminalBeforeInputActions(edit("insertReplacementText", "é"), "")).toEqual([text("é")]);
    expect(terminalBeforeInputActions(edit("insertText", "one\ntwo"), "")).toEqual([text("one"), ENTER, text("two")]);
  });

  it("makes a soft keyboard's line break the Enter key and its delete on the empty field Backspace or Delete", () => {
    expect(terminalBeforeInputActions(edit("insertLineBreak"), "")).toEqual([ENTER]);
    expect(terminalBeforeInputActions(edit("insertParagraph"), "")).toEqual([ENTER]);
    expect(terminalBeforeInputActions(edit("deleteContentBackward"), "")).toEqual([BACKSPACE]);
    expect(terminalBeforeInputActions(edit("deleteContentForward"), "")).toEqual([DELETE]);
    // A delete of text the field still holds is the field's own.
    expect(terminalBeforeInputActions(edit("deleteContentBackward"), "x")).toBeNull();
    expect(terminalBeforeInputActions(edit("deleteContentForward"), "x")).toBeNull();
  });

  it("pastes pasted and dropped content, as Ghostty pastes a drop", () => {
    expect(terminalBeforeInputActions(edit("insertFromPaste", "a\nb"), "")).toEqual([paste("a\nb")]);
    expect(terminalBeforeInputActions(edit("insertFromPasteAsQuotation", "q"), "")).toEqual([paste("q")]);
    expect(terminalBeforeInputActions(edit("insertFromDrop", "/tmp/a b"), "")).toEqual([paste("/tmp/a b")]);
  });

  it("leaves compositions, edits without data and edit types a terminal has no meaning for to the browser", () => {
    expect(terminalBeforeInputActions(edit("insertText", "a", true), "")).toBeNull();
    expect(terminalBeforeInputActions(edit("insertCompositionText", "に", true), "")).toBeNull();
    expect(terminalBeforeInputActions(edit("insertCompositionText", "に"), "")).toBeNull();
    expect(terminalBeforeInputActions(edit("insertFromComposition", "日本"), "")).toBeNull();
    expect(terminalBeforeInputActions(edit("deleteCompositionText"), "")).toBeNull();
    expect(terminalBeforeInputActions(edit("insertText", null), "")).toBeNull();
    expect(terminalBeforeInputActions(edit("insertText", ""), "")).toBeNull();
    expect(terminalBeforeInputActions(edit("insertFromDrop", null), "")).toBeNull();
    for (const inputType of ["historyUndo", "historyRedo", "deleteWordBackward", "insertFromYank", "formatBold"]) {
      expect(terminalBeforeInputActions(edit(inputType), "")).toBeNull();
    }
  });
});

describe("terminalInputActions", () => {
  it("sends what landed in the field, as a paste for pasted or dropped content", () => {
    expect(terminalInputActions(edit("insertText"), "")).toEqual([]);
    expect(terminalInputActions(edit("insertText"), "あ")).toEqual([text("あ")]);
    expect(terminalInputActions(edit("insertLineBreak"), "\n")).toEqual([ENTER]);
    expect(terminalInputActions(edit("insertFromDrop"), "dropped")).toEqual([paste("dropped")]);
    expect(terminalInputActions(edit("insertFromPaste"), "pasted")).toEqual([paste("pasted")]);
    expect(terminalInputActions(edit("", null), "plain")).toEqual([text("plain")]);
  });

  it("leaves a composition's field alone", () => {
    expect(terminalInputActions(edit("insertCompositionText", "に", true), "に")).toBeNull();
  });
});

describe("terminalEditKeyEvents", () => {
  const physical = (key: string) =>
    ({
      key,
      code: key,
      location: 0,
      repeat: false,
      shiftKey: false,
      ctrlKey: false,
      altKey: false,
      metaKey: false,
      timeStamp: 5,
    }) as KeyboardEvent;

  it("sends the press and release the physical key sends", () => {
    for (const key of ["Enter", "Backspace", "Delete"] as const) {
      const resolver = new KeyboardLayoutResolver();
      const down = terminalKeyDown(physical(key), resolver);
      expect(terminalEditKeyEvents(key, 5, new KeyboardLayoutResolver())).toEqual([
        down,
        terminalKeyUp(down, physical(key)),
      ]);
      expect(down).toMatchObject({ type: "down", key, code: key, unshiftedCodepoint: 0 });
    }
  });
});

interface Harness {
  input: TerminalTextInput;
  field: { value: string };
  sink: TerminalTextInputSink & { interactive: boolean };
  sent: TerminalTextInputAction[];
  /** A beforeinput; returns whether it was prevented. The caller applies an unprevented edit to the field. */
  beforeInput(
    inputType: string,
    data: string | null,
    options?: { cancelable?: boolean; isComposing?: boolean },
  ): boolean;
  input_(inputType: string, options?: { isComposing?: boolean }): void;
}

function harness(): Harness {
  const sent: TerminalTextInputAction[] = [];
  const sink = {
    interactive: true,
    commit: (actions: readonly TerminalTextInputAction[]) => {
      sent.push(...actions);
    },
  };
  const field = { value: "" };
  const input = new TerminalTextInput();
  return {
    input,
    field,
    sink,
    sent,
    beforeInput(inputType, data, { cancelable = true, isComposing = false } = {}) {
      let prevented = false;
      const event: TerminalBeforeInputEventLike = {
        inputType,
        data,
        isComposing,
        cancelable,
        preventDefault: () => {
          if (cancelable) prevented = true;
        },
      };
      input.beforeInput(event, field, sink);
      return prevented;
    },
    input_(inputType, { isComposing = false } = {}) {
      input.input({ inputType, data: null, isComposing }, field, sink);
    },
  };
}

const keydown = (overrides: Partial<TerminalTextKeyEventLike> = {}): TerminalTextKeyEventLike => ({
  key: "a",
  keyCode: 65,
  isComposing: false,
  ...overrides,
});

describe("TerminalTextInput", () => {
  it("leaves to the text system only the keydowns it owns", () => {
    const input = new TerminalTextInput();
    expect(input.keyDown(keydown())).toBe(false);
    expect(input.keyDown(keydown({ key: "Enter", keyCode: 13 }))).toBe(false);
    expect(input.keyDown(keydown({ key: "Dead", keyCode: 222 }))).toBe(false);
    expect(input.keyDown(keydown({ isComposing: true }))).toBe(true);
    expect(input.keyDown(keydown({ key: "Process", keyCode: 229 }))).toBe(true);
    expect(input.keyDown(keydown({ key: "Unidentified", keyCode: 229 }))).toBe(true);
    expect(input.keyDown(keydown({ key: "Unidentified", keyCode: 0 }))).toBe(true);
    // Chromium on macOS: the keydown that starts a composition keeps its key and is not yet composing.
    expect(input.keyDown(keydown({ key: "n", keyCode: 229 }))).toBe(true);
    // WebKit's keydown for the Enter that committed a composition, after compositionend.
    expect(input.keyDown(keydown({ key: "Enter", keyCode: 229 }))).toBe(true);
  });

  it("never lets a believed composition take a key the platform did not give it", () => {
    const input = new TerminalTextInput();
    input.compositionStart();
    expect(input.keyDown(keydown())).toBe(false);
  });

  it("sends an insert with no keydown once: the macOS Character Viewer", () => {
    const h = harness();
    expect(h.beforeInput("insertText", "😀")).toBe(true);
    expect(h.sent).toEqual([text("😀")]);
    expect(h.field.value).toBe("");
  });

  it("sends a keyCode 229 keydown's insert once, whether or not the browser honors the prevented beforeinput", () => {
    const honored = harness();
    expect(honored.input.keyDown(keydown({ key: "Unidentified", keyCode: 229 }))).toBe(true);
    expect(honored.beforeInput("insertText", "é")).toBe(true);
    expect(honored.sent).toEqual([text("é")]);

    const ignored = harness();
    ignored.input.keyDown(keydown({ key: "Process", keyCode: 229 }));
    ignored.beforeInput("insertText", "é");
    // The browser inserted it anyway.
    ignored.field.value = "é";
    ignored.input_("insertText");
    expect(ignored.sent).toEqual([text("é")]);
    expect(ignored.field.value).toBe("");
  });

  it("sends an uncancelable insert from the field at input, once", () => {
    const h = harness();
    h.input.keyDown(keydown({ key: "Unidentified", keyCode: 229 }));
    expect(h.beforeInput("insertText", "あ", { cancelable: false })).toBe(false);
    expect(h.sent).toEqual([]);
    h.field.value = "あ";
    h.input_("insertText");
    expect(h.sent).toEqual([text("あ")]);
    expect(h.field.value).toBe("");
  });

  it("sends a soft keyboard's Enter as the Enter key, cancelable or not", () => {
    const cancelable = harness();
    expect(cancelable.beforeInput("insertLineBreak", null)).toBe(true);
    expect(cancelable.sent).toEqual([ENTER]);

    const uncancelable = harness();
    uncancelable.beforeInput("insertParagraph", null, { cancelable: false });
    uncancelable.field.value = "\n";
    uncancelable.input_("insertParagraph");
    expect(uncancelable.sent).toEqual([ENTER]);
  });

  it("sends a soft keyboard's Backspace on the empty field as the Backspace key, cancelable or not", () => {
    const cancelable = harness();
    expect(cancelable.beforeInput("deleteContentBackward", null)).toBe(true);
    expect(cancelable.sent).toEqual([BACKSPACE]);

    const uncancelable = harness();
    uncancelable.beforeInput("deleteContentBackward", null, { cancelable: false });
    // Nothing to delete, so nothing landed.
    uncancelable.input_("deleteContentBackward");
    expect(uncancelable.sent).toEqual([BACKSPACE]);

    // An input that no uncancelable delete announced sends no key.
    const unannounced = harness();
    unannounced.input_("deleteContentBackward");
    expect(unannounced.sent).toEqual([]);
  });

  it("sends a composition once in Chromium's order: input while composing, then compositionend", () => {
    const h = harness();
    h.input.compositionStart();
    expect(h.input.keyDown(keydown({ key: "Process", keyCode: 229 }))).toBe(true);
    expect(h.beforeInput("insertCompositionText", "に", { isComposing: true })).toBe(false);
    h.field.value = "に";
    h.input_("insertCompositionText", { isComposing: true });
    expect(h.field.value).toBe("に");
    h.beforeInput("insertCompositionText", "日本", { isComposing: true });
    h.field.value = "日本";
    h.input_("insertCompositionText", { isComposing: true });
    expect(h.sent).toEqual([]);
    h.input.compositionEnd(h.field, h.sink);
    expect(h.sent).toEqual([text("日本")]);
    expect(h.field.value).toBe("");
  });

  it("sends a composition once in Firefox's order: compositionend, then an input not composing", () => {
    const h = harness();
    h.input.compositionStart();
    h.field.value = "日本";
    h.input_("insertCompositionText", { isComposing: true });
    h.input.compositionEnd(h.field, h.sink);
    expect(h.field.value).toBe("");
    h.input_("insertCompositionText");
    expect(h.sent).toEqual([text("日本")]);
  });

  it("sends a composition once in WebKit's order: the commit's edits, not composing, then compositionend", () => {
    const h = harness();
    h.input.compositionStart();
    h.field.value = "にほん";
    h.input_("insertCompositionText", { isComposing: true });
    // WebKit deletes the composition and inserts its commit before compositionend, with no composition left to report.
    expect(h.beforeInput("deleteCompositionText", null, { cancelable: false })).toBe(false);
    h.field.value = "";
    h.input_("deleteCompositionText");
    // Not prevented: compositionend sends the commit from the field.
    expect(h.beforeInput("insertFromComposition", "日本")).toBe(false);
    h.field.value = "日本";
    h.input_("insertFromComposition");
    expect(h.sent).toEqual([]);
    expect(h.field.value).toBe("日本");
    h.input.compositionEnd(h.field, h.sink);
    // WebKit's keydown for the committing Enter follows, and is the text system's.
    expect(h.input.keyDown(keydown({ key: "Enter", keyCode: 229 }))).toBe(true);
    expect(h.sent).toEqual([text("日本")]);
    expect(h.field.value).toBe("");
  });

  it("sends a composition once when focus leaves before WebKit commits it", () => {
    // A click elsewhere moves focus first; WebKit then commits into the field and sends it compositionend.
    const h = harness();
    h.input.compositionStart();
    h.field.value = "にほん";
    h.input_("insertCompositionText", { isComposing: true });
    h.input.blur();
    h.beforeInput("deleteCompositionText", null, { cancelable: false });
    h.field.value = "";
    h.input_("deleteCompositionText");
    expect(h.beforeInput("insertFromComposition", "日本")).toBe(false);
    h.field.value = "日本";
    h.input_("insertFromComposition");
    h.input.compositionEnd(h.field, h.sink);
    expect(h.sent).toEqual([text("日本")]);
    expect(h.field.value).toBe("");
  });

  it("sends a commit and the text inserted after it, each once", () => {
    // Korean: a syllable's composition, then the space the IME inserts outside it.
    const h = harness();
    h.input.compositionStart();
    h.field.value = "한";
    h.input_("insertCompositionText", { isComposing: true });
    h.input.compositionEnd(h.field, h.sink);
    h.input.keyDown(keydown({ key: "Process", keyCode: 229 }));
    expect(h.beforeInput("insertText", " ")).toBe(true);
    expect(h.sent).toEqual([text("한"), text(" ")]);
  });

  it("pastes a paste the surface's paste handler left to the browser, and a drop, once", () => {
    const pasted = harness();
    expect(pasted.beforeInput("insertFromPaste", "a\nb")).toBe(true);
    expect(pasted.sent).toEqual([paste("a\nb")]);

    const dropped = harness();
    dropped.beforeInput("insertFromDrop", null);
    dropped.field.value = "dropped text";
    dropped.input_("insertFromDrop");
    expect(dropped.sent).toEqual([paste("dropped text")]);
  });

  it("sends nothing for a read-only surface and keeps its field empty", () => {
    const h = harness();
    h.sink.interactive = false;
    expect(h.beforeInput("insertText", "x")).toBe(true);
    h.beforeInput("insertText", "y", { cancelable: false });
    h.field.value = "y";
    h.input_("insertText");
    expect(h.field.value).toBe("");
    h.input.compositionStart();
    h.field.value = "日本";
    h.input.compositionEnd(h.field, h.sink);
    expect(h.field.value).toBe("");
    expect(h.sent).toEqual([]);
  });

  it("forgets a prevented edit at the next event, so a later uncancelable insert is still sent", () => {
    const h = harness();
    h.beforeInput("insertText", "a");
    h.input.keyDown(keydown({ key: "Unidentified", keyCode: 229 }));
    h.beforeInput("insertText", "b", { cancelable: false });
    h.field.value = "b";
    h.input_("insertText");
    expect(h.sent).toEqual([text("a"), text("b")]);
  });

  it("ends a composition a missed compositionend left behind at blur", () => {
    const h = harness();
    h.input.compositionStart();
    h.input.blur();
    expect(h.beforeInput("insertText", "😀")).toBe(true);
    expect(h.sent).toEqual([text("😀")]);
  });
});
