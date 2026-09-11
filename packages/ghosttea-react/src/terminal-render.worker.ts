/// <reference lib="webworker" />
/// <reference types="@webgpu/types" />

import {
  decodeClipboardWrite,
  decodeLinkTargets,
  decodeCursorState,
  decodeFrame,
  decodeGlyphDefinitions,
  decodeRowReplacements,
  decodeScrollbarState,
  decodeStyleDefinitions,
  FrameFlag,
  type CursorState,
  type GlyphDefinition,
  type GlyphInstance,
  type StyleDefinition,
  type StyleRun,
  SectionKind,
} from "@vibecook/ghosttea-frame";
import type { RoutedTrfIdentity, TerminalScrollbarState } from "@vibecook/ghosttea-protocol";
import { CanvasTerminalRenderer } from "./renderers/canvas-renderer.js";
import {
  DEFAULT_EFFECTS,
  DEFAULT_THEME,
  type CellSelection,
  type PixelSize,
  type RenderView,
  type TerminalRenderer,
  type TerminalEffects,
  type TerminalTheme,
  renderedSizeChanged,
  terminalEffectsNeedAnimation,
} from "./renderers/types.js";
import { WebGpuTerminalRenderer } from "./renderers/webgpu-renderer.js";
import { classifyFrame } from "./frame-sequence.js";
import { cursorActivityChangesPixels } from "./cursor-invalidation.js";
import {
  emptyRenderMetrics,
  type TerminalRenderCounterSnapshot,
  type TerminalRenderPerformanceSnapshot,
} from "./performance.js";
import type { RendererToWorkerMessage, WorkerToRendererMessage } from "./worker-messages.js";
import { catalogAdmission, definitionCatalogFits, glyphCatalogFits } from "./catalog-budget.js";
import { RoutedFramesTransport, type RoutedAppliedFrame, type RoutedExpectedLayout } from "./routed-frames.js";

interface SessionSnapshot {
  rows: string[];
  nativeRows: GlyphInstance[][];
  nativeStyleRows: StyleRun[][];
  glyphDefinitions: Map<number, GlyphDefinition>;
  glyphPixelBytes: number;
  styleDefinitions: Map<number, StyleDefinition>;
  rowRevisions: bigint[];
  cursor: CursorState;
  layoutEpoch: bigint;
  sessionEpoch: bigint;
  sequence: bigint;
  awaitingResync: boolean;
  catalogFallback: boolean;
  scrollbar: TerminalScrollbarState | null;
  linkSignature: string;
}

interface SurfaceSnapshot {
  sessionHandle: string;
  focused: boolean;
  cursorBlinkVisible: boolean;
  selection: CellSelection | null;
  theme: TerminalTheme;
  effects: TerminalEffects;
  damage: { full: boolean; rows: Set<number>; geometryChanged: boolean };
}

interface MountedCanvas {
  canvas: OffscreenCanvas;
  size: PixelSize;
  sessionHandle: string;
}

interface SessionPresentationDefaults {
  theme: TerminalTheme;
  effects: TerminalEffects;
  selection: CellSelection | null;
  visible: boolean;
}

const hiddenCursor: CursorState = { x: 0, y: 0, visible: false, style: 1, blinking: false };
const CURSOR_BLINK_INTERVAL_MS = 600;
const MAX_SESSION_GLYPH_DEFINITIONS = 65_536;
const MAX_SESSION_GLYPH_PIXEL_BYTES = 64 * 1024 * 1024;
const MAX_SESSION_STYLE_DEFINITIONS = 65_536;
const MAX_SHARED_GLYPH_DEFINITIONS = 131_072;
const MAX_SHARED_GLYPH_PIXEL_BYTES = 128 * 1024 * 1024;
const MAX_RETAINED_STYLE_DEFINITIONS = 262_144;
const GLYPH_CATALOG_BUDGET = {
  maxDefinitions: MAX_SESSION_GLYPH_DEFINITIONS,
  maxSharedDefinitions: MAX_SHARED_GLYPH_DEFINITIONS,
  maxSessionPixelBytes: MAX_SESSION_GLYPH_PIXEL_BYTES,
  maxSharedPixelBytes: MAX_SHARED_GLYPH_PIXEL_BYTES,
} as const;
const NO_GLYPH_DEFINITIONS: readonly GlyphDefinition[] = [];
const NO_STYLE_DEFINITIONS: readonly StyleDefinition[] = [];
const MAX_PERFORMANCE_SAMPLES = 100_000;
const FRAME_CREDIT_BATCH_BYTES = 4 * 1024 * 1024;
const FRAME_CREDIT_MAX_DELAY_MS = 8;
const snapshots = new Map<string, SessionSnapshot>();
const sharedGlyphDefinitions = new Map<number, { definition: GlyphDefinition; references: number }>();
let sharedGlyphPixelBytes = 0;
let retainedStyleDefinitions = 0;
const surfaces = new Map<string, SurfaceSnapshot>();
const surfaceIdsBySession = new Map<string, Set<string>>();
const noSurfaceIds: ReadonlySet<string> = new Set();
const presentationDefaults = new Map<string, SessionPresentationDefaults>();
const mounts = new Map<string, MountedCanvas>();
const cursorBlinkTimers = new Map<string, ReturnType<typeof setTimeout>>();
const dirty = new Set<string>();
// Occluded surfaces continue ingesting frames so they resume from current state,
// but do not schedule GPU flushes or cursor timers while their native tab is hidden.
const occluded = new Set<string>();
// A frozen replica must not animate: a blinking cursor on a screen the host
// stopped updating reads as a live session. Focus is left untouched, since the
// runtime owns focus truth for control reclaim.
const frozenCursors = new Set<string>();
let renderer: TerminalRenderer | undefined;
let rendererPromise: Promise<TerminalRenderer> | undefined;
let flushScheduled = false;
let recoveryAttempts = 0;
let recovering = false;
let nativeTextAnnounced = false;
let forceCanvasFallback = false;
let partialRenderingEnabled = true;
let pendingFrameCreditBytes = 0;
let frameCreditTimer: ReturnType<typeof setTimeout> | undefined;
let shaderAnimationScheduled = false;

interface ActivePerformanceMeasurement {
  startedAt: number;
  lastActivityAt: number;
  lastFrameAt: Map<string, number>;
  dirtySince: Map<string, number>;
  frames: TerminalRenderPerformanceSnapshot["frames"];
  scheduling: TerminalRenderPerformanceSnapshot["scheduling"];
  renderer: TerminalRenderPerformanceSnapshot["renderer"];
  samples: TerminalRenderPerformanceSnapshot["samples"];
}

