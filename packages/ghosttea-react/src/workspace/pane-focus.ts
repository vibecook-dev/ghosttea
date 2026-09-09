type AnimationFrames = Pick<Window, "requestAnimationFrame" | "cancelAnimationFrame">;

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
