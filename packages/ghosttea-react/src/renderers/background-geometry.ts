import type { StyleRun } from "@vibecook/ghosttea-frame";
import { CELL_WIDTH, LINE_HEIGHT, ORIGIN_X, ORIGIN_Y } from "./types.js";

interface BackgroundBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Carry edge-cell backgrounds through the canvas padding and fractional cells.
 * Use the committed frame's grid: text can omit trailing blank cells, and the
 * canvas can resize before the terminal's replacement frame arrives. Expanding
 * the original rectangle avoids double blending translucent backgrounds.
 */
export function backgroundRunBounds(
  run: Pick<StyleRun, "cellStart" | "cellSpan">,
  row: number,
  cols: number,
  rows: number,
  scale: number,
  viewportWidth: number,
  viewportHeight: number,
): BackgroundBounds | null {
  if (cols <= 0 || row < 0 || row >= rows || run.cellSpan <= 0 || run.cellStart >= cols) return null;
  const end = run.cellStart + run.cellSpan;
  const x = run.cellStart === 0 ? 0 : (ORIGIN_X + run.cellStart * CELL_WIDTH) * scale;
  const y = row === 0 ? 0 : (ORIGIN_Y + row * LINE_HEIGHT) * scale;
  const right = end >= cols ? viewportWidth : Math.min(viewportWidth, (ORIGIN_X + end * CELL_WIDTH) * scale);
  const bottom =
    row === rows - 1 ? viewportHeight : Math.min(viewportHeight, (ORIGIN_Y + (row + 1) * LINE_HEIGHT) * scale);
  if (right <= x || bottom <= y) return null;
  return { x, y, width: right - x, height: bottom - y };
}
