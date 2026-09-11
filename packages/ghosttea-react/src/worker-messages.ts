import type { TerminalLink } from "@vibecook/ghosttea-frame";
import type { CellSelection, TerminalEffects, TerminalTheme } from "./renderers/types.js";
import type { TerminalScrollbarState } from "@vibecook/ghosttea-protocol";
import type { TerminalRenderCounterSnapshot, TerminalRenderPerformanceSnapshot } from "./performance.js";
import type { RoutedFramesAttachRequest, RoutedFramesTransportEvent } from "./routed-frames.js";

export type RendererToWorkerMessage =
  | { type: "renderer-config"; forceCanvasFallback: boolean }
  | { type: "partial-rendering"; enabled: boolean }
  | { type: "mount"; surfaceId: string; sessionHandle: string; canvas: OffscreenCanvas }
  | { type: "unmount"; surfaceId: string }
  | { type: "drop-session"; sessionHandle: string }
  | { type: "resize"; surfaceId: string; width: number; height: number; dpr: number }
  | { type: "frame"; packet: ArrayBuffer }
  | { type: "frame-gap"; sessionHandles: string[] }
  | { type: "expect-full"; sessionHandle: string }
  | { type: "theme"; sessionHandle: string; surfaceId?: string; theme: TerminalTheme }
  | { type: "effects"; sessionHandle: string; surfaceId?: string; effects: TerminalEffects }
  | { type: "selection"; sessionHandle: string; surfaceId?: string; selection: CellSelection | null }
  | { type: "visibility"; sessionHandle: string; surfaceId?: string; visible: boolean }
  | { type: "focus"; surfaceId: string; sessionHandle: string; focused: boolean }
  /** Hold the cursor steady while a replica is frozen, leaving focus untouched. */
  | { type: "cursor-frozen"; surfaceId: string; frozen: boolean }
  | { type: "cursor-activity"; sessionHandle: string }
  | { type: "force-full-redraw"; sessionHandle: string }
  | { type: "force-row-redraw"; sessionHandle: string; row: number }
  | { type: "performance-start"; requestId: number }
  | { type: "performance-finish"; requestId: number; quietMs: number; timeoutMs: number }
  | { type: "performance-counters"; requestId: number }
  | { type: "routed-frames-attach"; request: RoutedFramesAttachRequest }
  | { type: "routed-frames-detach"; activationId: string };

export type WorkerToRendererMessage =
  | { type: "link-targets"; sessionHandle: string; links: TerminalLink[] }
  | { type: "renderer-status"; backend: string; textEngine?: string; recovered?: boolean }
  | { type: "clipboard-write"; text: string }
  | { type: "scrollbar-state"; sessionHandle: string; scrollbar: TerminalScrollbarState }
  | { type: "frame-resync-needed"; sessionHandle: string }
  | { type: "frame-resync-complete"; sessionHandle: string }
  /**
   * A frame has been applied and its invalidation scheduled. Unlike
   * `frame-resync-complete` this carries the sequence it committed, so a
   * consumer can tell a recovered frame from the one it replaced.
   * `fullSnapshot` marks a complete screen — what a resume publishes, and the
   * only kind of frame that can prove a replica is current again.
   */
  | {
      type: "frame-committed";
      sessionHandle: string;
      sessionEpoch: bigint;
      frameSequence: bigint;
      fullSnapshot: boolean;
    }
  | { type: "catalog-pressure"; sessionHandle: string; reason: "working-set-exceeds-budget" }
  | { type: "frame-credit"; bytes: number }
  | { type: "performance-started"; requestId: number }
  | { type: "performance-result"; requestId: number; snapshot: TerminalRenderPerformanceSnapshot }
  | { type: "performance-counters"; requestId: number; snapshot: TerminalRenderCounterSnapshot }
  | { type: "routed-frames-event"; event: RoutedFramesTransportEvent }
  | { type: "renderer-reload-required"; reason: string };