let performanceMeasurement: ActivePerformanceMeasurement | undefined;

type SessionCounters = TerminalRenderCounterSnapshot["sessions"][string];
const lifetimeStartedAt = performance.now();
const lifetimeFrames: SessionCounters = {
  received: 0,
  bytes: 0,
  full: 0,
  incremental: 0,
  stale: 0,
  decodes: 0,
  applies: 0,
};
const lifetimeSessions = new Map<string, SessionCounters>();
const lifetimeRenderer = { queueSubmits: 0, presents: 0 };
const lifetimeFlow = { creditBytesReturned: 0, creditBatchesReturned: 0 };

function sessionCounters(sessionHandle: string): SessionCounters {
  let counters = lifetimeSessions.get(sessionHandle);
  if (!counters) {
    counters = { received: 0, bytes: 0, full: 0, incremental: 0, stale: 0, decodes: 0, applies: 0 };
    lifetimeSessions.set(sessionHandle, counters);
  }
  return counters;
}

function counterSnapshot(): TerminalRenderCounterSnapshot {
  return {
    backend: renderer?.kind ?? "starting",
    durationMs: performance.now() - lifetimeStartedAt,
    frames: { ...lifetimeFrames },
    renderer: { ...lifetimeRenderer },
    flow: { ...lifetimeFlow },
    sessions: Object.fromEntries([...lifetimeSessions].map(([id, counters]) => [id, { ...counters }])),
  };
}

function appendPerformanceSample(samples: number[], value: number): void {
  if (samples.length < MAX_PERFORMANCE_SAMPLES) samples.push(value);
}

function flushFrameCredit(): void {
  if (frameCreditTimer !== undefined) clearTimeout(frameCreditTimer);
  frameCreditTimer = undefined;
  if (pendingFrameCreditBytes === 0) return;
  const bytes = pendingFrameCreditBytes;
  pendingFrameCreditBytes = 0;
  lifetimeFlow.creditBytesReturned += bytes;
  lifetimeFlow.creditBatchesReturned += 1;
  postToRenderer({ type: "frame-credit", bytes });
}

function returnFrameCredit(bytes: number): void {
  pendingFrameCreditBytes += bytes;
  if (pendingFrameCreditBytes >= FRAME_CREDIT_BATCH_BYTES) {
    flushFrameCredit();
  } else if (frameCreditTimer === undefined) {
    frameCreditTimer = setTimeout(flushFrameCredit, FRAME_CREDIT_MAX_DELAY_MS);
  }
}

function beginPerformanceMeasurement(): void {
  const now = performance.now();
  performanceMeasurement = {
    startedAt: now,
    lastActivityAt: now,
    lastFrameAt: new Map(),
    dirtySince: new Map(),
    frames: {
      received: 0,
      bytes: 0,
      full: 0,
      incremental: 0,
      stale: 0,
      resyncRequested: 0,
      rowsDecoded: 0,
      glyphDefinitions: 0,
    },
    scheduling: { flushes: 0, renderCalls: 0, maximumDirtyPanes: 0, panesPerFlush: [] },
    renderer: {
      queueSubmits: 0,
      fullRenders: 0,
      partialRenders: 0,
      damagedRows: 0,
      geometryCacheHits: 0,
      geometryCacheMisses: 0,
      canvasPixelFrames: 0,
      renderPasses: 0,
      drawCalls: 0,
      rectangleVertices: 0,
      monoGlyphVertices: 0,
      colorGlyphVertices: 0,
      fallbackGlyphVertices: 0,
      vertexUploadBytes: 0,
      atlasUploadBytes: 0,
      atlasUploadCalls: 0,
    },
    samples: { frameApplyMs: [], renderCpuMs: [], dirtyToRenderMs: [], frameArrivalToRenderMs: [] },
  };
  renderer?.setPerformanceMeasurementEnabled?.(true);
}

function notePerformanceActivity(now = performance.now()): void {
  if (performanceMeasurement) performanceMeasurement.lastActivityAt = now;
}

function recordRenderMetrics(metrics: ReturnType<typeof emptyRenderMetrics>): void {
  const target = performanceMeasurement?.renderer;
  if (!target) return;
  target.queueSubmits += metrics.queueSubmits;
  target.fullRenders += metrics.fullRenders;
  target.partialRenders += metrics.partialRenders;
  target.damagedRows += metrics.damagedRows;
  target.geometryCacheHits += metrics.geometryCacheHits;
  target.geometryCacheMisses += metrics.geometryCacheMisses;
  target.canvasPixelFrames += metrics.canvasPixels;
  target.renderPasses += metrics.renderPasses;
  target.drawCalls += metrics.drawCalls;
  target.rectangleVertices += metrics.rectangleVertices;
  target.monoGlyphVertices += metrics.monoGlyphVertices;
  target.colorGlyphVertices += metrics.colorGlyphVertices;
  target.fallbackGlyphVertices += metrics.fallbackGlyphVertices;
  target.vertexUploadBytes += metrics.vertexUploadBytes;
  target.atlasUploadBytes += metrics.atlasUploadBytes;
  target.atlasUploadCalls += metrics.atlasUploadCalls;
}

function recordLifetimeRenderMetrics(metrics: ReturnType<typeof emptyRenderMetrics>): void {
  lifetimeRenderer.queueSubmits += metrics.queueSubmits;
  lifetimeRenderer.presents += metrics.fullRenders + metrics.partialRenders;
}

