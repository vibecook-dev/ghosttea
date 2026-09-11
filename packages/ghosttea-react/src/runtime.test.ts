import { afterEach, describe, expect, it, vi } from "vitest";
import { unknownSessionActivity, type ConfigSnapshot, type SessionSummary } from "@vibecook/ghosttea-protocol";
import { GhostteaTerminalRuntime } from "./runtime";

class FakeWorker extends EventTarget {
  readonly messages: unknown[] = [];
  completeExpectedSnapshots = true;
  terminated = false;

  postMessage(message: unknown): void {
    this.messages.push(message);
    if (
      this.completeExpectedSnapshots &&
      message &&
      typeof message === "object" &&
      (message as { type?: unknown }).type === "expect-full"
    ) {
      const sessionHandle = String((message as { sessionHandle?: unknown }).sessionHandle);
      queueMicrotask(() =>
        this.dispatchEvent(new MessageEvent("message", { data: { type: "frame-resync-complete", sessionHandle } })),
      );
    }
  }

  terminate(): void {
    this.terminated = true;
  }

  commitFrame(sessionHandle: string, options: { fullSnapshot?: boolean; frameSequence?: bigint } = {}): void {
    this.dispatchEvent(
      new MessageEvent("message", {
        data: {
          type: "frame-committed",
          sessionHandle,
          sessionEpoch: 4n,
          frameSequence: options.frameSequence ?? 1n,
          fullSnapshot: options.fullSnapshot ?? true,
        },
      }),
    );
  }
}

class FakePort extends EventTarget {
  readonly messages: Array<Record<string, unknown>> = [];
  readonly pendingSubscriptionAcknowledgements: number[] = [];
  attachReadWrite = true;
  bridgeCapabilities = true;
  deferSubscriptionAcknowledgements = false;
  subscriptionAcknowledgements = true;
  subscriptionControlAsArrayBuffer = false;
  helloProtocolMinor: number | undefined;
  configSnapshot: ConfigSnapshot | undefined;
  sessions: SessionSummary[] = [];
  deferAttachments = false;
  readonly pendingAttachments: Array<{ requestId: number; sessionId: string; viewId: string }> = [];
  attachViewStateSeq: number | undefined;
  selectionScope: "viewport" | "scrollback" | undefined;
  deferRemoteState = false;
  readonly pendingRemoteStateRequestIds: number[] = [];
  readonly remoteStateRequests: string[] = [];
  remoteSession: SessionSummary = session;
  remoteState: Record<string, unknown> = remoteSessionState();
  closed = false;
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;

  postMessage(message: Record<string, unknown>): void {
    this.messages.push(message);
    const requestId = Number(message.requestId);
    if (message.type === "hello") {
      this.dispatchEvent(
        new MessageEvent("message", {
          data: {
            requestId,
            type: "hello",
            protocolMajor: message.protocolMajor,
            protocolMinor: this.helloProtocolMinor ?? message.protocolMinor,
            serverBuild: "test",
            ...(this.configSnapshot ? { configRevision: this.configSnapshot.revision } : {}),
          },
        }),
      );
    } else if (message.type === "get-config" || message.type === "reload-config") {
      if (this.configSnapshot) {
        this.dispatchEvent(
          new MessageEvent("message", {
            data: { requestId, type: "config", config: this.configSnapshot },
          }),
        );
      }
    } else if (message.type === "list-sessions") {
      this.dispatchEvent(
        new MessageEvent("message", {
          data: { requestId, type: "sessions", sessions: this.sessions },
        }),
      );
    } else if (message.type === "create-session") {
      const options = message.options as Record<string, unknown>;
      this.dispatchEvent(
        new MessageEvent("message", {
          data: {
            requestId,
            type: "session-created",
            session: {
              ...session,
              id: "created",
              handle: "created-handle",
              executable: options.executable,
              cols: options.cols,
              rows: options.rows,
              persistence: options.persistence,
              scrollbackBytes: options.scrollbackBytes ?? 10_000_000,
            },
          },
        }),
      );
    } else if (message.type === "subscribe") {
      if (this.bridgeCapabilities && message.bridgeCapabilities === 1) {
        this.onmessage?.(
          new MessageEvent("message", {
            data: { type: "bridge-capabilities", requestId, protocolVersion: 1, frameCredits: true },
          }),
        );
      }
      if (this.subscriptionAcknowledgements) {
        if (this.deferSubscriptionAcknowledgements) this.pendingSubscriptionAcknowledgements.push(requestId);
        else this.acknowledgeSubscription(requestId);
      }
    } else if (message.type === "refresh-session") {
      this.dispatchEvent(new MessageEvent("message", { data: { requestId, type: "ok" } }));
    } else if (message.type === "attach-session") {
      const attachment = { requestId, sessionId: String(message.sessionId), viewId: String(message.viewId) };
      if (this.deferAttachments) this.pendingAttachments.push(attachment);
      else this.completeAttachment(attachment);
    } else if (message.type === "open-remote-session") {
      this.dispatchEvent(
        new MessageEvent("message", { data: { requestId, type: "session-created", session: this.remoteSession } }),
      );
    } else if (message.type === "get-remote-session-state" || message.type === "reconnect-remote-session") {
      this.remoteStateRequests.push(message.type);
      if (this.deferRemoteState) {
        this.pendingRemoteStateRequestIds.push(requestId);
        return;
      }
      this.answerRemoteState(requestId);
    } else if (message.type === "selection-text") {
      this.dispatchEvent(
        new MessageEvent("message", {
          data: {
            requestId,
            type: "selection-text",
            text: "copied from terminal",
            ...(this.selectionScope === undefined ? {} : { scope: this.selectionScope }),
          },
        }),
      );
    }
  }

  start(): void {}

  completeAttachment(attachment = this.pendingAttachments.shift()): void {
    if (!attachment) throw new Error("No pending view attachment");
    this.dispatchEvent(
      new MessageEvent("message", {
        data: {
          requestId: attachment.requestId,
          type: "view-attached",
          sessionId: attachment.sessionId,
          viewId: attachment.viewId,
          attachmentEpoch: 2,
          readWrite: this.attachReadWrite,
          ...(this.attachViewStateSeq === undefined ? {} : { viewStateSeq: this.attachViewStateSeq }),
        },
      }),
    );
  }

  answerRemoteState(requestId = this.pendingRemoteStateRequestIds.shift()): void {
    if (requestId === undefined) throw new Error("No pending remote session state request");
    this.dispatchEvent(
      new MessageEvent("message", { data: { requestId, type: "remote-session-state", ...this.remoteState } }),
    );
  }

  emitLifecycle(overrides: Record<string, unknown>): void {
    this.dispatchEvent(
      new MessageEvent("message", {
        data: {
          requestId: 0,
          type: "remote-session-state-changed",
          sessionId: session.id,
          lifecycleSeq: 1,
          deviceId: "device",
          deviceName: "studio-mac",
          state: "reconnecting",
          reason: null,
          exit: null,
          attempt: 1,
          nextRetryMs: null,
          lastContactMs: 4_000,
          ...overrides,
        },
      }),
    );
  }

  emitViewState(overrides: Record<string, unknown>): void {
    this.dispatchEvent(
      new MessageEvent("message", {
        data: {
          requestId: 0,
          type: "view-state-changed",
          sessionId: session.id,
          viewId: "view-1",
          viewStateSeq: 1,
          viewState: "attached",
          attachmentEpoch: 5,
          readWrite: true,
          error: null,
          retryable: null,
          ...overrides,
        },
      }),
    );
  }

  acknowledgeSubscription(requestId = this.pendingSubscriptionAcknowledgements.shift()): void {
    if (requestId === undefined) throw new Error("No pending frame subscription acknowledgement");
    const acknowledgement = { type: "subscription-ack", requestId };
    const data = this.subscriptionControlAsArrayBuffer
      ? new TextEncoder().encode(JSON.stringify(acknowledgement)).buffer
      : acknowledgement;
    this.onmessage?.(new MessageEvent("message", { data }));
  }

  close(): void {
    this.closed = true;
  }
}

function canvas(): HTMLCanvasElement {
  return {
    transferControlToOffscreen: () => ({}) as OffscreenCanvas,
  } as HTMLCanvasElement;
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
}

function frameForHandle(handle: string): ArrayBuffer {
  const frame = new ArrayBuffer(16);
  const view = new DataView(frame);
  view.setUint32(0, 0x31465254, true);
  view.setBigUint64(8, BigInt(handle), true);
  return frame;
}

const session = {
  id: "session",
  handle: "handle",
  executable: "/bin/zsh",
  cols: 80,
  rows: 24,
  exited: false,
  readWrite: true,
  title: null,
  cwd: null,
  bellCount: 0,
  pid: 1,
  createdAtMs: 1,
  exitCode: null,
  exitSignal: null,
  requestedTermination: null,
  exitOutcome: null,
  ownerId: null,
  persistence: null,
  activity: unknownSessionActivity(),
} as const;

function remoteSessionState(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    lifecycleSeq: 2,
    deviceId: "device",
    deviceName: "studio-mac",
    state: "suspended",
    reason: null,
    exit: null,
    attempt: 1,
    nextRetryMs: null,
    lastContactMs: 30_000,
    controller: null,
    controlRevision: 0,
    cols: 80,
    rows: 24,
    layoutEpoch: 1,
    views: [],
    ...overrides,
  };
}

const configSnapshot: ConfigSnapshot = {
  schemaVersion: 1,
  revision: "config-1",
  compatibility: {
    ghosttyVersion: "1.3.1",
    ghosttyCommit: "f8041e7",
    knownKeyCount: 200,
  },
  sources: [],
  diagnostics: [],
  configuredKeys: [],
  terminal: {
    scrollbackBytes: 10_000_000,
    foreground: [255, 255, 255],
    background: [40, 44, 52],
    cursor: [255, 255, 255],
  },
  renderer: {
    foreground: [255, 255, 255],
    background: [40, 44, 52],
    cursor: [255, 255, 255],
    selectionBackground: [255, 255, 255],
    selectionForeground: [40, 44, 52],
    fontSize: 13,
    fontFamilies: [],
    paddingX: [2, 2],
    paddingY: [2, 2],
    postProcess: "none",
    customShaderPaths: [],
  },
  workspace: {
    keybindings: [],
    clearKeybindings: false,
  },
};

