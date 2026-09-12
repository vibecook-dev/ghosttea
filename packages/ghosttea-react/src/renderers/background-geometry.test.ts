import { describe, expect, it } from "vitest";
import { backgroundRunBounds } from "./background-geometry.js";
import { CELL_WIDTH, LINE_HEIGHT, ORIGIN_X, ORIGIN_Y } from "./types.js";

describe("terminal edge backgrounds", () => {
  it.each([1, 1.25, 1.5, 2])("covers the whole canvas for a uniform TUI at DPR %s", (scale) => {
    // Cross column and row boundaries, including the screenshot's 89-column pane.
    for (const width of [700, 704.125, 706, 708, 710, 714]) {
      for (const height of [498, 501.25, 518]) {
        const cols = Math.floor((width - 2 * ORIGIN_X) / CELL_WIDTH);
        const rows = Math.floor((height - 2 * ORIGIN_Y) / LINE_HEIGHT);
        const pixelWidth = Math.round(width * scale);
        const pixelHeight = Math.round(height * scale);
        let bottom = 0;
        for (let row = 0; row < rows; row++) {
          const bounds = backgroundRunBounds(
            { cellStart: 0, cellSpan: cols },
            row,
            cols,
            rows,
            scale,
            pixelWidth,
            pixelHeight,
          )!;
          expect(bounds.x).toBe(0);
          expect(bounds.width).toBe(pixelWidth);
          expect(bounds.y).toBeCloseTo(bottom);
          bottom = bounds.y + bounds.height;
        }
        expect(bottom).toBe(pixelHeight);
      }
    }
  });

  it("keeps interior colors inside their own cells", () => {
    const bounds = backgroundRunBounds({ cellStart: 4, cellSpan: 3 }, 2, 89, 26, 2, 1412, 1010)!;
    expect(bounds.x).toBe((ORIGIN_X + 4 * CELL_WIDTH) * 2);
    expect(bounds.y).toBe((ORIGIN_Y + 2 * LINE_HEIGHT) * 2);
    expect(bounds.width).toBeCloseTo(3 * CELL_WIDTH * 2);
    expect(bounds.height).toBe(LINE_HEIGHT * 2);
  });

  it("does not extend the last colored run over trailing default-background cells", () => {
    const bounds = backgroundRunBounds({ cellStart: 0, cellSpan: 88 }, 1, 89, 26, 2, 1412, 1010)!;
    expect(bounds.x + bounds.width).toBe((ORIGIN_X + 88 * CELL_WIDTH) * 2);
  });

  it("uses each edge cell's color without overlapping adjacent runs or rows", () => {
    const left = backgroundRunBounds({ cellStart: 0, cellSpan: 88 }, 25, 89, 26, 2, 1412, 1010)!;
    const right = backgroundRunBounds({ cellStart: 88, cellSpan: 1 }, 25, 89, 26, 2, 1412, 1010)!;
    expect(left.x).toBe(0);
    expect(left.x + left.width).toBe(right.x);
    expect(right.x + right.width).toBe(1412);
    expect(right.y + right.height).toBe(1010);
    expect(left.y).toBe(right.y);
    expect(left.height).toBe(right.height);
  });

  it("extends the committed frame while an enlarged canvas awaits a resize frame", () => {
    const bounds = backgroundRunBounds({ cellStart: 0, cellSpan: 80 }, 23, 80, 24, 2, 1500, 1100)!;
    expect(bounds.width).toBe(1500);
    expect(bounds.y + bounds.height).toBe(1100);
  });

  it("clips a stale larger grid to a shrunken canvas", () => {
    expect(backgroundRunBounds({ cellStart: 88, cellSpan: 1 }, 1, 89, 26, 2, 1000, 800)).toBeNull();
    expect(backgroundRunBounds({ cellStart: 0, cellSpan: 89 }, 25, 89, 26, 2, 1000, 800)).toBeNull();
    const bounds = backgroundRunBounds({ cellStart: 0, cellSpan: 88 }, 20, 89, 26, 2, 1000, 800)!;
    expect(bounds.width).toBe(1000);
    expect(bounds.y + bounds.height).toBe(800);
  });
});