async function finishPerformanceMeasurement(requestId: number, quietMs: number, timeoutMs: number): Promise<void> {
  const active = performanceMeasurement;
  if (!active) throw new Error("No terminal render performance measurement is active");
  const deadline = performance.now() + timeoutMs;
  let timedOutWaitingForIdle = false;
  let gpuQueueDrainMs: number | null = null;

  while (true) {
    const now = performance.now();
    const hasVisibleDirty = [...dirty].some((id) => !occluded.has(id));
    if (!flushScheduled && !hasVisibleDirty && now - active.lastActivityAt >= quietMs) {
      const beforeDrainActivity = active.lastActivityAt;
      if (renderer?.settle) {
        const drainStarted = performance.now();
        await renderer.settle();
        gpuQueueDrainMs = performance.now() - drainStarted;
      }
      if (active.lastActivityAt === beforeDrainActivity && !flushScheduled) break;
    }
    if (now >= deadline) {
      timedOutWaitingForIdle = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(25, Math.max(1, quietMs / 4))));
  }

  if (timedOutWaitingForIdle && renderer?.settle) {
    const drainStarted = performance.now();
    await renderer.settle();
    gpuQueueDrainMs = performance.now() - drainStarted;
  }
  const snapshot: TerminalRenderPerformanceSnapshot = {
    backend: renderer?.kind ?? "starting",
    durationMs: performance.now() - active.startedAt,
    timedOutWaitingForIdle,
    gpuQueueDrainMs,
    frames: active.frames,
    scheduling: active.scheduling,
    renderer: active.renderer,
    samples: active.samples,
  };
  renderer?.setPerformanceMeasurementEnabled?.(false);
  if (performanceMeasurement === active) performanceMeasurement = undefined;
  postToRenderer({ type: "performance-result", requestId, snapshot });
}

function postToRenderer(message: WorkerToRendererMessage): void {
  self.postMessage(message);
}

function emptySessionSnapshot(): SessionSnapshot {
  return {
    rows: [],
    nativeRows: [],
    nativeStyleRows: [],
    glyphDefinitions: new Map(),
    glyphPixelBytes: 0,
    styleDefinitions: new Map(),
    rowRevisions: [],
    cursor: hiddenCursor,
    layoutEpoch: 0n,
    sessionEpoch: 0n,
    sequence: 0n,
    awaitingResync: false,
    catalogFallback: false,
    scrollbar: null,
    linkSignature: "",
  };
}

function snapshot(sessionHandle: string): SessionSnapshot {
  let value = snapshots.get(sessionHandle);
  if (!value) {
    value = emptySessionSnapshot();
    snapshots.set(sessionHandle, value);
  }
  return value;
}

function clearSessionCatalog(session: SessionSnapshot): void {
  for (const glyphId of session.glyphDefinitions.keys()) {
    const shared = sharedGlyphDefinitions.get(glyphId);
    if (!shared) continue;
    shared.references -= 1;
    if (shared.references <= 0) {
      sharedGlyphDefinitions.delete(glyphId);
      sharedGlyphPixelBytes -= shared.definition.pixels.byteLength;
    }
  }
  session.glyphDefinitions.clear();
  session.glyphPixelBytes = 0;
  retainedStyleDefinitions -= session.styleDefinitions.size;
  session.styleDefinitions.clear();
}

function installGlyphDefinitions(session: SessionSnapshot, definitions: readonly GlyphDefinition[]): void {
  for (const decoded of definitions) {
    if (session.glyphDefinitions.has(decoded.id)) continue;
    let shared = sharedGlyphDefinitions.get(decoded.id);
    const pixelBytes = shared?.definition.pixels.byteLength ?? decoded.pixels.byteLength;
    if (shared) {
      shared.references += 1;
    } else {
      shared = { definition: decoded, references: 1 };
      sharedGlyphDefinitions.set(decoded.id, shared);
      sharedGlyphPixelBytes += decoded.pixels.byteLength;
    }
    session.glyphDefinitions.set(decoded.id, shared.definition);
    session.glyphPixelBytes += pixelBytes;
  }
}

function installStyleDefinitions(session: SessionSnapshot, definitions: readonly StyleDefinition[]): void {
  for (const definition of definitions) {
    if (session.styleDefinitions.has(definition.id)) continue;
    session.styleDefinitions.set(definition.id, definition);
    retainedStyleDefinitions += 1;
  }
}

function dropSessionSnapshot(sessionHandle: string): void {
  const session = snapshots.get(sessionHandle);
  if (session) clearSessionCatalog(session);
  snapshots.delete(sessionHandle);
}

function defaults(sessionHandle: string): SessionPresentationDefaults {
  let value = presentationDefaults.get(sessionHandle);
  if (!value) {
    value = { theme: DEFAULT_THEME, effects: DEFAULT_EFFECTS, selection: null, visible: true };
    presentationDefaults.set(sessionHandle, value);
  }
  return value;
}

function surface(surfaceId: string, sessionHandle: string): SurfaceSnapshot {
  const existing = surfaces.get(surfaceId);
  if (existing) {
    if (existing.sessionHandle !== sessionHandle) throw new Error(`Surface ${surfaceId} changed sessions`);
    return existing;
  }
  const initial = defaults(sessionHandle);
  const value: SurfaceSnapshot = {
    sessionHandle,
    focused: false,
    cursorBlinkVisible: true,
    selection: initial.selection,
    theme: initial.theme,
    effects: initial.effects,
    damage: { full: true, rows: new Set(), geometryChanged: true },
  };
  surfaces.set(surfaceId, value);
  let sessionSurfaceIds = surfaceIdsBySession.get(sessionHandle);
  if (!sessionSurfaceIds) {
    sessionSurfaceIds = new Set();
    surfaceIdsBySession.set(sessionHandle, sessionSurfaceIds);
  }
  sessionSurfaceIds.add(surfaceId);
  if (!initial.visible) occluded.add(surfaceId);
  return value;
}

function surfaceIdsForSession(sessionHandle: string): ReadonlySet<string> {
  return surfaceIdsBySession.get(sessionHandle) ?? noSurfaceIds;
}

function deleteSurface(surfaceId: string): SurfaceSnapshot | undefined {
  const value = surfaces.get(surfaceId);
  if (!value) return undefined;
  surfaces.delete(surfaceId);
  const sessionSurfaceIds = surfaceIdsBySession.get(value.sessionHandle);
  sessionSurfaceIds?.delete(surfaceId);
  if (sessionSurfaceIds?.size === 0) surfaceIdsBySession.delete(value.sessionHandle);
  return value;
}

function renderView(session: SessionSnapshot, presentation: SurfaceSnapshot): RenderView {
  return {
    rows: session.rows,
    nativeRows: session.nativeRows,
    nativeStyleRows: session.nativeStyleRows,
    rowRevisions: session.rowRevisions,
    glyphDefinitions: session.glyphDefinitions,
    styleDefinitions: session.styleDefinitions,
    sessionEpoch: session.sessionEpoch,
    layoutEpoch: session.layoutEpoch,
    cursor: session.cursor,
    focused: presentation.focused,
    cursorBlinkVisible: presentation.cursorBlinkVisible,
    selection: presentation.selection,
    theme: presentation.theme,
    effects: presentation.effects,
    damage: presentation.damage,
  };
}

