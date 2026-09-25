import { describe, expect, it } from "vitest";
import { linkAtCell, linkModifierPressed, TerminalLinkGesture } from "./link-input.js";

const link = {
  uri: "https://example.com/",
  explicit: false,
  spans: [
    { row: 0, startColumn: 5, endColumn: 20 },
    { row: 1, startColumn: 0, endColumn: 4 },
  ],
};
const mods = { metaKey: true, ctrlKey: false, altKey: false, shiftKey: false };

describe("terminal link input", () => {
  it("uses Command on macOS and Control elsewhere, including Shift mouse-capture bypass", () => {
    expect(linkModifierPressed(mods, "darwin")).toBe(true);
    expect(linkModifierPressed({ ...mods, shiftKey: true }, "darwin")).toBe(true);
    expect(linkModifierPressed(mods, "linux")).toBe(false);
    expect(linkModifierPressed({ ...mods, metaKey: false, ctrlKey: true }, "win32")).toBe(true);
    expect(linkModifierPressed({ ...mods, altKey: true }, "darwin")).toBe(false);
  });
  it("hit-tests wrapped spans with exclusive end columns", () => {
    expect(linkAtCell([link], 5, 0)).toBe(link);
    expect(linkAtCell([link], 3, 1)).toBe(link);
    expect(linkAtCell([link], 4, 1)).toBeNull();
    expect(linkAtCell([link], 20, 0)).toBeNull();
  });
  it("opens only a primary gesture released on the same retained target", () => {
    const gesture = new TerminalLinkGesture();
    gesture.begin(1, link, 10, 10);
    expect(gesture.finish(1, link)).toBe(link.uri);
    expect(gesture.finish(1, link)).toBeNull();
    gesture.begin(1, link, 10, 10);
    expect(gesture.finish(2, link)).toBeNull();
    gesture.begin(1, link, 10, 10);
    expect(gesture.finish(1, { ...link })).toBeNull();
  });
  it("never opens after a drag, cancellation, or leaving the target", () => {
    const gesture = new TerminalLinkGesture();
    gesture.begin(1, link, 10, 10);
    gesture.move(1, 20, 10);
    gesture.move(1, 10, 10);
    expect(gesture.finish(1, link)).toBeNull();
    gesture.begin(1, link, 10, 10);
    gesture.cancel();
    expect(gesture.finish(1, link)).toBeNull();
    gesture.begin(1, link, 10, 10);
    expect(gesture.finish(1, null)).toBeNull();
  });
});
