import {
  DEFAULT_ROUTED_RECEIVER_CAPACITIES,
  ROUTED_CLOSE_CODES,
  ROUTED_DOOR_LIMITS,
  ROUTED_LEG_OUTBOUND,
  ROUTED_PROTOCOL_VERSION,
  compareRoutedSceneContent,
  decodeRoutedMessage,
  decodeRoutedPresentationEnvelope,
  encodeRoutedMessage,
  routedCrc32c,
  type RoutedAttachFramesLeg,
  type RoutedCellTransportGrant,
  type RoutedConnectionAccepted,
  type RoutedConnectionRefused,
  type RoutedFramesLegAttached,
  type RoutedPresentationEnvelopeHeader,
  type RoutedPresentationStatus,
  type RoutedProtocolLimits,
  type RoutedReceiverCapacities,
  type RoutedResumeRequest,
  type RoutedSceneContentStamp,
  type RoutedSessionAttachGrant,
  type RoutedTrfIdentity,
} from "@vibecook/ghosttea-protocol";

export interface RoutedFramesAttachRequest {
  cellBootId: string;
  /** Scene key already used by the mounted surfaces for this session. */
  sessionHandle: string;
  framesUrl: string;
  transportGrant: RoutedCellTransportGrant;
  attachGrant: RoutedSessionAttachGrant;
  activationId: string;
  replacesActivationId?: string;
  resume?: RoutedResumeRequest;
  receiverCapacities?: RoutedReceiverCapacities;
  capabilities?: string[];
}

export type RoutedFramesTransportEvent =
  | { type: "frames-attached"; attached: RoutedFramesLegAttached }
  | { type: "attach-refused"; activationId?: string; code: string; retryable: boolean }
  | {
      type: "frames-state";
      activationId: string;
      state: "attaching" | "resuming" | "seeding" | "applying" | "active" | "failed";
      resumeToken?: string;
      appliedContent?: RoutedSceneContentStamp;
      reason?: string;
    }
  | { type: "presentation-status"; status: RoutedPresentationStatus }
  | {
      type: "transport-closed";
      cellBootId: string;
      code: number;
      reason: string;
      activationIds: string[];
      preAuth: boolean;
      refusal?: RoutedConnectionRefused;
    };

export interface RoutedAppliedFrame {
  sessionHandle: string;
  viewHandle: string;
  cols: number;
  rows: number;
}

export interface RoutedExpectedLayout {
  cols: number;
  rows: number;
  scrollbackRows: number;
}

export interface RoutedFramesTransportOptions {
  socketFactory?: (url: string) => WebSocket;
  applyFrame: (
    packet: ArrayBuffer,
    identity: RoutedTrfIdentity,
    expectedLayout?: RoutedExpectedLayout,
    glyphNamespace?: string,
  ) => RoutedAppliedFrame;
  emit: (event: RoutedFramesTransportEvent) => void;
  creditReturned?: (bytes: number) => void;
}

interface StagedTransfer {
  transferId: string;
  kind: "seed" | "catchup";
  bytes: Uint8Array;
  chunkCount: number;
  chunks: Set<number>;
  ranges: Array<{ start: number; end: number }>;
  checksum: number;
  targetLayout: { cols: number; rows: number; scrollbackRows: number };
  baseContent: RoutedSceneContentStamp | null;
  resultContent: RoutedSceneContentStamp;
}

interface FramesActivation {
  request: RoutedFramesAttachRequest;
  sessionId: string;
  leaseEpoch: number;
  identity?: RoutedTrfIdentity;
  resumeToken?: string;
  appliedContent?: RoutedSceneContentStamp;
  lastActivationSequence: number;
  workerStatusSequence: number;
  transfer?: StagedTransfer;
  sceneRefreshTimer?: number;
  presentationRefreshTimer?: number;
}

interface FramesConnection {
  cellBootId: string;
  framesUrl: string;
  transportGrant: RoutedCellTransportGrant;
  receiverCapacities: RoutedReceiverCapacities;
  capabilities: string[];
  socket: WebSocket;
  accepted?: RoutedConnectionAccepted;
  activationIds: Set<string>;
  heartbeatSequence: number;
  heartbeatAckSequence: number;
  heartbeatTimer?: number;
  heartbeatDeadlineTimer?: number;
  creditSequence: number;
  connectionBytesReturned: number;
  connectionBytesReported: number;
  accountBytesReturned: Map<string, number>;
  accountDrainTimers: Map<string, number>;
  creditTimer?: number;
  refusal?: RoutedConnectionRefused;
}

