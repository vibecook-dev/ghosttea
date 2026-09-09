import { describe, expect, it } from "vitest";
import { createPaneFocusScheduler } from "./pane-focus";

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