function scheduleCursorBlink(surfaceId: string, reset: boolean): void {
  const existing = cursorBlinkTimers.get(surfaceId);
  if (existing !== undefined) clearTimeout(existing);
  cursorBlinkTimers.delete(surfaceId);
  const value = surfaces.get(surfaceId);
  if (!value) return;
  const session = snapshot(value.sessionHandle);
  if (reset) value.cursorBlinkVisible = true;
  if (
    occluded.has(surfaceId) ||
    frozenCursors.has(surfaceId) ||
    !value.focused ||
    !session.cursor.visible ||
    !session.cursor.blinking
  )
    return;
  cursorBlinkTimers.set(
    surfaceId,
    setTimeout(() => {
      cursorBlinkTimers.delete(surfaceId);
      const current = surfaces.get(surfaceId);
      const currentSession = current ? snapshots.get(current.sessionHandle) : undefined;
      if (
        occluded.has(surfaceId) ||
        !current ||
        !currentSession ||
        !current.focused ||
        !currentSession.cursor.visible ||
        !currentSession.cursor.blinking
      )
        return;
      current.cursorBlinkVisible = !current.cursorBlinkVisible;
      invalidateRows(surfaceId, [currentSession.cursor.y]);
      scheduleCursorBlink(surfaceId, false);
    }, CURSOR_BLINK_INTERVAL_MS),
  );
}

async function createRenderer(): Promise<TerminalRenderer> {
  if (forceCanvasFallback) {
    const canvas = new CanvasTerminalRenderer();
    postToRenderer({ type: "renderer-status", backend: canvas.kind, recovered: true });
    return canvas;
  }
  try {
    const gpu = await WebGpuTerminalRenderer.create((info) => void recoverDevice(info));
    recoveryAttempts = 0;
    postToRenderer({ type: "renderer-status", backend: gpu.kind });
    return gpu;
  } catch (error) {
    console.warn("[terminal-renderer] WebGPU unavailable; using diagnostic Canvas2D", error);
    const canvas = new CanvasTerminalRenderer();
    postToRenderer({ type: "renderer-status", backend: canvas.kind });
    return canvas;
  }
}

async function ensureRenderer(): Promise<TerminalRenderer> {
  rendererPromise ??= createRenderer();
  renderer = await rendererPromise;
  return renderer;
}

async function recoverDevice(info: GPUDeviceLostInfo): Promise<void> {
  if (recovering || renderer?.kind === "canvas2d") return;
  recovering = true;
  recoveryAttempts += 1;
  console.warn(`[terminal-renderer] WebGPU device lost (${info.reason}): ${info.message}`);
  renderer = undefined;
  rendererPromise = WebGpuTerminalRenderer.create((nextInfo) => void recoverDevice(nextInfo));
  try {
    const next = await rendererPromise;
    renderer = next;
    recoveryAttempts = 0;
    recovering = false;
    for (const [id, mount] of mounts) {
      next.mount(id, mount.canvas);
      next.resize(id, mount.size);
      invalidateFull(id);
    }
    scheduleShaderAnimation();
    postToRenderer({ type: "renderer-status", backend: next.kind, recovered: true });
  } catch (error) {
    console.error("[terminal-renderer] WebGPU recovery failed", error);
    rendererPromise = undefined;
    recovering = false;
    if (recoveryAttempts >= 3) {
      postToRenderer({ type: "renderer-reload-required", reason: "webgpu-device-loss" });
      return;
    }
    const delay = Math.min(5_000, 250 * 2 ** Math.min(recoveryAttempts, 4));
    setTimeout(() => void recoverDevice(info), delay);
  }
}

function scheduleFlush(): void {
  if (flushScheduled) return;
  flushScheduled = true;
  const run = (): void => {
    flushScheduled = false;
    void flush();
  };
  if (typeof self.requestAnimationFrame === "function") self.requestAnimationFrame(run);
  else setTimeout(run, 8);
}

function shaderAnimationActive(surfaceId: string, presentation: SurfaceSnapshot): boolean {
  return (
    renderer?.kind === "webgpu" &&
    mounts.has(surfaceId) &&
    !occluded.has(surfaceId) &&
    presentation.focused &&
    terminalEffectsNeedAnimation(presentation.effects)
  );
}

function scheduleShaderAnimation(): void {
  if (
    shaderAnimationScheduled ||
    ![...surfaces].some(([surfaceId, presentation]) => shaderAnimationActive(surfaceId, presentation))
  )
    return;
  shaderAnimationScheduled = true;
  const run = (): void => {
    shaderAnimationScheduled = false;
    for (const [surfaceId, presentation] of surfaces) {
      if (shaderAnimationActive(surfaceId, presentation)) markDirty(surfaceId);
    }
    scheduleShaderAnimation();
  };
  if (typeof self.requestAnimationFrame === "function") self.requestAnimationFrame(run);
  else setTimeout(run, 16);
}

async function flush(): Promise<void> {
  const backend = await ensureRenderer();
  const ids = [...dirty].filter((id) => !occluded.has(id));
  if (performanceMeasurement && ids.length > 0) {
    performanceMeasurement.scheduling.flushes += 1;
    appendPerformanceSample(performanceMeasurement.scheduling.panesPerFlush, ids.length);
    performanceMeasurement.scheduling.maximumDirtyPanes = Math.max(
      performanceMeasurement.scheduling.maximumDirtyPanes,
      ids.length,
    );
  }
  for (const id of ids) dirty.delete(id);
  const entries = ids.flatMap((id) => {
    const presentation = surfaces.get(id);
    const session = presentation ? snapshots.get(presentation.sessionHandle) : undefined;
    return mounts.has(id) && presentation && session ? [{ id, view: renderView(session, presentation) }] : [];
  });
  if (entries.length > 0) {
    try {
      const active = performanceMeasurement;
      const beforeRender = active ? performance.now() : 0;
      const metrics = backend.renderBatch
        ? backend.renderBatch(entries)
        : entries.map(({ id, view }) => backend.render(id, view));
      for (const metric of metrics) recordLifetimeRenderMetrics(metric ?? emptyRenderMetrics());
      const renderedAt = active ? performance.now() : 0;
      for (const { id } of entries) {
        const damage = surfaces.get(id)?.damage;
        if (!damage) continue;
        damage.full = false;
        damage.rows.clear();
        damage.geometryChanged = false;
      }
      if (active && performanceMeasurement === active) {
        active.scheduling.renderCalls += entries.length;
        appendPerformanceSample(active.samples.renderCpuMs, renderedAt - beforeRender);
        for (let index = 0; index < entries.length; index += 1) {
          const { id } = entries[index]!;
          const dirtySince = active.dirtySince.get(id);
          const sessionHandle = surfaces.get(id)?.sessionHandle;
          const lastFrameAt = sessionHandle ? active.lastFrameAt.get(sessionHandle) : undefined;
          if (dirtySince !== undefined)
            appendPerformanceSample(active.samples.dirtyToRenderMs, renderedAt - dirtySince);
          if (lastFrameAt !== undefined)
            appendPerformanceSample(active.samples.frameArrivalToRenderMs, renderedAt - lastFrameAt);
          active.dirtySince.delete(id);
          recordRenderMetrics(metrics[index] ?? emptyRenderMetrics());
        }
        notePerformanceActivity(renderedAt);
      }
    } catch (error) {
      console.error(`[terminal-renderer] failed to render ${entries.length} view(s)`, error);
    }
  }
  if ([...dirty].some((id) => !occluded.has(id))) scheduleFlush();
}

