import { EventEmitter } from "node:events";
import { type Socket } from "node:net";
import { openEndpoint } from "./endpoints.js";
import {
  PROTOCOL_MAJOR,
  PROTOCOL_MINOR,
  SESSION_SCROLLBACK_PROTOCOL_MINOR,
  STRUCTURED_ERROR_PROTOCOL_MINOR,
  isServerEvent,
  isValidScrollbackBytes,
  type AutomationInputOperation,
  SESSION_LIFECYCLE_PROTOCOL_MINOR,
  type SessionReleaseState,
  type ClientCommand,
  type ConfigDocument,
  type ConfigDocumentUpdate,
  type ConfigDocumentValidation,
  type ConfigSnapshot,
  type CreateSessionOptions,
  type ServerEvent,
  type SessionOwnerTransfer,
  type SessionSummary,
  type TerminationSource,
} from "@vibecook/ghosttea-protocol";

export { endpointPersists, localEndpoints, openEndpoint, type LocalEndpoints } from "./endpoints.js";

export type GhostteaControlCommand = ClientCommand extends infer Command
  ? Command extends { requestId: number }
    ? Omit<Command, "requestId">
    : never
  : never;

type PendingRequest = {
  resolve: (event: ServerEvent) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

type ExitWaiter = {
  promise: Promise<SessionExitedEvent>;
  cancel: (error: Error) => void;
};

export interface GhostteaControlConnection {
  controlSocket: string;
  authToken: string;
  /** Accepted for compatibility with full daemon descriptors; never opened. */
  frameSocket?: string;
}

export type AutomationInputResult = Extract<ServerEvent, { type: "automation-input-result" }>;
export type SessionExitedEvent = Extract<ServerEvent, { type: "session-exited" }>;

const MAX_CONTROL_BYTES = 1024 * 1024;
const CONFIG_DOCUMENT_PROTOCOL_MINOR = 11;
const REMOTE_LIFECYCLE_PROTOCOL_MINOR = 12;
const SESSION_OWNER_TRANSFER_PROTOCOL_MINOR = 14;

export class GhostteaConfigDocumentConflictError extends Error {
  readonly document: ConfigDocument;

  constructor(document: ConfigDocument) {
    super("Ghosttea configuration changed since it was read");
    this.name = "GhostteaConfigDocumentConflictError";
    this.document = document;
  }
}

export class GhostteaRequestError extends Error {
  readonly stage: string | undefined;
  readonly code: string | undefined;
  readonly osError: number | undefined;

  constructor(event: Extract<ServerEvent, { type: "error" }>) {
    super(event.message);
    this.stage = event.stage;
    this.code = event.code;
    this.osError = event.osError;
  }
}

function packet(bytes: Uint8Array): Buffer {
  const output = Buffer.allocUnsafe(4 + bytes.byteLength);
  output.writeUInt32LE(bytes.byteLength, 0);
  output.set(bytes, 4);
  return output;
}

export interface GhostteaAutomationClientOptions {
  clientBuild?: string;
  connectTimeoutMs?: number;
  requestTimeoutMs?: number;
}

/**
 * Node control-socket access to Ghosttea sessions.
 *
 * This client never opens the frame socket, attaches a renderer view, or
 * claims terminal layout authority. Automation input is conditionally ordered
 * by the service against accepted human input.
 */
export class GhostteaAutomationClient extends EventEmitter {
  readonly #connection: GhostteaControlConnection;
  readonly #options: GhostteaAutomationClientOptions;
  readonly #pending = new Map<number, PendingRequest>();
  #socket: Socket | undefined;
  #connectPromise: Promise<void> | undefined;
  #buffer = Buffer.alloc(0);
  #authenticated = false;
  #serverProtocolMinor = 0;
  #nextRequestId = 1;
  #disposed = false;

  constructor(connection: GhostteaControlConnection, options: GhostteaAutomationClientOptions = {}) {
    super();
    this.#connection = connection;
    this.#options = options;
  }

  get connected(): boolean {
    return this.#authenticated && this.#socket !== undefined;
  }

  /** Negotiated daemon minor, or undefined before/after a connection. */
  get serverProtocolMinor(): number | undefined {
    return this.connected ? this.#serverProtocolMinor : undefined;
  }

  /** Whether callers may rely on structured control-error metadata. */
  get structuredErrorsSupported(): boolean {
    return (this.serverProtocolMinor ?? 0) >= STRUCTURED_ERROR_PROTOCOL_MINOR;
  }

  connect(): Promise<void> {
    if (this.#disposed) return Promise.reject(new Error("Ghosttea automation client is disposed"));
    if (this.connected) return Promise.resolve();
    this.#connectPromise ??= this.#open().finally(() => {
      if (!this.connected) this.#connectPromise = undefined;
    });
    return this.#connectPromise;
  }

  async #open(): Promise<void> {
    // One budget covers waiting for a free endpoint and authenticating on it,
    // so a slow connect cannot silently double the caller's timeout.
    const deadline = Date.now() + (this.#options.connectTimeoutMs ?? 10_000);
    const socket = await openEndpoint(this.#connection.controlSocket, deadline);
    this.#socket = socket;
    this.#buffer = Buffer.alloc(0);
    this.#authenticated = false;
    this.#serverProtocolMinor = 0;
    socket.on("data", (chunk) => this.#onData(socket, typeof chunk === "string" ? Buffer.from(chunk) : chunk));
    socket.on("error", (error) => this.#onSocketError(socket, error));
    socket.on("close", () => this.#onSocketClose(socket));
    await new Promise<void>((resolve, reject) => {
      const onAuthenticated = (): void => {
        cleanup();
        resolve();
      };
      const onFailure = (error: Error): void => {
        cleanup();
        if (this.#socket === socket) {
          this.#socket = undefined;
          this.#authenticated = false;
        }
        socket.destroy();
        reject(error);
      };
      const onClose = (): void => {
        onFailure(new Error("Ghosttea control connection closed during authentication"));
      };
      const cleanup = (): void => {
        socket.off("close", onClose);
        this.off("authenticated", onAuthenticated);
        this.off("connection-error", onFailure);
        clearTimeout(timeout);
      };
      const timeout = setTimeout(
        () => onFailure(new Error("Ghosttea control connection timed out during authentication")),
        Math.max(0, deadline - Date.now()),
      );
      socket.once("close", onClose);
      this.once("authenticated", onAuthenticated);
      this.once("connection-error", onFailure);
      // `openEndpoint` resolves only once connected, so authenticate now.
      socket.write(packet(Buffer.from(this.#connection.authToken)));
    });
    try {
      const hello = await this.#requestConnected({
        type: "hello",
        protocolMajor: PROTOCOL_MAJOR,
        protocolMinor: PROTOCOL_MINOR,
        clientBuild: this.#options.clientBuild ?? "ghosttea-electron-automation",
      });
      if (hello.type !== "hello" || hello.protocolMajor !== PROTOCOL_MAJOR) {
        throw new Error("ghosttead protocol mismatch");
      }
      this.#serverProtocolMinor = hello.protocolMinor;
    } catch (error) {
      if (this.#socket === socket) {
        this.#socket = undefined;
        this.#authenticated = false;
      }
      socket.destroy();
      throw error;
    }
  }

  async createSession(options: CreateSessionOptions): Promise<SessionSummary> {
    const event = await this.request({ type: "create-session", options });
    if (event.type !== "session-created") throw new Error("ghosttead returned an unexpected response");
    return event.session;
  }

  async getConfig(): Promise<ConfigSnapshot> {
    const event = await this.request({ type: "get-config" });
    if (event.type !== "config") throw new Error("ghosttead returned an unexpected configuration response");
    return event.config;
  }

  async reloadConfig(): Promise<ConfigSnapshot> {
    const event = await this.request({ type: "reload-config" });
    if (event.type !== "config") throw new Error("ghosttead returned an unexpected configuration response");
    return event.config;
  }

  async getConfigDocument(): Promise<ConfigDocument> {
    await this.connect();
    const event = await this.#requestConnected({ type: "get-config-document" });
    if (event.type !== "config-document") {
      throw new Error("ghosttead returned an unexpected configuration document response");
    }
    return event.document;
  }

  async validateConfigDocument(contents: string): Promise<ConfigDocumentValidation> {
    await this.connect();
    const event = await this.#requestConnected({ type: "validate-config-document", contents });
    if (event.type !== "config-document-validation") {
      throw new Error("ghosttead returned an unexpected configuration validation response");
    }
    return {
      documentRevision: event.documentRevision,
      config: event.config,
    };
  }

  async replaceConfigDocument(expectedRevision: string, contents: string): Promise<ConfigDocumentUpdate> {
    await this.connect();
    const event = await this.#requestConnected({
      type: "replace-config-document",
      expectedRevision,
      contents,
    });
    if (event.type === "config-document-conflict") {
      throw new GhostteaConfigDocumentConflictError(event.document);
    }
    if (event.type !== "config-document-updated") {
      throw new Error("ghosttead returned an unexpected configuration document update response");
    }
    return {
      document: event.document,
      config: event.config,
    };
  }

  async listSessions(): Promise<SessionSummary[]> {
    const event = await this.request({ type: "list-sessions" });
    if (event.type !== "sessions") throw new Error("ghosttead returned an unexpected response");
    return event.sessions;
  }

  async getSession(sessionId: string): Promise<SessionSummary> {
    const event = await this.request({ type: "get-session", sessionId });
    if (event.type !== "session" || event.session.id !== sessionId) {
      throw new Error("ghosttead returned an unexpected session");
    }
    return event.session;
  }

  waitForExit(sessionId: string, timeoutMs = 10_000): Promise<SessionExitedEvent> {
    return this.#createExitWaiter(sessionId, timeoutMs).promise;
  }

  #createExitWaiter(sessionId: string, timeoutMs: number): ExitWaiter {
    let cancel = (_error: Error): void => undefined;
    const promise = new Promise<SessionExitedEvent>((resolve, reject) => {
      let settled = false;
      const finish = (event: SessionExitedEvent): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(event);
      };
      const listener = (event: SessionExitedEvent): void => {
        if (event.sessionId !== sessionId) return;
        finish(event);
      };
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error(`Timed out waiting for Ghosttea session ${sessionId} to exit`));
      }, timeoutMs);
      const cleanup = (): void => {
        clearTimeout(timeout);
        this.off("session-exited", listener);
      };
      cancel = (error): void => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      this.on("session-exited", listener);
      void this.getSession(sessionId)
        .then((session) => {
          if (!session.exited) return;
          finish({
            requestId: 0,
            type: "session-exited",
            sessionId,
            exitCode: session.exitCode,
            exitSignal: session.exitSignal,
            requestedTermination: session.requestedTermination,
            exitOutcome: session.exitOutcome ?? "unknown",
          });
        })
        .catch(() => undefined);
    });
    return { promise, cancel };
  }

  async terminateAndWait(
    sessionId: string,
    source: TerminationSource = "application",
    timeoutMs = 10_000,
  ): Promise<SessionExitedEvent> {
    const exited = this.#createExitWaiter(sessionId, timeoutMs);
    try {
      await this.terminate(sessionId, source);
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      exited.cancel(error);
      void exited.promise.catch(() => undefined);
      throw cause;
    }
    return exited.promise;
  }

  async humanInputEpoch(sessionId: string): Promise<number> {
    const event = await this.request({ type: "get-automation-state", sessionId });
    if (event.type !== "automation-state" || event.sessionId !== sessionId) {
      throw new Error("ghosttead returned an unexpected automation state");
    }
    return event.humanInputEpoch;
  }

  async input(
    sessionId: string,
    operation: AutomationInputOperation,
    expectedHumanInputEpoch: number,
  ): Promise<AutomationInputResult> {
    const event = await this.request({
      type: "automation-input",
      sessionId,
      expectedHumanInputEpoch,
      operation,
    });
    if (event.type !== "automation-input-result" || event.sessionId !== sessionId) {
      throw new Error("ghosttead returned an unexpected automation result");
    }
    return event;
  }

  async pasteAndSubmit(sessionId: string, text: string): Promise<AutomationInputResult> {
    const expectedHumanInputEpoch = await this.humanInputEpoch(sessionId);
    return this.input(sessionId, { kind: "paste", text, submit: true }, expectedHumanInputEpoch);
  }

  async paste(sessionId: string, text: string): Promise<AutomationInputResult> {
    const expectedHumanInputEpoch = await this.humanInputEpoch(sessionId);
    return this.input(sessionId, { kind: "paste", text, submit: false }, expectedHumanInputEpoch);
  }

  async sendText(sessionId: string, text: string): Promise<AutomationInputResult> {
    const expectedHumanInputEpoch = await this.humanInputEpoch(sessionId);
    return this.input(sessionId, { kind: "text", text }, expectedHumanInputEpoch);
  }

  async interrupt(sessionId: string): Promise<AutomationInputResult> {
    const expectedHumanInputEpoch = await this.humanInputEpoch(sessionId);
    return this.input(sessionId, { kind: "interrupt" }, expectedHumanInputEpoch);
  }

  async releaseSession(sessionId: string, condition: "unused" | "exited"): Promise<SessionReleaseState> {
    const event = await this.request({ type: "release-session", sessionId, condition });
    if (event.type !== "session-release") throw new Error("ghosttead returned an unexpected release response");
    return event.state;
  }

  async terminate(sessionId: string, source: TerminationSource = "application"): Promise<void> {
    const event = await this.request({ type: "terminate", sessionId, source });
    if (event.type !== "ok") throw new Error("ghosttead rejected session termination");
  }

  async closeSessionOwner(ownerId: string, transfers: readonly SessionOwnerTransfer[] = []): Promise<void> {
    const event = await this.request({
      type: "close-session-owner",
      ownerId,
      ...(transfers.length > 0 ? { transfers: [...transfers] } : {}),
    });
    if (event.type !== "ok") throw new Error("ghosttead rejected session owner closure");
  }

  async request(command: GhostteaControlCommand): Promise<ServerEvent> {
    await this.connect();
    return this.#requestConnected(command);
  }

  #requestConnected(command: GhostteaControlCommand): Promise<ServerEvent> {
    const socket = this.#socket;
    if (!socket || !this.#authenticated) {
      return Promise.reject(new Error("Ghosttea automation client is not connected"));
    }
    if (
      command.type === "get-config-document" ||
      command.type === "validate-config-document" ||
      command.type === "replace-config-document"
    ) {
      this.#requireProtocolMinor(CONFIG_DOCUMENT_PROTOCOL_MINOR, "configuration documents");
    }
    if (
      command.type === "get-remote-session-state" ||
      command.type === "reconnect-remote-session" ||
      command.type === "retry-remote-view"
    ) {
      this.#requireProtocolMinor(REMOTE_LIFECYCLE_PROTOCOL_MINOR, "remote session lifecycle");
    }
    if (command.type === "close-session-owner") {
      this.#requireProtocolMinor(SESSION_OWNER_TRANSFER_PROTOCOL_MINOR, "safe session owner closure");
    }
    if (command.type === "create-session" && command.options.scrollbackBytes !== undefined) {
      if (!isValidScrollbackBytes(command.options.scrollbackBytes)) {
        return Promise.reject(new RangeError("scrollbackBytes must be a non-negative safe integer"));
      }
      this.#requireProtocolMinor(SESSION_SCROLLBACK_PROTOCOL_MINOR, "per-session scrollback limits");
    }
    if (
      command.type === "release-session" ||
      (command.type === "create-session" && command.options.creationId !== undefined)
    ) {
      this.#requireProtocolMinor(SESSION_LIFECYCLE_PROTOCOL_MINOR, "session lifecycle ownership");
    }
    const requestId = this.#nextRequestId++;
    const encoded = Buffer.from(JSON.stringify({ ...command, requestId } satisfies ClientCommand));
    if (encoded.byteLength > MAX_CONTROL_BYTES) {
      return Promise.reject(new Error("Ghosttea control packet exceeds quota"));
    }
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(requestId);
        reject(new Error(`Ghosttea request timed out: ${command.type}`));
      }, this.#options.requestTimeoutMs ?? 10_000);
      this.#pending.set(requestId, { resolve, reject, timeout });
      socket.write(packet(encoded));
    });
  }

  #requireProtocolMinor(required: number, capability: string): void {
    if (this.#serverProtocolMinor < required) {
      throw new Error(
        `ghosttead does not support ${capability} (requires protocol 1.${required}, server is 1.${this.#serverProtocolMinor})`,
      );
    }
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#socket?.destroy();
    this.#socket = undefined;
    this.#authenticated = false;
    this.#serverProtocolMinor = 0;
    this.#rejectPending(new Error("Ghosttea automation client closed"));
  }

  #onData(socket: Socket, chunk: Buffer): void {
    if (this.#socket !== socket) return;
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    while (this.#buffer.length >= 4) {
      const length = this.#buffer.readUInt32LE(0);
      if (length > MAX_CONTROL_BYTES) {
        this.#socket?.destroy(new Error("Ghosttea control packet exceeds quota"));
        return;
      }
      if (this.#buffer.length < 4 + length) return;
      const body = this.#buffer.subarray(4, 4 + length);
      this.#buffer = this.#buffer.subarray(4 + length);
      if (!this.#authenticated) {
        if (body.toString("utf8") !== "ok") {
          this.emit("connection-error", new Error("ghosttead authentication failed"));
          this.#socket?.destroy();
          return;
        }
        this.#authenticated = true;
        this.emit("authenticated");
        continue;
      }
      let decoded: unknown;
      try {
        decoded = JSON.parse(body.toString("utf8"));
      } catch {
        this.#socket?.destroy(new Error("ghosttead returned invalid JSON"));
        return;
      }
      if (!isServerEvent(decoded)) {
        this.#socket?.destroy(new Error("ghosttead returned an invalid event"));
        return;
      }
      if (decoded.requestId === 0) {
        this.emit(decoded.type, decoded);
        continue;
      }
      const pending = this.#pending.get(decoded.requestId);
      if (!pending) continue;
      this.#pending.delete(decoded.requestId);
      clearTimeout(pending.timeout);
      if (decoded.type === "error") pending.reject(new GhostteaRequestError(decoded));
      else pending.resolve(decoded);
    }
  }

  #onSocketError(socket: Socket, error: Error): void {
    if (this.#socket !== socket) return;
    if (!this.#authenticated) this.emit("connection-error", error);
    else this.emit("transport-error", error);
  }

  #onSocketClose(socket: Socket): void {
    if (this.#socket !== socket) return;
    const wasConnected = this.#authenticated;
    this.#socket = undefined;
    this.#authenticated = false;
    this.#serverProtocolMinor = 0;
    this.#connectPromise = undefined;
    this.#rejectPending(new Error("Ghosttea control connection closed"));
    if (wasConnected && !this.#disposed) this.emit("close");
  }

  #rejectPending(error: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.#pending.clear();
  }
}

export { SESSION_LIFECYCLE_PROTOCOL_MINOR };
