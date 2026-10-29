import type { TerminalKeyEvent } from "@vibecook/ghosttea-protocol";
import { terminalKeyDown, terminalKeyUp, type KeyboardLayoutResolver } from "./keyboard-input.js";

/**
 * Text input that reaches the terminal's hidden textarea from the platform's
 * text system rather than as a keydown the terminal encodes: an IME's commit,
 * the macOS Character Viewer, the Windows emoji panel, touch keyboard and voice
 * typing, a soft keyboard's text and its Enter and Backspace, a drop. The
 * textarea is kept empty outside a composition, so whatever the platform puts
 * in it is new input for the terminal.
 *
 * The semantics follow the iOS surface's `GhostteaCompositionBuffer`: committed
 * text is text, a line break in it is the Enter key, and a delete with nothing
 * to delete is the Backspace key.
 */

/** A key the text system asks for with an input event instead of a keydown. */
export type TerminalEditKey = "Enter" | "Backspace" | "Delete";

export type TerminalTextInputAction =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "paste"; readonly text: string }
  | { readonly type: "key"; readonly key: TerminalEditKey };

/** The fields of a DOM `InputEvent` the classification reads. */
export interface TerminalInputEventLike {
  readonly inputType: string;
  readonly data: string | null;
  readonly isComposing: boolean;
}

export interface TerminalBeforeInputEventLike extends TerminalInputEventLike {
  readonly cancelable: boolean;
  preventDefault(): void;
}

/** The fields of a DOM `KeyboardEvent` that say whether the text system owns it. */
export type TerminalTextKeyEventLike = Pick<KeyboardEvent, "key" | "keyCode" | "isComposing">;

/** The textarea, or anything with a value the platform edits. */
export interface TerminalTextField {
  value: string;
}

export interface TerminalTextInputSink {
  /** Whether the surface takes input. A read-only surface sends nothing. */
  readonly interactive: boolean;
  /** Sends the actions to the terminal, in order. */
  commit(actions: readonly TerminalTextInputAction[]): void;
}

const ENTER: TerminalTextInputAction = { type: "key", key: "Enter" };
const BACKSPACE: TerminalTextInputAction = { type: "key", key: "Backspace" };
const DELETE: TerminalTextInputAction = { type: "key", key: "Delete" };

/** Edits that carry clipboard-like content: the terminal pastes them, as Ghostty does a drop. */
const PASTE_INPUT_TYPES: ReadonlySet<string> = new Set([
  "insertFromPaste",
  "insertFromPasteAsQuotation",
  "insertFromDrop",
]);

/**
 * The keyCode engines give a keydown the IME processed, whose result arrives as
 * composition or input events. Chromium on Windows and Linux also names its key
 * "Process", as Firefox does while composing, but Chromium on macOS keeps the
 * typed key (an "n") and changes only the keyCode. The keydown that starts a
 * composition is not yet `isComposing` either, so on macOS this keyCode is all
 * that marks it, and encoding it would send its letter ahead of the commit.
 * WebKit also sends such a keydown after `compositionend` for the key that
 * committed the composition, Enter included.
 */
const IME_PROCESSED_KEY_CODE = 229;

/**
 * Committed text as terminal input: the text between line breaks, and the
 * Enter key for each `\r\n`, `\r` or `\n`, so a soft keyboard's or an IME's
 * line break sends what the Enter key sends rather than a bare LF.
 */
export function committedTextActions(text: string): TerminalTextInputAction[] {
  const actions: TerminalTextInputAction[] = [];
  text.split(/\r\n|\r|\n/).forEach((line, index) => {
    if (index > 0) actions.push(ENTER);
    if (line) actions.push({ type: "text", text: line });
  });
  return actions;
}

/**
 * What a `beforeinput` on the textarea asks of the terminal, or null when it is
 * not the terminal's to take now: a composition's edits (the commit arrives at
 * `compositionend`), an edit with no data to send, a delete of text the field
 * still holds, and every edit type a terminal has no meaning for.
 */
export function terminalBeforeInputActions(
  event: TerminalInputEventLike,
  value: string,
): TerminalTextInputAction[] | null {
  if (event.isComposing) return null;
  switch (event.inputType) {
    case "insertText":
    case "insertReplacementText":
      return event.data ? committedTextActions(event.data) : null;
    case "insertLineBreak":
    case "insertParagraph":
      return [ENTER];
    case "insertFromPaste":
    case "insertFromPasteAsQuotation":
    case "insertFromDrop":
      return event.data ? [{ type: "paste", text: event.data }] : null;
    case "deleteContentBackward":
      return value === "" ? [BACKSPACE] : null;
    case "deleteContentForward":
      return value === "" ? [DELETE] : null;
    default:
      return null;
  }
}

/**
 * What an `input` the browser applied leaves in the textarea for the terminal,
 * which the caller then clears: pasted or dropped content as a paste, anything
 * else as committed text. Null while a composition owns the field.
 */
export function terminalInputActions(
  event: Pick<TerminalInputEventLike, "inputType" | "isComposing">,
  value: string,
): TerminalTextInputAction[] | null {
  if (event.isComposing) return null;
  if (value === "") return [];
  return PASTE_INPUT_TYPES.has(event.inputType) ? [{ type: "paste", text: value }] : committedTextActions(value);
}

/**
 * The key events an edit key sends: the press and release the physical key
 * would, through the same `terminalKeyDown`, so a soft keyboard's Enter
 * encodes exactly as the Enter key does under every keyboard protocol.
 */
