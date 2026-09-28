import { describe, expect, it } from "vitest";
import { rowDamage, selectionDamageRows, shiftDamage } from "./row-damage.js";

const screen = (rows: string[]) => ({ rows, nativeRows: rows.map(() => []), nativeStyleRows: rows.map(() => []) });

describe("exact row damage", () => {
  it("reuses shifted rows while repainting exposed and overwritten rows", () => {
    expect(rowDamage(screen(["a", "b", "c", "d", "e"]), screen(["b", "c", "changed", "e", "f"]))).toEqual({
      scrollRows: 1,
      rows: [2, 4],
    });
    expect(rowDamage(screen(["b", "c", "d"]), screen(["a", "b", "c"]))).toEqual({ scrollRows: -1, rows: [0] });
  });
  it("repaints glyph/style changes even when the text did not change", () => {
    const before = {
      ...screen(["a", "b", "c"]),
      nativeStyleRows: [[{ styleId: 1, cellStart: 0, cellSpan: 1 }], [], []],
    };
    expect(rowDamage(before, screen(["a", "b", "c"]))).toEqual({ scrollRows: 0, rows: [0] });
  });
  it("does not infer motion from a screen of repeated lines", () => {
    expect(rowDamage(screen(["x", "x", "x"]), screen(["x", "x", "x"]))).toEqual({ scrollRows: 0, rows: [] });
    expect(rowDamage(screen(["a", "b", "c"]), screen(["z", "a", "y"]))).toEqual({ scrollRows: 0, rows: [0, 1, 2] });
  });
  it("translates pending damage through multiple arrivals before a paint", () => {
    const rows = new Set([1, 4]);
    shiftDamage(rows, 1, 5);
    rows.add(4);
    shiftDamage(rows, 1, 5);
    rows.add(4);
    expect([...rows]).toEqual([2, 3, 4]);
  });
  it("bounds selection damage and includes the erased selection", () => {
    const selection = { anchor: { row: 2, column: 0 }, focus: { row: 3, column: 8 } };
    expect(selectionDamageRows(selection, null, 40)).toEqual([2, 3]);
    expect(selectionDamageRows(null, { anchor: { row: -5, column: 0 }, focus: { row: 100, column: 0 } }, 3)).toEqual([
      0, 1, 2,
    ]);
  });
});