function markDirty(id: string): void {
  if (performanceMeasurement && !performanceMeasurement.dirtySince.has(id)) {
    performanceMeasurement.dirtySince.set(id, performance.now());
  }
  dirty.add(id);
  if (!occluded.has(id)) scheduleFlush();
}

function invalidateFull(id: string): void {
  const value = surfaces.get(id);
  if (!value) return;
  const damage = value.damage;
  damage.full = true;
  damage.rows.clear();
  damage.geometryChanged = true;
  markDirty(id);
}

function invalidateRows(id: string, rows: Iterable<number>, geometryChanged = false): void {
  if (!partialRenderingEnabled) {
    invalidateFull(id);
    return;
  }
  const value = surfaces.get(id);
  if (!value) return;
  const damage = value.damage;
  if (!damage.full) {
    damage.geometryChanged ||= geometryChanged;
    for (const row of rows) {
      if (Number.isSafeInteger(row) && row >= 0) damage.rows.add(row);
    }
  }
  markDirty(id);
}

function invalidateSessionFull(sessionHandle: string): void {
  for (const surfaceId of surfaceIdsForSession(sessionHandle)) invalidateFull(surfaceId);
}

function invalidateSessionRows(sessionHandle: string, rows: Iterable<number>, geometryChanged = false): void {
  const damagedRows = [...rows];
  for (const surfaceId of surfaceIdsForSession(sessionHandle)) invalidateRows(surfaceId, damagedRows, geometryChanged);
}

async function mount(surfaceId: string, sessionHandle: string, canvas: OffscreenCanvas): Promise<void> {
  if (mounts.has(surfaceId)) renderer?.unmount(surfaceId);
  snapshot(sessionHandle);
  surface(surfaceId, sessionHandle);
  const entry: MountedCanvas = { canvas, size: { width: 1, height: 1, dpr: 1 }, sessionHandle };
  mounts.set(surfaceId, entry);
  const backend = await ensureRenderer();
  if (mounts.get(surfaceId) !== entry) return;
  backend.mount(surfaceId, canvas);
  backend.resize(surfaceId, entry.size);
  invalidateFull(surfaceId);
  scheduleShaderAnimation();
}

