import {
  ROUTED_CLOSE_CODES,
  ROUTED_DOOR_LIMITS,
  ROUTED_LEG_OUTBOUND,
  ROUTED_PROTOCOL_VERSION,
  decodeRoutedMessage,
  encodeRoutedMessage,
  type RoutedCellActivationStatus,
  type RoutedCellTransportGrant,
  type RoutedClaimGeometry,
  type RoutedConnectionAccepted,
  type RoutedConnectionRefused,
  type RoutedControlLegAttached,
  type RoutedDeclareDemand,
  type RoutedGeometryCommitted,
  type RoutedGeometryRefused,
  type RoutedReleaseGeometry,
  type RoutedSessionAttachGrant,
  type RoutedSourceDemand,
  type RoutedTransferGeometry,
} from "@vibecook/ghosttea-protocol";

export interface RoutedControlAttachRequest {
  cellBootId: string;
  controlUrl: string;
  transportGrant: RoutedCellTransportGrant;
  attachGrant: RoutedSessionAttachGrant;
  activationId: string;
  replacesActivationId?: string;
  /** Replace this connection's last admitted activation for the session.
   * A pending predecessor is resolved first, including after local detach. */
  replacePreviousActivation?: boolean;
  initialDemand: RoutedSourceDemand;
  capabilities?: string[];
}

export interface RoutedExtensionMessageContext {
  readonly cellBootId: string;
  readonly connectionSetId: string;
  readonly channel: "control";
}

/** The geometry verb a control-leg reply answers. */
export type RoutedGeometryRequestKind = "claim" | "transfer" | "release";

/** The request a geometry reply answers, with the context its sender attached. */
export interface RoutedGeometryRequest {
  readonly kind: RoutedGeometryRequestKind;
  /** Opaque to the transport; handed back unchanged with the reply. */
  readonly context?: unknown;
}

export type RoutedControlTransportEvent =
  | { type: "transport-ready"; cellBootId: string; accepted: RoutedConnectionAccepted }
  | { type: "control-attached"; attached: RoutedControlLegAttached }
  | { type: "attach-refused"; activationId?: string; code: string; retryable: boolean }
  | { type: "cell-status"; status: RoutedCellActivationStatus }
  | { type: "demand-accepted"; activationId?: string; demandSequence: number }
  | {
      type: "geometry-committed";
      activationId?: string;
      request?: RoutedGeometryRequest;
      committed: RoutedGeometryCommitted;
    }
  | {
      type: "geometry-refused";
      activationId?: string;
      request?: RoutedGeometryRequest;
      refused: RoutedGeometryRefused;
    }
  | {
      type: "extension-message";
      message: Readonly<Record<string, unknown>>;
      context: RoutedExtensionMessageContext;
    }
  | {
      type: "transport-closed";
      cellBootId: string;
      code: number;
      reason: string;
      activationIds: string[];
      preAuth: boolean;
      refusal?: RoutedConnectionRefused;
    };

interface ControlActivation {
  request: RoutedControlAttachRequest;
  demandSequence: number;
  lastDemand: RoutedSourceDemand;
}

/** One geometry request still owed its reply, oldest first. */
interface PendingGeometryReply {
  activationId: string;
  request: RoutedGeometryRequest;
  /** A release only: the sequence of the heartbeat sent right behind it. */
  fence?: number;
}

interface ControlConnection {
  cellBootId: string;
  controlUrl: string;
  transportGrant: RoutedCellTransportGrant;
  capabilities: string[];
  socket: WebSocket;
  accepted?: RoutedConnectionAccepted;
  activationIds: Set<string>;
  pendingGeometry: PendingGeometryReply[];
  replacements: Map<string, ControlReplacement>;
  heartbeatSequence: number;
  heartbeatAckSequence: number;
  heartbeatTimer?: number;
  heartbeatDeadlineTimer?: number;
  refusal?: RoutedConnectionRefused;
}

/** One cell-side identity per session, not a history of DOM mounts. Retained
 * after demand-none until replacement, cell revocation, or connection death. */
interface ControlReplacement {
  admitted?: string;
  pending?: RoutedControlAttachRequest;
  queued?: ControlActivation;
}

const socketOpen = 1;
const socketClosing = 2;