const socketOpen = 1;
const socketClosing = 2;

function exactStamp(left: RoutedSceneContentStamp | undefined, right: RoutedSceneContentStamp): boolean {
  return left !== undefined && compareRoutedSceneContent(left, right) === 0;
}

function copyArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = bytes.slice();
  return copy.buffer as ArrayBuffer;
}

function capacitiesFitWithin(accepted: RoutedReceiverCapacities, advertised: RoutedReceiverCapacities): boolean {
  return (
    accepted.connectionCreditBytes <= advertised.connectionCreditBytes &&
    accepted.perActivationCreditBytes <= advertised.perActivationCreditBytes &&
    accepted.stagingBytesPerSession <= advertised.stagingBytesPerSession &&
    accepted.stagingBytesTotal <= advertised.stagingBytesTotal &&
    accepted.maxConcurrentActivations <= advertised.maxConcurrentActivations &&
    accepted.maxConcurrentSeeds <= advertised.maxConcurrentSeeds
  );
}

/** Worker-owned T1 frames connection pool. It never posts presentation bytes to main. */
export class RoutedFramesTransport {
  readonly #socketFactory: (url: string) => WebSocket;
  readonly #applyFrame: RoutedFramesTransportOptions["applyFrame"];
  readonly #emit: RoutedFramesTransportOptions["emit"];
  readonly #creditReturned: ((bytes: number) => void) | undefined;
  readonly #connections = new Map<string, FramesConnection>();
  readonly #activations = new Map<string, FramesActivation>();
  #stagingBytes = 0;
  #disposed = false;

  constructor(options: RoutedFramesTransportOptions) {
    this.#socketFactory = options.socketFactory ?? ((url) => new WebSocket(url));
    this.#applyFrame = options.applyFrame;
    this.#emit = options.emit;
    this.#creditReturned = options.creditReturned;
  }