function applyFrame(
  packet: ArrayBuffer,
  expectedIdentity?: RoutedTrfIdentity,
  expectedLayout?: RoutedExpectedLayout,
): RoutedAppliedFrame | undefined {
  const active = performanceMeasurement;
  const applyStarted = active ? performance.now() : 0;
  lifetimeFrames.received += 1;
  lifetimeFrames.bytes += packet.byteLength;
  if (active) {
    active.frames.received += 1;
    active.frames.bytes += packet.byteLength;
    active.lastActivityAt = applyStarted;
  }
  const frame = decodeFrame(packet);
  const id = frame.sessionHandle.toString();
  if (
    expectedIdentity &&
    (id !== expectedIdentity.sessionHandle || frame.viewHandle.toString() !== expectedIdentity.viewHandle)
  ) {
    throw new Error("TRF1 identity does not match the routed activation binding");
  }
  if (expectedLayout && (frame.cols !== expectedLayout.cols || frame.rows !== expectedLayout.rows)) {
    throw new Error("transfer layout does not match TRF1");
  }
  if (expectedLayout && (frame.flags & FrameFlag.FullSnapshot) === 0) {
    throw new Error("routed transfer is not a full TRF1 snapshot");
  }
  const counters = sessionCounters(id);
  lifetimeFrames.decodes += 1;
  counters.received += 1;
  counters.bytes += packet.byteLength;
  counters.decodes += 1;
  if ((frame.flags & FrameFlag.FullSnapshot) !== 0) {
    lifetimeFrames.full += 1;
    counters.full += 1;
  } else {
    lifetimeFrames.incremental += 1;
    counters.incremental += 1;
  }
  if (active) {
    active.lastFrameAt.set(id, applyStarted);
    if ((frame.flags & FrameFlag.FullSnapshot) !== 0) active.frames.full += 1;
    else active.frames.incremental += 1;
  }
  const replacingScene = expectedLayout !== undefined;
  const installedScene = replacingScene ? snapshots.get(id) : undefined;
  const previous = replacingScene ? emptySessionSnapshot() : snapshot(id);
  const fullFrame = (frame.flags & FrameFlag.FullSnapshot) !== 0;
  const catalogReset = (frame.flags & FrameFlag.CatalogReset) !== 0;
  if (catalogReset && !fullFrame) {
    if (expectedIdentity) throw new Error("catalog reset without a full routed frame");
    if (active) {
      active.frames.resyncRequested += 1;
      appendPerformanceSample(active.samples.frameApplyMs, performance.now() - applyStarted);
    }
    previous.awaitingResync = true;
    postToRenderer({ type: "frame-resync-needed", sessionHandle: id });
    return;
  }
  const classification = classifyFrame(previous, {
    sessionEpoch: frame.sessionEpoch,
    layoutEpoch: frame.layoutEpoch,
    sequence: frame.frameSequence,
    full: fullFrame,
  });
  if (classification === "stale") {
    lifetimeFrames.stale += 1;
    counters.stale += 1;
    if (active) {
      active.frames.stale += 1;
      appendPerformanceSample(active.samples.frameApplyMs, performance.now() - applyStarted);
    }
    if (expectedIdentity) throw new Error("stale routed TRF1 frame");
    return undefined;
  }
  const changedSession = previous.sessionEpoch !== 0n && frame.sessionEpoch !== previous.sessionEpoch;
  if (classification === "resync") {
    if (expectedIdentity) throw new Error("routed TRF1 continuity requires a transfer");
    if (active) {
      active.frames.resyncRequested += 1;
      appendPerformanceSample(active.samples.frameApplyMs, performance.now() - applyStarted);
    }
    previous.awaitingResync = true;
    postToRenderer({ type: "frame-resync-needed", sessionHandle: id });
    return undefined;
  }
  const completingResync = previous.awaitingResync;
  const rowSection = frame.sections.find((candidate) => candidate.kind === SectionKind.RowReplacements);
  const cursorSection = frame.sections.find((candidate) => candidate.kind === SectionKind.CursorState);
  const glyphSection = frame.sections.find((candidate) => candidate.kind === SectionKind.GlyphDefinitions);
  const styleSection = frame.sections.find((candidate) => candidate.kind === SectionKind.StyleDefinitions);
  const clipboardSection = frame.sections.find((candidate) => candidate.kind === SectionKind.ClipboardWrite);
  const scrollbarSection = frame.sections.find((candidate) => candidate.kind === SectionKind.ScrollbarState);
  if (!rowSection || !cursorSection) {
    if (expectedIdentity) throw new Error("routed TRF1 frame is missing required sections");
    if (active) appendPerformanceSample(active.samples.frameApplyMs, performance.now() - applyStarted);
    return undefined;
  }
  const fullRows = (rowSection.flags & 1) !== 0;
  if (replacingScene && !fullRows) {
    throw new Error("routed transfer row section is not a full snapshot");
  }

  const glyphDefinitions = glyphSection ? decodeGlyphDefinitions(glyphSection) : NO_GLYPH_DEFINITIONS;
  const styleDefinitions = styleSection ? decodeStyleDefinitions(styleSection) : NO_STYLE_DEFINITIONS;
  const replacements = decodeRowReplacements(rowSection);
  for (const replacement of replacements) {
    if (replacement.row >= frame.rows) throw new RangeError("Row replacement exceeds viewport");
  }
  const linkSection = frame.sections.find((candidate) => candidate.kind === SectionKind.LinkTargets);
  const links = linkSection ? decodeLinkTargets(linkSection, frame.cols, frame.rows) : [];
  const nextCursor = decodeCursorState(cursorSection);
  const clipboardText = clipboardSection ? decodeClipboardWrite(clipboardSection) : undefined;
  let scrollbar: TerminalScrollbarState | undefined;
  if (scrollbarSection) {
    const decoded = decodeScrollbarState(scrollbarSection);
    scrollbar = {
      total: Number(decoded.total),
      offset: Number(decoded.offset),
      length: Number(decoded.length),
    };
    if (
      !Number.isSafeInteger(scrollbar.total) ||
      !Number.isSafeInteger(scrollbar.offset) ||
      !Number.isSafeInteger(scrollbar.length)
    ) {
      throw new RangeError("Scrollbar state exceeds JavaScript's safe integer range");
    }
  }
  if (
    expectedLayout &&
    (scrollbar === undefined ||
      scrollbar.length !== expectedLayout.rows ||
      scrollbar.total - scrollbar.length !== expectedLayout.scrollbackRows)
  ) {
    throw new Error("transfer scrollback layout does not match TRF1");
  }
  if (active) active.frames.glyphDefinitions += glyphDefinitions.length;
  const resetsCatalog = replacingScene || changedSession || completingResync || catalogReset;
  const wasCatalogFallback = previous.catalogFallback;
  if (resetsCatalog) {
    previous.rows = [];
    previous.nativeRows = [];
    previous.nativeStyleRows = [];
    clearSessionCatalog(previous);
    previous.rowRevisions = [];
    const catalogFits =
      glyphCatalogFits(
        previous.glyphDefinitions,
        previous.glyphPixelBytes,
        sharedGlyphDefinitions,
        sharedGlyphPixelBytes,
        glyphDefinitions,
        GLYPH_CATALOG_BUDGET,
      ) &&
      definitionCatalogFits(
        previous.styleDefinitions,
        styleDefinitions,
        MAX_SESSION_STYLE_DEFINITIONS,
        retainedStyleDefinitions,
        MAX_RETAINED_STYLE_DEFINITIONS,
      );
    const admission = catalogAdmission(true, wasCatalogFallback, catalogFits);
    previous.catalogFallback = admission === "text-fallback";
    if (admission === "install") {
      installGlyphDefinitions(previous, glyphDefinitions);
      installStyleDefinitions(previous, styleDefinitions);
    } else if (!wasCatalogFallback) {
      postToRenderer({
        type: "catalog-pressure",
        sessionHandle: id,
        reason: "working-set-exceeds-budget",
      });
    }
  } else if (!previous.catalogFallback) {
    const catalogFits =
      glyphCatalogFits(
        previous.glyphDefinitions,
        previous.glyphPixelBytes,
        sharedGlyphDefinitions,
        sharedGlyphPixelBytes,
        glyphDefinitions,
        GLYPH_CATALOG_BUDGET,
      ) &&
      definitionCatalogFits(
        previous.styleDefinitions,
        styleDefinitions,
        MAX_SESSION_STYLE_DEFINITIONS,
        retainedStyleDefinitions,
        MAX_RETAINED_STYLE_DEFINITIONS,
      );
    const admission = catalogAdmission(false, false, catalogFits);
    if (admission === "request-full") {
      if (expectedIdentity) throw new Error("routed catalog pressure requires a fresh transfer");
      if (active) {
        active.frames.resyncRequested += 1;
        appendPerformanceSample(active.samples.frameApplyMs, performance.now() - applyStarted);
      }
      previous.awaitingResync = true;
      postToRenderer({ type: "frame-resync-needed", sessionHandle: id });
      return undefined;
    }
    if (admission === "install") {
      installGlyphDefinitions(previous, glyphDefinitions);
      installStyleDefinitions(previous, styleDefinitions);
    }
  }
  if (!previous.catalogFallback && !nativeTextAnnounced && glyphDefinitions.length > 0) {
    nativeTextAnnounced = true;
    postToRenderer({ type: "renderer-status", backend: renderer?.kind ?? "starting", textEngine: "native" });
  }
  let scrollbarChanged = false;
  if (scrollbar) {
    if (
      !previous.scrollbar ||
      previous.scrollbar.total !== scrollbar.total ||
      previous.scrollbar.offset !== scrollbar.offset ||
      previous.scrollbar.length !== scrollbar.length
    ) {
      previous.scrollbar = scrollbar;
      scrollbarChanged = true;
    }
  }

  const useNativeCatalog = !previous.catalogFallback;
  const rows = fullRows ? Array<string>(frame.rows).fill("") : previous.rows.slice();
  const nativeRows = fullRows
    ? Array.from({ length: frame.rows }, () => [] as GlyphInstance[])
    : previous.nativeRows.slice();
  const nativeStyleRows = fullRows
    ? Array.from({ length: frame.rows }, () => [] as StyleRun[])
    : previous.nativeStyleRows.slice();
  const rowRevisions = fullRows ? Array<bigint>(frame.rows).fill(0n) : previous.rowRevisions.slice();
  const damagedRows: number[] = [];
  if (active) active.frames.rowsDecoded += replacements.length;
  for (const replacement of replacements) {
    if (replacement.revision < (rowRevisions[replacement.row] ?? 0n)) continue;
    rows[replacement.row] = replacement.text;
    nativeRows[replacement.row] = useNativeCatalog ? replacement.glyphs : [];
    nativeStyleRows[replacement.row] = useNativeCatalog ? replacement.styles : [];
    rowRevisions[replacement.row] = replacement.revision;
    damagedRows.push(replacement.row);
  }
  previous.rows = rows;
  previous.nativeRows = nativeRows;
  previous.nativeStyleRows = nativeStyleRows;
  previous.rowRevisions = rowRevisions;
  const geometryChanged = damagedRows.length > 0;
  const previousCursor = previous.cursor;
  const cursorChanged =
    nextCursor.x !== previousCursor.x ||
    nextCursor.y !== previousCursor.y ||
    nextCursor.visible !== previousCursor.visible ||
    nextCursor.style !== previousCursor.style ||
    nextCursor.blinking !== previousCursor.blinking;
  previous.cursor = nextCursor;
  previous.layoutEpoch = frame.layoutEpoch;
  previous.sessionEpoch = frame.sessionEpoch;
  previous.sequence = frame.frameSequence;
  previous.awaitingResync = false;
  if (replacingScene) {
    snapshots.set(id, previous);
    if (installedScene) clearSessionCatalog(installedScene);
  }
  const linkSignature = JSON.stringify(links);
  if (previous.linkSignature !== linkSignature || changedSession || completingResync) {
    previous.linkSignature = linkSignature;
    postToRenderer({ type: "link-targets", sessionHandle: id, links });
  }
  if (clipboardText !== undefined) postToRenderer({ type: "clipboard-write", text: clipboardText });
  if (scrollbarChanged && scrollbar) postToRenderer({ type: "scrollbar-state", sessionHandle: id, scrollbar });
  if (completingResync) postToRenderer({ type: "frame-resync-complete", sessionHandle: id });
  const requiresFullRedraw = fullRows || changedSession || completingResync;
  if (!requiresFullRedraw && cursorChanged) damagedRows.push(previousCursor.y, nextCursor.y);
  const hasRowDamage = damagedRows.length > 0;
  for (const surfaceId of surfaceIdsForSession(id)) {
    if (cursorChanged) scheduleCursorBlink(surfaceId, true);
    if (requiresFullRedraw) invalidateFull(surfaceId);
    else if (hasRowDamage) invalidateRows(surfaceId, damagedRows, geometryChanged);
  }
  // Announced only once the frame is committed and its redraw scheduled, so a
  // consumer waiting on recovery is never told "done" ahead of the pixels.
  postToRenderer({
    type: "frame-committed",
    sessionHandle: id,
    sessionEpoch: frame.sessionEpoch,
    frameSequence: frame.frameSequence,
    // A resume publishes a full refresh, and `classifyFrame` only accepts a
    // resync-completing frame that carries one, so this flag is what tells a
    // recovered screen apart from a partial update of the stale one.
    fullSnapshot: fullFrame,
  });
  lifetimeFrames.applies += 1;
  counters.applies += 1;
  if (active) appendPerformanceSample(active.samples.frameApplyMs, performance.now() - applyStarted);
  return {
    sessionHandle: id,
    viewHandle: frame.viewHandle.toString(),
    cols: frame.cols,
    rows: frame.rows,
  };
}

