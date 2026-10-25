import { describe, expect, it } from "vitest";
import type { SessionSummary } from "@vibecook/ghosttea-protocol";
import { createPaneFocusScheduler, directionalPaneTarget, paneBoxes, relativePaneTarget } from "./pane-focus";
import { pane, type PaneNode } from "./pane-layout";

const leaf = (id: string) => pane(id, { id } as SessionSummary);
let splits = 0;
const split = (axis: "horizontal" | "vertical", first: PaneNode, second: PaneNode, ratio = 0.5): PaneNode => ({
  kind: "split",
  id: `split-${++splits}`,
  axis,
  ratio,
  first,
  second,
});

describe("where a goto_split moves focus, and whether it moves at all", () => {
  it("wraps previous and next, and goes nowhere from a single pane or an unknown one", () => {
    const layout = split("horizontal", leaf("a"), split("vertical", leaf("b"), leaf("c")));
    expect(relativePaneTarget(layout, "a", 1)).toBe("b");
    expect(relativePaneTarget(layout, "a", -1)).toBe("c");
    expect(relativePaneTarget(layout, "c", 1)).toBe("a");
    expect(relativePaneTarget(leaf("a"), "a", 1)).toBeNull();
    expect(relativePaneTarget(layout, "gone", 1)).toBeNull();
    expect(relativePaneTarget(undefined, undefined, 1)).toBeNull();
  });

  it("places each pane by the layout's ratios in a unit square", () => {
    const layout = split("horizontal", leaf("left"), split("vertical", leaf("top"), leaf("bottom"), 0.25), 0.4);
    expect(paneBoxes(layout)).toEqual([
      { id: "left", left: 0, top: 0, width: 0.4, height: 1 },
      { id: "top", left: 0.4, top: 0, width: 0.6, height: 0.25 },
      { id: "bottom", left: 0.4, top: 0.25, width: 0.6, height: 0.75 },
    ]);
    expect(paneBoxes(leaf("a"))).toEqual([{ id: "a", left: 0, top: 0, width: 1, height: 1 }]);
    expect(paneBoxes(undefined)).toEqual([]);
  });

  it("goes to the nearest pane that way, off-axis distance counting double", () => {
    const boxes = paneBoxes(
      split("horizontal", leaf("left"), split("vertical", leaf("top-right"), leaf("bottom-right"))),
    );
    expect(directionalPaneTarget(boxes, "left", "right")).toBe("top-right");
    expect(directionalPaneTarget(boxes, "bottom-right", "left")).toBe("left");
    expect(directionalPaneTarget(boxes, "top-right", "down")).toBe("bottom-right");
    expect(directionalPaneTarget(boxes, "bottom-right", "up")).toBe("top-right");
  });

  it("wraps around the layout when no pane lies that way, as Ghostty's nearestWrapped does", () => {
    const boxes = paneBoxes(
      split("horizontal", leaf("left"), split("vertical", leaf("top-right"), leaf("bottom-right"))),
    );
    // Ghostty lands on the same panes: the source moves one whole layout the other way.
    expect(directionalPaneTarget(boxes, "left", "left")).toBe("top-right");
    expect(directionalPaneTarget(boxes, "top-right", "up")).toBe("bottom-right");
    expect(directionalPaneTarget(boxes, "bottom-right", "right")).toBe("left");
    const pair = paneBoxes(split("horizontal", leaf("a"), leaf("b")));
    for (const direction of ["left", "right", "up", "down"] as const) {
      expect(directionalPaneTarget(pair, "a", direction), direction).toBe("b");
      expect(directionalPaneTarget(pair, "b", direction), direction).toBe("a");
    }
  });

  it("goes nowhere from a single pane or an unknown one", () => {
    expect(directionalPaneTarget(paneBoxes(leaf("a")), "a", "right")).toBeNull();
    expect(directionalPaneTarget(paneBoxes(split("horizontal", leaf("a"), leaf("b"))), "gone", "right")).toBeNull();
    expect(directionalPaneTarget([], undefined, "left")).toBeNull();
  });
});

function animationFrames() {
  let nextId = 0;
  const callbacks = new Map<number, FrameRequestCallback>();
  return {
    requestAnimationFrame(callback: FrameRequestCallback) {
      callbacks.set(++nextId, callback);
      return nextId;
    },
    cancelAnimationFrame(id: number) {
      callbacks.delete(id);
    },
    flush() {
      // A request made during this frame belongs to the next frame. Cancellation
      // also applies to callbacks in the current frame that have not run yet.
      for (const id of [...callbacks.keys()]) {
        const callback = callbacks.get(id);
        callbacks.delete(id);
        callback?.(0);
      }
    },
    get pending() {
      return callbacks.size;
    },
  };
}

describe("workspace pane focus scheduling", () => {
  it("settles on a clicked pane when another pane still has a pending focus request", () => {
    const frames = animationFrames();
    const transitions: string[] = [];
    let focused = "left";
    const focus = (paneId: string): void => {
      if (focused === paneId) return;
      focused = paneId;
      transitions.push(paneId);
      scheduler.request(paneId, focus); // TerminalSurface.onFocus -> Workspace.onActivate
    };
    const scheduler = createPaneFocusScheduler(frames);

    scheduler.request("left", focus);
    scheduler.request("right", focus); // Pointer activation before the left request runs.
    focus("right"); // The terminal pointer handler also focuses immediately.
    for (let frame = 0; frame < 60; frame++) frames.flush();

    expect(transitions).toEqual(["right"]);
    expect(focused).toBe("right");
    expect(frames.pending).toBe(0);
  });

  it("honors the last activation when several panes are requested in one frame", () => {
    const frames = animationFrames();
    const focused: string[] = [];
    const focus = (id: string): void => {
      focused.push(id);
    };
    const scheduler = createPaneFocusScheduler(frames);
    scheduler.request("left", focus);
    scheduler.request("right", focus);
    scheduler.request("third", focus);
    expect(frames.pending).toBe(1);
    frames.flush();
    expect(focused).toEqual(["third"]);
    expect(frames.pending).toBe(0);
  });

  it("keeps a reentrant focus request cancellable by a later activation", () => {
    const frames = animationFrames();
    const focused: string[] = [];
    const focus = (id: string): void => {
      focused.push(id);
      if (id === "left") scheduler.request("left", focus);
    };
    const scheduler = createPaneFocusScheduler(frames);
    scheduler.request("left", focus);
    frames.flush();
    scheduler.request("right", focus);
    frames.flush();
    expect(focused).toEqual(["left", "right"]);
    expect(frames.pending).toBe(0);
  });

  it("cancels pending work on cleanup and can be reused after effect setup", () => {
    const frames = animationFrames();
    const focused: string[] = [];
    const focus = (id: string): void => {
      focused.push(id);
    };
    const scheduler = createPaneFocusScheduler(frames);
    scheduler.request("left", focus);
    scheduler.cancel();
    scheduler.cancel();
    frames.flush();
    expect(focused).toEqual([]);
    scheduler.request("right", focus);
    frames.flush();
    expect(focused).toEqual(["right"]);
  });
});