  attach(request: RoutedFramesAttachRequest): void {
    if (this.#disposed) return;
    const claims = request.attachGrant.claims;
    if (
      claims.sessionId.length === 0 ||
      request.activationId.length === 0 ||
      !/^(0|[1-9][0-9]*)$/.test(request.sessionHandle) ||
      claims.audienceCellBootId !== request.cellBootId ||
      request.transportGrant.claims.audienceCellBootId !== request.cellBootId
    ) {
      throw new Error("Routed frames attach grant does not match the requested cell");
    }
    const previous = this.#activations.get(request.activationId);
    if (
      previous?.appliedContent !== undefined &&
      request.resume !== undefined &&
      !exactStamp(previous.appliedContent, request.resume.from)
    ) {
      throw new Error("Routed frames resume does not name the worker's applied scene");
    }
    const appliedContent = request.resume?.from ?? previous?.appliedContent;
    const lastActivationSequence = previous?.lastActivationSequence ?? -1;
    const workerStatusSequence = previous?.workerStatusSequence ?? 0;
    if (previous) this.detach(request.activationId);
    const activation: FramesActivation = {
      request,
      sessionId: claims.sessionId,
      leaseEpoch: claims.leaseEpoch ?? 0,
      ...(appliedContent === undefined ? {} : { appliedContent }),
      lastActivationSequence,
      workerStatusSequence,
    };
    this.#activations.set(request.activationId, activation);
    this.#emit({ type: "frames-state", activationId: request.activationId, state: "attaching" });
    const connection = this.#connection(request);
    connection.activationIds.add(request.activationId);
    if (connection.accepted) this.#sendAttach(connection, activation);
  }

  detach(activationId: string): void {
    const activation = this.#activations.get(activationId);
    if (!activation) return;
    this.#releaseTransfer(activation);
    if (activation.sceneRefreshTimer !== undefined) clearTimeout(activation.sceneRefreshTimer);
    if (activation.presentationRefreshTimer !== undefined) clearTimeout(activation.presentationRefreshTimer);
    this.#activations.delete(activationId);
    const connection = this.#connections.get(activation.request.cellBootId);
    if (connection) {
      connection.activationIds.delete(activationId);
      this.#scheduleAccountDrain(connection, activationId);
    }
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const activationId of [...this.#activations.keys()]) this.detach(activationId);
    for (const connection of this.#connections.values()) {
      if (connection.heartbeatTimer !== undefined) clearTimeout(connection.heartbeatTimer);
      if (connection.heartbeatDeadlineTimer !== undefined) clearTimeout(connection.heartbeatDeadlineTimer);
      if (connection.creditTimer !== undefined) clearTimeout(connection.creditTimer);
      for (const timer of connection.accountDrainTimers.values()) clearTimeout(timer);
      if (connection.socket.readyState < socketClosing) connection.socket.close(1000, "runtime-destroyed");
    }
    this.#connections.clear();
  }

  #connection(request: RoutedFramesAttachRequest): FramesConnection {
    const existing = this.#connections.get(request.cellBootId);
    if (
      existing &&
      existing.framesUrl === request.framesUrl &&
      existing.transportGrant.claims.connectionSetId === request.transportGrant.claims.connectionSetId &&
      existing.socket.readyState < socketClosing
    ) {
      return existing;
    }
    if (existing) this.#closeConnection(existing, 1000, "connection-replaced", true);
    const socket = this.#socketFactory(request.framesUrl);
    socket.binaryType = "arraybuffer";
    const connection: FramesConnection = {
      cellBootId: request.cellBootId,
      framesUrl: request.framesUrl,
      transportGrant: request.transportGrant,
      receiverCapacities: request.receiverCapacities ?? DEFAULT_ROUTED_RECEIVER_CAPACITIES,
      capabilities: request.capabilities ?? ["resume"],
      socket,
      activationIds: new Set(),
      heartbeatSequence: 0,
      heartbeatAckSequence: 0,
      creditSequence: 0,
      connectionBytesReturned: 0,
      connectionBytesReported: 0,
      accountBytesReturned: new Map(),
      accountDrainTimers: new Map(),
    };
    this.#connections.set(request.cellBootId, connection);
    socket.addEventListener("open", () => this.#hello(connection));
    socket.addEventListener("message", (event) => void this.#message(connection, event));
    socket.addEventListener("close", (event) => this.#closed(connection, event.code, event.reason));
    socket.addEventListener("error", () => {
      // The close event carries the protocol-classifying code. Browsers expose
      // no useful error detail here and logging a grant-bearing request is forbidden.
    });
    return connection;
  }

  #hello(connection: FramesConnection): void {
    this.#send(
      connection,
      encodeRoutedMessage("ConnectionHello", {
        protocolMajor: ROUTED_PROTOCOL_VERSION.major,
        protocolMinor: ROUTED_PROTOCOL_VERSION.minor,
        channel: "frames",
        transportGrant: connection.transportGrant,
        receiverCapacities: connection.receiverCapacities,
        capabilities: connection.capabilities,
      }),
    );
  }

  async #message(connection: FramesConnection, event: MessageEvent): Promise<void> {
    if (this.#connections.get(connection.cellBootId) !== connection) return;
    if (typeof event.data === "string") {
      this.#text(connection, event.data);
      return;
    }
    let bytes: Uint8Array;
    if (event.data instanceof ArrayBuffer) bytes = new Uint8Array(event.data);
    else if (ArrayBuffer.isView(event.data)) {
      bytes = new Uint8Array(event.data.buffer, event.data.byteOffset, event.data.byteLength);
    } else if (event.data instanceof Blob) {
      bytes = new Uint8Array(await event.data.arrayBuffer());
    } else {
      this.#protocolFailure(connection, undefined, 0, "unsupported binary message");
      return;
    }
    this.#binary(connection, bytes);
  }

  #text(connection: FramesConnection, text: string): void {
    const maxBytes = connection.accepted?.protocolLimits.maxControlMessageBytes ?? 262_144;
    if (new TextEncoder().encode(text).byteLength > maxBytes) {
      this.#protocolFailure(connection, undefined, 0, "frames control message too large");
      return;
    }
    const decoded = decodeRoutedMessage(text, ROUTED_LEG_OUTBOUND.frames);
    if (!decoded.ok) {
      this.#protocolFailure(connection, undefined, 0, `invalid frames message: ${decoded.error}`);
      return;
    }
    const message = decoded.message;
    if (message.type === "ConnectionAccepted") {
      if (
        connection.accepted ||
        message.channel !== "frames" ||
        message.connectionSetId !== connection.transportGrant.claims.connectionSetId ||
        message.selectedProtocolVersion.major !== ROUTED_PROTOCOL_VERSION.major ||
        message.selectedProtocolVersion.minor > ROUTED_PROTOCOL_VERSION.minor ||
        message.capabilities.some((capability) => !connection.capabilities.includes(capability)) ||
        message.creditEpoch === undefined ||
        message.initialWindows === undefined ||
        !capacitiesFitWithin(message.initialWindows, connection.receiverCapacities)
      ) {
        this.#protocolFailure(connection, undefined, 0, "invalid frames acceptance");
        return;
      }
      connection.accepted = message;
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
      this.#protocolFailure(connection, undefined, 0, "message before ConnectionAccepted");
      return;
    }
    if (message.type === "LegHeartbeatAck") {
      if (message.sequence > connection.heartbeatSequence) {
        this.#protocolFailure(connection, undefined, 0, "heartbeat ack is ahead");
        return;
      }
      if (message.sequence > connection.heartbeatAckSequence) {
        connection.heartbeatAckSequence = message.sequence;
        this.#armHeartbeatDeadline(connection);
      }
      return;
    }
    if (message.type === "AttachRefused") {
      if (message.activationId !== undefined && !connection.activationIds.has(message.activationId)) {
        if (!this.#activations.has(message.activationId)) return;
        this.#protocolFailure(connection, undefined, 0, "attach refusal binding mismatch");
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
    if (message.type === "FramesLegAttached") {
      const activation = this.#activations.get(message.activationId);
      if (!connection.activationIds.has(message.activationId) && !activation) return;
      const duplicateIdentity = [...connection.activationIds].some((activationId) => {
        if (activationId === message.activationId) return false;
        const identity = this.#activations.get(activationId)?.identity;
        return (
          identity?.sessionHandle === message.trfIdentity.sessionHandle &&
          identity.viewHandle === message.trfIdentity.viewHandle
        );
      });
      if (
        !activation ||
        !connection.activationIds.has(message.activationId) ||
        message.sessionId !== activation.sessionId ||
        message.trfIdentity.sessionHandle !== activation.request.sessionHandle ||
        duplicateIdentity ||
        (message.outcome.kind === "resume-accepted" &&
          (!connection.accepted.capabilities.includes("resume") ||
            activation.request.resume === undefined ||
            message.outcome.from === undefined ||
            !exactStamp(activation.request.resume.from, message.outcome.from)))
      ) {
        this.#protocolFailure(connection, message.activationId, 0, "frames attach identity mismatch");
        return;
      }
      activation.identity = message.trfIdentity;
      activation.resumeToken = message.resumeToken;
      this.#emit({ type: "frames-attached", attached: message });
      this.#emit({
        type: "frames-state",
        activationId: message.activationId,
        state: message.outcome.kind === "resume-accepted" ? "resuming" : "seeding",
        resumeToken: message.resumeToken,
      });
      this.#reportPresentation(
        connection,
        activation,
        message.outcome.kind === "resume-accepted" ? "recovering" : "seeding",
      );
      return;
    }
    this.#protocolFailure(connection, undefined, 0, `unexpected frames message ${message.type}`);
  }

  #sendAttach(connection: FramesConnection, activation: FramesActivation): void {
    const resume = connection.accepted?.capabilities.includes("resume") ? activation.request.resume : undefined;
    const body: RoutedAttachFramesLeg = {
      activationId: activation.request.activationId,
      attachGrant: activation.request.attachGrant,
      ...(resume === undefined ? {} : { resume }),
    };
    this.#send(connection, encodeRoutedMessage("AttachFramesLeg", body));
  }

