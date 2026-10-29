import { describe, expect, it } from "vitest";

import { effectIntermediateTextureCount, selectionRowCellLength, specialDrawingCells } from "./webgpu-renderer.js";

describe("WebGPU special-cell classification", () => {
  it("uses terminal columns for mixed ASCII, block, and box cells", () => {
    const cells = specialDrawingCells("a▀b╭c");

    expect([...cells.block]).toEqual([[1, "▀"]]);
    expect([...cells.box]).toEqual([[3, "╭"]]);
  });

  it("falls back to grapheme widths for wide and combining text", () => {
    const cells = specialDrawingCells("日▀e\u0301╭");

    expect([...cells.block]).toEqual([[2, "▀"]]);
    expect([...cells.box]).toEqual([[4, "╭"]]);
  });

  it("does not replace letters with blocks after a host-width ZWJ cluster", () => {
    // Browser widths put the block at column 4; the host puts the letter a
    // there. The native font glyphs remain the exact fallback for this row.
    const cells = specialDrawingCells("👩‍💻ab▀X", [
      { cellStart: 0, cellSpan: 4 },
      { cellStart: 4, cellSpan: 1 },
      { cellStart: 5, cellSpan: 1 },
      { cellStart: 6, cellSpan: 1 },
      { cellStart: 7, cellSpan: 1 },
    ]);
    expect(cells.block.size).toBe(0);
    expect(cells.box.size).toBe(0);
  });

  it("preserves procedural drawing when the host grid agrees", () => {
    const cells = specialDrawingCells("日▀e\u0301╭", [
      { cellStart: 0, cellSpan: 2 },
      { cellStart: 2, cellSpan: 1 },
      { cellStart: 3, cellSpan: 1 },
      { cellStart: 4, cellSpan: 1 },
    ]);
    expect([...cells.block]).toEqual([[2, "▀"]]);
    expect([...cells.box]).toEqual([[4, "╭"]]);
  });
});

describe("native selection backdrop", () => {
  it("covers following text after a host's four-column joined emoji", () => {
    expect(
      selectionRowCellLength("👩‍💻X", [
        { cellStart: 0, cellSpan: 4 },
        { cellStart: 4, cellSpan: 1 },
      ]),
    ).toBe(5);
    expect(
      selectionRowCellLength("🛙X", [
        { cellStart: 0, cellSpan: 2 },
        { cellStart: 2, cellSpan: 1 },
      ]),
    ).toBe(3);
  });

  it("keeps trailing spaces and text-only fallback selection", () => {
    expect(selectionRowCellLength("X   ", [{ cellStart: 0, cellSpan: 1 }])).toBe(4);
    expect(selectionRowCellLength("👩‍💻X   ", [{ cellStart: 4, cellSpan: 1 }])).toBe(8);
    expect(selectionRowCellLength("日e\u0301", [])).toBe(3);
  });
});

describe("WebGPU effect targets", () => {
  it("allocates only the intermediates required before the canvas pass", () => {
    expect([0, 1, 2, 3, 4].map(effectIntermediateTextureCount)).toEqual([0, 0, 1, 2, 2]);
  });
});
