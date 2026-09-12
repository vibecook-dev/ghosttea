import type { TerminalLink } from "@vibecook/ghosttea-frame";
import { terminalLinkUrl } from "@vibecook/ghosttea-protocol";
import { ControlClient } from "@vibecook/ghosttea";
import {
  DEFAULT_ROUTED_PROTOCOL_LIMITS,
  PROTOCOL_MAJOR,
  PROTOCOL_MINOR,
  SESSION_SCROLLBACK_PROTOCOL_MINOR,
  STRUCTURED_ERROR_PROTOCOL_MINOR,
  isRoutedSessionAttachGrant,
  isRoutedTerminalOpenTicket,
  isValidScrollbackBytes,
  type ConfigSnapshot,
  type CreateSessionOptions,
  type ExitOutcome,
  type RemoteControllerInfo,
  type RemoteHostSummary,
  type RemoteSessionLifecycle,
  type RemoteViewRecord,
  type RoutedReceiverCapacities,
  type RoutedSessionAttachGrant,
  type RoutedTerminalOpenTicket,
  type SelectionScopeKind,
  type SessionActivity,
  type ServerEvent,
  type SessionSummary,
  type SharedSessionSummary,
  type TerminalKeyEvent,
  type TerminalMouseEvent,
  type TerminalScrollbarState,
  type TerminationSource,
} from "@vibecook/ghosttea-protocol";
import { FRAME_MAGIC, FrameFlag } from "@vibecook/ghosttea-frame";
import type { CellSelection, TerminalEffects, TerminalTheme } from "./renderers/types.js";
import type { TerminalRenderCounterSnapshot, TerminalRenderPerformanceSnapshot } from "./performance.js";
import { FrameResyncController } from "./frame-resync.js";
import type { RendererToWorkerMessage, WorkerToRendererMessage } from "./worker-messages.js";
import {
  initialRoutedActivation,
  reduceRoutedActivation,
  type RoutedActivationEvent,
  type RoutedActivationState,
} from "./routed-activation.js";
import {
  RoutedControlTransport,
  type RoutedControlTransportEvent,
  type RoutedExtensionMessageContext,
} from "./routed-control.js";
import type { RoutedFramesTransportEvent } from "./routed-frames.js";

export type { RoutedExtensionMessageContext } from "./routed-control.js";

export interface GhostteaRendererPorts {
  control: MessagePort;
  frames: MessagePort;
}

export interface GhostteaRendererPlatform {
  writeClipboard(text: string): void;
  /** Open a user-clicked URL in the host. Omit to disable link interaction. */
  openExternal?(url: string): void | Promise<void>;
  forceCanvasFallback(): boolean;
  setForceCanvasFallback(enabled: boolean): void;
  reload(): void;
}

interface GhostteaTerminalRuntimeBaseOptions {
  platform: GhostteaRendererPlatform;
  workerFactory?: () => Worker;
  clientBuild?: string;
  sessionOwnerId?: string;
  frameSubscriptionGraceMs?: number;
}

export interface GhostteaPortTerminalRuntimeOptions extends GhostteaTerminalRuntimeBaseOptions {
  transport?: "ports";
  ports: GhostteaRendererPorts | Promise<GhostteaRendererPorts>;
}

export type RoutedTerminalInputOperation =
  | { kind: "text"; text: string }
  | { kind: "paste"; text: string }
  | { kind: "key"; event: TerminalKeyEvent }
  | { kind: "mouse"; event: TerminalMouseEvent }
  | { kind: "scroll"; rows: number }
  | { kind: "scroll-to"; row: number }
  | { kind: "interrupt" };

export interface RoutedTerminalInputContext {
  sessionId: string;
  viewId: string;
  activationId: string;
  leaseEpoch: number;
  inputSequence: number;
  operation: RoutedTerminalInputOperation;
}

export type RoutedSessionEvent =
  | { type: "updated"; session: SessionSummary }
  | { type: "activity-changed"; sessionId: string; activity: SessionActivity }
  | {
      type: "exited";
      sessionId: string;
      exitCode: number | null;
      exitSignal: string | null;
      requestedTermination: TerminationSource | null;
      exitOutcome: ExitOutcome;
    }
  | { type: "removed"; sessionId: string };

export interface GhostteaRoutedHost {
  openTicket(
    sessionId: string,
    options?: { reason?: "mount" | "retry" | "route-stale" | "pre-auth" },
  ): Promise<RoutedTerminalOpenTicket>;
  renewAttach?(params: {
    sessionId: string;
    expectGeneration: number;
    requestId: string;
  }): Promise<{ attachGrant: RoutedSessionAttachGrant }>;
  listSessions?(): Promise<SessionSummary[]>;
  getSession?(sessionId: string): Promise<SessionSummary | null>;
  createSession?(options: CreateSessionOptions): Promise<SessionSummary>;
  terminate?(sessionId: string, source: TerminationSource): void | Promise<void>;
  /**
   * Encodes the host's negotiated input extension. TPv3 T1 currently defines
   * no terminal-input tag, so routed input stays closed when this is absent.
   */
  encodeInput?(context: RoutedTerminalInputContext): Readonly<Record<string, unknown>> | null;
  /** Receives negotiated host-owned messages from an authenticated routed control leg. */
  onExtensionMessage?(message: Readonly<Record<string, unknown>>, context: RoutedExtensionMessageContext): void;
}

export interface GhostteaRoutedTerminalRuntimeOptions extends GhostteaTerminalRuntimeBaseOptions {
  transport: "routed";
  host: GhostteaRoutedHost;
  websocketFactory?: (url: string) => WebSocket;
  receiverCapacities?: RoutedReceiverCapacities;
  capabilities?: string[];
}

export type GhostteaTerminalRuntimeOptions = GhostteaPortTerminalRuntimeOptions | GhostteaRoutedTerminalRuntimeOptions;

export type TerminalMount = {
  resize: (width: number, height: number, dpr: number) => void;
  dispose: () => void;
};

const MAX_BROWSER_TIMEOUT_MS = 2_147_483_647;

function routedConnectionRefusalIsRecoverable(refusal: { code: string; retryable: boolean }): boolean {
  return refusal.retryable || refusal.code === "GRANT_GENERATION_ROLLBACK" || refusal.code === "GRANT_NONCE_REPLAYED";
}

function sameSessionActivity(left: SessionActivity, right: SessionActivity): boolean {
  return (
    left.kind === right.kind &&
    left.source === right.source &&
    left.confidence === right.confidence &&
    left.rootProcessGroupId === right.rootProcessGroupId &&
    left.foregroundProcessGroupId === right.foregroundProcessGroupId &&
    left.observedAtMs === right.observedAtMs
  );
}

interface MountedCanvas {
  canvas: HTMLCanvasElement;
  sessionHandle: string;
  sessionId: string;
  viewId: string;
  generation: number;
  references: number;
  disposeTimer: number | undefined;
  active: boolean;
}

interface ViewRuntimeState {
  sessionId: string;
  sessionHandle: string;
  attachmentEpoch?: number | undefined;
  readWrite?: boolean;
  /** Viewer-local policy; it can remove input but never add a server right. */
  clientReadWrite: boolean;
  /** Only an explicit host/component request may claim the geometry seat. */
  resizeControlRequested: boolean;
  visible: boolean;
  inputSequence: number;
  resizeSequence: number;
  controlEpoch: number | undefined;
  desiredCols: number | undefined;
  desiredRows: number | undefined;
  pendingInput: Array<(attachmentEpoch: number, inputSequence: number) => void>;
  /** Highest per-view sequence applied, from any of the three update paths. */
  lastViewStateSeq: number | undefined;
  /**
   * Survives the epoch being cleared so a frozen replica stays copyable: the
   * daemon authorizes offline selection from its ownership record, not from a
   * live attachment.
   */
  lastAttachmentEpoch: number | undefined;
  /** Attachment epoch this view has already claimed control for, if any. */
  claimedEpoch: number | undefined;
  /** Control revision that claim was made against, for the cleared-controller retry. */
  claimedRevision: number;
}

/** A session's lifecycle as this client currently believes it. */
export type RemoteSessionRuntimeState = RemoteSessionLifecycle & {
  sessionId: string;
  /** Monotonic clock reading when this state was observed, for honest elapsed timing. */
  observedAt: number;
  /**
   * Live again, but still showing the screen from before the outage. The
   * replica is not trustworthy until a frame from the recovered stream has
   * actually been committed, so the pane stays cooled until then.
   */
  awaitingRecoveryFrame: boolean;
};

/** States that leave a screen on display which the host is no longer updating. */
export function showsStaleScreen(state: RemoteSessionLifecycle["state"]): boolean {
  return state !== "live" && state !== "opening";
}

/** Whether a pane is showing stale content: frozen outright, or live but not yet redrawn. */
export function sessionIsFrozen(state: RemoteSessionRuntimeState): boolean {
  return showsStaleScreen(state.state) || state.awaitingRecoveryFrame;
}

export interface SelectionScope {
  sessionId: string;
  viewId: string;
  scope: SelectionScopeKind;
}

export interface RemoteInputSuppression {
  sessionId: string;
  viewId: string;
  state: RemoteSessionRuntimeState["state"];
}

/** A per-view update from an event, a reconciliation, or an attach response. */
type RemoteViewStateUpdate = Omit<RemoteViewRecord, "viewId" | "viewStateSeq"> & { viewStateSeq?: number };

type FrameChannelMessage =
  | ArrayBuffer
  | { type: "subscription-ack"; requestId: number }
  | { type: "frame-gap"; skipped: number; sessionHandles?: string[]; historyComplete?: boolean }
  | { type: "bridge-capabilities"; requestId: number; protocolVersion: number; frameCredits: boolean };

interface RoutedActivationRuntime {
  sessionId: string;
  sessionHandle: string;
  state: RoutedActivationState;
  ticket?: RoutedTerminalOpenTicket;
  replacesActivationId?: string;
  viewIds: Set<string>;
  start?: Promise<void>;
  attachTimer?: number;
  renewalTimer?: number;
  framesResume?: Promise<void>;
  recoveryAttempts: number;
  preAuthRemints: { control: number; frames: number };
  protocolFailures: { control: number; frames: number };
}

interface RoutedGeometryState {
  holderViewId?: string;
  holderGeneration?: number;
  revision: number;
  cols?: number;
  rows?: number;
}

const FRAME_SUBSCRIPTION_ACK_TIMEOUT_MS = 10_000;
const FRAME_SUBSCRIPTION_ACK_PROTOCOL_MINOR = 7;
const FRAME_BRIDGE_CAPABILITY_VERSION = 1;
const CONFIG_PROTOCOL_MINOR = 10;
const REMOTE_LIFECYCLE_PROTOCOL_MINOR = 12;
const CONTROL_REVISION_CAS_PROTOCOL_MINOR = 13;
const SESSION_OWNER_TRANSFER_PROTOCOL_MINOR = 14;
const DEFAULT_FRAME_SUBSCRIPTION_GRACE_MS = 1_000;
/** A one-shot resume covers a 20 s dial plus the attach handshake. */
const RECONNECT_REQUEST_TIMEOUT_MS = 60_000;

export function waitForGhostteaRendererPorts(timeoutMs = 10_000): Promise<GhostteaRendererPorts> {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      window.removeEventListener("message", listener);
      reject(new Error("Electron did not transfer the terminal control and frame ports"));
    }, timeoutMs);
    const listener = (event: MessageEvent): void => {
      if (event.data?.type !== "ghosttea:ports" || event.ports.length !== 2) return;
      window.clearTimeout(timeout);
      window.removeEventListener("message", listener);
      resolve({ control: event.ports[0]!, frames: event.ports[1]! });
    };
    window.addEventListener("message", listener);
  });
}

export class GhostteaTerminalRuntime extends EventTarget {
  readonly #worker: Worker;
  readonly #ports: Promise<GhostteaRendererPorts> | undefined;
  readonly #routedHost: GhostteaRoutedHost | undefined;
  readonly #routedReceiverCapacities: RoutedReceiverCapacities | undefined;
  readonly #routedCapabilities: string[];
  readonly #routedControl: RoutedControlTransport | undefined;
  readonly #routedBySession = new Map<string, RoutedActivationRuntime>();
  readonly #routedByActivation = new Map<string, RoutedActivationRuntime>();
  readonly #routedGeometry = new Map<string, RoutedGeometryState>();
  readonly #routedAttachDeadlineByCell = new Map<string, number>();
  readonly #platform: GhostteaRendererPlatform;
  readonly #clientBuild: string;
  readonly #sessionOwnerId: string | undefined;
  readonly #frameSubscriptionGraceMs: number;
  #control: ControlClient | undefined;
  #frames: MessagePort | undefined;
  #ready: Promise<void> | undefined;
  readonly #sessionByHandle = new Map<string, SessionSummary>();
  readonly #handleBySessionId = new Map<string, string>();
  readonly #subscribedSessionHandles = new Set<string>();
  readonly #pinnedSessionHandles = new Set<string>();
  readonly #sessionMountReferences = new Map<string, number>();
  readonly #sessionReleaseTimers = new Map<string, number>();
  #frameSubscriptionVersion = 1;
  #frameSubscriptionQueuedVersion = 0;
  #frameSubscriptionRequestId = 1;
  #frameSubscriptionReady = Promise.resolve();
  readonly #frameSubscriptionRequests = new Map<
    number,
    { resolve: () => void; reject: (error: Error) => void; timer: number }
  >();
  #frameBridgeCapabilityProbeRequestId: number | undefined;
  #frameSubscriptionAcksSupported = false;
  #frameFlowControlEnabled = false;
  readonly #mountedCanvases = new WeakMap<HTMLCanvasElement, MountedCanvas>();
  readonly #mountedEntries = new Set<MountedCanvas>();
  readonly #mountGenerationBySurface = new Map<string, number>();
  readonly #mouseTrackingByHandle = new Map<string, boolean>();
  readonly #scrollbarByHandle = new Map<string, TerminalScrollbarState>();
  readonly #focusByView = new Map<string, boolean>();
  readonly #views = new Map<string, ViewRuntimeState>();
  readonly #remoteSessions = new Map<string, RemoteSessionRuntimeState>();
  readonly #controlBySession = new Map<string, { controller: RemoteControllerInfo | null; revision: number }>();
  /** Sessions whose current outage episode has already produced a full snapshot. */
  readonly #recoveredSessions = new Set<string>();
  #remoteLifecycleSupported = false;
  #controlRevisionCasSupported = false;
  #ownerAwareAttachmentSupported = false;
  #serverProtocolMinor = 0;
  #rendererBackend = "starting";
  #configSnapshot: ConfigSnapshot | undefined;
  #configProtocolSupported = false;
  readonly #metadataTimers = new Map<string, number>();
  readonly #metadataRefreshes = new Map<string, Promise<void>>();
  readonly #metadataRefreshPending = new Set<string>();
  readonly #sessionGenerationByHandle = new Map<string, number>();
  readonly #appliedRoutedExitEvents = new Set<string>();
  #sessionGeneration = 0;
  readonly #resync: FrameResyncController;
  #performanceRequestId = 1;
  readonly #performanceRequests = new Map<
    number,
    {
      resolve: (value: TerminalRenderPerformanceSnapshot | undefined) => void;
      reject: (error: Error) => void;
      timer: number;
    }
  >();
  readonly #counterRequests = new Map<
    number,
    { resolve: (value: TerminalRenderCounterSnapshot) => void; reject: (error: Error) => void; timer: number }
  >();
  readonly #linksByHandle = new Map<string, TerminalLink[]>();
  #disposed = false;