  #binary(connection: FramesConnection, bytes: Uint8Array): void {
    if (!connection.accepted) {
      this.#protocolFailure(connection, undefined, bytes.byteLength, "binary message before acceptance");
      return;
    }
    const decoded = decodeRoutedPresentationEnvelope(bytes);
    if (!decoded.ok) {
      this.#protocolFailure(connection, undefined, bytes.byteLength, `bad envelope: ${decoded.error}`);
      return;
    }
    const { header, payload } = decoded.envelope;
    if (header.creditEpoch !== connection.accepted.creditEpoch) {
      this.#protocolFailure(connection, header.activationId, decoded.chargedBytes, "credit epoch mismatch");
      return;
    }
    if (header.profiling !== undefined && !connection.accepted.capabilities.includes("profiling-envelope")) {
      this.#protocolFailure(connection, header.activationId, decoded.chargedBytes, "unnegotiated profiling envelope");
      return;
    }
    if (header.kind === "calibration") {
      if (payload.byteLength !== 0) {
        this.#protocolFailure(connection, undefined, decoded.chargedBytes, "calibration payload is not empty");
        return;
      }
      const sequence = header.calibration!.sequence;
      if (sequence > connection.heartbeatSequence) {
        this.#protocolFailure(connection, undefined, decoded.chargedBytes, "calibration echo is ahead");
        return;
      }
      if (sequence > connection.heartbeatAckSequence) {
        connection.heartbeatAckSequence = sequence;
        this.#armHeartbeatDeadline(connection);
      }
      this.#returnCredit(connection, undefined, decoded.chargedBytes);
      return;
    }
    const activation = this.#activations.get(header.activationId);
    if (!activation || !connection.activationIds.has(header.activationId) || !activation.identity) {
      this.#returnCredit(connection, header.activationId, decoded.chargedBytes);
      if (activation)
        this.#protocolFailure(connection, header.activationId, 0, "presentation activation binding mismatch");
      return;
    }
    if (
      header.sessionId !== activation.sessionId ||
      header.leaseEpoch !== activation.leaseEpoch ||
      header.activationSequence <= activation.lastActivationSequence
    ) {
      this.#protocolFailure(
        connection,
        header.activationId,
        decoded.chargedBytes,
        "presentation identity or sequence mismatch",
      );
      return;
    }
    activation.lastActivationSequence = header.activationSequence;
    if ((header.kind === "transfer-begin" || header.kind === "transfer-end") && payload.byteLength !== 0) {
      this.#protocolFailure(connection, header.activationId, decoded.chargedBytes, "transfer metadata carries payload");
      return;
    }
    switch (header.kind) {
      case "trf1-frame":
        this.#incremental(connection, activation, header, payload, decoded.chargedBytes);
        break;
      case "transfer-begin":
        this.#beginTransfer(connection, activation, header, decoded.chargedBytes);
        break;
      case "transfer-chunk":
        this.#transferChunk(connection, activation, header, payload, decoded.chargedBytes);
        break;
      case "transfer-end":
        this.#endTransfer(connection, activation, header, decoded.chargedBytes);
        break;
    }
  }

  #incremental(
    connection: FramesConnection,
    activation: FramesActivation,
    header: RoutedPresentationEnvelopeHeader,
    payload: Uint8Array,
    chargedBytes: number,
  ): void {
    if (
      payload.byteLength > connection.accepted!.protocolLimits.maxUrgentPresentationUnitBytes ||
      !header.resultContent ||
      header.baseContent === undefined ||
      (header.baseContent !== null && !exactStamp(activation.appliedContent, header.baseContent))
    ) {
      this.#protocolFailure(connection, header.activationId, chargedBytes, "incremental base mismatch");
      return;
    }
    try {
      this.#emit({ type: "frames-state", activationId: header.activationId, state: "applying" });
      this.#applyFrame(
        copyArrayBuffer(payload),
        activation.identity!,
        undefined,
        header.resultContent.sceneEpoch.cellBootId,
      );
      activation.appliedContent = header.resultContent;
      this.#returnCredit(connection, header.activationId, chargedBytes);
      this.#sceneApplied(connection, activation);
    } catch (error) {
      this.#protocolFailure(connection, header.activationId, chargedBytes, String(error));
    }
  }

  #beginTransfer(
    connection: FramesConnection,
    activation: FramesActivation,
    header: RoutedPresentationEnvelopeHeader,
    chargedBytes: number,
  ): void {
    const transfer = header.transfer;
    const limits = connection.accepted!.protocolLimits;
    const windows = connection.accepted!.initialWindows!;
    if (
      activation.transfer ||
      !transfer?.kind ||
      transfer.totalBytes === undefined ||
      transfer.chunkCount === undefined ||
      !transfer.targetLayout ||
      !transfer.checksum ||
      !header.resultContent ||
      transfer.totalBytes > windows.stagingBytesPerSession ||
      this.#stagingBytes + transfer.totalBytes > windows.stagingBytesTotal ||
      (transfer.kind === "catchup" && transfer.totalBytes > limits.maxCatchupBytes) ||
      (transfer.kind === "catchup" &&
        (header.baseContent == null || !exactStamp(activation.appliedContent, header.baseContent)))
    ) {
      this.#protocolFailure(connection, header.activationId, chargedBytes, "transfer budget or header invalid");
      return;
    }
    const activeSeeds = [...this.#activations.values()].filter(
      (candidate) => candidate.transfer?.kind === "seed",
    ).length;
    if (transfer.kind === "seed" && activeSeeds >= windows.maxConcurrentSeeds) {
      this.#protocolFailure(connection, header.activationId, chargedBytes, "seed concurrency exceeded");
      return;
    }
    activation.transfer = {
      transferId: transfer.transferId,
      kind: transfer.kind,
      bytes: new Uint8Array(transfer.totalBytes),
      chunkCount: transfer.chunkCount,
      chunks: new Set(),
      ranges: [],
      checksum: transfer.checksum.value,
      targetLayout: transfer.targetLayout,
      baseContent: header.baseContent ?? null,
      resultContent: header.resultContent,
    };
    this.#stagingBytes += transfer.totalBytes;
    this.#returnCredit(connection, header.activationId, chargedBytes);
    this.#emit({ type: "frames-state", activationId: header.activationId, state: "seeding" });
  }

  #transferChunk(
    connection: FramesConnection,
    activation: FramesActivation,
    header: RoutedPresentationEnvelopeHeader,
    payload: Uint8Array,
    chargedBytes: number,
  ): void {
    const staging = activation.transfer;
    const transfer = header.transfer;
    const chunkIndex = transfer?.chunkIndex;
    const byteOffset = transfer?.byteOffset;
    if (
      !staging ||
      transfer?.transferId !== staging.transferId ||
      chunkIndex === undefined ||
      byteOffset === undefined ||
      chunkIndex >= staging.chunkCount ||
      staging.chunks.has(chunkIndex) ||
      payload.byteLength > connection.accepted!.protocolLimits.maxPresentationChunkBytes ||
      byteOffset + payload.byteLength > staging.bytes.byteLength
    ) {
      this.#protocolFailure(connection, header.activationId, chargedBytes, "transfer chunk invalid");
      return;
    }
    const end = byteOffset + payload.byteLength;
    if (staging.ranges.some((range) => byteOffset < range.end && end > range.start)) {
      this.#protocolFailure(connection, header.activationId, chargedBytes, "transfer chunk overlap");
      return;
    }
    staging.bytes.set(payload, byteOffset);
    staging.chunks.add(chunkIndex);
    staging.ranges.push({ start: byteOffset, end });
    // Transfer bytes become reclaimable as soon as the staging copy completes.
    this.#returnCredit(connection, header.activationId, chargedBytes);
  }

  #endTransfer(
    connection: FramesConnection,
    activation: FramesActivation,
    header: RoutedPresentationEnvelopeHeader,
    chargedBytes: number,
  ): void {
    const staging = activation.transfer;
    if (!staging || header.transfer?.transferId !== staging.transferId) {
      this.#protocolFailure(connection, header.activationId, chargedBytes, "transfer end without begin");
      return;
    }
    this.#returnCredit(connection, header.activationId, chargedBytes);
    const ranges = [...staging.ranges].sort((left, right) => left.start - right.start);
    let cursor = 0;
    for (const range of ranges) {
      if (range.start !== cursor) {
        this.#protocolFailure(connection, header.activationId, 0, "transfer has a range gap");
        return;
      }
      cursor = range.end;
    }
    if (
      staging.chunks.size !== staging.chunkCount ||
      cursor !== staging.bytes.byteLength ||
      routedCrc32c(staging.bytes) !== staging.checksum ||
      (staging.kind === "catchup" &&
        (staging.baseContent === null || !exactStamp(activation.appliedContent, staging.baseContent)))
    ) {
      this.#protocolFailure(connection, header.activationId, 0, "transfer validation failed");
      return;
    }
    try {
      this.#emit({ type: "frames-state", activationId: header.activationId, state: "applying" });
      this.#applyFrame(
        staging.bytes.buffer as ArrayBuffer,
        activation.identity!,
        staging.targetLayout,
        staging.resultContent.sceneEpoch.cellBootId,
      );
      activation.appliedContent = staging.resultContent;
      this.#releaseTransfer(activation);
      this.#sceneApplied(connection, activation);
    } catch (error) {
      this.#protocolFailure(connection, header.activationId, 0, String(error));
    }
  }

  #releaseTransfer(activation: FramesActivation): void {
    if (!activation.transfer) return;
    this.#stagingBytes = Math.max(0, this.#stagingBytes - activation.transfer.bytes.byteLength);
    delete activation.transfer;
  }

  #sceneApplied(connection: FramesConnection, activation: FramesActivation): void {
    const appliedContent = activation.appliedContent;
    if (!appliedContent) return;
    this.#send(
      connection,
      encodeRoutedMessage("SceneApplied", {
        sessionId: activation.sessionId,
        activationId: activation.request.activationId,
        leaseEpoch: activation.leaseEpoch,
        appliedContent,
      }),
    );
    this.#emit({
      type: "frames-state",
      activationId: activation.request.activationId,
      state: "active",
      ...(activation.resumeToken === undefined ? {} : { resumeToken: activation.resumeToken }),
      appliedContent,
    });
    this.#reportPresentation(connection, activation, "active");
    if (activation.sceneRefreshTimer !== undefined) clearTimeout(activation.sceneRefreshTimer);
    activation.sceneRefreshTimer = setTimeout(
      () => this.#sceneApplied(connection, activation),
      connection.accepted!.protocolLimits.sceneAppliedRefreshMs,
    );
  }

  #reportPresentation(
    connection: FramesConnection,
    activation: FramesActivation,
    state: RoutedPresentationStatus["state"],
  ): void {
    activation.workerStatusSequence += 1;
    const status: RoutedPresentationStatus = {
      activationId: activation.request.activationId,
      workerStatusSequence: activation.workerStatusSequence,
      state,
      ...(activation.appliedContent === undefined ? {} : { sceneContent: activation.appliedContent }),
      leaseTtlMs: Math.max(
        connection.accepted?.protocolLimits.presentationStatusRefreshMs ?? 2_000,
        connection.accepted?.heartbeatTtlMs ?? ROUTED_DOOR_LIMITS.heartbeatTtlMs,
      ),
    };
    this.#emit({ type: "presentation-status", status });
    if (activation.presentationRefreshTimer !== undefined) clearTimeout(activation.presentationRefreshTimer);
    const refreshMs = connection.accepted?.protocolLimits.presentationStatusRefreshMs ?? 2_000;
    activation.presentationRefreshTimer = setTimeout(
      () => this.#reportPresentation(connection, activation, state),
      refreshMs,
    );
  }

  #returnCredit(connection: FramesConnection, activationId: string | undefined, bytes: number): void {
    if (bytes <= 0) return;
    connection.connectionBytesReturned += bytes;
    if (activationId) {
      connection.accountBytesReturned.set(
        activationId,
        (connection.accountBytesReturned.get(activationId) ?? 0) + bytes,
      );
      if (!connection.activationIds.has(activationId)) this.#scheduleAccountDrain(connection, activationId);
    }
    const limits = connection.accepted?.protocolLimits;
    if (connection.creditTimer !== undefined) return;
    connection.creditTimer = setTimeout(() => this.#flushCredit(connection), limits?.maxCreditReturnDelayMs ?? 16);
  }

  #flushCredit(connection: FramesConnection): void {
    if (connection.creditTimer !== undefined) clearTimeout(connection.creditTimer);
    delete connection.creditTimer;
    if (!connection.accepted || connection.connectionBytesReturned === 0) return;
    connection.creditSequence += 1;
    const newlyReturned = connection.connectionBytesReturned - connection.connectionBytesReported;
    connection.connectionBytesReported = connection.connectionBytesReturned;
    this.#send(
      connection,
      encodeRoutedMessage("TransportCredit", {
        creditEpoch: connection.accepted.creditEpoch!,
        creditSequence: connection.creditSequence,
        connectionBytesReturned: connection.connectionBytesReturned,
        accounts: [...connection.accountBytesReturned].map(([activationId, bytesReturned]) => ({
          activationId,
          bytesReturned,
        })),
      }),
    );
    this.#creditReturned?.(newlyReturned);
  }

  #scheduleAccountDrain(connection: FramesConnection, activationId: string): void {
    const previous = connection.accountDrainTimers.get(activationId);
    if (previous !== undefined) clearTimeout(previous);
    const ttl = connection.accepted?.protocolLimits.creditAccountDrainTtlMs ?? 5_000;
    connection.accountDrainTimers.set(
      activationId,
      setTimeout(() => {
        connection.accountDrainTimers.delete(activationId);
        if (!connection.activationIds.has(activationId)) connection.accountBytesReturned.delete(activationId);
      }, ttl),
    );
  }

  #scheduleHeartbeat(connection: FramesConnection): void {
    if (connection.heartbeatTimer !== undefined) clearTimeout(connection.heartbeatTimer);
    connection.heartbeatTimer = setTimeout(
      () => {
        if (!connection.accepted || connection.socket.readyState !== socketOpen) return;
        connection.heartbeatSequence += 1;
        this.#send(
          connection,
          encodeRoutedMessage("CalibrationPing", {
            sequence: connection.heartbeatSequence,
            t0: Date.now(),
          }),
        );
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

  #armHeartbeatDeadline(connection: FramesConnection): void {
    if (connection.heartbeatDeadlineTimer !== undefined) clearTimeout(connection.heartbeatDeadlineTimer);
    const ttl = connection.accepted?.heartbeatTtlMs ?? ROUTED_DOOR_LIMITS.heartbeatTtlMs;
    connection.heartbeatDeadlineTimer = setTimeout(() => {
      if (this.#connections.get(connection.cellBootId) !== connection) return;
      this.#closeConnection(connection, ROUTED_CLOSE_CODES.LEG_TIMEOUT, "heartbeat timeout", true);
    }, ttl);
  }

  #protocolFailure(
    connection: FramesConnection,
    activationId: string | undefined,
    chargedBytes: number,
    reason: string,
  ): void {
    this.#returnCredit(connection, activationId, chargedBytes);
    this.#flushCredit(connection);
    if (activationId) this.#emit({ type: "frames-state", activationId, state: "failed", reason: "PROTOCOL" });
    this.#closeConnection(connection, ROUTED_CLOSE_CODES.PROTOCOL, reason, true);
  }

  #send(connection: FramesConnection, text: string): void {
    if (connection.socket.readyState === socketOpen) connection.socket.send(text);
  }

  #closeConnection(connection: FramesConnection, code: number, reason: string, closeSocket: boolean): void {
    if (connection.heartbeatTimer !== undefined) clearTimeout(connection.heartbeatTimer);
    if (connection.heartbeatDeadlineTimer !== undefined) clearTimeout(connection.heartbeatDeadlineTimer);
    if (connection.creditTimer !== undefined) clearTimeout(connection.creditTimer);
    for (const timer of connection.accountDrainTimers.values()) clearTimeout(timer);
    if (closeSocket && connection.socket.readyState < socketClosing)
      connection.socket.close(code, reason.slice(0, 123));
    this.#closed(connection, code, reason);
  }

  #closed(connection: FramesConnection, code: number, reason: string): void {
    if (this.#connections.get(connection.cellBootId) !== connection) return;
    this.#connections.delete(connection.cellBootId);
    if (connection.heartbeatTimer !== undefined) clearTimeout(connection.heartbeatTimer);
    if (connection.heartbeatDeadlineTimer !== undefined) clearTimeout(connection.heartbeatDeadlineTimer);
    if (connection.creditTimer !== undefined) clearTimeout(connection.creditTimer);
    for (const timer of connection.accountDrainTimers.values()) clearTimeout(timer);
    connection.accountDrainTimers.clear();
    const activationIds = [...connection.activationIds];
    for (const activationId of activationIds) {
      const activation = this.#activations.get(activationId);
      if (!activation) continue;
      this.#releaseTransfer(activation);
      if (activation.sceneRefreshTimer !== undefined) clearTimeout(activation.sceneRefreshTimer);
      if (activation.presentationRefreshTimer !== undefined) clearTimeout(activation.presentationRefreshTimer);
    }
    this.#emit({
      type: "transport-closed",
      cellBootId: connection.cellBootId,
      code,
      reason,
      activationIds,
      preAuth: connection.refusal === undefined && connection.accepted === undefined && code === 1008,
      ...(connection.refusal === undefined ? {} : { refusal: connection.refusal }),
    });
  }
}

/** Kept local to avoid a second source of protocol defaults in the worker. */
export function routedCreditDelay(limits: RoutedProtocolLimits | undefined): number {
  return limits?.maxCreditReturnDelayMs ?? 16;
}
