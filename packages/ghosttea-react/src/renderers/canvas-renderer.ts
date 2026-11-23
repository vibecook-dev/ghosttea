import { CursorStyle } from "@vibecook/ghosttea-frame";
import { emptyRenderMetrics, type TerminalRenderMetrics } from "../performance.js";
import {
  CELL_WIDTH,
  LINE_HEIGHT,
  ORIGIN_X,
  ORIGIN_Y,
  effectiveCursorStyle,
  renderedSizeChanged,
  type CellPoint,
  type PixelSize,
  type RenderView,
  type Rgba,
  type TerminalRenderer,
} from "./types.js";

interface CanvasSurface extends PixelSize {
  canvas: OffscreenCanvas;
  context: OffscreenCanvasRenderingContext2D;
}

function css(color: Rgba): string {
  const [red, green, blue, alpha] = color;
  return `rgba(${Math.round(red * 255)}, ${Math.round(green * 255)}, ${Math.round(blue * 255)}, ${alpha})`;
}

function ordered(selection: RenderView["selection"]): [CellPoint, CellPoint] | null {
  if (!selection) return null;
  const { anchor, focus } = selection;
  return anchor.row < focus.row || (anchor.row === focus.row && anchor.column <= focus.column)
    ? [anchor, focus]
    : [focus, anchor];
}

export class CanvasTerminalRenderer implements TerminalRenderer {
  readonly kind = "canvas2d" as const;
  readonly #surfaces = new Map<string, CanvasSurface>();
  #performanceMeasurementEnabled = false;

  setPerformanceMeasurementEnabled(enabled: boolean): void {
    this.#performanceMeasurementEnabled = enabled;
  }

  mount(id: string, canvas: OffscreenCanvas): void {
    const context = canvas.getContext("2d", { alpha: true });
    if (!context) throw new Error("Canvas2D worker backend unavailable");
    this.#surfaces.set(id, { canvas, context, width: 1, height: 1, dpr: 1 });
  }

  rebind(from: string, to: string): void {
    const surface = this.#surfaces.get(from);
    if (!surface) return;
    this.#surfaces.delete(from);
    this.#surfaces.set(to, surface);
  }

  unmount(id: string): void {
    this.#surfaces.delete(id);
  }

  resize(id: string, size: PixelSize): void {
    const surface = this.#surfaces.get(id);
    if (!surface) return;
    const changed = renderedSizeChanged(surface, size);
    Object.assign(surface, size);
    if (!changed) return;
    surface.canvas.width = Math.max(1, Math.round(size.width * size.dpr));
    surface.canvas.height = Math.max(1, Math.round(size.height * size.dpr));
  }

  render(id: string, view: RenderView): TerminalRenderMetrics | undefined {
    const surface = this.#surfaces.get(id);
    if (!surface) return;
    const { context, width, height, dpr } = surface;
    context.clearRect(0, 0, surface.canvas.width, surface.canvas.height);
    context.save();
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.fillStyle = css(view.theme.background);
    context.fillRect(0, 0, width, height);
    const selection = ordered(view.selection);
    if (selection) {
      context.fillStyle = css(view.theme.selection);
      const [start, end] = selection;
      for (let row = start.row; row <= end.row; row += 1) {
        const first = row === start.row ? start.column : 0;
        const last = row === end.row ? end.column : Math.max(0, view.rows[row]?.length ?? 0);
        context.fillRect(
          ORIGIN_X + first * CELL_WIDTH,
          ORIGIN_Y + row * LINE_HEIGHT,
          Math.max(1, last - first + 1) * CELL_WIDTH,
          LINE_HEIGHT,
        );
      }
    }
    context.font = "13px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace";
    context.textBaseline = "top";
    context.fillStyle = css(view.theme.foreground);
    for (let row = 0; row < view.rows.length; row += 1) {
      context.fillText(view.rows[row] ?? "", ORIGIN_X, ORIGIN_Y + row * LINE_HEIGHT);
    }
    if (selection) {
      const [start, end] = selection;
      context.fillStyle = css(view.theme.selectionForeground);
      for (let row = start.row; row <= end.row; row += 1) {
        const first = row === start.row ? start.column : 0;
        const last = row === end.row ? end.column : Math.max(0, view.rows[row]?.length ?? 0);
        context.save();
        context.beginPath();
        context.rect(
          ORIGIN_X + first * CELL_WIDTH,
          ORIGIN_Y + row * LINE_HEIGHT,
          Math.max(1, last - first + 1) * CELL_WIDTH,
          LINE_HEIGHT,
        );
        context.clip();
        context.fillText(view.rows[row] ?? "", ORIGIN_X, ORIGIN_Y + row * LINE_HEIGHT);
        context.restore();
      }
    }
    const cursorStyle = effectiveCursorStyle(view);
    if (cursorStyle !== null) {
      const x = ORIGIN_X + view.cursor.x * CELL_WIDTH;
      const y = ORIGIN_Y + view.cursor.y * LINE_HEIGHT;
      const color =
        cursorStyle === CursorStyle.HollowBlock
          ? ([view.theme.cursor[0], view.theme.cursor[1], view.theme.cursor[2], 1] as const)
          : view.theme.cursor;
      context.fillStyle = css(color);
      if (cursorStyle === CursorStyle.Bar) {
        context.fillRect(x, y, 2, LINE_HEIGHT);
      } else if (cursorStyle === CursorStyle.Underline) {
        context.fillRect(x, y + LINE_HEIGHT - 2, CELL_WIDTH, 2);
      } else if (cursorStyle === CursorStyle.HollowBlock) {
        context.strokeStyle = css(color);
        context.lineWidth = 1;
        context.strokeRect(x + 0.5, y + 0.5, CELL_WIDTH - 1, LINE_HEIGHT - 1);
      } else {
        context.fillRect(x, y, CELL_WIDTH, LINE_HEIGHT);
        context.save();
        context.beginPath();
        context.rect(x, y, CELL_WIDTH, LINE_HEIGHT);
        context.clip();
        context.fillStyle = css(view.theme.cursorText ?? view.theme.background);
        context.fillText(view.rows[view.cursor.y] ?? "", ORIGIN_X, ORIGIN_Y + view.cursor.y * LINE_HEIGHT);
        context.restore();
      }
    }
    context.restore();
    if (!this.#performanceMeasurementEnabled) return undefined;
    const metrics = emptyRenderMetrics();
    metrics.fullRenders = 1;
    metrics.damagedRows = Math.max(view.rows.length, view.nativeRows.length, view.nativeStyleRows.length);
    metrics.canvasPixels = surface.canvas.width * surface.canvas.height;
    metrics.renderPasses = 1;
    metrics.drawCalls = 1;
    return metrics;
  }
}