  constructor(options: GhostteaTerminalRuntimeOptions) {
    super();
    this.#worker =
      options.workerFactory?.() ??
      new Worker(new URL("./terminal-render.worker.js", import.meta.url), { type: "module" });
    this.#ports = options.transport === "routed" ? undefined : Promise.resolve(options.ports);
    this.#routedHost = options.transport === "routed" ? options.host : undefined;
    this.#routedReceiverCapacities = options.transport === "routed" ? options.receiverCapacities : undefined;
    this.#routedCapabilities = options.transport === "routed" ? (options.capabilities ?? ["resume"]) : [];
    this.#routedControl =
      options.transport === "routed"
        ? new RoutedControlTransport({
            ...(options.websocketFactory === undefined ? {} : { socketFactory: options.websocketFactory }),
            acceptExtensionMessages: options.host.onExtensionMessage !== undefined,
            emit: (event) => this.#handleRoutedControlEvent(event),
          })
        : undefined;
    this.#platform = options.platform;
    this.#clientBuild = options.clientBuild ?? "ghosttea-react";
    this.#sessionOwnerId = options.sessionOwnerId;
    this.#frameSubscriptionGraceMs = Math.max(
      0,
      options.frameSubscriptionGraceMs ?? DEFAULT_FRAME_SUBSCRIPTION_GRACE_MS,
    );
    this.#resync = new FrameResyncController((sessionHandle) => this.#refreshSession(sessionHandle), {
      onExhausted: (sessionHandle, error) => {
        console.error(`[terminal-runtime] frame resynchronization exhausted for ${sessionHandle}`, error);
        this.dispatchEvent(new CustomEvent("frame-resync-failed", { detail: { sessionHandle, error } }));
      },
    });
    this.#worker.addEventListener("error", (event) => {
      console.error(`[terminal-runtime] render worker failed to start: ${event.message || "unknown worker error"}`);
      this.dispatchEvent(new CustomEvent("renderer-error", { detail: event }));
    });
    this.#worker.addEventListener("messageerror", (event) => {
      console.error("[terminal-runtime] render worker rejected a message", event);
      this.dispatchEvent(new CustomEvent("renderer-error", { detail: event }));
    });
    this.#worker.addEventListener("message", ({ data }: MessageEvent<WorkerToRendererMessage>) => {
      if (data.type === "renderer-status") {
        this.#rendererBackend = data.backend;
        console.info(
          `[terminal-runtime] renderer backend: ${data.backend}${data.textEngine ? ` + ${data.textEngine} text` : ""}${data.recovered ? " (recovered)" : ""}`,
        );
        this.dispatchEvent(new CustomEvent("renderer-status", { detail: data }));
      } else if (data.type === "clipboard-write") {
        this.#platform.writeClipboard(data.text);
      } else if (data.type === "link-targets") {
        this.#linksByHandle.set(
          data.sessionHandle,
          data.links.filter((link) => terminalLinkUrl(link.uri) !== null),
        );
        this.dispatchEvent(new CustomEvent("link-targets", { detail: { sessionHandle: data.sessionHandle } }));
      } else if (data.type === "scrollbar-state") {
        this.#scrollbarByHandle.set(data.sessionHandle, data.scrollbar);
        this.dispatchEvent(
          new CustomEvent("scrollbar-state", {
            detail: { sessionHandle: data.sessionHandle, scrollbar: data.scrollbar },
          }),
        );
      } else if (data.type === "frame-resync-needed") {
        this.#resync.request(data.sessionHandle);
      } else if (data.type === "frame-resync-complete") {
        this.#resync.complete(data.sessionHandle);
      } else if (data.type === "frame-committed") {
        if (this.#routedHost?.getSession) this.#scheduleMetadataRefresh(data.sessionHandle);
        this.#recordCommittedFrame(data.sessionHandle, data.fullSnapshot);
      } else if (data.type === "catalog-pressure") {
        console.warn(
          `[terminal-runtime] native text catalog budget exceeded for ${data.sessionHandle}; using bounded fallback text`,
        );
        this.dispatchEvent(new CustomEvent("catalog-pressure", { detail: data }));
      } else if (data.type === "frame-credit" && this.#frameFlowControlEnabled) {
        this.#frames?.postMessage({ type: "frame-credit", bytes: data.bytes });
      } else if (data.type === "performance-started") {
        this.#resolvePerformanceRequest(data.requestId, undefined);
      } else if (data.type === "performance-result") {
        this.#resolvePerformanceRequest(data.requestId, data.snapshot);
      } else if (data.type === "performance-counters") {
        const pending = this.#counterRequests.get(data.requestId);
        if (!pending) return;
        window.clearTimeout(pending.timer);
        this.#counterRequests.delete(data.requestId);
        pending.resolve(data.snapshot);
      } else if (data.type === "routed-frames-event") {
        this.#handleRoutedFramesEvent(data.event);
      } else if (data.type === "renderer-reload-required") {
        console.error(`[terminal-runtime] renderer requested reload: ${String(data.reason ?? "unknown")}`);
        this.#platform.setForceCanvasFallback(true);
        this.#platform.reload();
      }
    });
    this.#postWorker({
      type: "renderer-config",
      forceCanvasFallback: this.#platform.forceCanvasFallback(),
    });
  }

  #postWorker(message: RendererToWorkerMessage, transfer: Transferable[] = []): void {
    if (this.#disposed) return;
    this.#worker.postMessage(message, transfer);
  }

  get rendererBackend(): string {
    return this.#rendererBackend;
  }

  /** Current main-authority state for a routed session. */
  routedActivation(sessionId: string): RoutedActivationState | undefined {
    return this.#routedBySession.get(sessionId)?.state;
  }

  routedViewInputAllowed(viewId: string): boolean {
    const view = this.#views.get(viewId);
    if (!view?.clientReadWrite || view.readWrite === false) return false;
    return this.#routedBySession.get(view.sessionId)?.state.inputAllowed ?? false;
  }

  #resolvePerformanceRequest(requestId: number, value: TerminalRenderPerformanceSnapshot | undefined): void {
    const pending = this.#performanceRequests.get(requestId);
    if (!pending) return;
    window.clearTimeout(pending.timer);
    this.#performanceRequests.delete(requestId);
    pending.resolve(value);
  }

  #performanceRequest(
    send: (requestId: number) => RendererToWorkerMessage,
    timeoutMs: number,
  ): Promise<TerminalRenderPerformanceSnapshot | undefined> {
    if (this.#disposed) return Promise.reject(new Error("Terminal runtime is disposed"));
    const requestId = this.#performanceRequestId++;
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.#performanceRequests.delete(requestId);
        reject(new Error(`Terminal render performance request ${requestId} timed out`));
      }, timeoutMs);
      this.#performanceRequests.set(requestId, { resolve, reject, timer });
      this.#postWorker(send(requestId));
    });
  }

  async startPerformanceMeasurement(): Promise<void> {
    await this.#performanceRequest((requestId) => ({ type: "performance-start", requestId }), 10_000);
  }

  async finishPerformanceMeasurement(
    options: {
      quietMs?: number;
      timeoutMs?: number;
    } = {},
  ): Promise<TerminalRenderPerformanceSnapshot> {
    const quietMs = Math.max(0, options.quietMs ?? 250);
    const timeoutMs = Math.max(quietMs + 1_000, options.timeoutMs ?? 15_000);
    const result = await this.#performanceRequest(
      (requestId) => ({ type: "performance-finish", requestId, quietMs, timeoutMs }),
      timeoutMs + 5_000,
    );
    if (!result) throw new Error("Terminal render worker returned no performance snapshot");
    return result;
  }

  /** Reads monotonic production counters without starting a sample window or draining the GPU. */
  readPerformanceCounters(timeoutMs = 2_000): Promise<TerminalRenderCounterSnapshot> {
    if (this.#disposed) return Promise.reject(new Error("Terminal runtime is disposed"));
    const requestId = this.#performanceRequestId++;
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.#counterRequests.delete(requestId);
        reject(new Error(`Terminal render counter request ${requestId} timed out`));
      }, timeoutMs);
      this.#counterRequests.set(requestId, { resolve, reject, timer });
      this.#postWorker({ type: "performance-counters", requestId });
    });
  }

  connect(): Promise<void> {
    if (this.#disposed) return Promise.reject(new Error("Terminal runtime is disposed"));
    this.#ready ??= this.#connect();
    return this.#ready;
  }

  async #connect(): Promise<void> {
    if (this.#routedHost) return;
    const ports = await this.#ports!;
    if (this.#disposed) {
      ports.control.close();
      ports.frames.close();
      throw new Error("Terminal runtime was disposed before its ports arrived");
    }
    console.info("[terminal-runtime] received control and frame ports");
    this.#control = new ControlClient(ports.control);
    this.#control.addEventListener("session-exited", (event) => {
      const detail = (event as CustomEvent<Extract<ServerEvent, { type: "session-exited" }>>).detail;
      this.#applySessionExited(detail);
    });
    this.#control.addEventListener("events-lost", () => {
      // The daemon dropped events faster than this client drained them. Any
      // of them could have been a session-exited, so reconcile against the
      // daemon's authoritative session list.
      void this.#resyncAfterLostEvents();
    });
    this.#control.addEventListener("session-activity-changed", (event) => {
      const detail = (event as CustomEvent<Extract<ServerEvent, { type: "session-activity-changed" }>>).detail;
      this.#applySessionActivity(detail);
    });
    this.#control.addEventListener("control-changed", (event) => {
      const detail = (event as CustomEvent<Extract<ServerEvent, { type: "control-changed" }>>).detail;
      this.#applyController(
        detail.sessionId,
        { viewId: detail.controllerViewId, controlEpoch: detail.controlEpoch },
        detail.cols,
        detail.rows,
      );
    });
    this.#control.addEventListener("control-state", (event) => {
      const detail = (event as CustomEvent<Extract<ServerEvent, { type: "control-state" }>>).detail;
      this.#applyController(detail.sessionId, detail.controller, detail.cols, detail.rows, detail.controlRevision);
    });
    this.#control.addEventListener("remote-session-state-changed", (event) => {
      const detail = (event as CustomEvent<Extract<ServerEvent, { type: "remote-session-state-changed" }>>).detail;
      this.#applyRemoteSessionState(detail.sessionId, detail, false);
    });
    this.#control.addEventListener("view-state-changed", (event) => {
      const detail = (event as CustomEvent<Extract<ServerEvent, { type: "view-state-changed" }>>).detail;
      this.#applyViewState(detail.viewId, detail);
    });
    this.#control.addEventListener("config-changed", (event) => {
      const detail = (event as CustomEvent<Extract<ServerEvent, { type: "config-changed" }>>).detail;
      this.#installConfig(detail.config);
    });
    this.#frames = ports.frames;
    this.#frames.onmessage = ({ data }: MessageEvent<FrameChannelMessage>) => {
      if (!(data instanceof ArrayBuffer)) {
        this.#handleFrameChannelControl(data);
        return;
      }
      if (data.byteLength < 4) return;
      const view = new DataView(data);
      if (view.getUint32(0, true) !== FRAME_MAGIC) {
        try {
          this.#handleFrameChannelControl(JSON.parse(new TextDecoder().decode(data)) as unknown);
        } catch {
          console.warn("[terminal-runtime] frame channel received an invalid control packet");
        }
        return;
      }
      if (data.byteLength < 16) {
        this.#returnFrameCredit(data.byteLength);
        return;
      }
      const sessionHandle = view.getBigUint64(8, true).toString();
      // A frame can already be queued in the bridge when its session is
      // terminated. Do not recreate worker state for a session we deliberately
      // dropped, and do not render sessions owned only by automation clients.
      if (!this.#sessionByHandle.has(sessionHandle) || !this.#subscribedSessionHandles.has(sessionHandle)) {
        this.#returnFrameCredit(data.byteLength);
        return;
      }
      const tracking = (view.getUint16(6, true) & FrameFlag.MouseTracking) !== 0;
      if (this.#mouseTrackingByHandle.get(sessionHandle) !== tracking) {
        this.#mouseTrackingByHandle.set(sessionHandle, tracking);
        this.dispatchEvent(new CustomEvent("terminal-modes", { detail: { sessionHandle, mouseTracking: tracking } }));
      }
      this.#scheduleMetadataRefresh(sessionHandle);
      this.#postWorker({ type: "frame", packet: data }, [data]);
    };
    this.#frames.start();
    const hello = await this.#control.request({
      type: "hello",
      protocolMajor: PROTOCOL_MAJOR,
      protocolMinor: PROTOCOL_MINOR,
      clientBuild: this.#clientBuild,
    });
    if (hello.type !== "hello" || hello.protocolMajor !== PROTOCOL_MAJOR)
      throw new Error("ghosttead protocol mismatch");
    this.#serverProtocolMinor = hello.protocolMinor;
    this.#frameSubscriptionAcksSupported = hello.protocolMinor >= FRAME_SUBSCRIPTION_ACK_PROTOCOL_MINOR;
    this.#configProtocolSupported = hello.protocolMinor >= CONFIG_PROTOCOL_MINOR;
    this.#remoteLifecycleSupported = hello.protocolMinor >= REMOTE_LIFECYCLE_PROTOCOL_MINOR;
    this.#controlRevisionCasSupported = hello.protocolMinor >= CONTROL_REVISION_CAS_PROTOCOL_MINOR;
    this.#ownerAwareAttachmentSupported = hello.protocolMinor >= SESSION_OWNER_TRANSFER_PROTOCOL_MINOR;
    if (this.#configProtocolSupported && hello.configRevision !== undefined) {
      await this.#refreshConfig();
    }
    await this.#queueFrameSubscriptionSync();
    console.info("[terminal-runtime] authenticated ghosttead protocol");
  }

  get configSnapshot(): ConfigSnapshot | undefined {
    return this.#configSnapshot;
  }

  async getConfig(): Promise<ConfigSnapshot | undefined> {
    await this.connect();
    return this.#configSnapshot;
  }

  async reloadConfig(): Promise<ConfigSnapshot> {
    await this.connect();
    if (this.#routedHost) throw new Error("Configuration reload is not part of the routed host contract");
    const response = await this.#control!.request({ type: "reload-config" });
    if (response.type !== "config") throw new Error("ghosttead returned an unexpected configuration response");
    this.#installConfig(response.config);
    return response.config;
  }

  #installConfig(config: ConfigSnapshot): void {
    if (this.#configSnapshot?.revision === config.revision) return;
    this.#configSnapshot = config;
    this.dispatchEvent(new CustomEvent("config-changed", { detail: config }));
  }

  async #refreshConfig(): Promise<void> {
    if (!this.#configProtocolSupported || !this.#control) return;
    const response = await this.#control.request({ type: "get-config" });
    if (response.type !== "config") throw new Error("ghosttead returned an unexpected configuration response");
    this.#installConfig(response.config);
  }

  #handleFrameChannelControl(message: unknown): boolean {
    if (!message || typeof message !== "object") return false;
    const data = message as {
      type?: unknown;
      requestId?: unknown;
      protocolVersion?: unknown;
      frameCredits?: unknown;
      sessionHandles?: unknown;
    };
    if (data.type === "subscription-ack" && Number.isSafeInteger(data.requestId) && Number(data.requestId) >= 0) {
      const pending = this.#frameSubscriptionRequests.get(Number(data.requestId));
      if (!pending) return true;
      window.clearTimeout(pending.timer);
      this.#frameSubscriptionRequests.delete(Number(data.requestId));
      pending.resolve();
      return true;
    }
    if (
      data.type === "bridge-capabilities" &&
      data.requestId === this.#frameBridgeCapabilityProbeRequestId &&
      data.protocolVersion === FRAME_BRIDGE_CAPABILITY_VERSION &&
      data.frameCredits === true
    ) {
      this.#frameFlowControlEnabled = true;
      return true;
    }
    if (data.type !== "frame-gap") return false;
    const reportedHandles = Array.isArray(data.sessionHandles)
      ? data.sessionHandles.filter(
          (handle): handle is string =>
            typeof handle === "string" &&
            this.#subscribedSessionHandles.has(handle) &&
            this.#sessionByHandle.has(handle),
        )
      : [...this.#subscribedSessionHandles].filter((handle) => this.#sessionByHandle.has(handle));
    const sessionHandles = [...new Set(reportedHandles)];
    sessionHandles.sort(
      (left, right) =>
        Number((this.#sessionMountReferences.get(right) ?? 0) > 0) -
        Number((this.#sessionMountReferences.get(left) ?? 0) > 0),
    );
    if (sessionHandles.length > 0) this.#postWorker({ type: "frame-gap", sessionHandles });
    return true;
  }

  #returnFrameCredit(bytes: number): void {
    if (this.#frameFlowControlEnabled) this.#frames?.postMessage({ type: "frame-credit", bytes });
  }

  #bumpSessionGeneration(sessionHandle: string): number {
    this.#sessionGeneration += 1;
    this.#sessionGenerationByHandle.set(sessionHandle, this.#sessionGeneration);
    return this.#sessionGeneration;
  }

  #applySessionExited(detail: Extract<ServerEvent, { type: "session-exited" }>): void {
    const handle = this.#handleBySessionId.get(detail.sessionId);
    const session = handle ? this.#sessionByHandle.get(handle) : undefined;
    if (!handle || !session) return;
    this.#cancelMetadataRefresh(handle);
    const exited = {
      ...session,
      exited: true,
      exitCode: detail.exitCode,
      exitSignal: detail.exitSignal,
      requestedTermination: detail.requestedTermination,
      exitOutcome: detail.exitOutcome,
    };
    this.#sessionByHandle.set(handle, exited);
    this.#bumpSessionGeneration(handle);
    this.dispatchEvent(new CustomEvent("session-metadata", { detail: exited }));
    this.dispatchEvent(new CustomEvent("session-exited", { detail }));
  }

  #applySessionActivity(detail: Extract<ServerEvent, { type: "session-activity-changed" }>): void {
    const handle = this.#handleBySessionId.get(detail.sessionId);
    const session = handle ? this.#sessionByHandle.get(handle) : undefined;
    if (!handle || !session || session.exited) return;
    const updated = { ...session, activity: detail.activity };
    this.#sessionByHandle.set(handle, updated);
    this.#bumpSessionGeneration(handle);
    this.dispatchEvent(new CustomEvent("session-activity", { detail }));
    this.dispatchEvent(new CustomEvent("session-metadata", { detail: updated }));
  }

  #applyRoutedSessionSummary(sessionHandle: string, next: SessionSummary, expectedGeneration?: number): boolean {
    const previous = this.#sessionByHandle.get(sessionHandle);
    if (
      !previous ||
      previous.exited ||
      previous.id !== next.id ||
      next.handle !== sessionHandle ||
      this.#handleBySessionId.get(next.id) !== sessionHandle ||
      (expectedGeneration !== undefined && this.#sessionGenerationByHandle.get(sessionHandle) !== expectedGeneration)
    ) {
      return false;
    }
    this.#sessionByHandle.set(sessionHandle, next);
    this.#bumpSessionGeneration(sessionHandle);
    if (
      previous.title !== next.title ||
      previous.cwd !== next.cwd ||
      previous.exited !== next.exited ||
      !sameSessionActivity(previous.activity, next.activity)
    ) {
      this.dispatchEvent(new CustomEvent("session-metadata", { detail: next }));
    }
    return true;
  }

  #scheduleMetadataRefresh(sessionHandle: string): void {
    const scheduledSession = this.#sessionByHandle.get(sessionHandle);
    if (!scheduledSession || scheduledSession.exited) return;
    if (this.#routedHost?.getSession && this.#metadataRefreshes.has(sessionHandle)) {
      this.#metadataRefreshPending.add(sessionHandle);
      return;
    }
    if (this.#metadataTimers.has(sessionHandle)) return;
    const timer = window.setTimeout(() => {
      this.#metadataTimers.delete(sessionHandle);
      const session = this.#sessionByHandle.get(sessionHandle);
      if (!session || session.exited) return;
      if (this.#control) {
        void this.#control
          .request({ type: "get-session", sessionId: session.id })
          .then((response) => {
            if (response.type !== "session") return;
            const previous = this.#sessionByHandle.get(sessionHandle);
            if (!previous || previous.id !== response.session.id || previous.exited) return;
            this.#sessionByHandle.set(sessionHandle, response.session);
            if (
              previous.title !== response.session.title ||
              previous.cwd !== response.session.cwd ||
              previous.exited !== response.session.exited ||
              !sameSessionActivity(previous.activity, response.session.activity)
            ) {
              this.dispatchEvent(new CustomEvent("session-metadata", { detail: response.session }));
            }
          })
          .catch((error) => {
            const current = this.#sessionByHandle.get(sessionHandle);
            if (!current || current.exited || this.#disposed) return;
            console.warn("[terminal-runtime] session metadata refresh failed", error);
          });
        return;
      }
      if (this.#routedHost?.getSession) this.#startRoutedMetadataRefresh(sessionHandle, session);
    }, 200);
    this.#metadataTimers.set(sessionHandle, timer);
  }

  #startRoutedMetadataRefresh(sessionHandle: string, session: SessionSummary): void {
    const host = this.#routedHost;
    const getSession = host?.getSession;
    if (!host || !getSession || this.#disposed) return;
    if (this.#metadataRefreshes.has(sessionHandle)) {
      this.#metadataRefreshPending.add(sessionHandle);
      return;
    }
    const expectedGeneration = this.#sessionGenerationByHandle.get(sessionHandle);
    const refresh = Promise.resolve()
      .then(() => getSession.call(host, session.id))
      .then((next) => {
        if (next === null) return;
        this.#applyRoutedSessionSummary(sessionHandle, next, expectedGeneration);
      })
      .catch((error) => {
        const current = this.#sessionByHandle.get(sessionHandle);
        if (!current || current.exited || this.#disposed) return;
        console.warn("[terminal-runtime] session metadata refresh failed", error);
      })
      .finally(() => {
        if (this.#metadataRefreshes.get(sessionHandle) !== refresh) return;
        this.#metadataRefreshes.delete(sessionHandle);
        if (!this.#metadataRefreshPending.delete(sessionHandle) || this.#disposed) return;
        const current = this.#sessionByHandle.get(sessionHandle);
        if (current && !current.exited) this.#scheduleMetadataRefresh(sessionHandle);
      });
    this.#metadataRefreshes.set(sessionHandle, refresh);
  }

  #cancelMetadataRefresh(sessionHandle: string): void {
    const timer = this.#metadataTimers.get(sessionHandle);
    if (timer !== undefined) window.clearTimeout(timer);
    this.#metadataTimers.delete(sessionHandle);
    this.#metadataRefreshPending.delete(sessionHandle);
  }

  sessionMetadata(sessionHandle: string): SessionSummary | undefined {
    return this.#sessionByHandle.get(sessionHandle);
  }

  registerSession(session: SessionSummary): void {
    const previous = this.#sessionByHandle.get(session.handle);
    if (!previous || previous.id !== session.id || !previous.exited || !session.exited) {
      this.#appliedRoutedExitEvents.delete(session.handle);
    }
    this.#sessionByHandle.set(session.handle, session);
    this.#handleBySessionId.set(session.id, session.handle);
    this.#bumpSessionGeneration(session.handle);
  }

  applySessionEvent(event: RoutedSessionEvent): void {
    if (this.#disposed) return;
    if (event.type === "updated") {
      const handle = this.#handleBySessionId.get(event.session.id);
      if (handle) this.#applyRoutedSessionSummary(handle, event.session);
      return;
    }
    if (event.type === "activity-changed") {
      this.#applySessionActivity({
        requestId: 0,
        type: "session-activity-changed",
        sessionId: event.sessionId,
        activity: event.activity,
      });
      return;
    }
    if (event.type === "exited") {
      const handle = this.#handleBySessionId.get(event.sessionId);
      const current = handle ? this.#sessionByHandle.get(handle) : undefined;
      if (!handle || !current || this.#appliedRoutedExitEvents.has(handle)) return;
      this.#appliedRoutedExitEvents.add(handle);
      this.#applySessionExited({
        requestId: 0,
        type: "session-exited",
        sessionId: event.sessionId,
        exitCode: event.exitCode,
        exitSignal: event.exitSignal,
        requestedTermination: event.requestedTermination,
        exitOutcome: event.exitOutcome,
      });
      return;
    }
    this.unregisterSession(event.sessionId);
  }

  #queueFrameSubscriptionSync(): Promise<void> {
    const frames = this.#frames;
    if (!frames) return Promise.resolve();
    if (this.#frameSubscriptionQueuedVersion >= this.#frameSubscriptionVersion) {
      return this.#frameSubscriptionReady;
    }
    const queuedVersion = this.#frameSubscriptionVersion;
    this.#frameSubscriptionQueuedVersion = queuedVersion;
    const requestId = this.#frameSubscriptionRequestId++;
    const sessionHandles = [...this.#subscribedSessionHandles];
    const probesBridge = this.#frameBridgeCapabilityProbeRequestId === undefined;
    if (probesBridge) this.#frameBridgeCapabilityProbeRequestId = requestId;
    const subscription = {
      type: "subscribe",
      requestId,
      sessionHandles,
      ...(probesBridge ? { bridgeCapabilities: FRAME_BRIDGE_CAPABILITY_VERSION } : {}),
      ...(this.#frameFlowControlEnabled ? { frameCredits: true } : {}),
    };
    const previous = this.#frameSubscriptionReady;
    const operation = previous
      .catch(() => undefined)
      .then(() => this.#sendFrameSubscription(frames, subscription, probesBridge));
    this.#frameSubscriptionReady = operation;
    void operation.catch(() => {
      if (this.#frameSubscriptionReady === operation) {
        this.#frameSubscriptionQueuedVersion = Math.min(this.#frameSubscriptionQueuedVersion, queuedVersion - 1);
      }
    });
    return operation;
  }

  #sendFrameSubscription(
    frames: MessagePort,
    subscription: {
      type: string;
      requestId: number;
      sessionHandles: string[];
      bridgeCapabilities?: number;
      frameCredits?: boolean;
    },
    probesBridge: boolean,
  ): Promise<void> {
    if (!this.#frameSubscriptionAcksSupported) {
      try {
        frames.postMessage(subscription);
        return Promise.resolve();
      } catch (error) {
        if (probesBridge && !this.#frameFlowControlEnabled) this.#frameBridgeCapabilityProbeRequestId = undefined;
        return Promise.reject(error);
      }
    }
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        if (!this.#frameSubscriptionRequests.delete(subscription.requestId)) return;
        reject(new Error(`Frame subscription ${subscription.requestId} was not acknowledged`));
      }, FRAME_SUBSCRIPTION_ACK_TIMEOUT_MS);
      this.#frameSubscriptionRequests.set(subscription.requestId, { resolve, reject, timer });
      try {
        frames.postMessage(subscription);
      } catch (error) {
        window.clearTimeout(timer);
        this.#frameSubscriptionRequests.delete(subscription.requestId);
        if (probesBridge && !this.#frameFlowControlEnabled) this.#frameBridgeCapabilityProbeRequestId = undefined;
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  #syncFrameSubscriptionsInBackground(): void {
    void this.connect()
      .then(() => this.#queueFrameSubscriptionSync())
      .catch((error) => {
        if (this.#disposed) return;
        console.error("[terminal-runtime] failed to update frame subscriptions", error);
        this.dispatchEvent(new CustomEvent("frame-subscription-error", { detail: { error } }));
      });
  }

  #retainFrameSubscription(sessionHandle: string): { ready: Promise<void>; added: boolean } {
    const releaseTimer = this.#sessionReleaseTimers.get(sessionHandle);
    if (releaseTimer !== undefined) {
      window.clearTimeout(releaseTimer);
      this.#sessionReleaseTimers.delete(sessionHandle);
    }
    this.#sessionMountReferences.set(sessionHandle, (this.#sessionMountReferences.get(sessionHandle) ?? 0) + 1);
    const added = !this.#subscribedSessionHandles.has(sessionHandle);
    if (added) {
      this.#subscribedSessionHandles.add(sessionHandle);
      this.#frameSubscriptionVersion += 1;
    }
    return {
      added,
      ready: this.connect().then(() => this.#queueFrameSubscriptionSync()),
    };
  }

  #expectFullSnapshot(sessionHandle: string): void {
    if (
      this.#disposed ||
      !this.#subscribedSessionHandles.has(sessionHandle) ||
      !this.#sessionByHandle.has(sessionHandle)
    )
      return;
    this.#postWorker({ type: "expect-full", sessionHandle });
    this.#resync.request(sessionHandle);
  }

  #scheduleFrameSubscriptionRelease(sessionHandle: string): void {
    if (
      (this.#sessionMountReferences.get(sessionHandle) ?? 0) > 0 ||
      this.#pinnedSessionHandles.has(sessionHandle) ||
      !this.#subscribedSessionHandles.has(sessionHandle) ||
      this.#sessionReleaseTimers.has(sessionHandle)
    )
      return;
    const timer = window.setTimeout(() => {
      this.#sessionReleaseTimers.delete(sessionHandle);
      if ((this.#sessionMountReferences.get(sessionHandle) ?? 0) > 0 || this.#pinnedSessionHandles.has(sessionHandle))
        return;
      if (this.#subscribedSessionHandles.delete(sessionHandle)) {
        this.#frameSubscriptionVersion += 1;
        this.#syncFrameSubscriptionsInBackground();
      }
      this.#resync.cancel(sessionHandle);
      this.#postWorker({ type: "drop-session", sessionHandle });
    }, this.#frameSubscriptionGraceMs);
    this.#sessionReleaseTimers.set(sessionHandle, timer);
  }

  #releaseFrameSubscription(sessionHandle: string): void {
    const references = Math.max(0, (this.#sessionMountReferences.get(sessionHandle) ?? 0) - 1);
    if (references === 0) this.#sessionMountReferences.delete(sessionHandle);
    else this.#sessionMountReferences.set(sessionHandle, references);
    this.#scheduleFrameSubscriptionRelease(sessionHandle);
  }

  setSessionPinned(sessionHandle: string, pinned: boolean): void {
    if (pinned) {
      if (!this.#sessionByHandle.has(sessionHandle)) {
        throw new Error(`Cannot pin unknown terminal session ${sessionHandle}`);
      }
      if (this.#pinnedSessionHandles.has(sessionHandle)) return;
      this.#pinnedSessionHandles.add(sessionHandle);
      const releaseTimer = this.#sessionReleaseTimers.get(sessionHandle);
      if (releaseTimer !== undefined) {
        window.clearTimeout(releaseTimer);
        this.#sessionReleaseTimers.delete(sessionHandle);
      }
      if (!this.#subscribedSessionHandles.has(sessionHandle)) {
        this.#subscribedSessionHandles.add(sessionHandle);
        this.#frameSubscriptionVersion += 1;
        void this.connect()
          .then(() => this.#queueFrameSubscriptionSync())
          .then(() => this.#expectFullSnapshot(sessionHandle))
          .catch((error) => {
            if (!this.#disposed)
              console.error(`[terminal-runtime] failed to pin frame subscription ${sessionHandle}`, error);
          });
      }
    } else {
      if (!this.#pinnedSessionHandles.delete(sessionHandle)) return;
      this.#scheduleFrameSubscriptionRelease(sessionHandle);
    }
  }

  async createSession(options: CreateSessionOptions): Promise<SessionSummary> {
    await this.connect();
    if (this.#routedHost) {
      if (!this.#routedHost.createSession) throw new Error("The routed host does not provide session creation");
      const session = await this.#routedHost.createSession(options);
      this.registerSession(session);
      return session;
    }
    if (options.scrollbackBytes !== undefined) {
      if (!isValidScrollbackBytes(options.scrollbackBytes)) {
        throw new RangeError("scrollbackBytes must be a non-negative safe integer");
      }
      if (this.#serverProtocolMinor < SESSION_SCROLLBACK_PROTOCOL_MINOR) {
        throw new Error(
          `ghosttead does not support per-session scrollback limits (requires protocol 1.${SESSION_SCROLLBACK_PROTOCOL_MINOR}, server is 1.${this.#serverProtocolMinor})`,
        );
      }
    }
    const response = await this.#control!.request({
      type: "create-session",
      options: { ...options, ...(this.#sessionOwnerId ? { ownerId: this.#sessionOwnerId } : {}) },
    });
    if (response.type !== "session-created") throw new Error("ghosttead returned an unexpected response");
    this.registerSession(response.session);
    console.info(`[terminal-runtime] created session ${response.session.id}`);
    return response.session;
  }

  async listSessions(): Promise<SessionSummary[]> {
    await this.connect();
    if (this.#routedHost) {
      const sessions = this.#routedHost.listSessions
        ? await this.#routedHost.listSessions()
        : [...this.#sessionByHandle.values()];
      for (const session of sessions) this.registerSession(session);
      return sessions;
    }
    const response = await this.#control!.request({ type: "list-sessions" });
    if (response.type !== "sessions") throw new Error("ghosttead returned an unexpected response");
    for (const session of response.sessions) {
      this.registerSession(session);
    }
    return response.sessions;
  }

  /**
   * Reconcile tracked sessions against the daemon's authoritative list after
   * an events-lost notice. A session still listed but now exited had its exit
   * event lost; a session absent from the list entirely exited and left the
   * registry, so its exit details are gone and are reported as unknown.
   */
  async #resyncAfterLostEvents(): Promise<void> {
    try {
      const before = new Map<string, SessionSummary>();
      for (const session of this.#sessionByHandle.values()) {
        before.set(session.id, session);
      }
      const [sessions] = await Promise.all([
        this.listSessions(),
        this.#refreshConfig(),
        this.#reconcileRemoteSessions(),
      ]);
      const known = new Set<string>();
      for (const session of sessions) {
        known.add(session.id);
        const previous = before.get(session.id);
        if (!previous || previous.exited || !session.exited) continue;
        this.#cancelMetadataRefresh(session.handle);
        this.dispatchEvent(new CustomEvent("session-metadata", { detail: session }));
        this.dispatchEvent(
          new CustomEvent("session-exited", {
            detail: {
              requestId: 0,
              type: "session-exited",
              sessionId: session.id,
              exitCode: session.exitCode,
              exitSignal: session.exitSignal,
              requestedTermination: session.requestedTermination,
              exitOutcome: session.exitOutcome ?? "unknown",
            } satisfies Extract<ServerEvent, { type: "session-exited" }>,
          }),
        );
      }
      for (const [handle, session] of this.#sessionByHandle) {
        if (session.exited || known.has(session.id)) continue;
        const detail = {
          requestId: 0,
          type: "session-exited",
          sessionId: session.id,
          exitCode: null,
          exitSignal: null,
          requestedTermination: null,
          exitOutcome: "unknown",
        } satisfies Extract<ServerEvent, { type: "session-exited" }>;
        this.#cancelMetadataRefresh(handle);
        const exited = {
          ...session,
          exited: true,
          exitCode: null,
          exitSignal: null,
          requestedTermination: null,
          exitOutcome: "unknown" as const,
        };
        this.#sessionByHandle.set(handle, exited);
        this.dispatchEvent(new CustomEvent("session-metadata", { detail: exited }));
        this.dispatchEvent(new CustomEvent("session-exited", { detail }));
      }
    } catch (error) {
      if (!this.#disposed) console.error("[terminal-runtime] failed to resynchronize state after lost events", error);
    }
  }

  async listRemoteHosts(): Promise<RemoteHostSummary[]> {
    await this.connect();
    if (this.#routedHost) throw new Error("Remote-host discovery is not part of the routed host contract");
    const response = await this.#control!.request({ type: "list-remote-hosts" });
    if (response.type !== "remote-hosts") throw new Error("ghosttead returned an unexpected response");
    return response.hosts;
  }

  async listRemoteSessions(deviceId: string): Promise<SharedSessionSummary[]> {
    await this.connect();
    if (this.#routedHost) throw new Error("Remote-session discovery is not part of the routed host contract");
    const response = await this.#control!.request({ type: "list-remote-sessions", deviceId }, 35_000);
    if (response.type !== "remote-sessions" || response.deviceId !== deviceId)
      throw new Error("ghosttead returned an unexpected response");
    return response.sessions;
  }

  async openRemoteSession(
    deviceId: string,
    remoteSessionId: string,
    cols: number,
    rows: number,
    deviceName = deviceId,
  ): Promise<SessionSummary> {
    await this.connect();
    if (this.#routedHost) throw new Error("Remote-session opening is not part of the routed host contract");
    const response = await this.#control!.request({
      type: "open-remote-session",
      deviceId,
      remoteSessionId,
      cols,
      rows,
      ...(this.#sessionOwnerId ? { ownerId: this.#sessionOwnerId } : {}),
    });
    if (response.type !== "session-created") throw new Error("ghosttead could not open the remote session");
    this.registerSession(response.session);
    // The session counts as remote from here, before any daemon event, so its
    // input is never queued. A daemon on this minor reports `opening` until
    // the first snapshot lands, so start there and let its events take over;
    // an older daemon reports nothing at all, and seeding `opening` against it
    // would block input forever. The sequence below is under every real event.
    this.#remoteSessions.set(response.session.id, {
      sessionId: response.session.id,
      state: this.#remoteLifecycleSupported ? "opening" : "live",
      reason: null,
      exit: null,
      lifecycleSeq: -1,
      deviceId,
      deviceName,
      attempt: null,
      nextRetryMs: null,
      lastContactMs: null,
      observedAt: performance.now(),
      awaitingRecoveryFrame: false,
    });
    return response.session;
  }

  async #refreshSession(sessionHandle: string): Promise<void> {
    const session = this.#sessionByHandle.get(sessionHandle);
    if (!session) return;
    if (!this.#control) throw new Error(`Session ${sessionHandle} is not ready for frame resynchronization`);
    // A refresh of a remote session re-attaches and resynchronizes over the
    // network, so it needs the same budget as a one-shot reconnect.
    const response = await this.#control.request(
      { type: "refresh-session", sessionId: session.id },
      RECONNECT_REQUEST_TIMEOUT_MS,
    );
    if (response.type !== "ok") throw new Error("ghosttead rejected frame resynchronization");
  }

  mount(sessionId: string, sessionHandle: string, viewId: string, canvas: HTMLCanvasElement): TerminalMount {
    if (this.#disposed) throw new Error("Cannot mount a disposed terminal runtime");
    if (this.#routedHost) return this.#mountRouted(sessionId, sessionHandle, viewId, canvas);
    const mounted = this.#mountedCanvases.get(canvas);
    if (mounted) {
      if (!mounted.active) throw new Error("A released terminal canvas cannot be remounted");
      if (mounted.sessionHandle !== sessionHandle) {
        throw new Error("A terminal canvas cannot be reassigned to another session");
      }
      mounted.references += 1;
      if (mounted.disposeTimer !== undefined) {
        window.clearTimeout(mounted.disposeTimer);
        mounted.disposeTimer = undefined;
      }
      return this.#createMountLease(mounted);
    }

    const offscreen = canvas.transferControlToOffscreen();
    const subscription = this.#retainFrameSubscription(sessionHandle);
    const generation = (this.#mountGenerationBySurface.get(viewId) ?? 0) + 1;
    this.#mountGenerationBySurface.set(viewId, generation);
    this.#postWorker({ type: "mount", surfaceId: viewId, sessionHandle, canvas: offscreen }, [offscreen]);
    const entry: MountedCanvas = {
      canvas,
      sessionHandle,
      sessionId,
      viewId,
      generation,
      references: 1,
      disposeTimer: undefined,
      active: true,
    };
    this.#mountedCanvases.set(canvas, entry);
    this.#mountedEntries.add(entry);
    const view: ViewRuntimeState = {
      sessionId,
      sessionHandle,
      clientReadWrite: true,
      resizeControlRequested: false,
      visible: true,
      inputSequence: 0,
      resizeSequence: 0,
      controlEpoch: undefined,
      desiredCols: undefined,
      desiredRows: undefined,
      pendingInput: [],
      lastViewStateSeq: undefined,
      lastAttachmentEpoch: undefined,
      claimedEpoch: undefined,
      claimedRevision: 0,
    };
    this.#views.set(viewId, view);
    const remote = this.#remoteSessions.get(sessionId);
    if (remote && remote.state !== "live") this.#setCursorFrozen(sessionId, true);
    void subscription.ready
      .then(() => {
        const current = this.#views.get(viewId);
        if (current !== view || !entry.active) return undefined;
        if (subscription.added) this.#expectFullSnapshot(sessionHandle);
        return this.#control?.request(
          {
            type: "attach-session",
            sessionId,
            viewId,
            ...(this.#ownerAwareAttachmentSupported && this.#sessionOwnerId ? { ownerId: this.#sessionOwnerId } : {}),
          },
          60_000,
        );
      })
      .then((response) => {
        if (!response) return;
        if (response.type !== "view-attached" || response.viewId !== viewId) {
          throw new Error("ghosttead returned an invalid view attachment");
        }
        const current = this.#views.get(viewId);
        if (current !== view) return;
        const applied = this.#applyViewState(viewId, {
          ...(response.viewStateSeq !== undefined ? { viewStateSeq: response.viewStateSeq } : {}),
          viewState: "attached",
          attachmentEpoch: response.attachmentEpoch,
          readWrite: response.readWrite,
          error: null,
          retryable: null,
        });
        if (!applied) return;
        this.dispatchEvent(
          new CustomEvent("view-attached", {
            detail: { sessionId, sessionHandle, viewId, readWrite: response.readWrite },
          }),
        );
        const previous = this.#sessionByHandle.get(sessionHandle);
        if (previous && previous.readWrite !== response.readWrite) {
          const updated = { ...previous, readWrite: response.readWrite };
          this.#sessionByHandle.set(sessionHandle, updated);
          this.dispatchEvent(new CustomEvent("session-metadata", { detail: updated }));
        }
        const pending = current.pendingInput.splice(0);
        if (!response.readWrite) return;
        for (const operation of pending) {
          current.inputSequence += 1;
          operation(response.attachmentEpoch, current.inputSequence);
        }
      })
      .catch((error) => console.error(`[terminal-runtime] failed to attach view ${viewId}`, error));
    return this.#createMountLease(entry);
  }

  #mountRouted(sessionId: string, sessionHandle: string, viewId: string, canvas: HTMLCanvasElement): TerminalMount {
    const mounted = this.#mountedCanvases.get(canvas);
    if (mounted) {
      if (!mounted.active) throw new Error("A released terminal canvas cannot be remounted");
      if (mounted.sessionHandle !== sessionHandle) {
        throw new Error("A terminal canvas cannot be reassigned to another session");
      }
      mounted.references += 1;
      if (mounted.disposeTimer !== undefined) {
        window.clearTimeout(mounted.disposeTimer);
        mounted.disposeTimer = undefined;
      }
      return this.#createMountLease(mounted);
    }
    const offscreen = canvas.transferControlToOffscreen();
    const generation = (this.#mountGenerationBySurface.get(viewId) ?? 0) + 1;
    this.#mountGenerationBySurface.set(viewId, generation);
    this.#postWorker({ type: "mount", surfaceId: viewId, sessionHandle, canvas: offscreen }, [offscreen]);
    const entry: MountedCanvas = {
      canvas,
      sessionHandle,
      sessionId,
      viewId,
      generation,
      references: 1,
      disposeTimer: undefined,
      active: true,
    };
    this.#mountedCanvases.set(canvas, entry);
    this.#mountedEntries.add(entry);
    const session = this.#sessionByHandle.get(sessionHandle);
    this.#views.set(viewId, {
      sessionId,
      sessionHandle,
      ...(session === undefined ? {} : { readWrite: session.readWrite }),
      clientReadWrite: true,
      resizeControlRequested: false,
      visible: true,
      inputSequence: 0,
      resizeSequence: 0,
      controlEpoch: undefined,
      desiredCols: undefined,
      desiredRows: undefined,
      pendingInput: [],
      lastViewStateSeq: undefined,
      lastAttachmentEpoch: undefined,
      claimedEpoch: undefined,
      claimedRevision: 0,
    });
    const activation = this.#routedBySession.get(sessionId);
    if (activation) activation.viewIds.add(viewId);
    void this.#ensureRoutedActivation(sessionId, sessionHandle, viewId).catch((error: unknown) => {
      if (!this.#disposed) console.error(`[terminal-runtime] routed activation failed for ${sessionId}`, error);
    });
    return this.#createMountLease(entry);
  }

  async #ensureRoutedActivation(sessionId: string, sessionHandle: string, viewId: string): Promise<void> {
    const existing = this.#routedBySession.get(sessionId);
    if (existing) {
      existing.viewIds.add(viewId);
      if (existing.start) await existing.start;
      const anyWritable =
        this.#routedHost?.encodeInput !== undefined &&
        [...existing.viewIds].some((candidate) => {
          const view = this.#views.get(candidate);
          return view?.clientReadWrite === true && view.readWrite !== false;
        });
      this.#transitionRouted(existing, { type: "input-policy", policy: anyWritable ? "read-write" : "read-only" });
      this.#declareRoutedDemand(existing);
      return;
    }
    const activationId = crypto.randomUUID();
    const inputPolicy =
      this.#routedHost?.encodeInput !== undefined &&
      this.#views.get(viewId)?.clientReadWrite !== false &&
      this.#views.get(viewId)?.readWrite !== false
        ? "read-write"
        : "read-only";
    const entry: RoutedActivationRuntime = {
      sessionId,
      sessionHandle,
      state: initialRoutedActivation(sessionId, activationId, inputPolicy),
      viewIds: new Set([viewId]),
      recoveryAttempts: 0,
      preAuthRemints: { control: 0, frames: 0 },
      protocolFailures: { control: 0, frames: 0 },
    };
    this.#routedBySession.set(sessionId, entry);
    this.#routedByActivation.set(activationId, entry);
    entry.start = this.#startRoutedActivation(entry, "mount");
    try {
      await entry.start;
    } finally {
      delete entry.start;
    }
  }

  #routedTicketMatches(entry: RoutedActivationRuntime, ticket: unknown): ticket is RoutedTerminalOpenTicket {
    return (
      isRoutedTerminalOpenTicket(ticket) &&
      ticket.route.cellBootId === ticket.transportGrant.claims.audienceCellBootId &&
      ticket.route.cellBootId === ticket.attachGrant.claims.audienceCellBootId &&
      ticket.route.cellBootId === ticket.transportGrant.protected.kid.cellBootId &&
      ticket.route.cellBootId === ticket.attachGrant.protected.kid.cellBootId &&
      ticket.transportGrant.claims.clientId === ticket.attachGrant.claims.clientId &&
      ticket.transportGrant.claims.allowedChannels.includes("control") &&
      ticket.transportGrant.claims.allowedChannels.includes("frames") &&
      ticket.attachGrant.claims.sessionId === entry.sessionId &&
      ticket.attachGrant.claims.routeRevision === ticket.route.routeRevision &&
      (ticket.route.leaseEpoch === undefined ||
        ticket.attachGrant.claims.leaseEpoch === undefined ||
        ticket.route.leaseEpoch === ticket.attachGrant.claims.leaseEpoch)
    );
  }

  #routedRenewalMatches(
    entry: RoutedActivationRuntime,
    value: unknown,
    previousGeneration: number,
  ): value is RoutedSessionAttachGrant {
    const ticket = entry.ticket;
    return (
      ticket !== undefined &&
      isRoutedSessionAttachGrant(value) &&
      value.protected.kid.cellBootId === ticket.route.cellBootId &&
      value.claims.audienceCellBootId === ticket.route.cellBootId &&
      value.claims.clientId === ticket.attachGrant.claims.clientId &&
      value.claims.sessionId === entry.sessionId &&
      value.claims.routeRevision === ticket.route.routeRevision &&
      value.claims.leaseEpoch === ticket.attachGrant.claims.leaseEpoch &&
      value.claims.grantGeneration > previousGeneration
    );
  }

  async #startRoutedActivation(
    entry: RoutedActivationRuntime,
    reason: "mount" | "retry" | "route-stale" | "pre-auth",
  ): Promise<void> {
    const host = this.#routedHost;
    if (!host || this.#disposed || entry.viewIds.size === 0) return;
    let ticket: RoutedTerminalOpenTicket;
    try {
      ticket = await host.openTicket(entry.sessionId, { reason });
    } catch (error) {
      this.#transitionRouted(entry, { type: "no-route", reason: String(error) });
      return;
    }
    if (this.#routedBySession.get(entry.sessionId) !== entry || this.#disposed) return;
    if (!this.#routedTicketMatches(entry, ticket)) {
      this.#transitionRouted(entry, { type: "no-route", reason: "ticket-binding-mismatch" });
      return;
    }
    this.#transitionRouted(entry, { type: "ticket-minted", endpointsPresent: ticket.endpoints !== undefined });
    if (!ticket.endpoints) return;
    entry.ticket = ticket;
    this.#transitionRouted(entry, { type: "transport-ready" });
    this.#routedControl!.attach({
      cellBootId: ticket.route.cellBootId,
      controlUrl: ticket.endpoints.controlUrl,
      transportGrant: ticket.transportGrant,
      attachGrant: ticket.attachGrant,
      activationId: entry.state.activationId,
      ...(entry.replacesActivationId === undefined ? {} : { replacesActivationId: entry.replacesActivationId }),
      initialDemand: this.#routedDemand(entry),
      capabilities: this.#routedCapabilities,
    });
    this.#postWorker({
      type: "routed-frames-attach",
      request: {
        cellBootId: ticket.route.cellBootId,
        sessionHandle: entry.sessionHandle,
        framesUrl: ticket.endpoints.framesUrl,
        transportGrant: ticket.transportGrant,
        attachGrant: ticket.attachGrant,
        activationId: entry.state.activationId,
        ...(entry.replacesActivationId === undefined ? {} : { replacesActivationId: entry.replacesActivationId }),
        ...(this.#routedReceiverCapacities === undefined ? {} : { receiverCapacities: this.#routedReceiverCapacities }),
        capabilities: this.#routedCapabilities,
      },
    });
    this.#armRoutedAttachDeadline(
      entry,
      this.#routedAttachDeadlineByCell.get(ticket.route.cellBootId) ??
        DEFAULT_ROUTED_PROTOCOL_LIMITS.activationAttachDeadlineMs,
    );
    this.#scheduleRoutedRenewal(entry);
  }

  #stopRoutedActivation(entry: RoutedActivationRuntime): void {
    this.#routedControl?.detach(entry.state.activationId);
    this.#postWorker({ type: "routed-frames-detach", activationId: entry.state.activationId });
    if (entry.attachTimer !== undefined) window.clearTimeout(entry.attachTimer);
    delete entry.attachTimer;
    if (entry.renewalTimer !== undefined) window.clearTimeout(entry.renewalTimer);
    delete entry.renewalTimer;
    delete entry.ticket;
  }

  #transitionRouted(entry: RoutedActivationRuntime, event: RoutedActivationEvent): void {
    const previous = entry.state;
    const next = reduceRoutedActivation(previous, event);
    if (next === previous) return;
    entry.state = next;
    if (next.phase !== "attaching" && entry.attachTimer !== undefined) {
      window.clearTimeout(entry.attachTimer);
      delete entry.attachTimer;
    }
    if ((next.phase === "unavailable" || next.phase === "ended") && next.phase !== previous.phase) {
      this.#stopRoutedActivation(entry);
    }
    if (!previous.presentationReady && next.presentationReady) {
      entry.recoveryAttempts = 0;
      entry.protocolFailures.control = 0;
      entry.protocolFailures.frames = 0;
    }
    this.dispatchEvent(
      new CustomEvent("routed-activation-state", {
        detail: { sessionId: entry.sessionId, previous, current: next },
      }),
    );
    if (previous.presentationReady !== next.presentationReady || previous.inputAllowed !== next.inputAllowed) {
      for (const viewId of entry.viewIds) {
        const view = this.#views.get(viewId);
        this.dispatchEvent(
          new CustomEvent("routed-view-readiness", {
            detail: {
              sessionId: entry.sessionId,
              viewId,
              presentationReady: next.presentationReady,
              inputAllowed: next.inputAllowed && view?.clientReadWrite === true && view.readWrite !== false,
              phase: next.phase,
            },
          }),
        );
      }
    }
  }

  #handleRoutedControlEvent(event: RoutedControlTransportEvent): void {
    if (this.#disposed) return;
    if (event.type === "extension-message") {
      const host = this.#routedHost;
      if (!host?.onExtensionMessage) return;
      try {
        host.onExtensionMessage(event.message, event.context);
      } catch (error) {
        console.error("[terminal-runtime] routed extension handler failed", error);
      }
      return;
    }
    if (event.type === "transport-ready") {
      const deadline = event.accepted.protocolLimits.activationAttachDeadlineMs;
      this.#routedAttachDeadlineByCell.set(event.cellBootId, deadline);
      for (const entry of this.#routedBySession.values()) {
        if (entry.ticket?.route.cellBootId === event.cellBootId && entry.state.phase === "attaching") {
          this.#armRoutedAttachDeadline(entry, deadline);
        }
      }
      return;
    }
    if (event.type === "control-attached") {
      const entry = this.#routedByActivation.get(event.attached.activationId);
      if (!entry || event.attached.sessionId !== entry.sessionId) return;
      entry.preAuthRemints.control = 0;
      this.#transitionRouted(entry, {
        type: "control-attached",
        grantGeneration: event.attached.grantGenerationAccepted,
        rights: event.attached.rights,
      });
      const previousGeometry = this.#routedGeometry.get(entry.sessionId);
      if (
        !event.attached.rights.includes("geometry") &&
        previousGeometry?.holderViewId !== undefined &&
        entry.viewIds.has(previousGeometry.holderViewId)
      ) {
        // The cell auto-releases a holder when renewal drops the geometry
        // right. Preserve its next CAS revision without retaining authority.
        this.#routedGeometry.set(entry.sessionId, {
          revision: previousGeometry.revision + 1,
          ...(previousGeometry.cols === undefined ? {} : { cols: previousGeometry.cols }),
          ...(previousGeometry.rows === undefined ? {} : { rows: previousGeometry.rows }),
        });
      }
      const geometry = this.#routedGeometry.get(entry.sessionId);
      for (const viewId of entry.viewIds) {
        const view = this.#views.get(viewId);
        if (
          view?.resizeControlRequested &&
          geometry?.holderViewId !== viewId &&
          view.desiredCols !== undefined &&
          view.desiredRows !== undefined
        ) {
          this.#claimRoutedGeometry(entry, viewId, view.desiredCols, view.desiredRows);
        }
      }
      return;
    }
    if (event.type === "attach-refused") {
      const entry = event.activationId ? this.#routedByActivation.get(event.activationId) : undefined;
      if (!entry) return;
      this.#transitionRouted(entry, { type: "attach-refused", code: event.code, retryable: event.retryable });
      if (entry.state.phase === "recovering") {
        this.#recoverRoutedActivation(
          entry,
          event.code === "STALE_ROUTE" || event.code === "FENCED" ? "route-stale" : "retry",
        );
      }
      return;
    }
    if (event.type === "cell-status") {
      const entry = this.#routedByActivation.get(event.status.activationId);
      if (!entry || event.status.sessionId !== entry.sessionId) return;
      this.#transitionRouted(entry, { type: "cell-status", status: event.status, now: performance.now() });
      const sequence = entry.state.lastCellStatusSequence;
      window.setTimeout(() => {
        if (entry.state.lastCellStatusSequence !== sequence) return;
        this.#transitionRouted(entry, { type: "cell-lease-expired" });
      }, event.status.leaseTtlMs);
      if (
        event.status.presentation.state === "revoked" &&
        (event.status.presentation.reason === "leg-dead" || event.status.presentation.reason === "stale-route")
      ) {
        this.#recoverRoutedActivation(
          entry,
          event.status.presentation.reason === "stale-route" ? "route-stale" : "retry",
        );
      }
      return;
    }
    if (event.type === "geometry-committed") {
      const entry = event.activationId ? this.#routedByActivation.get(event.activationId) : undefined;
      if (!entry) return;
      this.#routedGeometry.set(entry.sessionId, {
        holderViewId: event.committed.holder.viewId,
        holderGeneration: event.committed.holder.holderGeneration,
        revision: event.committed.geometryRevision,
        cols: event.committed.cols,
        rows: event.committed.rows,
      });
      this.dispatchEvent(new CustomEvent("routed-geometry", { detail: { sessionId: entry.sessionId, ...event } }));
      return;
    }
    if (event.type === "geometry-refused") {
      const entry = event.activationId ? this.#routedByActivation.get(event.activationId) : undefined;
      if (entry && event.refused.geometryRevision !== undefined) {
        const previous = this.#routedGeometry.get(entry.sessionId);
        const holder = event.refused.currentHolder;
        this.#routedGeometry.set(entry.sessionId, {
          revision: event.refused.geometryRevision,
          ...(holder === undefined ? {} : { holderViewId: holder.viewId, holderGeneration: holder.holderGeneration }),
          ...(previous?.cols === undefined ? {} : { cols: previous.cols }),
          ...(previous?.rows === undefined ? {} : { rows: previous.rows }),
        });
      }
      this.dispatchEvent(new CustomEvent("routed-geometry-refused", { detail: event }));
      return;
    }
    if (event.type === "transport-closed") {
      this.#routedAttachDeadlineByCell.delete(event.cellBootId);
      for (const activationId of event.activationIds) {
        const entry = this.#routedByActivation.get(activationId);
        if (!entry) continue;
        if (event.preAuth || event.refusal) {
          const recoverable = event.refusal ? routedConnectionRefusalIsRecoverable(event.refusal) : true;
          this.#transitionRouted(entry, {
            type: "transport-failed",
            ...(event.preAuth ? { preAuth: true } : {}),
            ...(event.refusal === undefined ? {} : { retryable: recoverable }),
          });
          if (entry.state.phase === "unavailable") continue;
          this.#recoverRoutedActivation(entry, event.preAuth ? "pre-auth" : "retry", "control");
          continue;
        }
        const routeStale = event.code === 4000 || event.code === 4001;
        if (event.code === 4002) {
          this.#transitionRouted(entry, { type: "replaced" });
          continue;
        }
        if (event.code === 4003) {
          if (entry.protocolFailures.control >= 1) {
            this.#transitionRouted(entry, { type: "leg-lost", channel: "control", resumeCapable: false });
            this.#transitionRouted(entry, {
              type: "transport-failed",
              recoveryExhausted: true,
              reason: "protocol",
            });
            this.dispatchEvent(
              new CustomEvent("routed-protocol-error", {
                detail: { sessionId: entry.sessionId, channel: "control", reason: event.reason },
              }),
            );
            continue;
          }
          entry.protocolFailures.control += 1;
        }
        this.#transitionRouted(entry, {
          type: routeStale ? "route-stale" : "leg-lost",
          channel: "control",
          resumeCapable: false,
        });
        this.#recoverRoutedActivation(entry, routeStale ? "route-stale" : "retry", "control");
      }
    }
  }

  #handleRoutedFramesEvent(event: RoutedFramesTransportEvent): void {
    if (event.type === "frames-attached") {
      const entry = this.#routedByActivation.get(event.attached.activationId);
      if (!entry || event.attached.sessionId !== entry.sessionId) return;
      entry.preAuthRemints.frames = 0;
      this.#transitionRouted(entry, {
        type: "frames-attached",
        outcome: event.attached.outcome,
        trfIdentity: event.attached.trfIdentity,
        resumeToken: event.attached.resumeToken,
      });
      return;
    }
    if (event.type === "attach-refused") {
      const entry = event.activationId ? this.#routedByActivation.get(event.activationId) : undefined;
      if (!entry) return;
      this.#transitionRouted(entry, { type: "attach-refused", code: event.code, retryable: event.retryable });
      if (entry.state.phase === "recovering") {
        this.#recoverRoutedActivation(
          entry,
          event.code === "STALE_ROUTE" || event.code === "FENCED" ? "route-stale" : "retry",
          "frames",
        );
      }
      return;
    }
    if (event.type === "frames-state") {
      const entry = this.#routedByActivation.get(event.activationId);
      if (!entry) return;
      this.#transitionRouted(entry, {
        type: "frames-state",
        state: {
          activationId: event.activationId,
          state: event.state,
          ...(event.resumeToken === undefined ? {} : { resumeToken: event.resumeToken }),
          ...(event.appliedContent === undefined ? {} : { appliedContent: event.appliedContent }),
        },
      });
      if (event.state === "active" && event.appliedContent) {
        this.#transitionRouted(entry, { type: "sync-complete", appliedContent: event.appliedContent });
      } else if (event.state === "failed") {
        this.#transitionRouted(entry, { type: "sync-failed" });
      }
      return;
    }
    if (event.type === "presentation-status") {
      const entry = this.#routedByActivation.get(event.status.activationId);
      if (!entry) return;
      this.#transitionRouted(entry, { type: "presentation-status", status: event.status, now: performance.now() });
      const sequence = entry.state.lastWorkerStatusSequence;
      window.setTimeout(() => {
        if (entry.state.lastWorkerStatusSequence !== sequence) return;
        this.#transitionRouted(entry, { type: "worker-lease-expired" });
      }, event.status.leaseTtlMs);
      return;
    }
    for (const activationId of event.activationIds) {
      const entry = this.#routedByActivation.get(activationId);
      if (!entry) continue;
      if (event.preAuth || event.refusal) {
        const recoverable = event.refusal ? routedConnectionRefusalIsRecoverable(event.refusal) : true;
        this.#transitionRouted(entry, {
          type: "transport-failed",
          ...(event.preAuth ? { preAuth: true } : {}),
          ...(event.refusal === undefined ? {} : { retryable: recoverable }),
        });
        if (entry.state.phase === "unavailable") continue;
        this.#resumeRoutedFrames(entry, event.preAuth ? "pre-auth" : "retry");
        continue;
      }
      const routeStale = event.code === 4000 || event.code === 4001;
      if (event.code === 4002) {
        this.#transitionRouted(entry, { type: "replaced" });
        continue;
      }
      if (event.code === 4003) {
        if (entry.protocolFailures.frames >= 1) {
          this.#transitionRouted(entry, { type: "leg-lost", channel: "frames", resumeCapable: false });
          this.#transitionRouted(entry, {
            type: "transport-failed",
            recoveryExhausted: true,
            reason: "protocol",
          });
          this.dispatchEvent(
            new CustomEvent("routed-protocol-error", {
              detail: { sessionId: entry.sessionId, channel: "frames", reason: event.reason },
            }),
          );
          continue;
        }
        entry.protocolFailures.frames += 1;
      }
      const activationFailed = event.code === 4002 || event.code === 4003;
      const canResume =
        !routeStale &&
        !activationFailed &&
        this.#routedCapabilities.includes("resume") &&
        entry.state.resumeToken !== undefined &&
        entry.state.appliedContent !== undefined &&
        entry.ticket?.endpoints !== undefined;
      this.#transitionRouted(entry, {
        type: routeStale ? "route-stale" : "leg-lost",
        channel: "frames",
        resumeCapable: canResume,
      });
      if (canResume) {
        this.#resumeRoutedFrames(entry, "retry");
      } else {
        this.#recoverRoutedActivation(entry, routeStale ? "route-stale" : "retry", "frames");
      }
    }
  }

  #resumeRoutedFrames(entry: RoutedActivationRuntime, reason: "retry" | "pre-auth"): void {
    if (entry.framesResume || this.#disposed) return;
    const task = (async () => {
      const host = this.#routedHost;
      const previousTicket = entry.ticket;
      const activationId = entry.state.activationId;
      const resumeToken = entry.state.resumeToken;
      const appliedContent = entry.state.appliedContent;
      if (!host || !previousTicket?.endpoints || !resumeToken || !appliedContent) {
        this.#recoverRoutedActivation(entry, reason, "frames");
        return;
      }
      if (reason === "pre-auth") {
        if (entry.preAuthRemints.frames >= 1) {
          this.#transitionRouted(entry, { type: "transport-failed", preAuth: true, recoveryExhausted: true });
          return;
        }
        entry.preAuthRemints.frames += 1;
      }
      entry.recoveryAttempts += 1;
      if (entry.recoveryAttempts > 5) {
        this.#transitionRouted(entry, { type: "transport-failed", recoveryExhausted: true });
        return;
      }
      let ticket: RoutedTerminalOpenTicket;
      try {
        ticket = await host.openTicket(entry.sessionId, { reason });
      } catch {
        this.#recoverRoutedActivation(entry, "retry", "frames");
        return;
      }
      if (
        this.#disposed ||
        this.#routedByActivation.get(activationId) !== entry ||
        entry.state.activationId !== activationId
      ) {
        return;
      }
      if (!this.#routedTicketMatches(entry, ticket) || !ticket.endpoints) {
        this.#recoverRoutedActivation(entry, "route-stale", "frames");
        return;
      }
      const sameRoute =
        ticket.route.cellBootId === previousTicket.route.cellBootId &&
        ticket.route.routeRevision === previousTicket.route.routeRevision &&
        ticket.route.leaseEpoch === previousTicket.route.leaseEpoch;
      if (!sameRoute) {
        this.#transitionRouted(entry, { type: "route-stale" });
        this.#recoverRoutedActivation(entry, "route-stale", "frames");
        return;
      }
      entry.ticket = ticket;
      this.#routedControl?.renew(activationId, ticket.attachGrant);
      this.#scheduleRoutedRenewal(entry);
      this.#postWorker({
        type: "routed-frames-attach",
        request: {
          cellBootId: ticket.route.cellBootId,
          sessionHandle: entry.sessionHandle,
          framesUrl: ticket.endpoints.framesUrl,
          transportGrant: ticket.transportGrant,
          attachGrant: ticket.attachGrant,
          activationId,
          resume: { resumeToken, from: appliedContent },
          ...(this.#routedReceiverCapacities === undefined
            ? {}
            : { receiverCapacities: this.#routedReceiverCapacities }),
          capabilities: this.#routedCapabilities,
        },
      });
    })();
    entry.framesResume = task;
    void task.finally(() => {
      if (entry.framesResume === task) delete entry.framesResume;
    });
  }

  #recoverRoutedActivation(
    entry: RoutedActivationRuntime,
    reason: "retry" | "route-stale" | "pre-auth",
    failedChannel?: "control" | "frames",
  ): void {
    if (this.#disposed || entry.viewIds.size === 0 || entry.state.phase === "ended") return;
    if (reason === "pre-auth") {
      const channel = failedChannel ?? "control";
      if (entry.preAuthRemints[channel] >= 1) {
        this.#transitionRouted(entry, { type: "transport-failed", preAuth: true, recoveryExhausted: true });
        return;
      }
      entry.preAuthRemints[channel] += 1;
    }
    entry.recoveryAttempts += 1;
    if (entry.recoveryAttempts > 5) {
      this.#transitionRouted(entry, { type: "transport-failed", recoveryExhausted: true });
      return;
    }
    // Geometry belongs to the cell-side attach/client/view scope. Preserve it
    // across a same-route leg replacement, but never carry its revision or
    // holder generation to a newly routed cell.
    if (reason === "route-stale") this.#routedGeometry.delete(entry.sessionId);
    const previousActivationId = entry.state.activationId;
    this.#routedControl?.detach(previousActivationId);
    this.#postWorker({ type: "routed-frames-detach", activationId: previousActivationId });
    this.#routedByActivation.delete(previousActivationId);
    const nextActivationId = crypto.randomUUID();
    entry.replacesActivationId = previousActivationId;
    const inputPolicy =
      this.#routedHost?.encodeInput !== undefined &&
      [...entry.viewIds].some((viewId) => {
        const view = this.#views.get(viewId);
        return view?.clientReadWrite === true && view.readWrite !== false;
      })
        ? "read-write"
        : "read-only";
    entry.state = {
      ...initialRoutedActivation(entry.sessionId, nextActivationId, inputPolicy),
      phase: "recovering",
      replacesActivationId: previousActivationId,
      preAuthRemintUsed: entry.preAuthRemints.control > 0 || entry.preAuthRemints.frames > 0,
    };
    this.#routedByActivation.set(nextActivationId, entry);
    if (entry.attachTimer !== undefined) window.clearTimeout(entry.attachTimer);
    delete entry.attachTimer;
    if (entry.renewalTimer !== undefined) window.clearTimeout(entry.renewalTimer);
    delete entry.renewalTimer;
    delete entry.ticket;
    const delay = Math.min(2_000, 100 * 2 ** Math.max(0, entry.recoveryAttempts - 1));
    window.setTimeout(() => {
      if (this.#routedByActivation.get(nextActivationId) !== entry) return;
      entry.start = this.#startRoutedActivation(entry, reason);
      void entry.start.finally(() => delete entry.start);
    }, delay);
  }

  #armRoutedAttachDeadline(entry: RoutedActivationRuntime, delayMs: number): void {
    if (entry.attachTimer !== undefined) window.clearTimeout(entry.attachTimer);
    const activationId = entry.state.activationId;
    entry.attachTimer = window.setTimeout(
      () => {
        if (this.#routedByActivation.get(activationId) !== entry || entry.state.phase !== "attaching") return;
        this.#transitionRouted(entry, { type: "attach-deadline" });
        this.#recoverRoutedActivation(entry, "retry");
      },
      Math.max(0, delayMs),
    );
  }

  #scheduleRoutedRenewal(entry: RoutedActivationRuntime): void {
    const ticket = entry.ticket;
    const host = this.#routedHost;
    if (!ticket || !host) return;
    if (entry.renewalTimer !== undefined) window.clearTimeout(entry.renewalTimer);
    const generation = ticket.attachGrant.claims.grantGeneration;
    const delay = Math.max(0, ticket.attachGrant.claims.expiresAt - Date.now() - 60_000);
    if (delay > MAX_BROWSER_TIMEOUT_MS) {
      entry.renewalTimer = window.setTimeout(() => {
        if (entry.ticket !== ticket || this.#disposed) return;
        this.#scheduleRoutedRenewal(entry);
      }, MAX_BROWSER_TIMEOUT_MS);
      return;
    }
    entry.renewalTimer = window.setTimeout(() => {
      this.#transitionRouted(entry, { type: "grant-expiring" });
      if (!host.renewAttach) {
        this.#transitionRouted(entry, { type: "renew-failed" });
        return;
      }
      const requestId = crypto.randomUUID();
      void host
        .renewAttach({ sessionId: entry.sessionId, expectGeneration: generation, requestId })
        .then(({ attachGrant }) => {
          if (entry.ticket !== ticket || !this.#routedRenewalMatches(entry, attachGrant, generation)) {
            this.#transitionRouted(entry, { type: "renew-failed" });
            return;
          }
          entry.ticket = { ...ticket, attachGrant };
          this.#routedControl?.renew(entry.state.activationId, attachGrant);
          this.#scheduleRoutedRenewal(entry);
        })
        .catch(() => this.#transitionRouted(entry, { type: "renew-failed" }));
    }, delay);
  }

  #routedDemand(entry: RoutedActivationRuntime) {
    let live = false;
    let urgent = false;
    for (const viewId of entry.viewIds) {
      const view = this.#views.get(viewId);
      live ||= view?.visible === true;
      urgent ||= view?.visible === true && this.#focusByView.get(viewId) === true;
    }
    return {
      mode: live ? ("live" as const) : ("none" as const),
      urgency: urgent ? ("urgent" as const) : ("normal" as const),
    };
  }

  #declareRoutedDemand(entry: RoutedActivationRuntime): void {
    this.#routedControl?.declareDemand(entry.state.activationId, this.#routedDemand(entry));
  }

  #releaseRoutedView(sessionId: string, viewId: string): void {
    const entry = this.#routedBySession.get(sessionId);
    if (!entry) return;
    entry.viewIds.delete(viewId);
    if (entry.viewIds.size > 0) {
      const anyWritable =
        this.#routedHost?.encodeInput !== undefined &&
        [...entry.viewIds].some((candidate) => {
          const view = this.#views.get(candidate);
          return view?.clientReadWrite === true && view.readWrite !== false;
        });
      this.#transitionRouted(entry, { type: "input-policy", policy: anyWritable ? "read-write" : "read-only" });
      this.#declareRoutedDemand(entry);
      return;
    }
    this.#transitionRouted(entry, { type: "detach" });
    this.#routedBySession.delete(sessionId);
    this.#routedByActivation.delete(entry.state.activationId);
    this.#routedGeometry.delete(sessionId);
  }

  /**
   * Detach one of our views and let the seat go with it.
   *
   * The daemon clears the resize controller when its holder detaches, but a
   * local session announces control only through the legacy `control-changed`
   * frame, which cannot say "no controller": the clear never reaches this
   * client, and a pane that remounts (a split re-parents its surface) would
   * see its own previous incarnation on the record forever and never claim.
   * Our own detach is the one clear this client can predict, so the record is
   * cleared here at the same revision and the session's remaining views get
   * their one look at the empty seat (§4.2.3).
   */
  #detachView(sessionId: string, viewId: string): void {
    this.#control?.notify({ type: "detach-session", sessionId, viewId });
    const control = this.#controlBySession.get(sessionId);
    if (!control?.controller || control.controller.viewId !== viewId) return;
    this.#controlBySession.set(sessionId, { controller: null, revision: control.revision });
    for (const other of this.#viewIdsForSession(sessionId)) {
      if (other !== viewId) this.#maybeReclaim(other);
    }
  }

  #createMountLease(mounted: MountedCanvas): TerminalMount {
    let disposed = false;
    return {
      resize: (width, height, dpr) =>
        this.#postWorker({ type: "resize", surfaceId: mounted.viewId, width, height, dpr }),
      dispose: () => {
        if (disposed) return;
        disposed = true;
        if (!mounted.active) return;
        mounted.references -= 1;
        if (mounted.references !== 0) return;
        mounted.disposeTimer = window.setTimeout(() => {
          mounted.disposeTimer = undefined;
          if (mounted.references !== 0 || !mounted.active) return;
          mounted.active = false;
          const ownsWorkerSurface = this.#mountGenerationBySurface.get(mounted.viewId) === mounted.generation;
          if (ownsWorkerSurface) {
            this.#postWorker({ type: "unmount", surfaceId: mounted.viewId });
            this.#mountGenerationBySurface.delete(mounted.viewId);
            if (this.#routedHost) this.#releaseRoutedView(mounted.sessionId, mounted.viewId);
            else this.#detachView(mounted.sessionId, mounted.viewId);
            this.#views.delete(mounted.viewId);
            this.#focusByView.delete(mounted.viewId);
          }
          this.#mountedCanvases.delete(mounted.canvas);
          this.#mountedEntries.delete(mounted);
          if (!this.#routedHost) this.#releaseFrameSubscription(mounted.sessionHandle);
        }, 0);
      },
    };
  }

  get remoteLifecycleSupported(): boolean {
    return this.#remoteLifecycleSupported;
  }

  /** Negotiated daemon minor, or undefined until the hello completes. */
  get serverProtocolMinor(): number | undefined {
    return this.#serverProtocolMinor === 0 ? undefined : this.#serverProtocolMinor;
  }

  /** Whether callers may rely on structured control-error metadata. */
  get structuredErrorsSupported(): boolean {
    return (this.serverProtocolMinor ?? 0) >= STRUCTURED_ERROR_PROTOCOL_MINOR;
  }

  /** Last known lifecycle of a remote session; undefined for local sessions. */
  remoteSession(sessionId: string): RemoteSessionRuntimeState | undefined {
    return this.#remoteSessions.get(sessionId);
  }

  #applyController(
    sessionId: string,
    controller: RemoteControllerInfo | null,
    cols: number,
    rows: number,
    revision = 0,
  ): void {
    const previous = this.#controlBySession.get(sessionId);
    // A revisioned announcement older than what is cached is a queued view of
    // the past, and must be dropped whole. Keeping its payload while raising
    // the revision would manufacture a state that never existed — "nobody
    // holds control, as of the newest revision" — and that reads as an empty
    // seat the funnel may claim. The compare-and-swap would not catch it
    // either: the expectation would be genuinely current, so the host would
    // accept a claim that takes control from the real holder.
    if (revision >= 1 && previous !== undefined && revision < previous.revision) return;
    this.#controlBySession.set(sessionId, {
      controller,
      // A legacy `control-changed` carries no revision; keep the last one so a
      // downgrade never looks like the controller was cleared at a newer one.
      // Unrevisioned announcements cannot be ordered against each other, so
      // they stay last-write-wins — the only semantics available for them.
      revision: Math.max(revision, previous?.revision ?? 0),
    });
    for (const [viewId, view] of this.#views) {
      if (view.sessionId !== sessionId) continue;
      if (!controller || controller.viewId !== viewId) {
        view.controlEpoch = undefined;
        continue;
      }
      view.controlEpoch = controller.controlEpoch;
      if (
        view.desiredCols !== undefined &&
        view.desiredRows !== undefined &&
        (view.desiredCols !== cols || view.desiredRows !== rows)
      ) {
        this.#sendResize(viewId, view, view.desiredCols, view.desiredRows);
      }
    }
    // A cleared controller is the one case worth re-evaluating: a view with an
    // outstanding explicit resize-control request may now take the seat.
    for (const viewId of this.#viewIdsForSession(sessionId)) this.#maybeReclaim(viewId);
  }

  *#viewIdsForSession(sessionId: string): Generator<string> {
    for (const [viewId, view] of this.#views) {
      if (view.sessionId === sessionId) yield viewId;
    }
  }

  /**
   * The single funnel for taking resize control (§4.2.3). Every condition that
   * gates an explicit claim re-enters here when it changes, because no one
   * event is enough: recovery can mark a view attached before its session
   * reaches live, while the resize-control request already exists.
   *
   * At most one claim per attachment epoch, plus one more each time the
   * controller is cleared at a newer revision.
   *
   * A host that reports real revisions gets a compare-and-swap, so a claim or
   * a clear that landed since this client last looked rejects the attempt
   * instead of silently overwriting it. The outcome is asymmetric and needs no
   * loop of its own: the daemon announces the resulting controller state, this
   * funnel re-runs on it, and another pane holding control simply fails the
   * guard above while an empty seat at a newer revision passes the one below.
   */
  #maybeReclaim(viewId: string): void {
    const view = this.#views.get(viewId);
    if (!view || view.readWrite === false || !view.clientReadWrite || !view.resizeControlRequested) return;
    const attachmentEpoch = view.attachmentEpoch;
    if (attachmentEpoch === undefined) return;
    if (view.desiredCols === undefined || view.desiredRows === undefined) return;
    const remote = this.#remoteSessions.get(view.sessionId);
    if (remote && (remote.state !== "live" || remote.awaitingRecoveryFrame)) return;
    const control = this.#controlBySession.get(view.sessionId);
    const controller = control?.controller ?? null;
    // Never take control from another pane. Our own name on the record is not
    // a reason to stop: after a resume it is the previous incarnation's, and
    // the new attachment epoch below is what decides.
    if (controller && controller.viewId !== viewId) return;
    const revision = control?.revision ?? 0;
    // One claim per attachment epoch. A controller *cleared* at a newer
    // revision earns one more; the seat being confirmed as ours does not.
    if (view.claimedEpoch === attachmentEpoch && (controller !== null || view.claimedRevision >= revision)) return;
    const session = this.#sessionByHandle.get(view.sessionHandle);
    if (!session) return;
    view.claimedEpoch = attachmentEpoch;
    view.claimedRevision = revision;
    this.#control?.notify({
      type: "focus-and-resize",
      sessionId: session.id,
      viewId,
      attachmentEpoch,
      cols: view.desiredCols,
      rows: view.desiredRows,
      // Revision 0 is the "legacy, unknown" sentinel, never a real observation
      // to swap against: a host without revisions only understands the
      // unconditional claim, so the field stays off. The negotiated minor is
      // checked too, because a cached revision could outlive a daemon
      // downgrade and a daemon that predates the field would ignore it —
      // turning a swap the caller believes in into a silent overwrite.
      ...(this.#controlRevisionCasSupported && revision >= 1 ? { expectedControlRevision: revision } : {}),
    });
  }

  /**
   * The only path that mutates per-view attachment state, whether the update
   * arrived as an event, a reconciliation, or an attach response. A sequence
   * at or below the last applied one is a delayed transition from an abandoned
   * attempt and is dropped; an update without a sequence comes from a daemon
   * older than the fence and applies directly.
   */
  #applyViewState(viewId: string, update: RemoteViewStateUpdate): boolean {
    const view = this.#views.get(viewId);
    if (!view) return false;
    if (update.viewStateSeq !== undefined) {
      if (view.lastViewStateSeq !== undefined && update.viewStateSeq <= view.lastViewStateSeq) return false;
      view.lastViewStateSeq = update.viewStateSeq;
    }
    const remote = this.#remoteSessions.has(view.sessionId);
    if (update.viewState === "attached" && update.attachmentEpoch !== null) {
      // Nothing typed against the previous incarnation may ride out on a
      // freshly armed epoch.
      if (remote) view.pendingInput.length = 0;
      view.attachmentEpoch = update.attachmentEpoch;
      view.lastAttachmentEpoch = update.attachmentEpoch;
      if (update.readWrite !== null) view.readWrite = update.readWrite;
      this.#maybeReclaim(viewId);
      return true;
    }
    view.pendingInput.length = 0;
    view.attachmentEpoch = undefined;
    return true;
  }

  #applyRemoteSessionState(sessionId: string, lifecycle: RemoteSessionLifecycle, authoritative: boolean): boolean {
    const previous = this.#remoteSessions.get(sessionId);
    if (previous) {
      // A reconciliation is the source of truth and may restate its sequence;
      // a pushed event at a sequence already seen is stale.
      const stale = authoritative
        ? lifecycle.lifecycleSeq < previous.lifecycleSeq
        : lifecycle.lifecycleSeq <= previous.lifecycleSeq;
      if (stale) return false;
    }
    // Lifecycle events and frames travel independent channels, so a recovery
    // snapshot can commit either side of the live transition. An episode's
    // latch is cleared when it begins and set by any full snapshot, which lets
    // both arrival orders resolve without either one having to come first.
    if (showsStaleScreen(lifecycle.state) && (previous === undefined || !showsStaleScreen(previous.state))) {
      this.#recoveredSessions.delete(sessionId);
    }
    // Coming back from a frozen state, the screen on display is still the one
    // from before the outage. Keep it marked stale until the recovered stream
    // has committed a full frame; `opening` never had a screen to distrust.
    const awaitingRecoveryFrame =
      lifecycle.state === "live" &&
      previous !== undefined &&
      (previous.awaitingRecoveryFrame || showsStaleScreen(previous.state)) &&
      !this.#recoveredSessions.has(sessionId);
    const state: RemoteSessionRuntimeState = {
      ...lifecycle,
      sessionId,
      observedAt: performance.now(),
      awaitingRecoveryFrame,
    };
    this.#remoteSessions.set(sessionId, state);
    if (state.state !== "live") {
      for (const view of this.#views.values()) {
        if (view.sessionId === sessionId) view.pendingInput.length = 0;
      }
    }
    this.#setCursorFrozen(sessionId, sessionIsFrozen(state));
    this.dispatchEvent(new CustomEvent("remote-session-state", { detail: state }));
    for (const viewId of this.#viewIdsForSession(sessionId)) this.#maybeReclaim(viewId);
    return true;
  }

  /**
   * A committed frame is only evidence of recovery if it carries a whole
   * screen: a partial update repaints part of the stale one, which is exactly
   * what would thaw a pane too early.
   */
  #recordCommittedFrame(sessionHandle: string, fullSnapshot: boolean): void {
    if (!fullSnapshot) return;
    const sessionId = this.#sessionByHandle.get(sessionHandle)?.id;
    if (sessionId === undefined || !this.#remoteSessions.has(sessionId)) return;
    this.#recoveredSessions.add(sessionId);
    this.#thawRecoveredSession(sessionId);
  }

  /** What the pane shows is current again, so stop marking it stale. */
  #thawRecoveredSession(sessionId: string): void {
    const state = this.#remoteSessions.get(sessionId);
    if (!state || !state.awaitingRecoveryFrame || !this.#recoveredSessions.has(sessionId)) return;
    const thawed: RemoteSessionRuntimeState = { ...state, awaitingRecoveryFrame: false };
    this.#remoteSessions.set(sessionId, thawed);
    this.#setCursorFrozen(sessionId, sessionIsFrozen(thawed));
    this.dispatchEvent(new CustomEvent("remote-session-state", { detail: thawed }));
    for (const viewId of this.#viewIdsForSession(sessionId)) this.#maybeReclaim(viewId);
  }

  /** Hold the cursor steady while the replica is frozen, without disturbing focus. */
  #setCursorFrozen(sessionId: string, frozen: boolean): void {
    for (const [viewId, view] of this.#views) {
      if (view.sessionId === sessionId) this.#postWorker({ type: "cursor-frozen", surfaceId: viewId, frozen });
    }
  }

  async #remoteSessionStateRequest(
    command: { type: "get-remote-session-state" | "reconnect-remote-session"; sessionId: string },
    timeoutMs: number,
  ): Promise<RemoteSessionRuntimeState | undefined> {
    await this.connect();
    if (!this.#remoteLifecycleSupported) return undefined;
    const response = await this.#control!.request(command, timeoutMs);
    if (response.type !== "remote-session-state") {
      throw new Error("ghosttead returned an unexpected remote session state");
    }
    this.#applyRemoteSessionState(command.sessionId, response, true);
    this.#applyController(
      command.sessionId,
      response.controller,
      response.cols,
      response.rows,
      response.controlRevision,
    );
    for (const view of response.views) this.#applyViewState(view.viewId, view);
    return this.#remoteSessions.get(command.sessionId);
  }

  /** Rebuild this client's state for one remote session from the daemon. */
  async getRemoteSessionState(sessionId: string): Promise<RemoteSessionRuntimeState | undefined> {
    return this.#remoteSessionStateRequest({ type: "get-remote-session-state", sessionId }, 10_000);
  }

  async reconnectRemoteSession(sessionId: string): Promise<RemoteSessionRuntimeState | undefined> {
    return this.#remoteSessionStateRequest(
      { type: "reconnect-remote-session", sessionId },
      RECONNECT_REQUEST_TIMEOUT_MS,
    );
  }

  async retryRemoteView(sessionId: string, viewId: string): Promise<void> {
    await this.connect();
    if (!this.#remoteLifecycleSupported) return;
    const response = await this.#control!.request(
      { type: "retry-remote-view", sessionId, viewId },
      RECONNECT_REQUEST_TIMEOUT_MS,
    );
    if (response.type !== "view-state") throw new Error("ghosttead returned an unexpected view state");
    this.#applyViewState(response.viewId, response);
  }

  #reconcileRemoteSessions(): Promise<unknown> {
    if (!this.#remoteLifecycleSupported) return Promise.resolve();
    return Promise.all(
      [...this.#remoteSessions.keys()].map((sessionId) =>
        this.getRemoteSessionState(sessionId).catch((error: unknown) => {
          if (!this.#disposed) {
            console.warn(`[terminal-runtime] could not reconcile remote session ${sessionId}`, error);
          }
        }),
      ),
    );
  }

  /**
   * `silent` marks operations that drop without the keystroke hint: focus and
   * geometry updates are cosmetic, and pointer gestures are already answered
   * by the pane's frozen treatment.
   */
  #sendViewInput(
    viewId: string,
    operation: (attachmentEpoch: number, inputSequence: number) => void,
    silent = false,
  ): void {
    const view = this.#views.get(viewId);
    if (!view || view.readWrite === false || !view.clientReadWrite) return;
    const remote = this.#remoteSessions.get(view.sessionId);
    const attachmentEpoch = view.attachmentEpoch;
    // Input for a remote session is dropped with feedback rather than queued:
    // replaying a keystroke across an outage would deliver it to a screen the
    // user has never seen. The queue below survives only for a local session's
    // mount-to-attach gap, which is a local IPC round-trip.
    if (remote && (remote.state !== "live" || attachmentEpoch === undefined)) {
      view.pendingInput.length = 0;
      if (!silent) this.#reportSuppressedInput(view.sessionId, viewId, remote.state);
      return;
    }
    if (attachmentEpoch === undefined) {
      if (view.pendingInput.length < 256) view.pendingInput.push(operation);
      return;
    }
    view.inputSequence += 1;
    operation(attachmentEpoch, view.inputSequence);
  }

  #reportSuppressedInput(sessionId: string, viewId: string, state: RemoteSessionRuntimeState["state"]): void {
    this.dispatchEvent(
      new CustomEvent("input-suppressed", { detail: { sessionId, viewId, state } satisfies RemoteInputSuppression }),
    );
  }

  #sendRoutedInput(
    sessionId: string,
    viewId: string,
    operation: RoutedTerminalInputOperation,
    silent = false,
  ): boolean {
    const host = this.#routedHost;
    const view = this.#views.get(viewId);
    const activation = this.#routedBySession.get(sessionId);
    if (
      !host ||
      !view ||
      view.sessionId !== sessionId ||
      view.readWrite === false ||
      !view.clientReadWrite ||
      !activation?.state.inputAllowed
    ) {
      if (!silent) {
        this.dispatchEvent(
          new CustomEvent("routed-input-suppressed", {
            detail: {
              sessionId,
              viewId,
              reason: !host?.encodeInput ? "wire-verb-unavailable" : "input-not-allowed",
            },
          }),
        );
      }
      return false;
    }
    if (!host.encodeInput) {
      if (!silent) {
        this.dispatchEvent(
          new CustomEvent("routed-input-suppressed", {
            detail: { sessionId, viewId, reason: "wire-verb-unavailable" },
          }),
        );
      }
      return false;
    }
    view.inputSequence += 1;
    const message = host.encodeInput({
      sessionId,
      viewId,
      activationId: activation.state.activationId,
      leaseEpoch: activation.ticket?.attachGrant.claims.leaseEpoch ?? 0,
      inputSequence: view.inputSequence,
      operation,
    });
    return message !== null && this.#routedControl!.sendExtension(activation.state.activationId, message);
  }

  sendText(sessionId: string, viewId: string, text: string): void {
    if (this.#routedHost) {
      this.#sendRoutedInput(sessionId, viewId, { kind: "text", text });
      return;
    }
    this.#sendViewInput(viewId, (attachmentEpoch, inputSequence) =>
      this.#control?.notify({ type: "send-text", sessionId, viewId, attachmentEpoch, inputSequence, text }),
    );
    const handle = this.#handleBySessionId.get(sessionId);
    if (handle) this.#postWorker({ type: "cursor-activity", sessionHandle: handle });
  }

  paste(sessionId: string, viewId: string, text: string): void {
    if (this.#routedHost) {
      this.#sendRoutedInput(sessionId, viewId, { kind: "paste", text });
      return;
    }
    this.#sendViewInput(viewId, (attachmentEpoch, inputSequence) =>
      this.#control?.notify({ type: "paste", sessionId, viewId, attachmentEpoch, inputSequence, text }),
    );
    const handle = this.#handleBySessionId.get(sessionId);
    if (handle) this.#postWorker({ type: "cursor-activity", sessionHandle: handle });
  }

  sendKey(sessionId: string, viewId: string, event: TerminalKeyEvent): void {
    if (this.#routedHost) {
      this.#sendRoutedInput(sessionId, viewId, { kind: "key", event });
      return;
    }
    this.#sendViewInput(viewId, (attachmentEpoch, inputSequence) =>
      this.#control?.notify({ type: "send-key", sessionId, viewId, attachmentEpoch, inputSequence, event }),
    );
    const handle = this.#handleBySessionId.get(sessionId);
    if (handle) this.#postWorker({ type: "cursor-activity", sessionHandle: handle });
  }

  sendMouse(sessionId: string, viewId: string, event: TerminalMouseEvent): void {
    if (this.#routedHost) {
      this.#sendRoutedInput(sessionId, viewId, { kind: "mouse", event }, true);
      return;
    }
    this.#sendViewInput(
      viewId,
      (attachmentEpoch, inputSequence) =>
        this.#control?.notify({ type: "send-mouse", sessionId, viewId, attachmentEpoch, inputSequence, event }),
      true,
    );
  }

  scroll(sessionId: string, viewId: string, rows: number): void {
    if (rows === 0) return;
    if (this.#routedHost) {
      this.#sendRoutedInput(sessionId, viewId, { kind: "scroll", rows }, true);
      return;
    }
    // Scrolling is host-side input, so it is simply inert while frozen.
    this.#sendViewInput(
      viewId,
      (attachmentEpoch, inputSequence) =>
        this.#control?.notify({ type: "scroll", sessionId, viewId, attachmentEpoch, inputSequence, rows }),
      true,
    );
  }

  scrollTo(sessionId: string, viewId: string, row: number): void {
    if (!Number.isSafeInteger(row) || row < 0) return;
    if (this.#routedHost) {
      this.#sendRoutedInput(sessionId, viewId, { kind: "scroll-to", row }, true);
      return;
    }
    this.#sendViewInput(
      viewId,
      (attachmentEpoch, inputSequence) =>
        this.#control?.notify({ type: "scroll-to", sessionId, viewId, attachmentEpoch, inputSequence, row }),
      true,
    );
  }

  scrollbar(sessionHandle: string): TerminalScrollbarState | undefined {
    return this.#scrollbarByHandle.get(sessionHandle);
  }

  isMouseTracking(sessionHandle: string): boolean {
    return this.#mouseTrackingByHandle.get(sessionHandle) ?? false;
  }

  setTheme(sessionHandle: string, theme: TerminalTheme, surfaceId?: string): void {
    this.#postWorker({ type: "theme", sessionHandle, ...(surfaceId ? { surfaceId } : {}), theme });
    // A surface-scoped theme is renderer-local. Updating the daemon's
    // session-wide palette here would repaint every mirrored viewer.
    if (surfaceId) return;
    const session = this.#sessionByHandle.get(sessionHandle);
    if (!session) return;
    const rgb = (color: TerminalTheme["foreground"]): [number, number, number] => [
      Math.round(color[0] * 255),
      Math.round(color[1] * 255),
      Math.round(color[2] * 255),
    ];
    this.#control?.notify({
      type: "set-colors",
      sessionId: session.id,
      foreground: rgb(theme.foreground),
      background: rgb(theme.background),
      cursor: rgb(theme.cursor),
    });
  }

  setEffects(sessionHandle: string, effects: TerminalEffects, surfaceId?: string): void {
    this.#postWorker({ type: "effects", sessionHandle, ...(surfaceId ? { surfaceId } : {}), effects });
  }

  links(sessionHandle: string): readonly TerminalLink[] {
    return this.#platform.openExternal
      ? (this.#linksByHandle.get(sessionHandle) ?? []).filter(
          (link) => link.explicit || this.#configSnapshot?.renderer.linkUrl !== false,
        )
      : [];
  }

  async openLink(uri: string): Promise<void> {
    const url = terminalLinkUrl(uri);
    if (url) await this.#platform.openExternal?.(url);
  }

  setSelection(sessionHandle: string, selection: CellSelection | null, surfaceId?: string): void {
    this.#postWorker({ type: "selection", sessionHandle, ...(surfaceId ? { surfaceId } : {}), selection });
  }

  setVisible(sessionHandle: string, visible: boolean, surfaceId?: string): void {
    this.#postWorker({ type: "visibility", sessionHandle, ...(surfaceId ? { surfaceId } : {}), visible });
    if (this.#routedHost) {
      const session = this.#sessionByHandle.get(sessionHandle);
      if (!session) return;
      if (surfaceId) {
        const view = this.#views.get(surfaceId);
        if (view) view.visible = visible;
      } else {
        for (const view of this.#views.values()) {
          if (view.sessionId === session.id) view.visible = visible;
        }
      }
      const entry = this.#routedBySession.get(session.id);
      if (entry) this.#declareRoutedDemand(entry);
    }
  }

  forceFullRedraw(sessionHandle: string): void {
    this.#postWorker({ type: "force-full-redraw", sessionHandle });
  }

  forceRowRedraw(sessionHandle: string, row: number): void {
    this.#postWorker({ type: "force-row-redraw", sessionHandle, row });
  }

  setPartialRenderingEnabled(enabled: boolean): void {
    this.#postWorker({ type: "partial-rendering", enabled });
  }

  #claimRoutedGeometry(entry: RoutedActivationRuntime, viewId: string, cols: number, rows: number): void {
    const ticket = entry.ticket;
    const view = this.#views.get(viewId);
    if (!ticket || !view?.resizeControlRequested || !entry.state.rights.includes("geometry")) return;
    const geometry = this.#routedGeometry.get(entry.sessionId);
    this.#routedControl?.claimGeometry(entry.state.activationId, {
      sessionId: entry.sessionId,
      activationId: entry.state.activationId,
      leaseEpoch: ticket.attachGrant.claims.leaseEpoch ?? 0,
      claimant: { clientId: ticket.attachGrant.claims.clientId, viewId },
      cols,
      rows,
      expectRevision: geometry?.revision ?? 0,
    });
  }

  claimResizeControl(sessionHandle: string, viewId: string, cols: number, rows: number): void {
    const view = this.#views.get(viewId);
    if (view) {
      view.desiredCols = cols;
      view.desiredRows = rows;
      view.resizeControlRequested = true;
    }
    if (this.#routedHost) {
      const session = this.#sessionByHandle.get(sessionHandle);
      const entry = session ? this.#routedBySession.get(session.id) : undefined;
      if (entry) this.#claimRoutedGeometry(entry, viewId, cols, rows);
      return;
    }
    if (!this.#sessionByHandle.has(sessionHandle)) return;
    this.#maybeReclaim(viewId);
  }

  releaseResizeControl(viewId: string): void {
    const view = this.#views.get(viewId);
    if (!view) return;
    view.resizeControlRequested = false;
    if (this.#routedHost) {
      const entry = this.#routedBySession.get(view.sessionId);
      const geometry = this.#routedGeometry.get(view.sessionId);
      const ticket = entry?.ticket;
      if (entry && ticket && geometry?.holderViewId === viewId && geometry.holderGeneration !== undefined) {
        const sent = this.#routedControl?.releaseGeometry(entry.state.activationId, {
          sessionId: view.sessionId,
          activationId: entry.state.activationId,
          leaseEpoch: ticket.attachGrant.claims.leaseEpoch ?? 0,
          holder: {
            clientId: ticket.attachGrant.claims.clientId,
            viewId,
            holderGeneration: geometry.holderGeneration,
          },
        });
        if (sent) {
          // T1 sends no success body for release. The ordered control leg and
          // cell state machine make the next revision deterministic.
          this.#routedGeometry.set(view.sessionId, {
            revision: geometry.revision + 1,
            ...(geometry.cols === undefined ? {} : { cols: geometry.cols }),
            ...(geometry.rows === undefined ? {} : { rows: geometry.rows }),
          });
        }
      }
      return;
    }
    // The legacy protocol has no release verb, so the daemon keeps this view
    // seated. Dropping the request is what closes every resize path; the epoch
    // stays, because it is still the seat's truth and a later explicit claim
    // resumes on it. Clearing it here would leave the view with the record in
    // its own name and no epoch: the funnel's one-claim-per-attachment guard
    // refuses that claim, and a pane hidden by a zoom never resizes again.
  }

  setViewInputPolicy(viewId: string, readWrite: boolean): void {
    const view = this.#views.get(viewId);
    if (!view) return;
    view.clientReadWrite = readWrite;
    if (!readWrite) view.pendingInput.length = 0;
    const entry = this.#routedBySession.get(view.sessionId);
    if (entry) {
      const anyWritable =
        this.#routedHost?.encodeInput !== undefined &&
        [...entry.viewIds].some((candidate) => {
          const candidateView = this.#views.get(candidate);
          return candidateView?.clientReadWrite === true && candidateView.readWrite !== false;
        });
      this.#transitionRouted(entry, { type: "input-policy", policy: anyWritable ? "read-write" : "read-only" });
    }
  }

  setFocused(sessionHandle: string, viewId: string, focused: boolean, cols: number, rows: number): void {
    const view = this.#views.get(viewId);
    if (view) {
      view.desiredCols = cols;
      view.desiredRows = rows;
    }
    if (this.#focusByView.get(viewId) === focused) {
      return;
    }
    this.#focusByView.set(viewId, focused);
    this.#postWorker({ type: "focus", surfaceId: viewId, sessionHandle, focused });
    const session = this.#sessionByHandle.get(sessionHandle);
    if (!session) return;
    if (this.#routedHost) {
      const entry = this.#routedBySession.get(session.id);
      if (entry) this.#declareRoutedDemand(entry);
      return;
    }
    this.#sendViewInput(
      viewId,
      (attachmentEpoch, inputSequence) => {
        this.#control?.notify({
          type: "focus",
          sessionId: session.id,
          viewId,
          attachmentEpoch,
          inputSequence,
          focused,
        });
      },
      true,
    );
  }

  async copySelection(sessionId: string, viewId: string, selection: CellSelection, selectAll = false): Promise<string> {
    await this.connect();
    if (this.#routedHost) return "";
    const view = this.#views.get(viewId);
    if (!view || view.sessionId !== sessionId) return "";
    // A frozen replica stays copyable: offline the daemon answers from the
    // retained snapshot and authorizes by ownership, so the last epoch this
    // view held is enough to name the attachment.
    const attachmentEpoch = view.attachmentEpoch ?? view.lastAttachmentEpoch;
    if (attachmentEpoch === undefined) return "";
    const response = await this.#control!.request({
      type: "selection-text",
      sessionId,
      viewId,
      attachmentEpoch,
      startColumn: selection.anchor.column,
      startRow: selection.anchor.row,
      endColumn: selection.focus.column,
      endRow: selection.focus.row,
      selectAll,
    });
    if (response.type !== "selection-text") throw new Error("ghosttead returned an unexpected selection response");
    // Offline the daemon can only reach the retained screen, so say so rather
    // than letting a short copy read as the whole scrollback.
    if (response.scope !== undefined) {
      this.dispatchEvent(
        new CustomEvent("selection-scope", {
          detail: { sessionId, viewId, scope: response.scope } satisfies SelectionScope,
        }),
      );
    }
    if (response.text) this.#platform.writeClipboard(response.text);
    return response.text;
  }

  interrupt(sessionId: string, viewId: string): void {
    if (this.#routedHost) {
      this.#sendRoutedInput(sessionId, viewId, { kind: "interrupt" });
      return;
    }
    this.#sendViewInput(viewId, (attachmentEpoch, inputSequence) =>
      this.#control?.notify({ type: "interrupt", sessionId, viewId, attachmentEpoch, inputSequence }),
    );
    const handle = this.#handleBySessionId.get(sessionId);
    if (handle) this.#postWorker({ type: "cursor-activity", sessionHandle: handle });
  }

  #removeRegisteredSession(sessionId: string, detachViews: boolean): void {
    const handle = this.#handleBySessionId.get(sessionId);
    if (!handle) return;
    const releaseTimer = this.#sessionReleaseTimers.get(handle);
    if (releaseTimer !== undefined) window.clearTimeout(releaseTimer);
    this.#sessionReleaseTimers.delete(handle);
    this.#pinnedSessionHandles.delete(handle);
    this.#sessionMountReferences.delete(handle);
    const subscriptionChanged = this.#subscribedSessionHandles.delete(handle);
    this.#cancelMetadataRefresh(handle);
    this.#linksByHandle.delete(handle);
    this.#mouseTrackingByHandle.delete(handle);
    this.#scrollbarByHandle.delete(handle);
    for (const mounted of [...this.#mountedEntries]) {
      if (mounted.sessionHandle !== handle) continue;
      mounted.active = false;
      if (mounted.disposeTimer !== undefined) window.clearTimeout(mounted.disposeTimer);
      mounted.disposeTimer = undefined;
      const ownsWorkerSurface = this.#mountGenerationBySurface.get(mounted.viewId) === mounted.generation;
      if (ownsWorkerSurface) {
        this.#postWorker({ type: "unmount", surfaceId: mounted.viewId });
        this.#mountGenerationBySurface.delete(mounted.viewId);
        if (detachViews) this.#detachView(mounted.sessionId, mounted.viewId);
        this.#views.delete(mounted.viewId);
        this.#focusByView.delete(mounted.viewId);
      }
      this.#mountedCanvases.delete(mounted.canvas);
      this.#mountedEntries.delete(mounted);
    }
    for (const [viewId, view] of this.#views) {
      if (view.sessionId === sessionId) {
        view.pendingInput.length = 0;
        if (detachViews) this.#detachView(sessionId, viewId);
        this.#views.delete(viewId);
        this.#focusByView.delete(viewId);
      }
    }
    this.#sessionByHandle.delete(handle);
    this.#sessionGenerationByHandle.delete(handle);
    this.#appliedRoutedExitEvents.delete(handle);
    this.#handleBySessionId.delete(sessionId);
    this.#remoteSessions.delete(sessionId);
    this.#controlBySession.delete(sessionId);
    this.#recoveredSessions.delete(sessionId);
    if (subscriptionChanged) {
      this.#frameSubscriptionVersion += 1;
      this.#syncFrameSubscriptionsInBackground();
    }
    this.#resync.cancel(handle);
    this.#postWorker({ type: "drop-session", sessionHandle: handle });
  }

  unregisterSession(sessionId: string): void {
    const routed = this.#routedBySession.get(sessionId);
    if (routed) {
      for (const viewId of [...routed.viewIds]) this.#releaseRoutedView(sessionId, viewId);
    }
    this.#removeRegisteredSession(sessionId, true);
  }

  terminate(sessionId: string, source: TerminationSource = "user"): void {
    if (this.#routedHost) {
      void this.#routedHost.terminate?.(sessionId, source);
      const entry = this.#routedBySession.get(sessionId);
      if (entry) {
        for (const viewId of [...entry.viewIds]) this.#releaseRoutedView(sessionId, viewId);
      }
      this.#removeRegisteredSession(sessionId, false);
      return;
    }
    this.#control?.notify({ type: "terminate", sessionId, source });
    this.#removeRegisteredSession(sessionId, false);
  }

  resize(sessionId: string, viewId: string, cols: number, rows: number): void {
    const view = this.#views.get(viewId);
    if (!view || view.sessionId !== sessionId) return;
    view.desiredCols = cols;
    view.desiredRows = rows;
    if (!view.resizeControlRequested) return;
    if (this.#routedHost) {
      const entry = this.#routedBySession.get(sessionId);
      if (entry) this.#claimRoutedGeometry(entry, viewId, cols, rows);
      return;
    }
    if (view.attachmentEpoch === undefined || view.controlEpoch === undefined) {
      // Dimensions are one of the funnel's conditions: a pane that measured
      // itself while uncontrolled may now be able to take control.
      this.#maybeReclaim(viewId);
      return;
    }
    this.#sendResize(viewId, view, cols, rows);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const [viewId, view] of this.#views) {
      view.pendingInput.length = 0;
      this.#control?.notify({ type: "detach-session", sessionId: view.sessionId, viewId });
    }
    for (const mounted of this.#mountedEntries) {
      if (mounted.disposeTimer !== undefined) window.clearTimeout(mounted.disposeTimer);
      mounted.active = false;
      this.#mountedCanvases.delete(mounted.canvas);
    }
    this.#mountedEntries.clear();
    for (const timer of this.#sessionReleaseTimers.values()) window.clearTimeout(timer);
    this.#sessionReleaseTimers.clear();
    for (const pending of this.#frameSubscriptionRequests.values()) {
      window.clearTimeout(pending.timer);
      pending.reject(new Error("Terminal runtime was disposed during a frame subscription"));
    }
    this.#frameSubscriptionRequests.clear();
    for (const timer of this.#metadataTimers.values()) window.clearTimeout(timer);
    this.#metadataTimers.clear();
    this.#metadataRefreshPending.clear();
    this.#metadataRefreshes.clear();
    this.#sessionGenerationByHandle.clear();
    this.#appliedRoutedExitEvents.clear();
    this.#resync.dispose();
    for (const request of this.#performanceRequests.values()) {
      window.clearTimeout(request.timer);
      request.reject(new Error("Terminal runtime was disposed during a performance request"));
    }
    this.#performanceRequests.clear();
    for (const request of this.#counterRequests.values()) {
      window.clearTimeout(request.timer);
      request.reject(new Error("Terminal runtime was disposed during a counter request"));
    }
    this.#counterRequests.clear();
    this.#views.clear();
    this.#remoteSessions.clear();
    this.#controlBySession.clear();
    this.#recoveredSessions.clear();
    this.#focusByView.clear();
    this.#mountGenerationBySurface.clear();
    this.#linksByHandle.clear();
    this.#mouseTrackingByHandle.clear();
    this.#scrollbarByHandle.clear();
    this.#subscribedSessionHandles.clear();
    this.#pinnedSessionHandles.clear();
    this.#sessionMountReferences.clear();
    this.#sessionByHandle.clear();
    this.#handleBySessionId.clear();
    if (this.#frames) {
      this.#frames.onmessage = null;
      this.#frames.close();
      this.#frames = undefined;
    }
    this.#control?.dispose();
    this.#control = undefined;
    this.#routedControl?.dispose();
    for (const entry of this.#routedBySession.values()) {
      if (entry.attachTimer !== undefined) window.clearTimeout(entry.attachTimer);
      if (entry.renewalTimer !== undefined) window.clearTimeout(entry.renewalTimer);
    }
    this.#routedBySession.clear();
    this.#routedByActivation.clear();
    this.#routedGeometry.clear();
    this.#routedAttachDeadlineByCell.clear();
    this.#serverProtocolMinor = 0;
    this.#worker.terminate();
    if (this.#ports) {
      void this.#ports.then(
        (ports) => {
          ports.control.close();
          ports.frames.close();
        },
        () => undefined,
      );
    }
  }

  #sendResize(viewId: string, view: ViewRuntimeState, cols: number, rows: number): void {
    if (!view.resizeControlRequested || view.attachmentEpoch === undefined || view.controlEpoch === undefined) return;
    view.resizeSequence += 1;
    this.#control?.notify({
      type: "resize",
      sessionId: view.sessionId,
      viewId,
      attachmentEpoch: view.attachmentEpoch,
      controlEpoch: view.controlEpoch,
      resizeSequence: view.resizeSequence,
      cols,
      rows,
    });
  }
}

export function createGhostteaTerminalRuntime(options: GhostteaTerminalRuntimeOptions): GhostteaTerminalRuntime {
  return new GhostteaTerminalRuntime(options);
}