export function terminalEditKeyEvents(
  key: TerminalEditKey,
  timestamp: number,
  resolver?: KeyboardLayoutResolver,
): [down: TerminalKeyEvent, up: TerminalKeyEvent] {
  const event = {
    key,
    code: key,
    location: 0,
    repeat: false,
    shiftKey: false,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    timeStamp: timestamp,
  };
  const down = terminalKeyDown(event, resolver);
  return [down, terminalKeyUp(down, event)];
}

/**
 * The textarea's text-input state machine. Each edit reaches the terminal
 * exactly once, whichever of its events arrive and in whatever order:
 *
 * - A keydown the terminal encodes is prevented by the surface, so no input
 *   follows it. A keydown the text system owns (composing, keyCode 229,
 *   "Process", "Unidentified") is neither encoded nor prevented, and its text
 *   arrives here instead.
 * - A cancelable `beforeinput` is taken and prevented, so nothing lands in the
 *   field. Should a browser apply it anyway, its `input` is dropped.
 * - An edit the browser applies regardless (an uncancelable `beforeinput`)
 *   reaches `input`, which sends what landed in the field and clears it. A
 *   delete lands nothing, so an uncancelable one is remembered for its `input`.
 * - A composition's text is sent at `compositionend` from the field, which is
 *   then cleared. Until then the composition owns the field, whatever its
 *   events say: Chromium's commit `input` comes before `compositionend` and is
 *   composing, and WebKit's commit edits (`deleteCompositionText`,
 *   `insertFromComposition`) come before it too but are not. Firefox's `input`
 *   comes after `compositionend` and finds the field empty.
 */
export class TerminalTextInput {
  #composing = false;
  #prevented = false;
  #uncancelableDelete: TerminalTextInputAction | null = null;

  /**
   * Notes a keydown; true when the text system owns it, so the terminal must
   * neither encode it nor prevent it. Only the event decides: a composition
   * this object believes in never takes a key the platform did not give it.
   */
  keyDown(event: TerminalTextKeyEventLike): boolean {
    this.#forgetEdit();
    return (
      event.isComposing ||
      event.keyCode === IME_PROCESSED_KEY_CODE ||
      event.key === "Process" ||
      event.key === "Unidentified"
    );
  }

  compositionStart(): void {
    this.#composing = true;
    this.#forgetEdit();
  }

  compositionEnd(field: TerminalTextField, sink: TerminalTextInputSink): void {
    this.#composing = false;
    this.#forgetEdit();
    this.#flush(committedTextActions(field.value), field, sink);
  }

  /** A blur ends whatever composition a missed `compositionend` left behind; the field keeps its text for one still to come. */
  blur(): void {
    this.#composing = false;
    this.#forgetEdit();
  }

  beforeInput(event: TerminalBeforeInputEventLike, field: TerminalTextField, sink: TerminalTextInputSink): void {
    this.#forgetEdit();
    if (this.#composing || event.isComposing) return;
    if (!sink.interactive) {
      if (event.cancelable) event.preventDefault();
      return;
    }
    const actions = terminalBeforeInputActions(event, field.value);
    if (!actions) return;
    if (!event.cancelable) {
      const [only] = actions;
      if (actions.length === 1 && only?.type === "key" && only.key !== "Enter") this.#uncancelableDelete = only;
      return;
    }
    event.preventDefault();
    this.#prevented = true;
    sink.commit(actions);
  }

  input(event: Partial<TerminalInputEventLike>, field: TerminalTextField, sink: TerminalTextInputSink): void {
    const composing = this.#composing || event.isComposing === true;
    const prevented = this.#prevented;
    const uncancelableDelete = this.#uncancelableDelete;
    this.#forgetEdit();
    if (composing) return;
    if (prevented) {
      field.value = "";
      return;
    }
    const actions = terminalInputActions({ inputType: event.inputType ?? "", isComposing: false }, field.value) ?? [];
    this.#flush(actions.length === 0 && uncancelableDelete ? [uncancelableDelete] : actions, field, sink);
  }

  #flush(actions: readonly TerminalTextInputAction[], field: TerminalTextField, sink: TerminalTextInputSink): void {
    field.value = "";
    if (sink.interactive && actions.length > 0) sink.commit(actions);
  }

  #forgetEdit(): void {
    this.#prevented = false;
    this.#uncancelableDelete = null;
  }
}

/** The textarea, as `attachTerminalTextInput` listens to it. */
export interface TerminalTextInputTarget extends TerminalTextField {
  addEventListener(type: string, listener: (event: Event) => void): void;
  removeEventListener(type: string, listener: (event: Event) => void): void;
}

/**
 * Wires the textarea's text-input events to `textInput` and returns the
 * cleanup. They are listened to natively: React's `onBeforeInput` is its own
 * polyfill over keypress and textInput, not the DOM's `InputEvent`. Keydowns
 * stay with the surface, which asks `textInput.keyDown` before its bindings.
 */
export function attachTerminalTextInput(
  field: TerminalTextInputTarget,
  textInput: TerminalTextInput,
  sink: TerminalTextInputSink,
): () => void {
  const listeners: readonly (readonly [string, (event: Event) => void])[] = [
    ["beforeinput", (event) => textInput.beforeInput(event as InputEvent, field, sink)],
    ["input", (event) => textInput.input(event as InputEvent, field, sink)],
    ["compositionstart", () => textInput.compositionStart()],
    ["compositionend", () => textInput.compositionEnd(field, sink)],
    ["blur", () => textInput.blur()],
  ];
  for (const [type, listener] of listeners) field.addEventListener(type, listener);
  return () => {
    for (const [type, listener] of listeners) field.removeEventListener(type, listener);
  };
}