function controlChanged(control: FakePort, controllerViewId: string, cols: number, rows: number): void {
  control.dispatchEvent(
    new MessageEvent("message", {
      data: {
        requestId: 0,
        type: "control-changed",
        sessionId: session.id,
        controllerViewId,
        controlEpoch: 7,
        cols,
        rows,
        layoutEpoch: 2,
      },
    }),
  );
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("GhostteaTerminalRuntime mount ownership", () => {
  it("refuses scrollback overrides before 1.15 and validates them before send", async () => {
    vi.stubGlobal("window", globalThis);
    const control = new FakePort();
    control.helloProtocolMinor = 14;
    const runtime = new GhostteaTerminalRuntime({
      ports: { control: control as unknown as MessagePort, frames: new FakePort() as unknown as MessagePort },
      platform: {
        writeClipboard: () => undefined,
        forceCanvasFallback: () => false,
        setForceCanvasFallback: () => undefined,
        reload: () => undefined,
      },
      workerFactory: () => new FakeWorker() as unknown as Worker,
    });
    const options = {
      executable: "/bin/sh",
      args: [],
      cols: 80,
      rows: 24,
      persistence: "keep-until-exit" as const,
    };
    await expect(runtime.createSession({ ...options, scrollbackBytes: 0 })).rejects.toThrow("requires protocol 1.15");
    expect(runtime.serverProtocolMinor).toBe(14);
    expect(runtime.structuredErrorsSupported).toBe(false);
    expect(control.messages.some((message) => message.type === "create-session")).toBe(false);
    runtime.dispose();

    const currentControl = new FakePort();
    currentControl.helloProtocolMinor = 16;
    const current = new GhostteaTerminalRuntime({
      ports: {
        control: currentControl as unknown as MessagePort,
        frames: new FakePort() as unknown as MessagePort,
      },
      platform: {
        writeClipboard: () => undefined,
        forceCanvasFallback: () => false,
        setForceCanvasFallback: () => undefined,
        reload: () => undefined,
      },
      workerFactory: () => new FakeWorker() as unknown as Worker,
    });
    await expect(current.createSession({ ...options, scrollbackBytes: 0 })).resolves.toMatchObject({
      scrollbackBytes: 0,
    });
    expect(current.serverProtocolMinor).toBe(16);
    expect(current.structuredErrorsSupported).toBe(true);
    await expect(current.createSession({ ...options, scrollbackBytes: Number.MAX_SAFE_INTEGER + 1 })).rejects.toThrow(
      "safe integer",
    );
    expect(currentControl.messages.filter((message) => message.type === "create-session")).toHaveLength(1);
    current.dispose();
    expect(current.serverProtocolMinor).toBeUndefined();
    expect(current.structuredErrorsSupported).toBe(false);
  });

  it("negotiates, caches, and reloads the shared configuration snapshot", async () => {
    vi.stubGlobal("window", globalThis);
    const control = new FakePort();
    control.configSnapshot = configSnapshot;
    const runtime = new GhostteaTerminalRuntime({
      ports: { control: control as unknown as MessagePort, frames: new FakePort() as unknown as MessagePort },
      platform: {
        writeClipboard: () => undefined,
        forceCanvasFallback: () => false,
        setForceCanvasFallback: () => undefined,
        reload: () => undefined,
      },
      workerFactory: () => new FakeWorker() as unknown as Worker,
    });
    const changes: ConfigSnapshot[] = [];
    runtime.addEventListener("config-changed", (event) => {
      changes.push((event as CustomEvent<ConfigSnapshot>).detail);
    });

    await runtime.connect();
    expect(runtime.configSnapshot).toEqual(configSnapshot);
    expect(control.messages.map((message) => message.type)).toContain("get-config");
    expect(changes).toEqual([configSnapshot]);

    control.configSnapshot = {
      ...configSnapshot,
      revision: "config-2",
      renderer: { ...configSnapshot.renderer, postProcess: "better-crt" },
    };
    await expect(runtime.reloadConfig()).resolves.toEqual(control.configSnapshot);
    expect(runtime.configSnapshot?.renderer.postProcess).toBe("better-crt");
    expect(changes).toHaveLength(2);
    runtime.dispose();
  });

  it("refreshes configuration after the daemon reports lost events", async () => {
    vi.stubGlobal("window", globalThis);
    const control = new FakePort();
    control.configSnapshot = configSnapshot;
    const runtime = new GhostteaTerminalRuntime({
      ports: { control: control as unknown as MessagePort, frames: new FakePort() as unknown as MessagePort },
      platform: {
        writeClipboard: () => undefined,
        forceCanvasFallback: () => false,
        setForceCanvasFallback: () => undefined,
        reload: () => undefined,
      },
      workerFactory: () => new FakeWorker() as unknown as Worker,
    });

    await runtime.connect();
    control.configSnapshot = {
      ...configSnapshot,
      revision: "config-after-gap",
      renderer: { ...configSnapshot.renderer, postProcess: "better-crt" },
    };
    control.dispatchEvent(
      new MessageEvent("message", {
        data: { requestId: 0, type: "events-lost", skipped: 2 },
      }),
    );
    await flushMicrotasks();

    expect(runtime.configSnapshot).toEqual(control.configSnapshot);
    expect(control.messages.filter((message) => message.type === "get-config")).toHaveLength(2);
    runtime.dispose();
  });

  it("round-trips isolated performance measurements through the render worker", async () => {
    vi.stubGlobal("window", globalThis);
    const worker = new FakeWorker();
    const runtime = new GhostteaTerminalRuntime({
      ports: { control: new FakePort() as unknown as MessagePort, frames: new FakePort() as unknown as MessagePort },
      platform: {
        writeClipboard: () => undefined,
        forceCanvasFallback: () => false,
        setForceCanvasFallback: () => undefined,
        reload: () => undefined,
      },
      workerFactory: () => worker as unknown as Worker,
    });

    runtime.setPartialRenderingEnabled(false);
    expect(worker.messages.at(-1)).toEqual({ type: "partial-rendering", enabled: false });
    runtime.forceFullRedraw("pane-handle");
    expect(worker.messages.at(-1)).toEqual({ type: "force-full-redraw", sessionHandle: "pane-handle" });
    runtime.forceRowRedraw("pane-handle", 7);
    expect(worker.messages.at(-1)).toEqual({ type: "force-row-redraw", sessionHandle: "pane-handle", row: 7 });

    const started = runtime.startPerformanceMeasurement();
    const startMessage = worker.messages.at(-1) as { requestId: number; type: string };
    expect(startMessage.type).toBe("performance-start");
    worker.dispatchEvent(
      new MessageEvent("message", { data: { type: "performance-started", requestId: startMessage.requestId } }),
    );
    await expect(started).resolves.toBeUndefined();

    const finished = runtime.finishPerformanceMeasurement({ quietMs: 50, timeoutMs: 1_000 });
    const finishMessage = worker.messages.at(-1) as { requestId: number; type: string };
    expect(finishMessage).toMatchObject({ type: "performance-finish", quietMs: 50, timeoutMs: 1_050 });
    const snapshot = {
      backend: "webgpu",
      durationMs: 100,
      timedOutWaitingForIdle: false,
      gpuQueueDrainMs: 1,
      frames: {
        received: 1,
        bytes: 16,
        full: 1,
        incremental: 0,
        stale: 0,
        resyncRequested: 0,
        rowsDecoded: 24,
        glyphDefinitions: 10,
      },
      scheduling: { flushes: 1, renderCalls: 1, maximumDirtyPanes: 1, panesPerFlush: [1] },
      renderer: {
        queueSubmits: 1,
        fullRenders: 1,
        partialRenders: 0,
        damagedRows: 24,
        geometryCacheHits: 0,
        geometryCacheMisses: 0,
        canvasPixelFrames: 100,
        renderPasses: 2,
        drawCalls: 2,
        rectangleVertices: 6,
        monoGlyphVertices: 6,
        colorGlyphVertices: 0,
        fallbackGlyphVertices: 0,
        vertexUploadBytes: 336,
        atlasUploadBytes: 0,
        atlasUploadCalls: 0,
      },
      samples: { frameApplyMs: [1], renderCpuMs: [2], dirtyToRenderMs: [8], frameArrivalToRenderMs: [9] },
    };
    worker.dispatchEvent(
      new MessageEvent("message", {
        data: { type: "performance-result", requestId: finishMessage.requestId, snapshot },
      }),
    );
    await expect(finished).resolves.toEqual(snapshot);
    runtime.dispose();
  });

  it("copies stable terminal-owned selection text through the platform clipboard", async () => {
    vi.stubGlobal("window", globalThis);
    const worker = new FakeWorker();
    const writeClipboard = vi.fn();
    const runtime = new GhostteaTerminalRuntime({
      ports: { control: new FakePort() as unknown as MessagePort, frames: new FakePort() as unknown as MessagePort },
      platform: {
        writeClipboard,
        forceCanvasFallback: () => false,
        setForceCanvasFallback: () => undefined,
        reload: () => undefined,
      },
      workerFactory: () => worker as unknown as Worker,
    });
    await runtime.connect();
    runtime.registerSession(session);
    runtime.mount(session.id, session.handle, "view-1", canvas());
    await flushMicrotasks();
    const selection = { anchor: { column: 1, row: 42 }, focus: { column: 4, row: 45 } };

    await expect(runtime.copySelection(session.id, "view-1", selection)).resolves.toBe("copied from terminal");
    expect(writeClipboard).toHaveBeenCalledOnce();
    expect(writeClipboard).toHaveBeenCalledWith("copied from terminal");
  });

  it("publishes scrollbar state and sends absolute scroll positions through the attached view", async () => {
    vi.stubGlobal("window", globalThis);
    const worker = new FakeWorker();
    const control = new FakePort();
    const frames = new FakePort();
    const runtime = new GhostteaTerminalRuntime({
      ports: { control: control as unknown as MessagePort, frames: frames as unknown as MessagePort },
      platform: {
        writeClipboard: () => undefined,
        forceCanvasFallback: () => false,
        setForceCanvasFallback: () => undefined,
        reload: () => undefined,
      },
      workerFactory: () => worker as unknown as Worker,
    });
    await runtime.connect();
    runtime.registerSession(session);
    runtime.mount(session.id, session.handle, "view-1", canvas());
    await flushMicrotasks();

    const observed: unknown[] = [];
    runtime.addEventListener("scrollbar-state", (event) => observed.push((event as CustomEvent).detail));
    worker.dispatchEvent(
      new MessageEvent("message", {
        data: {
          type: "scrollbar-state",
          sessionHandle: session.handle,
          scrollbar: { total: 100, offset: 52, length: 24 },
        },
      }),
    );
    runtime.scrollTo(session.id, "view-1", 18);

    expect(runtime.scrollbar(session.handle)).toEqual({ total: 100, offset: 52, length: 24 });
    expect(observed).toEqual([{ sessionHandle: session.handle, scrollbar: { total: 100, offset: 52, length: 24 } }]);
    expect(control.messages).toContainEqual({
      requestId: 0,
      type: "scroll-to",
      sessionId: session.id,
      viewId: "view-1",
      attachmentEpoch: 2,
      inputSequence: 1,
      row: 18,
    });
  });

  it("forwards tab visibility to the renderer without detaching the terminal view", async () => {
    vi.stubGlobal("window", globalThis);
    const worker = new FakeWorker();
    const control = new FakePort();
    const frames = new FakePort();
    const runtime = new GhostteaTerminalRuntime({
      ports: { control: control as unknown as MessagePort, frames: frames as unknown as MessagePort },
      platform: {
        writeClipboard: () => undefined,
        forceCanvasFallback: () => false,
        setForceCanvasFallback: () => undefined,
        reload: () => undefined,
      },
      workerFactory: () => worker as unknown as Worker,
    });
    await runtime.connect();

    runtime.setVisible("handle", false);
    runtime.setVisible("handle", true);

    expect(worker.messages).toContainEqual({ type: "visibility", sessionHandle: "handle", visible: false });
    expect(worker.messages).toContainEqual({ type: "visibility", sessionHandle: "handle", visible: true });
    expect(control.messages.some((message) => message.type === "detach-session")).toBe(false);
  });

  it("subscribes the frame bridge only while a session is mounted", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", globalThis);
    const frames = new FakePort();
    const runtime = new GhostteaTerminalRuntime({
      ports: { control: new FakePort() as unknown as MessagePort, frames: frames as unknown as MessagePort },
      platform: {
        writeClipboard: () => undefined,
        forceCanvasFallback: () => false,
        setForceCanvasFallback: () => undefined,
        reload: () => undefined,
      },
      workerFactory: () => new FakeWorker() as unknown as Worker,
    });
    await runtime.connect();
    runtime.registerSession(session);
    expect(
      frames.messages.filter((message) => message.type === "subscribe").map((message) => message.sessionHandles),
    ).toEqual([[]]);
    const mount = runtime.mount(session.id, session.handle, "view-subscription", canvas());
    await flushMicrotasks();

    expect(
      frames.messages.filter((message) => message.type === "subscribe").map((message) => message.sessionHandles),
    ).toEqual([[], [session.handle]]);

    mount.dispose();
    await vi.advanceTimersByTimeAsync(1_001);
    expect(frames.messages.at(-1)).toMatchObject({ type: "subscribe", sessionHandles: [] });
  });

  it("serializes subscription mutations before attaching a newly mounted view", async () => {
    vi.stubGlobal("window", globalThis);
    const worker = new FakeWorker();
    const control = new FakePort();
    const frames = new FakePort();
    const runtime = new GhostteaTerminalRuntime({
      ports: { control: control as unknown as MessagePort, frames: frames as unknown as MessagePort },
      platform: {
        writeClipboard: () => undefined,
        forceCanvasFallback: () => false,
        setForceCanvasFallback: () => undefined,
        reload: () => undefined,
      },
      workerFactory: () => worker as unknown as Worker,
    });
    await runtime.connect();
    frames.deferSubscriptionAcknowledgements = true;
    const first = { ...session, id: "session-a", handle: "handle-a" };
    const second = { ...session, id: "session-b", handle: "handle-b" };
    runtime.registerSession(first);
    runtime.registerSession(second);

    runtime.setSessionPinned(first.handle, true);
    await flushMicrotasks();
    runtime.setSessionPinned(second.handle, true);
    runtime.mount(second.id, second.handle, "view-b", canvas());
    await flushMicrotasks();

    expect(
      frames.messages.filter((message) => message.type === "subscribe").map((message) => message.sessionHandles),
    ).toEqual([[], [first.handle]]);
    expect(control.messages.some((message) => message.type === "attach-session")).toBe(false);

    frames.acknowledgeSubscription();
    await flushMicrotasks();
    expect(frames.messages.at(-1)).toMatchObject({
      type: "subscribe",
      sessionHandles: [first.handle, second.handle],
    });
    expect(control.messages.some((message) => message.type === "attach-session")).toBe(false);

    frames.acknowledgeSubscription();
    await flushMicrotasks();
    expect(control.messages).toContainEqual(
      expect.objectContaining({ type: "attach-session", sessionId: second.id, viewId: "view-b" }),
    );
    runtime.dispose();
  });

  it("attributes live views to their application owner only after protocol 1.14", async () => {
    vi.stubGlobal("window", globalThis);
    const platform = {
      writeClipboard: () => undefined,
      forceCanvasFallback: () => false,
      setForceCanvasFallback: () => undefined,
      reload: () => undefined,
    };

    const currentControl = new FakePort();
    const current = new GhostteaTerminalRuntime({
      ports: { control: currentControl as unknown as MessagePort, frames: new FakePort() as unknown as MessagePort },
      sessionOwnerId: "tab-a",
      platform,
      workerFactory: () => new FakeWorker() as unknown as Worker,
    });
    await current.connect();
    current.registerSession(session);
    current.mount(session.id, session.handle, "current-view", canvas());
    await flushMicrotasks();
    expect(currentControl.messages).toContainEqual(
      expect.objectContaining({ type: "attach-session", viewId: "current-view", ownerId: "tab-a" }),
    );
    current.dispose();

    const legacyControl = new FakePort();
    legacyControl.helloProtocolMinor = 13;
    const legacy = new GhostteaTerminalRuntime({
      ports: { control: legacyControl as unknown as MessagePort, frames: new FakePort() as unknown as MessagePort },
      sessionOwnerId: "tab-a",
      platform,
      workerFactory: () => new FakeWorker() as unknown as Worker,
    });
    await legacy.connect();
    legacy.registerSession(session);
    legacy.mount(session.id, session.handle, "legacy-owner-view", canvas());
    await flushMicrotasks();
    expect(legacyControl.messages.find((message) => message.type === "attach-session")).not.toHaveProperty("ownerId");
    legacy.dispose();
  });

  it("accepts daemon acknowledgements forwarded as bytes by an older bridge", async () => {
    vi.stubGlobal("window", globalThis);
    const frames = new FakePort();
    frames.bridgeCapabilities = false;
    frames.subscriptionControlAsArrayBuffer = true;
    const runtime = new GhostteaTerminalRuntime({
      ports: { control: new FakePort() as unknown as MessagePort, frames: frames as unknown as MessagePort },
      platform: {
        writeClipboard: () => undefined,
        forceCanvasFallback: () => false,
        setForceCanvasFallback: () => undefined,
        reload: () => undefined,
      },
      workerFactory: () => new FakeWorker() as unknown as Worker,
    });

    await expect(runtime.connect()).resolves.toBeUndefined();
    expect(frames.messages.at(-1)).toMatchObject({
      type: "subscribe",
      bridgeCapabilities: 1,
      sessionHandles: [],
    });
    runtime.dispose();
  });

  it("resynchronizes only sessions attributed to a frame transport gap", async () => {
    vi.stubGlobal("window", globalThis);
    const worker = new FakeWorker();
    const frames = new FakePort();
    const runtime = new GhostteaTerminalRuntime({
      ports: { control: new FakePort() as unknown as MessagePort, frames: frames as unknown as MessagePort },
      platform: {
        writeClipboard: () => undefined,
        forceCanvasFallback: () => false,
        setForceCanvasFallback: () => undefined,
        reload: () => undefined,
      },
      workerFactory: () => worker as unknown as Worker,
    });
    await runtime.connect();
    const first = { ...session, id: "session-a", handle: "handle-a" };
    const second = { ...session, id: "session-b", handle: "handle-b" };
    runtime.registerSession(first);
    runtime.registerSession(second);
    runtime.setSessionPinned(first.handle, true);
    runtime.setSessionPinned(second.handle, true);
    await flushMicrotasks();
    worker.messages.length = 0;

    frames.onmessage?.(
      new MessageEvent("message", {
        data: { type: "frame-gap", skipped: 3, sessionHandles: [first.handle], historyComplete: true },
      }),
    );

    expect(worker.messages).toEqual([{ type: "frame-gap", sessionHandles: [first.handle] }]);
    runtime.dispose();
  });

  it("keeps an older bridge responsive without enabling unacknowledged frame credits", async () => {
    vi.stubGlobal("window", globalThis);
    const worker = new FakeWorker();
    const control = new FakePort();
    const frames = new FakePort();
    control.helloProtocolMinor = 6;
    frames.bridgeCapabilities = false;
    frames.subscriptionAcknowledgements = false;
    const runtime = new GhostteaTerminalRuntime({
      ports: { control: control as unknown as MessagePort, frames: frames as unknown as MessagePort },
      platform: {
        writeClipboard: () => undefined,
        forceCanvasFallback: () => false,
        setForceCanvasFallback: () => undefined,
        reload: () => undefined,
      },
      workerFactory: () => worker as unknown as Worker,
    });

    await runtime.connect();
    runtime.registerSession(session);
    runtime.mount(session.id, session.handle, "legacy-view", canvas());
    await flushMicrotasks();
    worker.dispatchEvent(new MessageEvent("message", { data: { type: "frame-credit", bytes: 512 } }));

    expect(control.messages).toContainEqual(
      expect.objectContaining({ type: "attach-session", sessionId: session.id, viewId: "legacy-view" }),
    );
    expect(frames.messages.filter((message) => message.type === "subscribe")).not.toContainEqual(
      expect.objectContaining({ frameCredits: true }),
    );
    expect(frames.messages.some((message) => message.type === "frame-credit")).toBe(false);
    expect(worker.messages).toContainEqual({ type: "expect-full", sessionHandle: session.handle });
    expect(control.messages.findIndex((message) => message.type === "refresh-session")).toBeLessThan(
      control.messages.findIndex((message) => message.type === "attach-session"),
    );
    runtime.dispose();
  });

  it("uses bridge-negotiated credits even when ghosttead predates subscription acknowledgements", async () => {
    vi.stubGlobal("window", globalThis);
    const worker = new FakeWorker();
    const control = new FakePort();
    const frames = new FakePort();
    control.helloProtocolMinor = 6;
    frames.subscriptionAcknowledgements = false;
    const runtime = new GhostteaTerminalRuntime({
      ports: { control: control as unknown as MessagePort, frames: frames as unknown as MessagePort },
      platform: {
        writeClipboard: () => undefined,
        forceCanvasFallback: () => false,
        setForceCanvasFallback: () => undefined,
        reload: () => undefined,
      },
      workerFactory: () => worker as unknown as Worker,
    });

    await runtime.connect();
    worker.dispatchEvent(new MessageEvent("message", { data: { type: "frame-credit", bytes: 512 } }));

    expect(frames.messages).toContainEqual({ type: "frame-credit", bytes: 512 });
    runtime.dispose();
  });

  it("unregisters renderer state without terminating the underlying PTY", async () => {
    vi.stubGlobal("window", globalThis);
    const worker = new FakeWorker();
    const control = new FakePort();
    const frames = new FakePort();
    const runtime = new GhostteaTerminalRuntime({
      ports: { control: control as unknown as MessagePort, frames: frames as unknown as MessagePort },
      platform: {
        writeClipboard: () => undefined,
        forceCanvasFallback: () => false,
        setForceCanvasFallback: () => undefined,
        reload: () => undefined,
      },
      workerFactory: () => worker as unknown as Worker,
    });
    await runtime.connect();
    runtime.registerSession(session);
    runtime.mount(session.id, session.handle, "view-unregister", canvas());
    await flushMicrotasks();

    runtime.unregisterSession(session.id);
    await flushMicrotasks();

    expect(control.messages.some((message) => message.type === "terminate")).toBe(false);
    expect(control.messages).toContainEqual({
      requestId: 0,
      type: "detach-session",
      sessionId: session.id,
      viewId: "view-unregister",
    });
    expect(runtime.sessionMetadata(session.handle)).toBeUndefined();
    expect(worker.messages).toContainEqual({ type: "drop-session", sessionHandle: session.handle });
    expect(frames.messages.at(-1)).toMatchObject({ type: "subscribe", sessionHandles: [] });
  });

  it("returns renderer subscriptions and metadata to baseline after session churn", async () => {
    vi.stubGlobal("window", globalThis);
    const worker = new FakeWorker();
    const control = new FakePort();
    const frames = new FakePort();
    const runtime = new GhostteaTerminalRuntime({
      ports: { control: control as unknown as MessagePort, frames: frames as unknown as MessagePort },
      platform: {
        writeClipboard: () => undefined,
        forceCanvasFallback: () => false,
        setForceCanvasFallback: () => undefined,
        reload: () => undefined,
      },
      workerFactory: () => worker as unknown as Worker,
    });
    await runtime.connect();

    const sessionCount = 256;
    for (let index = 0; index < sessionCount; index += 1) {
      const current = {
        ...session,
        id: `churn-session-${index}`,
        handle: String(10_000 + index),
      };
      runtime.registerSession(current);
      runtime.mount(current.id, current.handle, `churn-view-${index}`, canvas());
      await flushMicrotasks();
      runtime.unregisterSession(current.id);
      await flushMicrotasks();
      expect(runtime.sessionMetadata(current.handle)).toBeUndefined();
    }

    expect(control.messages.some((message) => message.type === "terminate")).toBe(false);
    expect(frames.messages.at(-1)).toMatchObject({ type: "subscribe", sessionHandles: [] });
    expect(
      worker.messages.filter(
        (message) =>
          message !== null && typeof message === "object" && "type" in message && message.type === "drop-session",
      ),
    ).toHaveLength(sessionCount);
    runtime.dispose();
  });

  it("applies unsolicited activity changes without waiting for a terminal frame", async () => {
    vi.stubGlobal("window", globalThis);
    const control = new FakePort();
    const runtime = new GhostteaTerminalRuntime({
      ports: { control: control as unknown as MessagePort, frames: new FakePort() as unknown as MessagePort },
      platform: {
        writeClipboard: () => undefined,
        forceCanvasFallback: () => false,
        setForceCanvasFallback: () => undefined,
        reload: () => undefined,
      },
      workerFactory: () => new FakeWorker() as unknown as Worker,
    });
    await runtime.connect();
    runtime.registerSession(session);
    const activities: unknown[] = [];
    const metadata: SessionSummary[] = [];
    runtime.addEventListener("session-activity", (event) => activities.push((event as CustomEvent).detail));
    runtime.addEventListener("session-metadata", (event) =>
      metadata.push((event as CustomEvent<SessionSummary>).detail),
    );

    const activity = {
      kind: "foreground-job",
      source: "process-group",
      confidence: "heuristic",
      rootProcessGroupId: 42,
      foregroundProcessGroupId: 43,
      observedAtMs: 100,
    } as const;
    control.dispatchEvent(
      new MessageEvent("message", {
        data: {
          requestId: 0,
          type: "session-activity-changed",
          sessionId: session.id,
          activity,
        },
      }),
    );

    expect(runtime.sessionMetadata(session.handle)?.activity).toEqual(activity);
    expect(activities).toEqual([{ requestId: 0, type: "session-activity-changed", sessionId: session.id, activity }]);
    expect(metadata.at(-1)?.activity).toEqual(activity);
  });

  it("cancels metadata refreshes and preserves complete exit metadata when a session exits", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", globalThis);
    const control = new FakePort();
    const frames = new FakePort();
    const runtime = new GhostteaTerminalRuntime({
      ports: { control: control as unknown as MessagePort, frames: frames as unknown as MessagePort },
      platform: {
        writeClipboard: () => undefined,
        forceCanvasFallback: () => false,
        setForceCanvasFallback: () => undefined,
        reload: () => undefined,
      },
      workerFactory: () => new FakeWorker() as unknown as Worker,
    });
    await runtime.connect();
    const exitingSession = { ...session, handle: "7" };
    runtime.registerSession(exitingSession);
    runtime.setSessionPinned(exitingSession.handle, true);
    const updates: SessionSummary[] = [];
    runtime.addEventListener("session-metadata", (event) =>
      updates.push((event as CustomEvent<SessionSummary>).detail),
    );

    const frame = frameForHandle(exitingSession.handle);
    frames.onmessage?.(new MessageEvent("message", { data: frame }));
    control.dispatchEvent(
      new MessageEvent("message", {
        data: {
          requestId: 0,
          type: "session-exited",
          sessionId: exitingSession.id,
          exitCode: null,
          exitSignal: "SIGTERM",
          requestedTermination: "user",
          exitOutcome: "user-terminated",
        },
      }),
    );
    await vi.advanceTimersByTimeAsync(250);

    expect(control.messages.some((message) => message.type === "get-session")).toBe(false);
    expect(updates.at(-1)).toMatchObject({
      exited: true,
      exitCode: null,
      exitSignal: "SIGTERM",
      requestedTermination: "user",
      exitOutcome: "user-terminated",
    });
  });

  it("suppresses an in-flight metadata failure after the session has exited", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", globalThis);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const control = new FakePort();
    const frames = new FakePort();
    const runtime = new GhostteaTerminalRuntime({
      ports: { control: control as unknown as MessagePort, frames: frames as unknown as MessagePort },
      platform: {
        writeClipboard: () => undefined,
        forceCanvasFallback: () => false,
        setForceCanvasFallback: () => undefined,
        reload: () => undefined,
      },
      workerFactory: () => new FakeWorker() as unknown as Worker,
    });
    await runtime.connect();
    const exitingSession = { ...session, handle: "8" };
    runtime.registerSession(exitingSession);
    runtime.setSessionPinned(exitingSession.handle, true);

    const frame = frameForHandle(exitingSession.handle);
    frames.onmessage?.(new MessageEvent("message", { data: frame }));
    await vi.advanceTimersByTimeAsync(200);
    const refresh = control.messages.find((message) => message.type === "get-session");
    expect(refresh).toBeDefined();

    control.dispatchEvent(
      new MessageEvent("message", {
        data: {
          requestId: 0,
          type: "session-exited",
          sessionId: exitingSession.id,
          exitCode: 0,
          exitSignal: null,
          requestedTermination: null,
          exitOutcome: "completed",
        },
      }),
    );
    frames.onmessage?.(new MessageEvent("message", { data: frame }));
    control.dispatchEvent(
      new MessageEvent("message", {
        data: { requestId: refresh!.requestId, type: "error", message: "unknown session" },
      }),
    );
    await vi.advanceTimersByTimeAsync(250);

    expect(control.messages.filter((message) => message.type === "get-session")).toHaveLength(1);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("propagates actual read-only attachment access and suppresses terminal input", async () => {
    vi.stubGlobal("window", globalThis);
    const control = new FakePort();
    control.attachReadWrite = false;
    const runtime = new GhostteaTerminalRuntime({
      ports: { control: control as unknown as MessagePort, frames: new FakePort() as unknown as MessagePort },
      platform: {
        writeClipboard: () => undefined,
        forceCanvasFallback: () => false,
        setForceCanvasFallback: () => undefined,
        reload: () => undefined,
      },
      workerFactory: () => new FakeWorker() as unknown as Worker,
    });
    await runtime.connect();
    runtime.registerSession(session);
    const updates: SessionSummary[] = [];
    runtime.addEventListener("session-metadata", (event) =>
      updates.push((event as CustomEvent<SessionSummary>).detail),
    );
    runtime.mount(session.id, session.handle, "view-only", canvas());
    await flushMicrotasks();

    runtime.sendText(session.id, "view-only", "blocked");

    expect(updates.at(-1)?.readWrite).toBe(false);
    expect(control.messages.some((message) => message.type === "send-text")).toBe(false);
  });

  it("never delivers keystrokes typed while a remote session is not live", async () => {
    vi.stubGlobal("window", globalThis);
    const control = new FakePort();
    const runtime = new GhostteaTerminalRuntime({
      ports: { control: control as unknown as MessagePort, frames: new FakePort() as unknown as MessagePort },
      platform: {
        writeClipboard: () => undefined,
        forceCanvasFallback: () => false,
        setForceCanvasFallback: () => undefined,
        reload: () => undefined,
      },
      workerFactory: () => new FakeWorker() as unknown as Worker,
    });
    control.deferAttachments = true;
    await runtime.connect();
    const suppressed: string[] = [];
    runtime.addEventListener("input-suppressed", (event) =>
      suppressed.push((event as CustomEvent<{ state: string }>).detail.state),
    );
    const remote = await runtime.openRemoteSession("device", "remote", 80, 24, "studio-mac");
    runtime.mount(remote.id, remote.handle, "view-1", canvas());
    await flushMicrotasks();

    // A remote attach is a network round-trip, not the millisecond local one
    // the queue exists for, so this keystroke is dropped rather than held.
    runtime.sendText(remote.id, "view-1", "typed before attach");
    control.completeAttachment();
    await flushMicrotasks();
    expect(control.messages.some((message) => message.type === "send-text")).toBe(false);

    control.emitLifecycle({ lifecycleSeq: 1, state: "reconnecting" });
    runtime.sendText(remote.id, "view-1", "typed while reconnecting");
    control.emitLifecycle({ lifecycleSeq: 2, state: "suspended" });
    runtime.paste(remote.id, "view-1", "pasted while suspended");
    await flushMicrotasks();
    expect(control.messages.some((message) => message.type === "send-text" || message.type === "paste")).toBe(false);
    expect(suppressed).toEqual(["opening", "reconnecting", "suspended"]);

    control.emitLifecycle({ lifecycleSeq: 3, state: "live" });
    control.emitViewState({ viewStateSeq: 4, attachmentEpoch: 9 });
    await flushMicrotasks();
    runtime.sendText(remote.id, "view-1", "typed after recovery");

    const delivered = control.messages.filter((message) => message.type === "send-text");
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({ text: "typed after recovery", attachmentEpoch: 9, inputSequence: 1 });
    runtime.dispose();
  });

  it("learns a session is remote from an opening event and holds its input", async () => {
    vi.stubGlobal("window", globalThis);
    const control = new FakePort();
    const runtime = new GhostteaTerminalRuntime({
      ports: { control: control as unknown as MessagePort, frames: new FakePort() as unknown as MessagePort },
      platform: {
        writeClipboard: () => undefined,
        forceCanvasFallback: () => false,
        setForceCanvasFallback: () => undefined,
        reload: () => undefined,
      },
      workerFactory: () => new FakeWorker() as unknown as Worker,
    });
    await runtime.connect();
    // A session restored into a pane was never opened through this runtime, so
    // the lifecycle event is the only thing that can mark it remote.
    runtime.registerSession(session);
    runtime.mount(session.id, session.handle, "view-1", canvas());
    await flushMicrotasks();
    control.emitLifecycle({ lifecycleSeq: 0, state: "opening" });

    expect(runtime.remoteSession(session.id)).toMatchObject({ state: "opening", deviceName: "studio-mac" });
    runtime.sendText(session.id, "view-1", "typed while opening");
    expect(control.messages.some((message) => message.type === "send-text")).toBe(false);

    control.emitLifecycle({ lifecycleSeq: 1, state: "live" });
    runtime.sendText(session.id, "view-1", "typed once live");
    expect(control.messages.filter((message) => message.type === "send-text")).toMatchObject([
      { text: "typed once live" },
    ]);
    runtime.dispose();
  });

  it("keeps a resumed pane cooled until the recovered stream commits a frame", async () => {
    vi.stubGlobal("window", globalThis);
    const worker = new FakeWorker();
    const control = new FakePort();
    const runtime = new GhostteaTerminalRuntime({
      ports: { control: control as unknown as MessagePort, frames: new FakePort() as unknown as MessagePort },
      platform: {
        writeClipboard: () => undefined,
        forceCanvasFallback: () => false,
        setForceCanvasFallback: () => undefined,
        reload: () => undefined,
      },
      workerFactory: () => worker as unknown as Worker,
    });
    await runtime.connect();
    const remote = await runtime.openRemoteSession("device", "remote", 80, 24, "studio-mac");
    runtime.mount(remote.id, remote.handle, "view-1", canvas());
    await flushMicrotasks();
    const states: boolean[] = [];
    runtime.addEventListener("remote-session-state", (event) =>
      states.push((event as CustomEvent<{ awaitingRecoveryFrame: boolean }>).detail.awaitingRecoveryFrame),
    );

    control.emitLifecycle({ lifecycleSeq: 1, state: "reconnecting" });
    control.emitLifecycle({ lifecycleSeq: 2, state: "live" });
    // Live again, but the screen is still the pre-outage one.
    expect(runtime.remoteSession(remote.id)?.awaitingRecoveryFrame).toBe(true);
    expect(worker.messages.filter((message) => (message as { type?: string }).type === "cursor-frozen").at(-1)).toEqual(
      {
        type: "cursor-frozen",
        surfaceId: "view-1",
        frozen: true,
      },
    );

    worker.commitFrame(remote.handle);

    expect(runtime.remoteSession(remote.id)?.awaitingRecoveryFrame).toBe(false);
    expect(states).toEqual([false, true, false]);
    expect(worker.messages.filter((message) => (message as { type?: string }).type === "cursor-frozen").at(-1)).toEqual(
      {
        type: "cursor-frozen",
        surfaceId: "view-1",
        frozen: false,
      },
    );
    runtime.dispose();
  });

  it("claims resize control once per attachment epoch only after an explicit request", async () => {
    vi.stubGlobal("window", globalThis);
    const control = new FakePort();
    const runtime = new GhostteaTerminalRuntime({
      ports: { control: control as unknown as MessagePort, frames: new FakePort() as unknown as MessagePort },
      platform: {
        writeClipboard: () => undefined,
        forceCanvasFallback: () => false,
        setForceCanvasFallback: () => undefined,
        reload: () => undefined,
      },
      workerFactory: () => new FakeWorker() as unknown as Worker,
    });
    await runtime.connect();
    runtime.registerSession(session);
    runtime.mount(session.id, session.handle, "view-1", canvas());
    await flushMicrotasks();
    const claims = (): Record<string, unknown>[] =>
      control.messages.filter((message) => message.type === "focus-and-resize");

    runtime.claimResizeControl(session.handle, "view-1", 80, 24);
    expect(claims()).toHaveLength(1);

    // Focus is scheduling state only and cannot add another geometry claim.
    runtime.setFocused(session.handle, "view-1", true, 80, 24);
    runtime.resize(session.id, "view-1", 100, 30);
    expect(claims()).toHaveLength(1);

    // A fresh attachment is a new epoch, and worth exactly one more claim.
    control.emitViewState({ viewStateSeq: 9, attachmentEpoch: 12 });
    expect(claims()).toHaveLength(2);
    expect(claims().at(-1)).toMatchObject({ attachmentEpoch: 12, cols: 100, rows: 30 });
    runtime.dispose();
  });

  it("lets a remounted pane reclaim the seat its previous incarnation held", async () => {
    // A split re-parents the active pane, so React remounts its surface: the
    // old view detaches while the record still names it, and a local session's
    // legacy control-changed frame can never say "no controller". The detach
    // itself must clear the seat here, or the new view waits forever.
    vi.stubGlobal("window", globalThis);
    const control = new FakePort();
    const runtime = new GhostteaTerminalRuntime({
      ports: { control: control as unknown as MessagePort, frames: new FakePort() as unknown as MessagePort },
      platform: {
        writeClipboard: () => undefined,
        forceCanvasFallback: () => false,
        setForceCanvasFallback: () => undefined,
        reload: () => undefined,
      },
      workerFactory: () => new FakeWorker() as unknown as Worker,
    });
    await runtime.connect();
    runtime.registerSession(session);
    const claims = (): Record<string, unknown>[] =>
      control.messages.filter((message) => message.type === "focus-and-resize");

    const first = runtime.mount(session.id, session.handle, "view-1", canvas());
    await flushMicrotasks();
    runtime.claimResizeControl(session.handle, "view-1", 80, 24);
    expect(claims()).toHaveLength(1);
    controlChanged(control, "view-1", 80, 24);

    // The remount: the successor attaches and asks while the record still names view-1.
    runtime.mount(session.id, session.handle, "view-2", canvas());
    await flushMicrotasks();
    runtime.claimResizeControl(session.handle, "view-2", 60, 18);
    expect(claims()).toHaveLength(1);

    // The old view goes; nothing arrives from the daemon about the seat.
    first.dispose();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await flushMicrotasks();

    expect(control.messages.filter((message) => message.type === "detach-session")).toMatchObject([
      { sessionId: session.id, viewId: "view-1" },
    ]);
    expect(claims()).toHaveLength(2);
    expect(claims().at(-1)).toMatchObject({ viewId: "view-2", cols: 60, rows: 18 });

    // Once the daemon seats the successor, its geometry flows again.
    controlChanged(control, "view-2", 60, 18);
    runtime.resize(session.id, "view-2", 50, 16);
    expect(control.messages.filter((message) => message.type === "resize").at(-1)).toMatchObject({
      viewId: "view-2",
      cols: 50,
      rows: 16,
    });
    runtime.dispose();
  });

  it("never turns focus into a geometry claim", async () => {
    vi.stubGlobal("window", globalThis);
    const control = new FakePort();
    const runtime = new GhostteaTerminalRuntime({
      ports: { control: control as unknown as MessagePort, frames: new FakePort() as unknown as MessagePort },
      platform: {
        writeClipboard: () => undefined,
        forceCanvasFallback: () => false,
        setForceCanvasFallback: () => undefined,
        reload: () => undefined,
      },
      workerFactory: () => new FakeWorker() as unknown as Worker,
    });
    await runtime.connect();
    runtime.registerSession(session);
    runtime.mount(session.id, session.handle, "mirror", canvas());
    await flushMicrotasks();

    for (let index = 0; index < 100; index += 1) {
      runtime.setFocused(session.handle, "mirror", index % 2 === 0, 80, 24);
    }
    runtime.resize(session.id, "mirror", 120, 40);

    expect(control.messages.filter((message) => message.type === "focus-and-resize")).toHaveLength(0);
    expect(control.messages.filter((message) => message.type === "resize")).toHaveLength(0);
    runtime.dispose();
  });

  it("thaws an idle pane whose recovery frame committed before the live event", async () => {
    vi.stubGlobal("window", globalThis);
    const worker = new FakeWorker();
    const control = new FakePort();
    const runtime = new GhostteaTerminalRuntime({
      ports: { control: control as unknown as MessagePort, frames: new FakePort() as unknown as MessagePort },
      platform: {
        writeClipboard: () => undefined,
        forceCanvasFallback: () => false,
        setForceCanvasFallback: () => undefined,
        reload: () => undefined,
      },
      workerFactory: () => worker as unknown as Worker,
    });
    await runtime.connect();
    const remote = await runtime.openRemoteSession("device", "remote", 80, 24, "studio-mac");
    runtime.mount(remote.id, remote.handle, "view-1", canvas());
    await flushMicrotasks();

    control.emitLifecycle({ lifecycleSeq: 1, state: "reconnecting" });
    // Frames and lifecycle events travel independent channels, so the recovery
    // snapshot can land first. An idle session then sends nothing further, and
    // waiting for a later frame would leave the pane frozen for good.
    worker.commitFrame(remote.handle);
    control.emitLifecycle({ lifecycleSeq: 2, state: "live" });

    expect(runtime.remoteSession(remote.id)?.awaitingRecoveryFrame).toBe(false);
    expect(worker.messages.filter((message) => (message as { type?: string }).type === "cursor-frozen").at(-1)).toEqual(
      { type: "cursor-frozen", surfaceId: "view-1", frozen: false },
    );
    runtime.dispose();
  });

  it("does not let a partial repaint of the stale screen pass as recovery", async () => {
    vi.stubGlobal("window", globalThis);
    const worker = new FakeWorker();
    const control = new FakePort();
    const runtime = new GhostteaTerminalRuntime({
      ports: { control: control as unknown as MessagePort, frames: new FakePort() as unknown as MessagePort },
      platform: {
        writeClipboard: () => undefined,
        forceCanvasFallback: () => false,
        setForceCanvasFallback: () => undefined,
        reload: () => undefined,
      },
      workerFactory: () => worker as unknown as Worker,
    });
    await runtime.connect();
    const remote = await runtime.openRemoteSession("device", "remote", 80, 24, "studio-mac");
    runtime.mount(remote.id, remote.handle, "view-1", canvas());
    await flushMicrotasks();

    control.emitLifecycle({ lifecycleSeq: 1, state: "reconnecting" });
    control.emitLifecycle({ lifecycleSeq: 2, state: "live" });
    // An older queued frame repaints part of the pre-outage screen.
    worker.commitFrame(remote.handle, { fullSnapshot: false, frameSequence: 7n });
    expect(runtime.remoteSession(remote.id)?.awaitingRecoveryFrame).toBe(true);

    worker.commitFrame(remote.handle, { frameSequence: 8n });
    expect(runtime.remoteSession(remote.id)?.awaitingRecoveryFrame).toBe(false);
    runtime.dispose();
  });

  it("requires a fresh snapshot for each outage, not the one that ended the last", async () => {
    vi.stubGlobal("window", globalThis);
    const worker = new FakeWorker();
    const control = new FakePort();
    const runtime = new GhostteaTerminalRuntime({
      ports: { control: control as unknown as MessagePort, frames: new FakePort() as unknown as MessagePort },
      platform: {
        writeClipboard: () => undefined,
        forceCanvasFallback: () => false,
        setForceCanvasFallback: () => undefined,
        reload: () => undefined,
      },
      workerFactory: () => worker as unknown as Worker,
    });
    await runtime.connect();
    const remote = await runtime.openRemoteSession("device", "remote", 80, 24, "studio-mac");
    runtime.mount(remote.id, remote.handle, "view-1", canvas());
    await flushMicrotasks();

    control.emitLifecycle({ lifecycleSeq: 1, state: "reconnecting" });
    control.emitLifecycle({ lifecycleSeq: 2, state: "live" });
    worker.commitFrame(remote.handle);
    expect(runtime.remoteSession(remote.id)?.awaitingRecoveryFrame).toBe(false);

    // A second outage starts its own episode; the previous snapshot proves
    // nothing about the screen this one left behind.
    control.emitLifecycle({ lifecycleSeq: 3, state: "reconnecting" });
    control.emitLifecycle({ lifecycleSeq: 4, state: "live" });
    expect(runtime.remoteSession(remote.id)?.awaitingRecoveryFrame).toBe(true);

    worker.commitFrame(remote.handle, { frameSequence: 2n });
    expect(runtime.remoteSession(remote.id)?.awaitingRecoveryFrame).toBe(false);
    runtime.dispose();
  });

  it("claims once when a recovered view is marked attached before its session is live", async () => {
    vi.stubGlobal("window", globalThis);
    const control = new FakePort();
    const renderWorker = new FakeWorker();
    const runtime = new GhostteaTerminalRuntime({
      ports: { control: control as unknown as MessagePort, frames: new FakePort() as unknown as MessagePort },
      platform: {
        writeClipboard: () => undefined,
        forceCanvasFallback: () => false,
        setForceCanvasFallback: () => undefined,
        reload: () => undefined,
      },
      workerFactory: () => renderWorker as unknown as Worker,
    });
    await runtime.connect();
    const remote = await runtime.openRemoteSession("device", "remote", 80, 24, "studio-mac");
    runtime.mount(remote.id, remote.handle, "view-1", canvas());
    await flushMicrotasks();
    runtime.claimResizeControl(remote.handle, "view-1", 80, 24);
    const claims = (): Record<string, unknown>[] =>
      control.messages.filter((message) => message.type === "focus-and-resize");
    const before = claims().length;
    control.emitLifecycle({ lifecycleSeq: 1, state: "reconnecting" });

    // Recovery marks the view attached *before* the session reaches live, so a
    // claim keyed on the attach event alone would fire into a dead session and
    // never retry.
    control.emitViewState({ viewStateSeq: 5, attachmentEpoch: 30 });
    expect(claims()).toHaveLength(before);

    control.emitLifecycle({ lifecycleSeq: 2, state: "live" });
    // Still showing the pre-outage screen: input is not ready, so neither is a claim.
    expect(claims()).toHaveLength(before);

    renderWorker.commitFrame(remote.handle, { frameSequence: 2n });
    expect(claims()).toHaveLength(before + 1);
    expect(claims().at(-1)).toMatchObject({ attachmentEpoch: 30 });

    // Duplicate events for the same epoch add nothing.
    control.emitViewState({ viewStateSeq: 6, attachmentEpoch: 30 });
    control.emitLifecycle({ lifecycleSeq: 3, state: "live" });
    expect(claims()).toHaveLength(before + 1);
    runtime.dispose();
  });

  it("claims nothing for a pane that does not hold meaningful focus", async () => {
    vi.stubGlobal("window", globalThis);
    const control = new FakePort();
    const runtime = new GhostteaTerminalRuntime({
      ports: { control: control as unknown as MessagePort, frames: new FakePort() as unknown as MessagePort },
      platform: {
        writeClipboard: () => undefined,
        forceCanvasFallback: () => false,
        setForceCanvasFallback: () => undefined,
        reload: () => undefined,
      },
      workerFactory: () => new FakeWorker() as unknown as Worker,
    });
    await runtime.connect();
    runtime.registerSession(session);
    runtime.mount(session.id, session.handle, "view-1", canvas());
    await flushMicrotasks();

    runtime.resize(session.id, "view-1", 100, 30);
    control.emitViewState({ viewStateSeq: 4, attachmentEpoch: 40 });
    expect(control.messages.filter((message) => message.type === "focus-and-resize")).toHaveLength(0);

    runtime.setFocused(session.handle, "view-1", false, 100, 30);
    control.emitViewState({ viewStateSeq: 5, attachmentEpoch: 41 });
    expect(control.messages.filter((message) => message.type === "focus-and-resize")).toHaveLength(0);
    runtime.dispose();
  });

  it("swaps against a reported revision and claims unconditionally without one", async () => {
    vi.stubGlobal("window", globalThis);
    const control = new FakePort();
    const runtime = new GhostteaTerminalRuntime({
      ports: { control: control as unknown as MessagePort, frames: new FakePort() as unknown as MessagePort },
      platform: {
        writeClipboard: () => undefined,
        forceCanvasFallback: () => false,
        setForceCanvasFallback: () => undefined,
        reload: () => undefined,
      },
      workerFactory: () => new FakeWorker() as unknown as Worker,
    });
    await runtime.connect();
    runtime.registerSession(session);
    runtime.mount(session.id, session.handle, "view-1", canvas());
    await flushMicrotasks();
    const claims = (): Record<string, unknown>[] =>
      control.messages.filter((message) => message.type === "focus-and-resize");

    runtime.claimResizeControl(session.handle, "view-1", 80, 24);
    expect(claims()).toHaveLength(1);

    // A host with no revisions has reported none, and 0 is the "unknown"
    // sentinel — swapping against it would be inventing an observation, so the
    // funnel's own claim goes out unconditional too.
    control.emitViewState({ viewStateSeq: 3, attachmentEpoch: 15 });
    expect(claims()).toHaveLength(2);
    expect(claims().at(-1)).toMatchObject({ attachmentEpoch: 15 });
    expect(claims().at(-1)).not.toHaveProperty("expectedControlRevision");

    // Once a revisioned host reports an empty seat, the claim swaps against it.
    control.dispatchEvent(
      new MessageEvent("message", {
        data: {
          requestId: 0,
          type: "control-state",
          sessionId: session.id,
          controller: null,
          controlRevision: 4,
          cols: 80,
          rows: 24,
          layoutEpoch: 2,
        },
      }),
    );
    expect(claims()).toHaveLength(3);
    expect(claims().at(-1)).toMatchObject({ expectedControlRevision: 4, attachmentEpoch: 15 });
    runtime.dispose();
  });

  it("withholds the swap from a daemon that predates it, and survives both claim answers", async () => {
    vi.stubGlobal("window", globalThis);
    const control = new FakePort();
    // A daemon on the lifecycle minor but before compare-and-swap: it would
    // ignore the field, turning a swap the caller believes in into a silent
    // overwrite, so the claim must go out unconditional despite a real revision.
    control.helloProtocolMinor = 12;
    const runtime = new GhostteaTerminalRuntime({
      ports: { control: control as unknown as MessagePort, frames: new FakePort() as unknown as MessagePort },
      platform: {
        writeClipboard: () => undefined,
        forceCanvasFallback: () => false,
        setForceCanvasFallback: () => undefined,
        reload: () => undefined,
      },
      workerFactory: () => new FakeWorker() as unknown as Worker,
    });
    await runtime.connect();
    runtime.registerSession(session);
    runtime.mount(session.id, session.handle, "view-1", canvas());
    await flushMicrotasks();
    const claims = (): Record<string, unknown>[] =>
      control.messages.filter((message) => message.type === "focus-and-resize");

    runtime.claimResizeControl(session.handle, "view-1", 80, 24);
    control.dispatchEvent(
      new MessageEvent("message", {
        data: {
          requestId: 0,
          type: "control-state",
          sessionId: session.id,
          controller: null,
          controlRevision: 11,
          cols: 80,
          rows: 24,
          layoutEpoch: 2,
        },
      }),
    );
    expect(claims()).toHaveLength(2);
    expect(claims().at(-1)).not.toHaveProperty("expectedControlRevision");

    // Whichever way a claim is answered, the control channel survives it: an
    // undecodable answer would take the socket down, not just the message.
    for (const answer of [
      {
        requestId: 0,
        type: "control-claimed",
        sessionId: session.id,
        controllerViewId: "view-1",
        controlEpoch: 5,
        controlRevision: 18,
        cols: 120,
        rows: 40,
        layoutEpoch: 3,
      },
      {
        requestId: 0,
        type: "control-rejected",
        sessionId: session.id,
        controller: null,
        controlRevision: 20,
        cols: 120,
        rows: 40,
        layoutEpoch: 3,
      },
      // "Cannot fence" is refused with a plain error, which must never read as
      // "you lost the race" — it changes no controller state at all.
      { requestId: 0, type: "error", message: "control revision fencing unavailable" },
    ]) {
      control.dispatchEvent(new MessageEvent("message", { data: answer }));
    }
    await flushMicrotasks();

    expect(control.closed).toBe(false);
    runtime.resize(session.id, "view-1", 90, 26);
    expect(control.messages.filter((message) => message.type === "resize")).toHaveLength(0);
    runtime.dispose();
  });

  it("drops a stale controller announcement whole rather than relabelling it", async () => {
    vi.stubGlobal("window", globalThis);
    const control = new FakePort();
    const runtime = new GhostteaTerminalRuntime({
      ports: { control: control as unknown as MessagePort, frames: new FakePort() as unknown as MessagePort },
      platform: {
        writeClipboard: () => undefined,
        forceCanvasFallback: () => false,
        setForceCanvasFallback: () => undefined,
        reload: () => undefined,
      },
      workerFactory: () => new FakeWorker() as unknown as Worker,
    });
    await runtime.connect();
    runtime.registerSession(session);
    runtime.mount(session.id, session.handle, "view-1", canvas());
    await flushMicrotasks();
    const announce = (controller: unknown, controlRevision: number): void => {
      control.dispatchEvent(
        new MessageEvent("message", {
          data: {
            requestId: 0,
            type: "control-state",
            sessionId: session.id,
            controller,
            controlRevision,
            cols: 80,
            rows: 24,
            layoutEpoch: 2,
          },
        }),
      );
    };
    const claims = (): Record<string, unknown>[] =>
      control.messages.filter((message) => message.type === "focus-and-resize");

    runtime.claimResizeControl(session.handle, "view-1", 80, 24);
    const before = claims().length;
    announce({ viewId: "other-pane", controlEpoch: 4 }, 31);

    // A clear from before that claim, delivered after it. Combining its payload
    // with the newer revision would invent "nobody holds control at 31" — an
    // empty seat whose expectation is genuinely current, so the host would
    // accept the claim and hand this pane control the other one still holds.
    announce(null, 30);
    expect(claims()).toHaveLength(before);

    // The cached view is still the newer one, so the seat stays taken: a later
    // clear at a revision that really is newer is what releases it.
    announce(null, 32);
    expect(claims()).toHaveLength(before + 1);
    expect(claims().at(-1)).toMatchObject({ expectedControlRevision: 32 });

    // The ordering rule covers revisioned announcements only. An unrevisioned
    // one carries no position to compare, so it stays last-write-wins — the
    // downgrade case where a revisioned daemon reports a session on a host
    // that has none. Ordering these by their 0 would drop every one of them:
    // this legacy event has to land, or the seat still looks empty and the
    // fresh epoch below takes control the other pane is holding.
    controlChanged(control, "other-pane", 80, 24);
    control.emitViewState({ viewStateSeq: 21, attachmentEpoch: 44 });
    expect(claims()).toHaveLength(before + 1);
    runtime.dispose();
  });

  it("ignores a controller announcement that repeats a revision it already acted on", async () => {
    vi.stubGlobal("window", globalThis);
    const control = new FakePort();
    const runtime = new GhostteaTerminalRuntime({
      ports: { control: control as unknown as MessagePort, frames: new FakePort() as unknown as MessagePort },
      platform: {
        writeClipboard: () => undefined,
        forceCanvasFallback: () => false,
        setForceCanvasFallback: () => undefined,
        reload: () => undefined,
      },
      workerFactory: () => new FakeWorker() as unknown as Worker,
    });
    await runtime.connect();
    runtime.registerSession(session);
    runtime.mount(session.id, session.handle, "view-1", canvas());
    await flushMicrotasks();
    const announce = (controller: unknown, controlRevision: number): void => {
      control.dispatchEvent(
        new MessageEvent("message", {
          data: {
            requestId: 0,
            type: "control-state",
            sessionId: session.id,
            controller,
            controlRevision,
            cols: 80,
            rows: 24,
            layoutEpoch: 2,
          },
        }),
      );
    };
    const claims = (): Record<string, unknown>[] =>
      control.messages.filter((message) => message.type === "focus-and-resize");

    runtime.claimResizeControl(session.handle, "view-1", 80, 24);
    announce(null, 9);
    expect(claims()).toHaveLength(2);
    expect(claims().at(-1)).toMatchObject({ expectedControlRevision: 9 });

    // A rejected claim announces the state that rejected it, and the same
    // state can be announced more than once. Re-running the funnel on an
    // announcement it has already acted on must not produce a second claim.
    announce(null, 9);
    announce(null, 9);
    expect(claims()).toHaveLength(2);
    runtime.dispose();
  });

  it("never claims control away from another pane, and retries when it is released", async () => {
    vi.stubGlobal("window", globalThis);
    const control = new FakePort();
    const runtime = new GhostteaTerminalRuntime({
      ports: { control: control as unknown as MessagePort, frames: new FakePort() as unknown as MessagePort },
      platform: {
        writeClipboard: () => undefined,
        forceCanvasFallback: () => false,
        setForceCanvasFallback: () => undefined,
        reload: () => undefined,
      },
      workerFactory: () => new FakeWorker() as unknown as Worker,
    });
    await runtime.connect();
    runtime.registerSession(session);
    runtime.mount(session.id, session.handle, "view-1", canvas());
    await flushMicrotasks();
    const controlState = (controller: unknown, controlRevision: number): void => {
      control.dispatchEvent(
        new MessageEvent("message", {
          data: {
            requestId: 0,
            type: "control-state",
            sessionId: session.id,
            controller,
            controlRevision,
            cols: 80,
            rows: 24,
            layoutEpoch: 2,
          },
        }),
      );
    };
    const claims = (): Record<string, unknown>[] =>
      control.messages.filter((message) => message.type === "focus-and-resize");

    // The host explicitly requests the geometry seat.
    runtime.claimResizeControl(session.handle, "view-1", 80, 24);
    expect(claims()).toHaveLength(1);

    // Automatic reclaim is the part that must not fight: a fresh epoch while
    // another view holds control claims nothing.
    controlState({ viewId: "other-pane", controlEpoch: 3 }, 5);
    control.emitViewState({ viewStateSeq: 9, attachmentEpoch: 12 });
    expect(claims()).toHaveLength(1);

    // Released at a newer revision, the pane that still holds focus takes it —
    // swapping against exactly the revision it saw the seat empty at.
    controlState(null, 6);
    expect(claims()).toHaveLength(2);
    expect(claims().at(-1)).toMatchObject({ attachmentEpoch: 12, expectedControlRevision: 6 });

    // The seat is ours now, so nothing further is claimed for this epoch.
    controlState({ viewId: "view-1", controlEpoch: 7 }, 7);
    expect(claims()).toHaveLength(2);

    // After a resume the record still names this view, but that is the
    // previous incarnation's claim: a fresh epoch has to take it back.
    control.emitViewState({ viewStateSeq: 14, attachmentEpoch: 20 });
    expect(claims()).toHaveLength(3);
    expect(claims().at(-1)).toMatchObject({ attachmentEpoch: 20 });
    runtime.dispose();
  });

  it("reports the reach of a selection the daemon answered locally", async () => {
    vi.stubGlobal("window", globalThis);
    const control = new FakePort();
    control.selectionScope = "viewport";
    const runtime = new GhostteaTerminalRuntime({
      ports: { control: control as unknown as MessagePort, frames: new FakePort() as unknown as MessagePort },
      platform: {
        writeClipboard: () => undefined,
        forceCanvasFallback: () => false,
        setForceCanvasFallback: () => undefined,
        reload: () => undefined,
      },
      workerFactory: () => new FakeWorker() as unknown as Worker,
    });
    await runtime.connect();
    const remote = await runtime.openRemoteSession("device", "remote", 80, 24, "studio-mac");
    runtime.mount(remote.id, remote.handle, "view-1", canvas());
    await flushMicrotasks();
    const scopes: string[] = [];
    runtime.addEventListener("selection-scope", (event) =>
      scopes.push((event as CustomEvent<{ scope: string }>).detail.scope),
    );

    await runtime.copySelection(remote.id, "view-1", {
      anchor: { column: 0, row: 0 },
      focus: { column: 4, row: 0 },
    });
    expect(scopes).toEqual(["viewport"]);

    // A daemon that answered from the host says nothing, and neither do we.
    control.selectionScope = undefined;
    await runtime.copySelection(remote.id, "view-1", {
      anchor: { column: 0, row: 0 },
      focus: { column: 4, row: 0 },
    });
    expect(scopes).toEqual(["viewport"]);
    runtime.dispose();
  });

  it("still queues a local session's keystrokes across its mount-to-attach gap", async () => {
    vi.stubGlobal("window", globalThis);
    const control = new FakePort();
    control.deferAttachments = true;
    const runtime = new GhostteaTerminalRuntime({
      ports: { control: control as unknown as MessagePort, frames: new FakePort() as unknown as MessagePort },
      platform: {
        writeClipboard: () => undefined,
        forceCanvasFallback: () => false,
        setForceCanvasFallback: () => undefined,
        reload: () => undefined,
      },
      workerFactory: () => new FakeWorker() as unknown as Worker,
    });
    await runtime.connect();
    runtime.registerSession(session);
    runtime.mount(session.id, session.handle, "view-1", canvas());
    await flushMicrotasks();

    runtime.sendText(session.id, "view-1", "typed before attach");
    expect(control.messages.some((message) => message.type === "send-text")).toBe(false);
    control.completeAttachment();
    await flushMicrotasks();

    expect(control.messages.filter((message) => message.type === "send-text")).toMatchObject([
      { text: "typed before attach", attachmentEpoch: 2, inputSequence: 1 },
    ]);
    runtime.dispose();
  });

  it("orders per-view state by sequence across events, reconciles, and attach responses", async () => {
    vi.stubGlobal("window", globalThis);
    const control = new FakePort();
    control.attachViewStateSeq = 3;
    const runtime = new GhostteaTerminalRuntime({
      ports: { control: control as unknown as MessagePort, frames: new FakePort() as unknown as MessagePort },
      platform: {
        writeClipboard: () => undefined,
        forceCanvasFallback: () => false,
        setForceCanvasFallback: () => undefined,
        reload: () => undefined,
      },
      workerFactory: () => new FakeWorker() as unknown as Worker,
    });
    await runtime.connect();
    const remote = await runtime.openRemoteSession("device", "remote", 80, 24, "studio-mac");
    runtime.mount(remote.id, remote.handle, "view-1", canvas());
    await flushMicrotasks();
    control.emitLifecycle({ lifecycleSeq: 1, state: "live" });

    // A delayed failure from an abandoned attempt must not unseat the newer
    // attachment the response already recorded.
    control.emitViewState({ viewStateSeq: 2, viewState: "failed", attachmentEpoch: null, readWrite: null });
    runtime.sendText(remote.id, "view-1", "after stale failure");
    await flushMicrotasks();
    expect(control.messages.filter((message) => message.type === "send-text")).toMatchObject([
      { attachmentEpoch: 2, inputSequence: 1 },
    ]);

    // A higher sequence wins, and a view that is not attached has no epoch.
    control.emitViewState({ viewStateSeq: 5, viewState: "failed", attachmentEpoch: null, readWrite: null });
    runtime.sendText(remote.id, "view-1", "after real failure");
    await flushMicrotasks();
    expect(control.messages.filter((message) => message.type === "send-text")).toHaveLength(1);

    control.remoteState = remoteSessionState({
      lifecycleSeq: 6,
      state: "live",
      views: [
        {
          viewId: "view-1",
          viewStateSeq: 7,
          viewState: "attached",
          attachmentEpoch: 11,
          readWrite: true,
          error: null,
          retryable: null,
        },
      ],
    });
    await runtime.getRemoteSessionState(remote.id);
    runtime.sendText(remote.id, "view-1", "after reconcile");
    await flushMicrotasks();
    expect(control.messages.filter((message) => message.type === "send-text")).toMatchObject([
      { attachmentEpoch: 2 },
      { attachmentEpoch: 11, text: "after reconcile" },
    ]);
    runtime.dispose();
  });

  it("applies an attach response from a daemon that predates the ordering fence", async () => {
    vi.stubGlobal("window", globalThis);
    const control = new FakePort();
    control.attachViewStateSeq = undefined;
    const runtime = new GhostteaTerminalRuntime({
      ports: { control: control as unknown as MessagePort, frames: new FakePort() as unknown as MessagePort },
      platform: {
        writeClipboard: () => undefined,
        forceCanvasFallback: () => false,
        setForceCanvasFallback: () => undefined,
        reload: () => undefined,
      },
      workerFactory: () => new FakeWorker() as unknown as Worker,
    });
    await runtime.connect();
    runtime.registerSession(session);
    runtime.mount(session.id, session.handle, "view-1", canvas());
    await flushMicrotasks();

    runtime.sendText(session.id, "view-1", "typed after legacy attach");
    expect(control.messages.filter((message) => message.type === "send-text")).toMatchObject([{ attachmentEpoch: 2 }]);
    runtime.dispose();
  });

  it("clears the per-view control epoch when the daemon reports no controller", async () => {
    vi.stubGlobal("window", globalThis);
    const control = new FakePort();
    const runtime = new GhostteaTerminalRuntime({
      ports: { control: control as unknown as MessagePort, frames: new FakePort() as unknown as MessagePort },
      platform: {
        writeClipboard: () => undefined,
        forceCanvasFallback: () => false,
        setForceCanvasFallback: () => undefined,
        reload: () => undefined,
      },
      workerFactory: () => new FakeWorker() as unknown as Worker,
    });
    await runtime.connect();
    runtime.registerSession(session);
    runtime.mount(session.id, session.handle, "view-1", canvas());
    await flushMicrotasks();
    runtime.claimResizeControl(session.handle, "view-1", 80, 24);

    control.dispatchEvent(
      new MessageEvent("message", {
        data: {
          requestId: 0,
          type: "control-state",
          sessionId: session.id,
          controller: { viewId: "view-1", controlEpoch: 7 },
          controlRevision: 4,
          cols: 80,
          rows: 24,
          layoutEpoch: 2,
        },
      }),
    );
    runtime.resize(session.id, "view-1", 100, 30);
    expect(control.messages.filter((message) => message.type === "resize")).toHaveLength(1);

    control.dispatchEvent(
      new MessageEvent("message", {
        data: {
          requestId: 0,
          type: "control-state",
          sessionId: session.id,
          controller: null,
          controlRevision: 5,
          cols: 80,
          rows: 24,
          layoutEpoch: 2,
        },
      }),
    );
    runtime.resize(session.id, "view-1", 110, 32);
    expect(control.messages.filter((message) => message.type === "resize")).toHaveLength(1);
    runtime.dispose();
  });

  it("reconciles every open remote session after the daemon reports lost events", async () => {
    vi.stubGlobal("window", globalThis);
    const control = new FakePort();
    const runtime = new GhostteaTerminalRuntime({
      ports: { control: control as unknown as MessagePort, frames: new FakePort() as unknown as MessagePort },
      platform: {
        writeClipboard: () => undefined,
        forceCanvasFallback: () => false,
        setForceCanvasFallback: () => undefined,
        reload: () => undefined,
      },
      workerFactory: () => new FakeWorker() as unknown as Worker,
    });
    await runtime.connect();
    control.sessions = [session];
    const remote = await runtime.openRemoteSession("device", "remote", 80, 24, "studio-mac");
    const states: string[] = [];
    runtime.addEventListener("remote-session-state", (event) =>
      states.push((event as CustomEvent<{ state: string }>).detail.state),
    );
    control.remoteState = remoteSessionState({ lifecycleSeq: 9, state: "ended", reason: "host-restarted" });
    control.dispatchEvent(new MessageEvent("message", { data: { requestId: 0, type: "events-lost", skipped: 3 } }));
    await flushMicrotasks();

    expect(control.remoteStateRequests).toEqual(["get-remote-session-state"]);
    expect(states).toEqual(["ended"]);
    expect(runtime.remoteSession(remote.id)).toMatchObject({ state: "ended", reason: "host-restarted" });
    runtime.dispose();
  });

  it("gives a one-shot reconnect the whole dial and handshake budget", async () => {
    vi.stubGlobal("window", globalThis);
    vi.useFakeTimers();
    const control = new FakePort();
    control.deferRemoteState = true;
    const runtime = new GhostteaTerminalRuntime({
      ports: { control: control as unknown as MessagePort, frames: new FakePort() as unknown as MessagePort },
      platform: {
        writeClipboard: () => undefined,
        forceCanvasFallback: () => false,
        setForceCanvasFallback: () => undefined,
        reload: () => undefined,
      },
      workerFactory: () => new FakeWorker() as unknown as Worker,
    });
    await runtime.connect();
    const remote = await runtime.openRemoteSession("device", "remote", 80, 24, "studio-mac");
    control.remoteState = remoteSessionState({ lifecycleSeq: 4, state: "live" });

    const reconnecting = runtime.reconnectRemoteSession(remote.id);
    // A default 10 s request budget could not survive a 20 s dial.
    await vi.advanceTimersByTimeAsync(30_000);
    control.answerRemoteState();
    await expect(reconnecting).resolves.toMatchObject({ state: "live" });
    expect(control.remoteStateRequests).toEqual(["reconnect-remote-session"]);
    runtime.dispose();
  });

  it("sends no lifecycle commands to a daemon that predates them", async () => {
    vi.stubGlobal("window", globalThis);
    const control = new FakePort();
    control.helloProtocolMinor = 11;
    control.configSnapshot = configSnapshot;
    const runtime = new GhostteaTerminalRuntime({
      ports: { control: control as unknown as MessagePort, frames: new FakePort() as unknown as MessagePort },
      platform: {
        writeClipboard: () => undefined,
        forceCanvasFallback: () => false,
        setForceCanvasFallback: () => undefined,
        reload: () => undefined,
      },
      workerFactory: () => new FakeWorker() as unknown as Worker,
    });
    await runtime.connect();
    const remote = await runtime.openRemoteSession("device", "remote", 80, 24, "studio-mac");

    await expect(runtime.getRemoteSessionState(remote.id)).resolves.toBeUndefined();
    await expect(runtime.reconnectRemoteSession(remote.id)).resolves.toBeUndefined();
    await runtime.retryRemoteView(remote.id, "view-1");
    control.dispatchEvent(new MessageEvent("message", { data: { requestId: 0, type: "events-lost", skipped: 1 } }));
    await flushMicrotasks();

    expect(control.remoteStateRequests).toEqual([]);
    expect(runtime.remoteLifecycleSupported).toBe(false);

    // Everything 1.11 did define keeps working: the pairing degrades to
    // Phase-0 behavior rather than losing the control channel.
    control.dispatchEvent(
      new MessageEvent("message", {
        data: { requestId: 0, type: "config-changed", config: { ...configSnapshot, revision: "config-v11" } },
      }),
    );
    await flushMicrotasks();
    expect(runtime.configSnapshot?.revision).toBe("config-v11");
    runtime.dispose();
  });

  it("keeps a frozen replica copyable after its attachment epoch is cleared", async () => {
    vi.stubGlobal("window", globalThis);
    const control = new FakePort();
    const runtime = new GhostteaTerminalRuntime({
      ports: { control: control as unknown as MessagePort, frames: new FakePort() as unknown as MessagePort },
      platform: {
        writeClipboard: () => undefined,
        forceCanvasFallback: () => false,
        setForceCanvasFallback: () => undefined,
        reload: () => undefined,
      },
      workerFactory: () => new FakeWorker() as unknown as Worker,
    });
    await runtime.connect();
    const remote = await runtime.openRemoteSession("device", "remote", 80, 24, "studio-mac");
    runtime.mount(remote.id, remote.handle, "view-1", canvas());
    await flushMicrotasks();
    control.emitViewState({ viewStateSeq: 8, viewState: "failed", attachmentEpoch: null, readWrite: null });

    await expect(
      runtime.copySelection(remote.id, "view-1", { anchor: { column: 0, row: 0 }, focus: { column: 4, row: 0 } }),
    ).resolves.toBe("copied from terminal");
    expect(control.messages.at(-1)).toMatchObject({ type: "selection-text", attachmentEpoch: 2 });
    runtime.dispose();
  });

  it("disposes mounted views, ports, timers, and the render worker exactly once", async () => {
    vi.stubGlobal("window", globalThis);
    const worker = new FakeWorker();
    const control = new FakePort();
    const frames = new FakePort();
    const runtime = new GhostteaTerminalRuntime({
      ports: { control: control as unknown as MessagePort, frames: frames as unknown as MessagePort },
      platform: {
        writeClipboard: () => undefined,
        forceCanvasFallback: () => false,
        setForceCanvasFallback: () => undefined,
        reload: () => undefined,
      },
      workerFactory: () => worker as unknown as Worker,
    });
    await runtime.connect();
    runtime.registerSession(session);
    runtime.mount(session.id, session.handle, "view-1", canvas());
    await flushMicrotasks();

    runtime.dispose();
    runtime.dispose();
    await flushMicrotasks();

    expect(control.messages.filter((message) => message.type === "detach-session")).toHaveLength(1);
    expect(control.closed).toBe(true);
    expect(frames.closed).toBe(true);
    expect(worker.terminated).toBe(true);
    await expect(runtime.connect()).rejects.toThrow("disposed");
  });

  it("mounts and unmounts mirrored session views as independent worker surfaces", async () => {
    vi.stubGlobal("window", globalThis);
    const worker = new FakeWorker();
    const control = new FakePort();
    const frames = new FakePort();
    const runtime = new GhostteaTerminalRuntime({
      ports: { control: control as unknown as MessagePort, frames: frames as unknown as MessagePort },
      platform: {
        writeClipboard: () => undefined,
        forceCanvasFallback: () => false,
        setForceCanvasFallback: () => undefined,
        reload: () => undefined,
      },
      workerFactory: () => worker as unknown as Worker,
    });
    await runtime.connect();

    const first = runtime.mount("session", "handle", "view-1", canvas());
    first.dispose();
    const second = runtime.mount("session", "handle", "view-2", canvas());
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(control.messages).toContainEqual({
      requestId: 0,
      type: "detach-session",
      sessionId: "session",
      viewId: "view-1",
    });
    expect(worker.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "mount", surfaceId: "view-1", sessionHandle: "handle" }),
        expect.objectContaining({ type: "mount", surfaceId: "view-2", sessionHandle: "handle" }),
        { type: "unmount", surfaceId: "view-1" },
      ]),
    );
    expect(worker.messages).not.toContainEqual({ type: "unmount", surfaceId: "view-2" });

    second.dispose();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(control.messages).toContainEqual({
      requestId: 0,
      type: "detach-session",
      sessionId: "session",
      viewId: "view-2",
    });
    expect(worker.messages).toContainEqual({ type: "unmount", surfaceId: "view-2" });
  });

  it("keeps resizing an unfocused view while it remains controller of its own PTY", async () => {
    vi.stubGlobal("window", globalThis);
    const worker = new FakeWorker();
    const control = new FakePort();
    const frames = new FakePort();
    const runtime = new GhostteaTerminalRuntime({
      ports: { control: control as unknown as MessagePort, frames: frames as unknown as MessagePort },
      platform: {
        writeClipboard: () => undefined,
        forceCanvasFallback: () => false,
        setForceCanvasFallback: () => undefined,
        reload: () => undefined,
      },
      workerFactory: () => worker as unknown as Worker,
    });
    await runtime.connect();
    runtime.registerSession(session);
    runtime.mount(session.id, session.handle, "view-1", canvas());
    await flushMicrotasks();

    runtime.claimResizeControl(session.handle, "view-1", 80, 24);
    controlChanged(control, "view-1", 80, 24);
    runtime.resize(session.id, "view-1", 100, 30);

    expect(control.messages).toContainEqual({
      requestId: 0,
      type: "resize",
      sessionId: session.id,
      viewId: "view-1",
      attachmentEpoch: 2,
      controlEpoch: 7,
      resizeSequence: 1,
      cols: 100,
      rows: 30,
    });

    const resizeCount = control.messages.filter((message) => message.type === "resize").length;
    controlChanged(control, "view-2", 120, 40);
    runtime.resize(session.id, "view-1", 101, 30);
    expect(control.messages.filter((message) => message.type === "resize")).toHaveLength(resizeCount);
  });

  it("replays the latest measured geometry after an initial control claim", async () => {
    vi.stubGlobal("window", globalThis);
    const worker = new FakeWorker();
    const control = new FakePort();
    const frames = new FakePort();
    const runtime = new GhostteaTerminalRuntime({
      ports: { control: control as unknown as MessagePort, frames: frames as unknown as MessagePort },
      platform: {
        writeClipboard: () => undefined,
        forceCanvasFallback: () => false,
        setForceCanvasFallback: () => undefined,
        reload: () => undefined,
      },
      workerFactory: () => worker as unknown as Worker,
    });
    await runtime.connect();
    runtime.registerSession(session);
    runtime.mount(session.id, session.handle, "view-1", canvas());
    await flushMicrotasks();

    runtime.claimResizeControl(session.handle, "view-1", 80, 24);
    runtime.resize(session.id, "view-1", 110, 31);
    controlChanged(control, "view-1", 80, 24);

    expect(control.messages).toContainEqual({
      requestId: 0,
      type: "resize",
      sessionId: session.id,
      viewId: "view-1",
      attachmentEpoch: 2,
      controlEpoch: 7,
      resizeSequence: 1,
      cols: 110,
      rows: 31,
    });
  });
});
