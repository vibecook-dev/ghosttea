import { leaves, type PaneNode } from "./pane-layout.js";

type AnimationFrames = Pick<Window, "requestAnimationFrame" | "cancelAnimationFrame">;

/**
 * The pane `goto_split:previous|next` moves focus to, wrapping, or null when
 * focus cannot move: a single pane, or an active pane the layout lacks. A goto
 * that leaves focus where it is is not performed (Ghostty's GTK split tree).
 */
export function relativePaneTarget(
  layout: PaneNode | undefined,
  activePaneId: string | undefined,
  offset: number,
): string | null {
  const panes = leaves(layout);
  const current = panes.findIndex((candidate) => candidate.id === activePaneId);
  if (panes.length < 2 || current < 0) return null;
  const target = panes[(current + offset + panes.length) % panes.length]!.id;
  return target === activePaneId ? null : target;
}

/** A pane's id and box. */
export interface PaneBox {
  readonly id: string;
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Each pane's box in a unit square, split by the layout's ratios, as the
 * workspace lays them out and as Ghostty's split tree places them for spatial
 * navigation. A zoomed layout keeps its boxes: they are where its panes are
 * once the zoom ends.
 */
export function paneBoxes(layout: PaneNode | undefined): PaneBox[] {
  const boxes: PaneBox[] = [];
  const place = (node: PaneNode, left: number, top: number, width: number, height: number): void => {
    if (node.kind === "pane") {
      boxes.push({ id: node.id, left, top, width, height });
      return;
    }
    if (node.axis === "horizontal") {
      const first = width * node.ratio;
      place(node.first, left, top, first, height);
      place(node.second, left + first, top, width - first, height);
    } else {
      const first = height * node.ratio;
      place(node.first, left, top, width, first);
      place(node.second, left, top + first, width, height - first);
    }
  };
  if (layout) place(layout, 0, 0, 1, 1);
  return boxes;
}

/**
 * The pane `goto_split:<direction>` moves focus to: the nearest whose centre
 * lies that way, off-axis distance counting double. When none does it wraps,
 * as Ghostty's `nearestWrapped` does (datastruct/split_tree.zig:438-474): the
 * active pane's centre moves one whole layout the other way and the nearest
 * is found again, so with two or more panes there is always a target. Null
 * for a single pane, or an active pane the boxes lack.
 */
export function directionalPaneTarget(
  panes: readonly PaneBox[],
  activePaneId: string | undefined,
  direction: "left" | "right" | "up" | "down",
): string | null {
  const source = panes.find((candidate) => candidate.id === activePaneId);
  if (!source) return null;
  const nearest = (sourceX: number, sourceY: number): string | null => {
    let best: { id: string; score: number } | undefined;
    for (const candidate of panes) {
      if (candidate.id === activePaneId) continue;
      const dx = candidate.left + candidate.width / 2 - sourceX;
      const dy = candidate.top + candidate.height / 2 - sourceY;
      const forward = direction === "left" ? -dx : direction === "right" ? dx : direction === "up" ? -dy : dy;
      if (forward <= 0) continue;
      const cross = direction === "left" || direction === "right" ? Math.abs(dy) : Math.abs(dx);
      const score = forward + cross * 2;
      if (!best || score < best.score) best = { id: candidate.id, score };
    }
    return best?.id ?? null;
  };
  const sourceX = source.left + source.width / 2;
  const sourceY = source.top + source.height / 2;
  const direct = nearest(sourceX, sourceY);
  if (direct !== null) return direct;

  const width = Math.max(...panes.map((box) => box.left + box.width)) - Math.min(...panes.map((box) => box.left));
  const height = Math.max(...panes.map((box) => box.top + box.height)) - Math.min(...panes.map((box) => box.top));
  if (direction === "left") return nearest(sourceX + width, sourceY);
  if (direction === "right") return nearest(sourceX - width, sourceY);
  if (direction === "up") return nearest(sourceX, sourceY + height);
  return nearest(sourceX, sourceY - height);
}

/** One deferred focus owner per workspace, including requests made by focus events themselves. */
export function createPaneFocusScheduler(frames: AnimationFrames) {
  let pending: { frame: number } | undefined;

  const cancel = (): void => {
    if (!pending) return;
    frames.cancelAnimationFrame(pending.frame);
    pending = undefined;
  };

  const request = (paneId: string, focusPane: (paneId: string) => void): void => {
    cancel();
    const next = { frame: 0 };
    pending = next;
    next.frame = frames.requestAnimationFrame(() => {
      if (pending !== next) return;
      // focus() synchronously emits onFocus, which may schedule the next request.
      pending = undefined;
      focusPane(paneId);
    });
  };

  return { request, cancel };
}