/** Main/input-thread T1 control connection pool. */
export class RoutedControlTransport {
  readonly #socketFactory: (url: string) => WebSocket;
  readonly #emit: (event: RoutedControlTransportEvent) => void;
  readonly #acceptExtensionMessages: boolean;
  readonly #connections = new Map<string, ControlConnection>();
  readonly #activations = new Map<string, ControlActivation>();
  #disposed = false;

  constructor(options: {
    socketFactory?: (url: string) => WebSocket;
    emit: (event: RoutedControlTransportEvent) => void;
    acceptExtensionMessages?: boolean;
  }) {
    this.#socketFactory = options.socketFactory ?? ((url) => new WebSocket(url));
    this.#emit = options.emit;
    this.#acceptExtensionMessages = options.acceptExtensionMessages ?? false;
  }

  attach(request: RoutedControlAttachRequest): void {
    if (this.#disposed) return;
    const claims = request.attachGrant.claims;
    if (
      claims.sessionId.length === 0 ||
      request.activationId.length === 0 ||
      claims.audienceCellBootId !== request.cellBootId ||
      request.transportGrant.claims.audienceCellBootId !== request.cellBootId
    ) {
      throw new Error("Routed control attach grant does not match the requested cell");
    }
    const existing = this.#activations.get(request.activationId);
    if (existing) this.detach(request.activationId);
    const activation: ControlActivation = { request, demandSequence: 0, lastDemand: request.initialDemand };
    this.#activations.set(request.activationId, activation);
    const connection = this.#connection(request);
    connection.activationIds.add(request.activationId);
    if (connection.accepted) this.#sendAttach(connection, activation);
  }

  renew(activationId: string, attachGrant: RoutedSessionAttachGrant): void {
    const activation = this.#activations.get(activationId);
    if (!activation) return;
    const request = { ...activation.request };
    delete request.replacesActivationId;
    activation.request = { ...request, attachGrant };
    const connection = this.#connections.get(activation.request.cellBootId);
    if (connection?.accepted) this.#sendAttach(connection, activation);
  }

  declareDemand(activationId: string, demand: RoutedSourceDemand): number | undefined {
    const activation = this.#activations.get(activationId);
    if (!activation) return undefined;
    activation.lastDemand = demand;
    const connection = this.#connections.get(activation.request.cellBootId);
    if (!connection?.accepted) return undefined;
    const replacement = connection.replacements.get(activation.request.attachGrant.claims.sessionId);
    if (
      activation.request.replacePreviousActivation &&
      replacement?.pending?.activationId !== activationId &&
      replacement?.admitted !== activationId
    )
      return undefined;
    activation.demandSequence += 1;
    const body: RoutedDeclareDemand = {
      sessionId: activation.request.attachGrant.claims.sessionId,
      activationId,
      leaseEpoch: activation.request.attachGrant.claims.leaseEpoch ?? 0,
      demandSequence: activation.demandSequence,
      demand,
    };
    this.#send(connection, encodeRoutedMessage("DeclareDemand", body));
    return activation.demandSequence;
  }

  /** `context` comes back unchanged on the reply this claim earns. */
  claimGeometry(activationId: string, claim: RoutedClaimGeometry, context?: unknown): boolean {
    if (claim.activationId !== activationId) return false;
    return this.#sendGeometry(activationId, encodeRoutedMessage("ClaimGeometry", claim), {
      kind: "claim",
      ...(context === undefined ? {} : { context }),
    });
  }

  /**
   * T1 answers a release only when it refuses it; a success has no body. A
   * heartbeat sent right behind the release fences it: the cell answers a
   * control leg in order, so a refusal arrives before that heartbeat's ack
   * and the ack alone proves a success. Without the fence a refused release
   * would take the next claim's or transfer's reply as its own. Refusals are
   * routine once another client can take the seat, because a release names
   * the holder this client last knew.
   */
  releaseGeometry(activationId: string, release: RoutedReleaseGeometry): boolean {
    if (release.activationId !== activationId) return false;
    const activation = this.#activations.get(activationId);
    const connection = activation ? this.#connections.get(activation.request.cellBootId) : undefined;
    if (!connection || !this.#sendActivation(activationId, encodeRoutedMessage("ReleaseGeometry", release))) {
      return false;
    }
    const fence = this.#sendHeartbeat(connection);
    if (fence !== undefined) connection.pendingGeometry.push({ activationId, request: { kind: "release" }, fence });
    return true;
  }

  /** `context` comes back unchanged on the reply this transfer earns. */
  transferGeometry(activationId: string, transfer: RoutedTransferGeometry, context?: unknown): boolean {
    if (transfer.activationId !== activationId) return false;
    return this.#sendGeometry(activationId, encodeRoutedMessage("TransferGeometry", transfer), {
      kind: "transfer",
      ...(context === undefined ? {} : { context }),
    });
  }

  /**
   * Extension seam for a future terminal-input wire verb. The current T1
   * contract publishes no such tag, so Ghosttea never invents one itself.
   */
  sendExtension(activationId: string, message: Readonly<Record<string, unknown>>): boolean {
    if (typeof message.type !== "string" || message.type.length === 0) return false;
    return this.#sendActivation(activationId, JSON.stringify(message));
  }

  detach(activationId: string): void {
    const activation = this.#activations.get(activationId);
    if (!activation) return;
    this.declareDemand(activationId, { mode: "none" });
    this.#activations.delete(activationId);
    const connection = this.#connections.get(activation.request.cellBootId);
    connection?.activationIds.delete(activationId);
    const replacement = connection?.replacements.get(activation.request.attachGrant.claims.sessionId);
    if (replacement?.queued === activation) delete replacement.queued;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const activationId of [...this.#activations.keys()]) this.detach(activationId);
    for (const connection of this.#connections.values()) {
      if (connection.heartbeatTimer !== undefined) clearTimeout(connection.heartbeatTimer);
      if (connection.heartbeatDeadlineTimer !== undefined) clearTimeout(connection.heartbeatDeadlineTimer);
      if (connection.socket.readyState < socketClosing) connection.socket.close(1000, "runtime-destroyed");
    }
    this.#connections.clear();
  }

  #connection(request: RoutedControlAttachRequest): ControlConnection {
    const existing = this.#connections.get(request.cellBootId);
    if (
      existing &&
      existing.controlUrl === request.controlUrl &&
      existing.transportGrant.claims.connectionSetId === request.transportGrant.claims.connectionSetId &&
      existing.socket.readyState < socketClosing
    ) {
      return existing;
    }
    if (existing) this.#closeConnection(existing, 1000, "connection-replaced", true);
    const socket = this.#socketFactory(request.controlUrl);
    const connection: ControlConnection = {
      cellBootId: request.cellBootId,
      controlUrl: request.controlUrl,
      transportGrant: request.transportGrant,
      capabilities: request.capabilities ?? ["resume"],
      socket,
      activationIds: new Set(),
      pendingGeometry: [],
      replacements: new Map(),
      heartbeatSequence: 0,
      heartbeatAckSequence: 0,
    };
    this.#connections.set(request.cellBootId, connection);
    socket.addEventListener("open", () => this.#hello(connection));
    socket.addEventListener("message", (event) => this.#message(connection, event));
    socket.addEventListener("close", (event) => this.#closed(connection, event.code, event.reason));
    socket.addEventListener("error", () => undefined);
    return connection;
  }

  #hello(connection: ControlConnection): void {
    this.#send(
      connection,
      encodeRoutedMessage("ConnectionHello", {
        protocolMajor: ROUTED_PROTOCOL_VERSION.major,
        protocolMinor: ROUTED_PROTOCOL_VERSION.minor,
        channel: "control",
        transportGrant: connection.transportGrant,
        capabilities: connection.capabilities,
      }),
    );
  }

  #message(connection: ControlConnection, event: MessageEvent): void {
    if (this.#connections.get(connection.cellBootId) !== connection) return;
    if (typeof event.data !== "string") {
      this.#closeConnection(connection, 4003, "binary on control leg", true);
      return;
    }
    const maxBytes = connection.accepted?.protocolLimits.maxControlMessageBytes ?? 262_144;
    if (new TextEncoder().encode(event.data).byteLength > maxBytes) {
      this.#closeConnection(connection, 4003, "control message too large", true);
      return;
    }
    const decoded = decodeRoutedMessage(event.data, ROUTED_LEG_OUTBOUND.control);
    if (!decoded.ok) {
      if (decoded.error === "unknown-type" && connection.accepted && this.#acceptExtensionMessages) {
        this.#emit({
          type: "extension-message",
          message: JSON.parse(event.data) as Readonly<Record<string, unknown>>,
          context: {
            cellBootId: connection.cellBootId,
            connectionSetId: connection.accepted.connectionSetId,
            channel: "control",
          },
        });
        return;
      }
      this.#closeConnection(connection, 4003, `invalid control message: ${decoded.error}`, true);
      return;
    }
    const message = decoded.message;
    if (message.type === "ConnectionAccepted") {
      if (
        connection.accepted ||
        message.channel !== "control" ||
        message.connectionSetId !== connection.transportGrant.claims.connectionSetId ||
        message.selectedProtocolVersion.major !== ROUTED_PROTOCOL_VERSION.major ||
        message.selectedProtocolVersion.minor > ROUTED_PROTOCOL_VERSION.minor ||
        message.capabilities.some((capability) => !connection.capabilities.includes(capability))
      ) {
        this.#closeConnection(connection, 4003, "invalid control acceptance", true);
        return;
      }
      connection.accepted = message;
      this.#emit({ type: "transport-ready", cellBootId: connection.cellBootId, accepted: message });
      this.#armHeartbeatDeadline(connection);
      this.#scheduleHeartbeat(connection);
      for (const activationId of connection.activationIds) {
        const activation = this.#activations.get(activationId);
        if (activation) this.#sendAttach(connection, activation);
      }
      return;
    }
    if (message.type === "ConnectionRefused") {
      connection.refusal = message;
      this.#closeConnection(connection, 1000, message.code, true);
      return;
    }
    if (!connection.accepted) {
      this.#closeConnection(connection, 4003, "message before ConnectionAccepted", true);
      return;
    }
    if (message.type === "LegHeartbeatAck") {
      if (message.sequence > connection.heartbeatSequence) {
        this.#closeConnection(connection, ROUTED_CLOSE_CODES.PROTOCOL, "heartbeat ack is ahead", true);
        return;
      }
      if (message.sequence > connection.heartbeatAckSequence) {
        connection.heartbeatAckSequence = message.sequence;
        this.#armHeartbeatDeadline(connection);
      }
      // The ack follows every reply to what was sent before its heartbeat, so
      // a release fenced by it that drew no refusal succeeded.
      connection.pendingGeometry = connection.pendingGeometry.filter(
        (pending) => pending.fence === undefined || pending.fence > message.sequence,
      );
      return;
    }
    if (message.type === "ControlLegAttached") {
      const replacement = connection.replacements.get(message.sessionId);
      const pending = replacement?.pending;
      if (replacement && pending?.activationId === message.activationId) {
        if (
          message.grantGenerationAccepted !== pending.attachGrant.claims.grantGeneration ||
          message.rights.some((right) => !pending.attachGrant.claims.rights.includes(right))
        ) {
          this.#closeConnection(connection, ROUTED_CLOSE_CODES.PROTOCOL, "control attach binding mismatch", true);
          return;
        }
        replacement.admitted = message.activationId;
        delete replacement.pending;
        // Detach retires the UI consumer, not the cell's identity. A late ACK
        // still resolves a queued replacement, but must not resurrect a view.
        if (connection.activationIds.has(message.activationId)) {
          this.#emit({ type: "control-attached", attached: message });
        }
        this.#drainReplacement(connection, message.sessionId, replacement);
        return;
      }
      const activation = this.#activations.get(message.activationId);
      if (!connection.activationIds.has(message.activationId) && !activation) return;
      if (
        !activation ||
        !connection.activationIds.has(message.activationId) ||
        message.sessionId !== activation.request.attachGrant.claims.sessionId ||
        message.grantGenerationAccepted !== activation.request.attachGrant.claims.grantGeneration ||
        message.rights.some((right) => !activation.request.attachGrant.claims.rights.includes(right))
      ) {
        this.#closeConnection(connection, ROUTED_CLOSE_CODES.PROTOCOL, "control attach binding mismatch", true);
        return;
      }
      this.#emit({ type: "control-attached", attached: message });
      return;
    }
    if (message.type === "AttachRefused") {
      for (const [sessionId, replacement] of connection.replacements) {
        if (message.activationId === undefined || replacement.pending?.activationId !== message.activationId) continue;
        // A refused attempt never became the native predecessor. Keep the
        // admitted id, even if this reply arrives after that attempt detached.
        delete replacement.pending;
        if (connection.activationIds.has(message.activationId)) {
          this.#emit({
            type: "attach-refused",
            activationId: message.activationId,
            code: message.code,
            retryable: message.retryable,
          });
        }
        this.#drainReplacement(connection, sessionId, replacement);
        return;
      }
      if (message.activationId !== undefined && !connection.activationIds.has(message.activationId)) {
        if (!this.#activations.has(message.activationId)) return;
        this.#closeConnection(connection, ROUTED_CLOSE_CODES.PROTOCOL, "attach refusal binding mismatch", true);
        return;
      }
      this.#emit({
        type: "attach-refused",
        ...(message.activationId === undefined ? {} : { activationId: message.activationId }),
        code: message.code,
        retryable: message.retryable,
      });
      return;
    }
    if (message.type === "CellActivationStatus") {
      const replacement = connection.replacements.get(message.sessionId);
      if (replacement?.admitted === message.activationId && message.presentation.state === "revoked") {
        delete replacement.admitted;
        if (!replacement.pending && !replacement.queued) connection.replacements.delete(message.sessionId);
      }
      const activation = this.#activations.get(message.activationId);
      if (!connection.activationIds.has(message.activationId) && !activation) return;
      if (
        !activation ||
        !connection.activationIds.has(message.activationId) ||
        message.sessionId !== activation.request.attachGrant.claims.sessionId
      ) {
        this.#closeConnection(connection, ROUTED_CLOSE_CODES.PROTOCOL, "cell status binding mismatch", true);
        return;
      }
      this.#emit({ type: "cell-status", status: message });
      return;
    }
    if (message.type === "DemandAccepted") {
      const activationId = this.#activationForDemand(connection, message.demandSequence);
      this.#emit({
        type: "demand-accepted",
        ...(activationId === undefined ? {} : { activationId }),
        demandSequence: message.demandSequence,
      });
      return;
    }
    if (message.type === "GeometryCommitted") {
      const pending = this.#geometryReplyTarget(connection, false);
      this.#emit({
        type: "geometry-committed",
        ...(pending === undefined ? {} : { activationId: pending.activationId, request: pending.request }),
        committed: message,
      });
      return;
    }
    if (message.type === "GeometryRefused") {
      const pending = this.#geometryReplyTarget(connection, true);
      this.#emit({
        type: "geometry-refused",
        ...(pending === undefined ? {} : { activationId: pending.activationId, request: pending.request }),
        refused: message,
      });
      return;
    }
    this.#closeConnection(connection, 4003, `unexpected control message ${message.type}`, true);
  }

  #activationForDemand(connection: ControlConnection, sequence: number): string | undefined {
    for (const activationId of connection.activationIds) {
      if (this.#activations.get(activationId)?.demandSequence === sequence) return activationId;
    }
    return undefined;
  }

  #sendAttach(connection: ControlConnection, activation: ControlActivation): void {
    let replacesActivationId = activation.request.replacesActivationId;
    if (activation.request.replacePreviousActivation) {
      const sessionId = activation.request.attachGrant.claims.sessionId;
      let replacement = connection.replacements.get(sessionId);
      if (!replacement) {
        replacement = {};
        connection.replacements.set(sessionId, replacement);
      }
      if (replacement.pending) {
        replacement.queued = activation;
        return;
      }
      replacement.pending = activation.request;
      replacesActivationId =
        replacement.admitted === activation.request.activationId ? undefined : replacement.admitted;
    }
    this.#send(
      connection,
      encodeRoutedMessage("AttachControlLeg", {
        activationId: activation.request.activationId,
        attachGrant: activation.request.attachGrant,
        ...(replacesActivationId === undefined ? {} : { replacesActivationId }),
        initialDemand: activation.lastDemand,
      }),
    );
  }

  #drainReplacement(connection: ControlConnection, sessionId: string, replacement: ControlReplacement): void {
    const queued = replacement.queued;
    delete replacement.queued;
    if (
      queued &&
      this.#connections.get(connection.cellBootId) === connection &&
      this.#activations.get(queued.request.activationId) === queued
    ) {
      this.#sendAttach(connection, queued);
    }
    if (!replacement.admitted && !replacement.pending && !replacement.queued) connection.replacements.delete(sessionId);
  }

  #sendActivation(activationId: string, text: string): boolean {
    const activation = this.#activations.get(activationId);
    if (!activation) return false;
    const connection = this.#connections.get(activation.request.cellBootId);
    if (!connection?.accepted) return false;
    const bytes = new TextEncoder().encode(text).byteLength;
    if (bytes > connection.accepted.protocolLimits.maxControlMessageBytes) return false;
    this.#send(connection, text);
    return true;
  }

  #sendGeometry(activationId: string, text: string, request: RoutedGeometryRequest): boolean {
    const activation = this.#activations.get(activationId);
    if (!activation) return false;
    const connection = this.#connections.get(activation.request.cellBootId);
    if (!connection || !this.#sendActivation(activationId, text)) return false;
    connection.pendingGeometry.push({ activationId, request });
    return true;
  }

  /**
   * The oldest request a geometry reply can answer. A release still waiting
   * on its fence is answered only by a refusal, so a commit passes it: the
   * release succeeded, and the commit belongs to a later request.
   */
  #geometryReplyTarget(connection: ControlConnection, refusal: boolean): PendingGeometryReply | undefined {
    if (!refusal) {
      while (connection.pendingGeometry[0]?.request.kind === "release") connection.pendingGeometry.shift();
    }
    return connection.pendingGeometry.shift();
  }

  #sendHeartbeat(connection: ControlConnection): number | undefined {
    if (!connection.accepted || connection.socket.readyState !== socketOpen) return undefined;
    connection.heartbeatSequence += 1;
    this.#send(
      connection,
      encodeRoutedMessage("LegHeartbeat", {
        connectionSetId: connection.accepted.connectionSetId,
        channel: "control",
        legGeneration: connection.accepted.legGeneration,
        sequence: connection.heartbeatSequence,
      }),
    );
    return connection.heartbeatSequence;
  }

  #scheduleHeartbeat(connection: ControlConnection): void {
    if (connection.heartbeatTimer !== undefined) clearTimeout(connection.heartbeatTimer);
    connection.heartbeatTimer = setTimeout(
      () => {
        if (this.#sendHeartbeat(connection) === undefined) return;
        this.#scheduleHeartbeat(connection);
      },
      Math.max(
        100,
        Math.min(
          ROUTED_DOOR_LIMITS.heartbeatIntervalMs,
          Math.floor((connection.accepted?.heartbeatTtlMs ?? ROUTED_DOOR_LIMITS.heartbeatTtlMs) / 3),
        ),
      ),
    );
  }

  #armHeartbeatDeadline(connection: ControlConnection): void {
    if (connection.heartbeatDeadlineTimer !== undefined) clearTimeout(connection.heartbeatDeadlineTimer);
    const ttl = connection.accepted?.heartbeatTtlMs ?? ROUTED_DOOR_LIMITS.heartbeatTtlMs;
    connection.heartbeatDeadlineTimer = setTimeout(() => {
      if (this.#connections.get(connection.cellBootId) !== connection) return;
      this.#closeConnection(connection, ROUTED_CLOSE_CODES.LEG_TIMEOUT, "heartbeat timeout", true);
    }, ttl);
  }

  #send(connection: ControlConnection, text: string): void {
    if (connection.socket.readyState === socketOpen) connection.socket.send(text);
  }

  #closeConnection(connection: ControlConnection, code: number, reason: string, closeSocket: boolean): void {
    if (connection.heartbeatTimer !== undefined) clearTimeout(connection.heartbeatTimer);
    if (connection.heartbeatDeadlineTimer !== undefined) clearTimeout(connection.heartbeatDeadlineTimer);
    if (closeSocket && connection.socket.readyState < socketClosing)
      connection.socket.close(code, reason.slice(0, 123));
    this.#closed(connection, code, reason);
  }

  #closed(connection: ControlConnection, code: number, reason: string): void {
    if (this.#connections.get(connection.cellBootId) !== connection) return;
    this.#connections.delete(connection.cellBootId);
    if (connection.heartbeatTimer !== undefined) clearTimeout(connection.heartbeatTimer);
    if (connection.heartbeatDeadlineTimer !== undefined) clearTimeout(connection.heartbeatDeadlineTimer);
    this.#emit({
      type: "transport-closed",
      cellBootId: connection.cellBootId,
      code,
      reason,
      activationIds: [...connection.activationIds],
      preAuth: connection.refusal === undefined && connection.accepted === undefined && code === 1008,
      ...(connection.refusal === undefined ? {} : { refusal: connection.refusal }),
    });
  }
}