const routedFrames = new RoutedFramesTransport({
  applyFrame: (packet, identity, expectedLayout) => {
    const applied = applyFrame(packet, identity, expectedLayout);
    if (!applied) throw new Error("routed TRF1 frame was not applied");
    return applied;
  },
  emit: (event) => postToRenderer({ type: "routed-frames-event", event }),
  creditReturned: (bytes) => {
    lifetimeFlow.creditBytesReturned += bytes;
    lifetimeFlow.creditBatchesReturned += 1;
  },
});

self.onmessage = (event: MessageEvent<RendererToWorkerMessage>) => {
  const message = event.data;
  try {
    if (message.type === "mount") {
      void mount(message.surfaceId, message.sessionHandle, message.canvas).catch((error) => {
        console.error("[terminal-renderer] mount failed", error);
      });
    } else if (message.type === "renderer-config") {
      forceCanvasFallback = Boolean(message.forceCanvasFallback);
    } else if (message.type === "partial-rendering") {
      partialRenderingEnabled = Boolean(message.enabled);
      for (const id of mounts.keys()) invalidateFull(id);
    } else if (message.type === "unmount") {
      mounts.delete(message.surfaceId);
      dirty.delete(message.surfaceId);
      deleteSurface(message.surfaceId);
      occluded.delete(message.surfaceId);
      frozenCursors.delete(message.surfaceId);
      renderer?.unmount(message.surfaceId);
      const timer = cursorBlinkTimers.get(message.surfaceId);
      if (timer !== undefined) clearTimeout(timer);
      cursorBlinkTimers.delete(message.surfaceId);
      // The session may be remounted after zoom/layout changes. Keep its decoded
      // snapshot; only drop-session represents terminal lifetime ending.
    } else if (message.type === "drop-session") {
      for (const surfaceId of surfaceIdsForSession(message.sessionHandle)) {
        mounts.delete(surfaceId);
        dirty.delete(surfaceId);
        surfaces.delete(surfaceId);
        occluded.delete(surfaceId);
        frozenCursors.delete(surfaceId);
        renderer?.unmount(surfaceId);
        const timer = cursorBlinkTimers.get(surfaceId);
        if (timer !== undefined) clearTimeout(timer);
        cursorBlinkTimers.delete(surfaceId);
      }
      surfaceIdsBySession.delete(message.sessionHandle);
      dropSessionSnapshot(message.sessionHandle);
      presentationDefaults.delete(message.sessionHandle);
      performanceMeasurement?.lastFrameAt.delete(message.sessionHandle);
    } else if (message.type === "resize") {
      const mounted = mounts.get(message.surfaceId);
      if (!mounted) return;
      const nextSize = { width: message.width, height: message.height, dpr: message.dpr };
      const changed = renderedSizeChanged(mounted.size, nextSize);
      mounted.size = nextSize;
      if (!changed) return;
      renderer?.resize(message.surfaceId, mounted.size);
      invalidateFull(message.surfaceId);
    } else if (message.type === "frame") {
      try {
        applyFrame(message.packet);
      } finally {
        returnFrameCredit(message.packet.byteLength);
      }
    } else if (message.type === "frame-gap") {
      for (const sessionHandle of message.sessionHandles) {
        const session = snapshot(sessionHandle);
        if (session.awaitingResync) continue;
        session.awaitingResync = true;
        postToRenderer({ type: "frame-resync-needed", sessionHandle });
      }
    } else if (message.type === "expect-full") {
      snapshot(message.sessionHandle).awaitingResync = true;
    } else if (message.type === "theme") {
      if (message.surfaceId) {
        surface(message.surfaceId, message.sessionHandle).theme = message.theme;
        invalidateFull(message.surfaceId);
      } else {
        defaults(message.sessionHandle).theme = message.theme;
        for (const surfaceId of surfaceIdsForSession(message.sessionHandle)) {
          surfaces.get(surfaceId)!.theme = message.theme;
          invalidateFull(surfaceId);
        }
      }
    } else if (message.type === "effects") {
      if (message.surfaceId) {
        surface(message.surfaceId, message.sessionHandle).effects = message.effects;
        invalidateFull(message.surfaceId);
      } else {
        defaults(message.sessionHandle).effects = message.effects;
        for (const surfaceId of surfaceIdsForSession(message.sessionHandle)) {
          surfaces.get(surfaceId)!.effects = message.effects;
          invalidateFull(surfaceId);
        }
      }
      scheduleShaderAnimation();
    } else if (message.type === "selection") {
      if (message.surfaceId) {
        surface(message.surfaceId, message.sessionHandle).selection = message.selection;
        invalidateFull(message.surfaceId);
      } else {
        defaults(message.sessionHandle).selection = message.selection;
        for (const surfaceId of surfaceIdsForSession(message.sessionHandle)) {
          surfaces.get(surfaceId)!.selection = message.selection;
          invalidateFull(surfaceId);
        }
      }
    } else if (message.type === "visibility") {
      if (!message.surfaceId) defaults(message.sessionHandle).visible = message.visible;
      if (message.surfaceId) surface(message.surfaceId, message.sessionHandle);
      const targetIds = message.surfaceId ? [message.surfaceId] : surfaceIdsForSession(message.sessionHandle);
      for (const surfaceId of targetIds) {
        if (message.visible) {
          occluded.delete(surfaceId);
          invalidateFull(surfaceId);
          scheduleCursorBlink(surfaceId, true);
        } else {
          occluded.add(surfaceId);
          const timer = cursorBlinkTimers.get(surfaceId);
          if (timer !== undefined) clearTimeout(timer);
          cursorBlinkTimers.delete(surfaceId);
        }
      }
      scheduleShaderAnimation();
    } else if (message.type === "focus") {
      const value = surface(message.surfaceId, message.sessionHandle);
      value.focused = Boolean(message.focused);
      scheduleCursorBlink(message.surfaceId, value.focused);
      invalidateRows(message.surfaceId, [snapshot(message.sessionHandle).cursor.y]);
      scheduleShaderAnimation();
    } else if (message.type === "cursor-frozen") {
      const value = surfaces.get(message.surfaceId);
      if (!value) return;
      if (message.frozen) {
        frozenCursors.add(message.surfaceId);
        const timer = cursorBlinkTimers.get(message.surfaceId);
        if (timer !== undefined) clearTimeout(timer);
        cursorBlinkTimers.delete(message.surfaceId);
        // Rest on the visible half of the blink so the frozen screen shows the
        // cursor where the host left it.
        if (!value.cursorBlinkVisible) {
          value.cursorBlinkVisible = true;
          invalidateRows(message.surfaceId, [snapshot(value.sessionHandle).cursor.y]);
        }
      } else {
        frozenCursors.delete(message.surfaceId);
        scheduleCursorBlink(message.surfaceId, true);
      }
    } else if (message.type === "cursor-activity") {
      const session = snapshot(message.sessionHandle);
      for (const surfaceId of surfaceIdsForSession(message.sessionHandle)) {
        const value = surfaces.get(surfaceId)!;
        const changesPixels = cursorActivityChangesPixels(session.cursor, value.focused, value.cursorBlinkVisible);
        scheduleCursorBlink(surfaceId, true);
        if (changesPixels) invalidateRows(surfaceId, [session.cursor.y]);
      }
    } else if (message.type === "force-full-redraw") {
      invalidateSessionFull(message.sessionHandle);
    } else if (message.type === "force-row-redraw") {
      invalidateSessionRows(message.sessionHandle, [message.row]);
    } else if (message.type === "performance-start") {
      void ensureRenderer()
        .then(() => {
          beginPerformanceMeasurement();
          postToRenderer({ type: "performance-started", requestId: message.requestId });
        })
        .catch((error) => console.error("[terminal-renderer] failed to start performance measurement", error));
    } else if (message.type === "performance-finish") {
      void finishPerformanceMeasurement(message.requestId, message.quietMs, message.timeoutMs).catch((error) => {
        console.error("[terminal-renderer] failed to finish performance measurement", error);
      });
    } else if (message.type === "performance-counters") {
      postToRenderer({ type: "performance-counters", requestId: message.requestId, snapshot: counterSnapshot() });
    } else if (message.type === "routed-frames-attach") {
      routedFrames.attach(message.request);
    } else if (message.type === "routed-frames-detach") {
      routedFrames.detach(message.activationId);
    }
  } catch (error) {
    console.error("[terminal-renderer] rejected worker message", error);
  }
};
