import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_ROUTED_PROTOCOL_LIMITS,
  encodeRoutedMessage,
  unknownSessionActivity,
  type RoutedCellTransportGrant,
  type RoutedSessionAttachGrant,
  type RoutedTerminalOpenTicket,
  type SessionSummary,
} from "@vibecook/ghosttea-protocol";
import { GhostteaTerminalRuntime, type GhostteaRoutedHost, type RoutedGeometryHolderChange } from "./runtime";
import { syncSurfaceFocus, type SurfaceFocusPolicy } from "./TerminalSurface";

class FakeWorker extends EventTarget {
  readonly messages: unknown[] = [];
  terminated = false;

  postMessage(message: unknown): void {
    this.messages.push(message);
  }

  emit(data: unknown): void {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }

  terminate(): void {
    this.terminated = true;
  }
}

class FakeSocket extends EventTarget {
  readyState = 0;
  binaryType = "blob";
  readonly sent: string[] = [];
  closeCode: number | undefined;

  send(data: string): void {
    this.sent.push(data);
  }

  open(): void {
    this.readyState = 1;
    this.dispatchEvent(new Event("open"));
  }

  receive(data: string): void {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }

  close(code = 1000, reason = ""): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.closeCode = code;
    const event = new Event("close") as Event & { code: number; reason: string };
    Object.assign(event, { code, reason });
    this.dispatchEvent(event);
  }
}

function grantPair(cellBootId: string, sessionId: string, connectionSetId: string) {
  const protectedBase = {
    v: 1 as const,
    iss: "fieldd" as const,
    alg: "HS256" as const,
    kid: { cellBootId, keyGeneration: 1 },
  };
  const transportGrant: RoutedCellTransportGrant = {
    protected: { ...protectedBase, typ: "CellTransportGrant" },
    claims: {
      audienceCellBootId: cellBootId,
      clientId: "window-1",
      connectionSetId,
      allowedChannels: ["control", "frames"],
      transportGrantGeneration: 1,
      issuedAt: 1,
      expiresAt: 999_999_999_999_999,
      nonce: `nonce-${cellBootId}`,
    },
    mac: "opaque",
  };
  const attachGrant: RoutedSessionAttachGrant = {
    protected: { ...protectedBase, typ: "SessionAttachGrant" },
    claims: {
      audienceCellBootId: cellBootId,
      clientId: "window-1",
      sessionId,
      leaseEpoch: 4,
      routeRevision: 2,
      grantGeneration: 1,
      rights: ["geometry", "input", "read"],
      issuedAt: 1,
      expiresAt: 999_999_999_999_999,
    },
    mac: "opaque",
  };
  return { transportGrant, attachGrant };
}

function ticket(cellBootId: string, sessionId: string, connectionSetId: string): RoutedTerminalOpenTicket {
  const grants = grantPair(cellBootId, sessionId, connectionSetId);
  return {
    route: { cellBootId, routeRevision: 2, leaseEpoch: 4 },
    endpoints: {
      controlUrl: `ws://127.0.0.1/${cellBootId}/control`,
      framesUrl: `ws://127.0.0.1/${cellBootId}/frames`,
    },
    ...grants,
  };
}

function session(id: string, handle: string): SessionSummary {
  return {
    id,
    handle,
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
  };
}

function canvas(): HTMLCanvasElement {
  return { transferControlToOffscreen: () => ({}) as OffscreenCanvas } as HTMLCanvasElement;
}

async function flush(): Promise<void> {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
}

type SentMessage = Record<string, unknown> & { type: string };

interface RoutedSeatHarness {
  runtime: GhostteaTerminalRuntime;
  socket: FakeSocket;
  activationId: string;
  /** Every `geometry-holder-changed` detail, in order. */
  holderEvents: RoutedGeometryHolderChange[];
  /** The geometry verbs sent since just before the control leg attached. */
  verbs(): SentMessage[];
  reply(type: "GeometryCommitted" | "GeometryRefused", body: Record<string, unknown>): void;
  /** Acknowledge every heartbeat sent so far, settling fenced releases. */
  ackHeartbeats(): void;
}

/** One routed session ("session-a", handle "11", client "window-1") with its control leg attached. */
async function routedSeat(
  options: { views?: string[]; rights?: string[]; attach?: boolean } = {},
): Promise<RoutedSeatHarness> {
  vi.stubGlobal("window", globalThis);
  const worker = new FakeWorker();
  const socket = new FakeSocket();
  const runtime = new GhostteaTerminalRuntime({
    transport: "routed",
    host: { openTicket: async () => ticket("cell-a", "session-a", "set-a") },
    platform: {
      writeClipboard: () => undefined,
      forceCanvasFallback: () => false,
      setForceCanvasFallback: () => undefined,
      reload: () => undefined,
    },
    websocketFactory: () => socket as unknown as WebSocket,
    workerFactory: () => worker as unknown as Worker,
  });
  const summary = session("session-a", "11");
  runtime.registerSession(summary);
  for (const viewId of options.views ?? ["view-a"]) runtime.mount(summary.id, summary.handle, viewId, canvas());
  await flush();
  socket.open();
  socket.receive(
    encodeRoutedMessage("ConnectionAccepted", {
      selectedProtocolVersion: { major: 1, minor: 0 },
      connectionSetId: "set-a",
      channel: "control",
      legGeneration: 1,
      heartbeatTtlMs: 15_000,
      protocolLimits: DEFAULT_ROUTED_PROTOCOL_LIMITS,
      capabilities: ["resume"],
    }),
  );
  const attach = JSON.parse(socket.sent.at(-1)!) as SentMessage & { activationId: string };
  expect(attach.type).toBe("AttachControlLeg");
  const holderEvents: RoutedGeometryHolderChange[] = [];
  runtime.addEventListener("geometry-holder-changed", (event) => {
    holderEvents.push((event as CustomEvent<RoutedGeometryHolderChange>).detail);
  });
  const start = socket.sent.length;
  const harness: RoutedSeatHarness = {
    runtime,
    socket,
    activationId: attach.activationId,
    holderEvents,
    verbs: () =>
      socket.sent
        .slice(start)
        .map((text) => JSON.parse(text) as SentMessage)
        .filter((message) => ["ClaimGeometry", "TransferGeometry", "ReleaseGeometry"].includes(message.type)),
    reply: (type, body) => socket.receive(encodeRoutedMessage(type, body as never)),
    ackHeartbeats: () => {
      for (const text of socket.sent) {
        const message = JSON.parse(text) as SentMessage & { sequence?: number };
        if (message.type === "LegHeartbeat") {
          socket.receive(encodeRoutedMessage("LegHeartbeatAck", { sequence: message.sequence! }));
        }
      }
    },
  };
  if (options.attach !== false) attachControl(harness, options.rights);
  return harness;
}

function attachControl(harness: RoutedSeatHarness, rights = ["geometry", "input", "read"]): void {
  harness.socket.receive(
    encodeRoutedMessage("ControlLegAttached", {
      sessionId: "session-a",
      activationId: harness.activationId,
      grantGenerationAccepted: 1,
      rights,
    }),
  );
}

function holder(clientId: string, viewId: string, holderGeneration: number) {
  return { clientId, viewId, holderGeneration };
}

describe("routed terminal runtime", () => {
  function inputFixture(openTicket?: GhostteaRoutedHost["openTicket"]) {
    vi.useFakeTimers();
    vi.stubGlobal("window", globalThis);
    const worker = new FakeWorker();
    const socket = new FakeSocket();
    const first = session("session-a", "11");
    let generation = 0;
    const runtime = new GhostteaTerminalRuntime({
      transport: "routed",
      host: {
        openTicket:
          openTicket ??
          (async () => {
            const result = ticket("cell-a", first.id, "set-a");
            result.attachGrant.claims.grantGeneration = ++generation;
            return result;
          }),
        encodeInput: (context) => ({ type: "TerminalInput", ...context }),
      },
      platform: {
        writeClipboard: () => undefined,
        forceCanvasFallback: () => false,
        setForceCanvasFallback: () => undefined,
        reload: () => undefined,
      },
      websocketFactory: () => socket as unknown as WebSocket,
      workerFactory: () => worker as unknown as Worker,
    });
    runtime.registerSession(first);
    const mount = (viewId: string) => runtime.mount(first.id, first.handle, viewId, canvas());
    const attaches = () => socket.sent.map((line) => JSON.parse(line)).filter((m) => m.type === "AttachControlLeg");
    const framesAttaches = () => worker.messages.filter((m) => (m as { type: string }).type === "routed-frames-attach");
    const connect = async () => {
      await flush();
      socket.open();
      socket.receive(
        encodeRoutedMessage("ConnectionAccepted", {
          selectedProtocolVersion: { major: 1, minor: 0 },
          connectionSetId: "set-a",
          channel: "control",
          legGeneration: 1,
          heartbeatTtlMs: 15_000,
          protocolLimits: DEFAULT_ROUTED_PROTOCOL_LIMITS,
          capabilities: ["resume"],
        }),
      );
    };
    const accept = (activationId: string, grantGenerationAccepted: number) => {
      socket.receive(
        encodeRoutedMessage("ControlLegAttached", {
          sessionId: first.id,
          activationId,
          grantGenerationAccepted,
          rights: ["geometry", "input", "read"],
        }),
      );
    };
    const present = (activationId: string) => {
      const stamp = { sceneEpoch: { cellBootId: "cell-a", modelGeneration: 1 }, sceneRevision: 1 };
      worker.emit({
        type: "routed-frames-event",
        event: {
          type: "frames-attached",
          attached: {
            sessionId: first.id,
            activationId,
            resumeToken: "resume",
            trfIdentity: { sessionHandle: "11", viewHandle: "12" },
            outcome: { kind: "seed-required", reason: "no-cursor" },
          },
        },
      });
      worker.emit({
        type: "routed-frames-event",
        event: { type: "frames-state", activationId, state: "active", appliedContent: stamp },
      });
      worker.emit({
        type: "routed-frames-event",
        event: {
          type: "presentation-status",
          status: {
            activationId,
            workerStatusSequence: 1,
            state: "active",
            sceneContent: stamp,
            leaseTtlMs: 10_000,
          },
        },
      });
      socket.receive(
        encodeRoutedMessage("CellActivationStatus", {
          sessionId: first.id,
          activationId,
          cellStatusSequence: 1,
          leaseTtlMs: 10_000,
          acceptedContent: stamp,
          presentation: { state: "presenting" },
          input: { state: "allowed" },
        }),
      );
    };
    const dispose = () => {
      runtime.dispose();
      vi.useRealTimers();
      vi.unstubAllGlobals();
    };
    return { runtime, worker, socket, first, mount, attaches, framesAttaches, connect, accept, present, dispose };
  }

  it("restores input after repeated last-pane detach and reattach with a fresh presentation lease", async () => {
    const h = inputFixture();
    try {
      let mounted = h.mount("view-0");
      await h.connect();
      let previous: string | undefined;
      for (let index = 0; index < 10; index++) {
        const attach = h.attaches().at(-1)!;
        expect(attach.replacesActivationId).toBe(previous);
        expect(h.framesAttaches()).toHaveLength(index);
        expect(h.runtime.routedViewInputAllowed(`view-${index}`)).toBe(false);
        h.accept(attach.activationId, index + 1);
        h.accept(attach.activationId, index + 1); // a duplicate ACK must not attach frames twice
        expect(h.framesAttaches()).toHaveLength(index + 1);
        expect(h.runtime.routedViewInputAllowed(`view-${index}`)).toBe(false);
        if (previous) {
          h.present(previous); // old leases cannot admit input on the replacement
          expect(h.runtime.routedViewInputAllowed(`view-${index}`)).toBe(false);
        }
        h.present(attach.activationId);
        expect(h.runtime.routedViewInputAllowed(`view-${index}`)).toBe(true);
        h.runtime.sendText(h.first.id, `view-${index}`, "probe");
        expect(JSON.parse(h.socket.sent.at(-1)!)).toMatchObject({
          type: "TerminalInput",
          activationId: attach.activationId,
        });
        if (index === 9) break;
        previous = attach.activationId;
        mounted.dispose();
        await vi.advanceTimersByTimeAsync(1);
        mounted = h.mount(`view-${index + 1}`);
        await flush();
      }
      const retained = h.mount("second-pane");
      await flush();
      mounted.dispose();
      await vi.advanceTimersByTimeAsync(1);
      expect(h.runtime.routedViewInputAllowed("second-pane")).toBe(true);
      expect(h.attaches()).toHaveLength(10);
      retained.dispose();
    } finally {
      h.dispose();
    }
  });

  it("recovers a replacement refusal against the admitted identity instead of the refused attempt", async () => {
    const h = inputFixture();
    try {
      const mounted = h.mount("old-view");
      await h.connect();
      const old = h.attaches().at(-1)!.activationId;
      h.accept(old, 1);
      h.present(old);
      mounted.dispose();
      await vi.advanceTimersByTimeAsync(1);
      h.mount("new-view");
      await flush();
      const refused = h.attaches().at(-1)!.activationId;
      h.socket.receive(
        encodeRoutedMessage("AttachRefused", { activationId: refused, code: "CAPACITY", retryable: true }),
      );
      await vi.advanceTimersByTimeAsync(100);
      const retry = h.attaches().at(-1)!;
      expect(retry.activationId).not.toBe(refused);
      expect(retry.replacesActivationId).toBe(old);
      expect(h.framesAttaches()).toHaveLength(1);
      h.accept(retry.activationId, 3);
      h.present(retry.activationId);
      expect(h.runtime.routedViewInputAllowed("new-view")).toBe(true);
    } finally {
      h.dispose();
    }
  });

  it("does not start frames for a pane detached before its control reply", async () => {
    const h = inputFixture();
    try {
      const mounted = h.mount("old-view");
      await h.connect();
      const old = h.attaches().at(-1)!.activationId;
      mounted.dispose();
      await vi.advanceTimersByTimeAsync(1);
      h.mount("new-view");
      await flush();
      expect(h.attaches()).toHaveLength(1);
      h.accept(old, 1);
      expect(h.framesAttaches()).toHaveLength(0);
      const next = h.attaches().at(-1)!;
      expect(next.replacesActivationId).toBe(old);
      h.accept(next.activationId, 2);
      h.present(next.activationId);
      expect(h.framesAttaches()).toHaveLength(1);
      expect(h.runtime.routedViewInputAllowed("new-view")).toBe(true);
    } finally {
      h.dispose();
    }
  });

  it.each(["resolve", "reject"] as const)(
    "ignores a retired pane's open ticket that settles late (%s)",
    async (settlement) => {
      let resolve!: (value: RoutedTerminalOpenTicket) => void;
      let reject!: (reason: Error) => void;
      const pending = new Promise<RoutedTerminalOpenTicket>((yes, no) => {
        resolve = yes;
        reject = no;
      });
      const openTicket = vi
        .fn<GhostteaRoutedHost["openTicket"]>()
        .mockReturnValueOnce(pending)
        .mockResolvedValue(ticket("cell-a", "session-a", "set-a"));
      const h = inputFixture(openTicket);
      try {
        const old = h.mount("old-view");
        await flush();
        old.dispose();
        await vi.advanceTimersByTimeAsync(1);
        h.mount("new-view");
        await h.connect();
        const current = h.attaches().at(-1)!;
        h.accept(current.activationId, 1);
        h.present(current.activationId);
        if (settlement === "resolve") resolve(ticket("cell-a", "session-a", "set-a"));
        else reject(new Error("old ticket failed"));
        await flush();
        expect(h.attaches()).toHaveLength(1);
        expect(h.framesAttaches()).toHaveLength(1);
        expect(h.runtime.routedViewInputAllowed("new-view")).toBe(true);
      } finally {
        h.dispose();
      }
    },
  );

  it("bounds lease timers and does not renew leases for stale status messages", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", globalThis);
    const worker = new FakeWorker();
    const socket = new FakeSocket();
    const runtime = new GhostteaTerminalRuntime({
      transport: "routed",
      host: { openTicket: async () => ticket("cell-a", "session-a", "set-a") },
      platform: {
        writeClipboard: () => undefined,
        forceCanvasFallback: () => false,
        setForceCanvasFallback: () => undefined,
        reload: () => undefined,
      },
      websocketFactory: () => socket as unknown as WebSocket,
      workerFactory: () => worker as unknown as Worker,
    });
    try {
      const first = session("session-a", "11");
      runtime.registerSession(first);
      runtime.mount(first.id, first.handle, "view-a", canvas());
      await flush();
      socket.open();
      socket.receive(
        encodeRoutedMessage("ConnectionAccepted", {
          selectedProtocolVersion: { major: 1, minor: 0 },
          connectionSetId: "set-a",
          channel: "control",
          legGeneration: 1,
          heartbeatTtlMs: 15_000,
          protocolLimits: DEFAULT_ROUTED_PROTOCOL_LIMITS,
          capabilities: ["resume"],
        }),
      );
      const { activationId } = JSON.parse(socket.sent.at(-1)!);
      socket.receive(
        encodeRoutedMessage("ControlLegAttached", {
          sessionId: first.id,
          activationId,
          grantGenerationAccepted: 1,
          rights: ["read"],
        }),
      );
      const stamp = { sceneEpoch: { cellBootId: "cell-a", modelGeneration: 1 }, sceneRevision: 1 };
      worker.emit({
        type: "routed-frames-event",
        event: {
          type: "frames-attached",
          attached: {
            sessionId: first.id,
            activationId,
            resumeToken: "resume-a",
            trfIdentity: { sessionHandle: "11", viewHandle: "12" },
            outcome: { kind: "seed-required", reason: "no-cursor" },
          },
        },
      });
      worker.emit({
        type: "routed-frames-event",
        event: {
          type: "frames-state",
          activationId,
          state: "active",
          appliedContent: stamp,
        },
      });
      const sendStatus = (sequence: number) => {
        socket.receive(
          encodeRoutedMessage("CellActivationStatus", {
            sessionId: first.id,
            activationId,
            cellStatusSequence: sequence,
            leaseTtlMs: 1_000,
            acceptedContent: stamp,
            presentation: { state: "presenting" },
            input: { state: "allowed" },
          }),
        );
        worker.emit({
          type: "routed-frames-event",
          event: {
            type: "presentation-status",
            status: {
              activationId,
              workerStatusSequence: sequence,
              state: "active",
              sceneContent: stamp,
              leaseTtlMs: 1_000,
            },
          },
        });
      };
      sendStatus(1);
      expect(runtime.routedActivation(first.id)?.presentationReady).toBe(true);
      const timerCount = vi.getTimerCount();
      for (let sequence = 2; sequence <= 200; sequence++) sendStatus(sequence);
      expect(vi.getTimerCount()).toBe(timerCount);
      await vi.advanceTimersByTimeAsync(900);
      sendStatus(200);
      sendStatus(199);
      await vi.advanceTimersByTimeAsync(100);
      expect(runtime.routedActivation(first.id)?.cellLeaseDeadline).toBe(0);
      expect(runtime.routedActivation(first.id)?.workerLeaseDeadline).toBe(0);
      expect(runtime.routedActivation(first.id)?.presentationReady).toBe(false);
    } finally {
      runtime.dispose();
      vi.useRealTimers();
    }
  });

  it("refreshes registered metadata 200ms after a routed frame commit", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", globalThis);
    const worker = new FakeWorker();
    const first = session("session-a", "11");
    const refreshed = {
      ...first,
      title: "build complete",
      cwd: "/workspace/project",
      activity: {
        ...first.activity,
        kind: "shell-idle" as const,
        source: "shell-integration" as const,
        confidence: "authoritative" as const,
        observedAtMs: 9,
      },
    };
    const getSession = vi.fn(async () => refreshed);
    const runtime = new GhostteaTerminalRuntime({
      transport: "routed",
      host: { openTicket: async () => ticket("cell-a", "session-a", "set-a"), getSession },
      platform: {
        writeClipboard: () => undefined,
        forceCanvasFallback: () => false,
        setForceCanvasFallback: () => undefined,
        reload: () => undefined,
      },
      workerFactory: () => worker as unknown as Worker,
    });
    const metadata = vi.fn();
    runtime.addEventListener("session-metadata", metadata);
    runtime.registerSession(first);

    worker.emit({
      type: "frame-committed",
      sessionHandle: first.handle,
      sessionEpoch: 1n,
      frameSequence: 1n,
      fullSnapshot: false,
    });
    await vi.advanceTimersByTimeAsync(199);
    expect(getSession).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await flush();

    expect(getSession).toHaveBeenCalledOnce();
    expect(getSession).toHaveBeenCalledWith(first.id);
    expect(runtime.sessionMetadata(first.handle)).toEqual(refreshed);
    expect(metadata).toHaveBeenCalledOnce();
    expect((metadata.mock.calls[0]![0] as CustomEvent).detail).toEqual(refreshed);

    runtime.dispose();
    vi.useRealTimers();
  });

  it("takes a routed session's mouse modes from the worker, once per change", () => {
    vi.stubGlobal("window", globalThis);
    const worker = new FakeWorker();
    const first = session("session-a", "11");
    const runtime = new GhostteaTerminalRuntime({
      transport: "routed",
      host: { openTicket: async () => ticket("cell-a", "session-a", "set-a") },
      platform: {
        writeClipboard: () => undefined,
        forceCanvasFallback: () => false,
        setForceCanvasFallback: () => undefined,
        reload: () => undefined,
      },
      workerFactory: () => worker as unknown as Worker,
    });
    const modes = vi.fn();
    runtime.addEventListener("terminal-modes", modes);
    runtime.registerSession(first);
    // A routed frame never passes the main thread, so before the worker says
    // otherwise the wheel scrolls locally — codex's history went unscrolled.
    expect(runtime.isMouseTracking(first.handle)).toBe(false);

    worker.emit({ type: "terminal-modes", sessionHandle: first.handle, mouseTracking: true });
    worker.emit({ type: "terminal-modes", sessionHandle: first.handle, mouseTracking: true });
    expect(runtime.isMouseTracking(first.handle)).toBe(true);
    expect(modes).toHaveBeenCalledOnce();
    expect((modes.mock.calls[0]![0] as CustomEvent).detail).toEqual({
      sessionHandle: first.handle,
      mouseTracking: true,
    });

    worker.emit({ type: "terminal-modes", sessionHandle: first.handle, mouseTracking: false });
    expect(runtime.isMouseTracking(first.handle)).toBe(false);
    expect(modes).toHaveBeenCalledTimes(2);
    runtime.dispose();
  });

  it("coalesces routed metadata reads without overlapping them", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", globalThis);
    const worker = new FakeWorker();
    const first = session("session-a", "11");
    let resolveFirst!: (value: SessionSummary | null) => void;
    const firstRead = new Promise<SessionSummary | null>((resolve) => {
      resolveFirst = resolve;
    });
    const getSession = vi
      .fn<() => Promise<SessionSummary | null>>()
      .mockImplementationOnce(() => firstRead)
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error("inventory unavailable"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const runtime = new GhostteaTerminalRuntime({
      transport: "routed",
      host: { openTicket: async () => ticket("cell-a", "session-a", "set-a"), getSession },
      platform: {
        writeClipboard: () => undefined,
        forceCanvasFallback: () => false,
        setForceCanvasFallback: () => undefined,
        reload: () => undefined,
      },
      workerFactory: () => worker as unknown as Worker,
    });
    runtime.registerSession(first);
    const commit = (frameSequence: bigint) =>
      worker.emit({
        type: "frame-committed",
        sessionHandle: first.handle,
        sessionEpoch: 1n,
        frameSequence,
        fullSnapshot: false,
      });

    commit(1n);
    await vi.advanceTimersByTimeAsync(200);
    expect(getSession).toHaveBeenCalledOnce();
    commit(2n);
    commit(3n);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(getSession).toHaveBeenCalledOnce();

    resolveFirst({ ...first, title: "first read" });
    await flush();
    await vi.advanceTimersByTimeAsync(199);
    expect(getSession).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(getSession).toHaveBeenCalledTimes(2);
    expect(runtime.sessionMetadata(first.handle)?.title).toBe("first read");

    commit(4n);
    await vi.advanceTimersByTimeAsync(200);
    await flush();
    expect(getSession).toHaveBeenCalledTimes(3);
    expect(runtime.sessionMetadata(first.handle)?.title).toBe("first read");
    expect(warn).toHaveBeenCalledWith(
      "[terminal-runtime] session metadata refresh failed",
      expect.objectContaining({ message: "inventory unavailable" }),
    );

    runtime.dispose();
    warn.mockRestore();
    vi.useRealTimers();
  });

  it("does not let a late routed read resurrect an exited session", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", globalThis);
    const worker = new FakeWorker();
    const first = session("session-a", "11");
    let resolveRead!: (value: SessionSummary | null) => void;
    const getSession = vi.fn(
      () =>
        new Promise<SessionSummary | null>((resolve) => {
          resolveRead = resolve;
        }),
    );
    const runtime = new GhostteaTerminalRuntime({
      transport: "routed",
      host: { openTicket: async () => ticket("cell-a", "session-a", "set-a"), getSession },
      platform: {
        writeClipboard: () => undefined,
        forceCanvasFallback: () => false,
        setForceCanvasFallback: () => undefined,
        reload: () => undefined,
      },
      workerFactory: () => worker as unknown as Worker,
    });
    runtime.registerSession(first);
    worker.emit({
      type: "frame-committed",
      sessionHandle: first.handle,
      sessionEpoch: 1n,
      frameSequence: 1n,
      fullSnapshot: false,
    });
    await vi.advanceTimersByTimeAsync(200);
    expect(getSession).toHaveBeenCalledOnce();

    runtime.applySessionEvent({
      type: "exited",
      sessionId: first.id,
      exitCode: null,
      exitSignal: "SIGTERM",
      requestedTermination: "application",
      exitOutcome: "application-terminated",
    });
    resolveRead({ ...first, title: "stale live session" });
    await flush();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(runtime.sessionMetadata(first.handle)).toMatchObject({
      exited: true,
      title: null,
      exitCode: null,
      exitSignal: "SIGTERM",
      requestedTermination: "application",
      exitOutcome: "application-terminated",
    });
    expect(getSession).toHaveBeenCalledOnce();

    runtime.dispose();
    vi.useRealTimers();
  });

  it("discards routed reads made stale by events, registrations, and removal", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", globalThis);
    const worker = new FakeWorker();
    const first = session("session-a", "11");
    const resolvers: Array<(value: SessionSummary | null) => void> = [];
    const getSession = vi.fn(
      () =>
        new Promise<SessionSummary | null>((resolve) => {
          resolvers.push(resolve);
        }),
    );
    const runtime = new GhostteaTerminalRuntime({
      transport: "routed",
      host: { openTicket: async () => ticket("cell-a", "session-a", "set-a"), getSession },
      platform: {
        writeClipboard: () => undefined,
        forceCanvasFallback: () => false,
        setForceCanvasFallback: () => undefined,
        reload: () => undefined,
      },
      workerFactory: () => worker as unknown as Worker,
    });
    runtime.registerSession(first);
    const startRead = async (frameSequence: bigint) => {
      worker.emit({
        type: "frame-committed",
        sessionHandle: first.handle,
        sessionEpoch: 1n,
        frameSequence,
        fullSnapshot: false,
      });
      await vi.advanceTimersByTimeAsync(200);
    };

    await startRead(1n);
    runtime.applySessionEvent({ type: "updated", session: { ...first, title: "newer event" } });
    resolvers[0]!({ ...first, title: "stale read one" });
    await flush();
    expect(runtime.sessionMetadata(first.handle)?.title).toBe("newer event");

    await startRead(2n);
    runtime.registerSession({ ...first, title: "newer registration" });
    resolvers[1]!({ ...first, title: "stale read two" });
    await flush();
    expect(runtime.sessionMetadata(first.handle)?.title).toBe("newer registration");

    await startRead(3n);
    runtime.applySessionEvent({ type: "removed", sessionId: first.id });
    resolvers[2]!({ ...first, title: "removed session" });
    await flush();
    expect(runtime.sessionMetadata(first.handle)).toBeUndefined();
    expect(getSession).toHaveBeenCalledTimes(3);

    runtime.dispose();
    vi.useRealTimers();
  });

  it("applies routed session events with ports-compatible activity and exit ordering", () => {
    vi.stubGlobal("window", globalThis);
    const worker = new FakeWorker();
    const terminate = vi.fn();
    const runtime = new GhostteaTerminalRuntime({
      transport: "routed",
      host: { openTicket: async () => ticket("cell-a", "session-a", "set-a"), terminate },
      platform: {
        writeClipboard: () => undefined,
        forceCanvasFallback: () => false,
        setForceCanvasFallback: () => undefined,
        reload: () => undefined,
      },
      workerFactory: () => worker as unknown as Worker,
    });
    const first = session("session-a", "11");
    runtime.registerSession(first);
    const order: string[] = [];
    const activities: unknown[] = [];
    const exits: unknown[] = [];
    runtime.addEventListener("session-activity", (event) => {
      order.push("activity");
      activities.push((event as CustomEvent).detail);
    });
    runtime.addEventListener("session-metadata", () => order.push("metadata"));
    runtime.addEventListener("session-exited", (event) => {
      order.push("exited");
      exits.push((event as CustomEvent).detail);
    });

    runtime.applySessionEvent({ type: "updated", session: { ...first, title: "host title" } });
    const activity = {
      kind: "foreground-job" as const,
      source: "process-group" as const,
      confidence: "authoritative" as const,
      rootProcessGroupId: 10,
      foregroundProcessGroupId: 20,
      observedAtMs: 30,
    };
    runtime.applySessionEvent({ type: "activity-changed", sessionId: first.id, activity });
    runtime.applySessionEvent({
      type: "exited",
      sessionId: first.id,
      exitCode: 7,
      exitSignal: null,
      requestedTermination: null,
      exitOutcome: "crashed",
    });

    expect(order).toEqual(["metadata", "activity", "metadata", "metadata", "exited"]);
    expect(activities).toEqual([{ requestId: 0, type: "session-activity-changed", sessionId: first.id, activity }]);
    expect(exits).toEqual([
      {
        requestId: 0,
        type: "session-exited",
        sessionId: first.id,
        exitCode: 7,
        exitSignal: null,
        requestedTermination: null,
        exitOutcome: "crashed",
      },
    ]);
    expect(runtime.sessionMetadata(first.handle)).toMatchObject({
      title: "host title",
      activity,
      exited: true,
      exitCode: 7,
      exitOutcome: "crashed",
    });

    runtime.applySessionEvent({ type: "updated", session: { ...first, title: "resurrected" } });
    runtime.applySessionEvent({
      type: "exited",
      sessionId: first.id,
      exitCode: 0,
      exitSignal: null,
      requestedTermination: null,
      exitOutcome: "completed",
    });
    expect(order).toHaveLength(5);
    runtime.applySessionEvent({ type: "removed", sessionId: first.id });
    expect(runtime.sessionMetadata(first.handle)).toBeUndefined();
    expect(terminate).not.toHaveBeenCalled();

    runtime.dispose();
  });

  it("emits the first explicit exit even when a full summary observed the exit first", () => {
    vi.stubGlobal("window", globalThis);
    const worker = new FakeWorker();
    const runtime = new GhostteaTerminalRuntime({
      transport: "routed",
      host: { openTicket: async () => ticket("cell-a", "session-a", "set-a") },
      platform: {
        writeClipboard: () => undefined,
        forceCanvasFallback: () => false,
        setForceCanvasFallback: () => undefined,
        reload: () => undefined,
      },
      workerFactory: () => worker as unknown as Worker,
    });
    const first = session("session-a", "11");
    runtime.registerSession(first);
    const order: string[] = [];
    runtime.addEventListener("session-metadata", () => order.push("metadata"));
    runtime.addEventListener("session-exited", () => order.push("exited"));
    const exit = {
      exitCode: 0,
      exitSignal: null,
      requestedTermination: null,
      exitOutcome: "completed" as const,
    };

    runtime.applySessionEvent({ type: "updated", session: { ...first, exited: true, ...exit } });
    expect(order).toEqual(["metadata"]);
    runtime.applySessionEvent({ type: "exited", sessionId: first.id, ...exit });
    expect(order).toEqual(["metadata", "metadata", "exited"]);
    runtime.applySessionEvent({ type: "exited", sessionId: first.id, ...exit });
    expect(order).toEqual(["metadata", "metadata", "exited"]);

    runtime.dispose();
  });

  it("forwards authenticated host extension messages with their routed identity", async () => {
    vi.stubGlobal("window", globalThis);
    const worker = new FakeWorker();
    const sockets: FakeSocket[] = [];
    const onExtensionMessage = vi.fn();
    const runtime = new GhostteaTerminalRuntime({
      transport: "routed",
      host: {
        openTicket: async () => ticket("cell-a", "session-a", "set-a"),
        onExtensionMessage,
      },
      platform: {
        writeClipboard: () => undefined,
        forceCanvasFallback: () => false,
        setForceCanvasFallback: () => undefined,
        reload: () => undefined,
      },
      websocketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket as unknown as WebSocket;
      },
      workerFactory: () => worker as unknown as Worker,
    });
    const first = session("session-a", "11");
    runtime.registerSession(first);
    runtime.mount(first.id, first.handle, "view-a", canvas());
    await flush();
    sockets[0]!.open();
    sockets[0]!.receive(
      encodeRoutedMessage("ConnectionAccepted", {
        selectedProtocolVersion: { major: 1, minor: 0 },
        connectionSetId: "set-a",
        channel: "control",
        legGeneration: 1,
        heartbeatTtlMs: 15_000,
        protocolLimits: DEFAULT_ROUTED_PROTOCOL_LIMITS,
        capabilities: ["resume"],
      }),
    );
    const message = { type: "HostSessionNotice", sessionId: first.id, revision: 4 };
    sockets[0]!.receive(JSON.stringify(message));

    expect(onExtensionMessage).toHaveBeenCalledOnce();
    expect(onExtensionMessage).toHaveBeenCalledWith(message, {
      cellBootId: "cell-a",
      connectionSetId: "set-a",
      channel: "control",
    });
    expect(sockets[0]!.readyState).toBe(1);

    runtime.dispose();
  });

  it("keeps routed input closed when T1 has no negotiated input encoder", async () => {
    vi.stubGlobal("window", globalThis);
    const worker = new FakeWorker();
    const sockets: FakeSocket[] = [];
    const runtime = new GhostteaTerminalRuntime({
      transport: "routed",
      host: { openTicket: async () => ticket("cell-a", "session-a", "set-a") },
      platform: {
        writeClipboard: () => undefined,
        forceCanvasFallback: () => false,
        setForceCanvasFallback: () => undefined,
        reload: () => undefined,
      },
      websocketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket as unknown as WebSocket;
      },
      workerFactory: () => worker as unknown as Worker,
    });
    const first = session("session-a", "11");
    runtime.registerSession(first);
    runtime.mount(first.id, first.handle, "view-a", canvas());
    await flush();

    expect(runtime.routedActivation(first.id)?.inputPolicy).toBe("read-only");
    expect(runtime.routedViewInputAllowed("view-a")).toBe(false);
    const suppressed = vi.fn();
    runtime.addEventListener("routed-input-suppressed", suppressed);
    const workerMessagesBeforeInput = worker.messages.length;
    runtime.sendText(first.id, "view-a", "blocked");
    expect(worker.messages).toHaveLength(workerMessagesBeforeInput);
    expect(suppressed).toHaveBeenCalledOnce();
    expect((suppressed.mock.calls[0]![0] as CustomEvent).detail.reason).toBe("wire-verb-unavailable");

    runtime.dispose();
  });

  it("re-mints after a terminal grant refusal instead of retrying the refused grant", async () => {
    vi.stubGlobal("window", globalThis);
    const worker = new FakeWorker();
    const sockets: FakeSocket[] = [];
    let generation = 0;
    const openTicket = vi.fn(async () => {
      const next = ticket("cell-a", "session-a", "set-a");
      generation += 1;
      next.transportGrant.claims.transportGrantGeneration = generation;
      next.transportGrant.claims.nonce = `nonce-${generation}`;
      return next;
    });
    const runtime = new GhostteaTerminalRuntime({
      transport: "routed",
      host: { openTicket },
      platform: {
        writeClipboard: () => undefined,
        forceCanvasFallback: () => false,
        setForceCanvasFallback: () => undefined,
        reload: () => undefined,
      },
      websocketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket as unknown as WebSocket;
      },
      workerFactory: () => worker as unknown as Worker,
    });
    const first = session("session-a", "11");
    runtime.registerSession(first);
    runtime.mount(first.id, first.handle, "view-a", canvas());
    await flush();
    sockets[0]!.open();
    sockets[0]!.receive(
      encodeRoutedMessage("ConnectionRefused", {
        code: "GRANT_NONCE_REPLAYED",
        retryable: false,
      }),
    );

    expect(runtime.routedActivation(first.id)?.phase).toBe("recovering");
    await new Promise((resolve) => setTimeout(resolve, 120));
    await flush();
    expect(openTicket).toHaveBeenCalledTimes(2);
    expect(sockets).toHaveLength(2);
    expect(generation).toBe(2);

    runtime.dispose();
  });

  it("re-dials one protocol failure, then makes a persistent failure unavailable", async () => {
    vi.stubGlobal("window", globalThis);
    const worker = new FakeWorker();
    const openTicket = vi.fn(async () => ticket("cell-a", "session-a", "set-a"));
    const runtime = new GhostteaTerminalRuntime({
      transport: "routed",
      host: { openTicket },
      platform: {
        writeClipboard: () => undefined,
        forceCanvasFallback: () => false,
        setForceCanvasFallback: () => undefined,
        reload: () => undefined,
      },
      websocketFactory: () => new FakeSocket() as unknown as WebSocket,
      workerFactory: () => worker as unknown as Worker,
    });
    const protocolError = vi.fn();
    runtime.addEventListener("routed-protocol-error", protocolError);
    const first = session("session-a", "11");
    runtime.registerSession(first);
    runtime.mount(first.id, first.handle, "view-a", canvas());
    await flush();
    const firstActivationId = runtime.routedActivation(first.id)!.activationId;

    worker.emit({
      type: "routed-frames-event",
      event: {
        type: "transport-closed",
        cellBootId: "cell-a",
        code: 4003,
        reason: "first malformed unit",
        activationIds: [firstActivationId],
        preAuth: false,
      },
    });
    expect(runtime.routedActivation(first.id)?.phase).toBe("recovering");
    await new Promise((resolve) => setTimeout(resolve, 120));
    await flush();
    const secondActivationId = runtime.routedActivation(first.id)!.activationId;
    expect(secondActivationId).not.toBe(firstActivationId);
    expect(openTicket).toHaveBeenCalledTimes(2);

    worker.emit({
      type: "routed-frames-event",
      event: {
        type: "transport-closed",
        cellBootId: "cell-a",
        code: 4003,
        reason: "second malformed unit",
        activationIds: [secondActivationId],
        preAuth: false,
      },
    });
    expect(runtime.routedActivation(first.id)).toMatchObject({
      phase: "unavailable",
      unavailableReason: "protocol",
    });
    expect(protocolError).toHaveBeenCalledOnce();
    expect((protocolError.mock.calls[0]![0] as CustomEvent).detail).toEqual({
      sessionId: first.id,
      channel: "frames",
      reason: "second malformed unit",
    });
    expect(worker.messages.at(-1)).toEqual({
      type: "routed-frames-detach",
      activationId: secondActivationId,
    });

    runtime.dispose();
  });

  it("owns two cell connection sets and sends allowed input directly on control", async () => {
    vi.stubGlobal("window", globalThis);
    const worker = new FakeWorker();
    const sockets: FakeSocket[] = [];
    const tickets = new Map([
      ["session-a", ticket("cell-a", "session-a", "set-a")],
      ["session-b", ticket("cell-b", "session-b", "set-b")],
    ]);
    const ticketGenerations = new Map<string, number>();
    const openTicket = vi.fn(async (sessionId: string) => {
      const base = tickets.get(sessionId)!;
      const generation = (ticketGenerations.get(sessionId) ?? 0) + 1;
      ticketGenerations.set(sessionId, generation);
      return {
        ...base,
        transportGrant: {
          ...base.transportGrant,
          claims: {
            ...base.transportGrant.claims,
            transportGrantGeneration: generation,
            nonce: `nonce-${sessionId}-${generation}`,
          },
        },
      };
    });
    const host: GhostteaRoutedHost = {
      openTicket,
      encodeInput: (context) => ({
        type: "TerminalInput",
        activationId: context.activationId,
        leaseEpoch: context.leaseEpoch,
        inputSequence: context.inputSequence,
        operation: context.operation,
      }),
    };
    const runtime = new GhostteaTerminalRuntime({
      transport: "routed",
      host,
      platform: {
        writeClipboard: () => undefined,
        forceCanvasFallback: () => false,
        setForceCanvasFallback: () => undefined,
        reload: () => undefined,
      },
      websocketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket as unknown as WebSocket;
      },
      workerFactory: () => worker as unknown as Worker,
    });
    const first = session("session-a", "11");
    const second = session("session-b", "21");
    runtime.registerSession(first);
    runtime.registerSession(second);
    runtime.mount(first.id, first.handle, "view-a", canvas());
    runtime.mount(second.id, second.handle, "view-b", canvas());
    runtime.claimResizeControl(first.handle, "view-a", 80, 24);
    await flush();

    expect(sockets).toHaveLength(2);
    expect(
      worker.messages
        .filter(
          (message): message is { type: "routed-frames-attach"; request: { cellBootId: string } } =>
            typeof message === "object" &&
            message !== null &&
            (message as { type?: string }).type === "routed-frames-attach",
        )
        .map((message) => message.request.cellBootId),
    ).toEqual([]); // the native control attachment must exist before frames starts
    for (const socket of sockets) socket.open();
    const helloA = JSON.parse(sockets[0]!.sent[0]!) as Record<string, unknown>;
    const helloB = JSON.parse(sockets[1]!.sent[0]!) as Record<string, unknown>;
    expect([helloA.type, helloB.type]).toEqual(["ConnectionHello", "ConnectionHello"]);
    expect(new Set([helloA.channel, helloB.channel])).toEqual(new Set(["control"]));

    for (let index = 0; index < sockets.length; index += 1) {
      const setId = index === 0 ? "set-a" : "set-b";
      sockets[index]!.receive(
        encodeRoutedMessage("ConnectionAccepted", {
          selectedProtocolVersion: { major: 1, minor: 0 },
          connectionSetId: setId,
          channel: "control",
          legGeneration: 1,
          heartbeatTtlMs: 15_000,
          protocolLimits: DEFAULT_ROUTED_PROTOCOL_LIMITS,
          capabilities: ["resume"],
        }),
      );
    }
    const attachA = JSON.parse(sockets[0]!.sent.at(-1)!) as { activationId: string; type: string };
    expect(attachA.type).toBe("AttachControlLeg");
    sockets[0]!.receive(
      encodeRoutedMessage("ControlLegAttached", {
        sessionId: first.id,
        activationId: attachA.activationId,
        grantGenerationAccepted: 1,
        rights: ["geometry", "input", "read"],
      }),
    );
    expect(
      worker.messages.filter((message) => (message as { type: string }).type === "routed-frames-attach"),
    ).toHaveLength(1);
    expect(JSON.parse(sockets[0]!.sent.at(-1)!)).toMatchObject({
      type: "ClaimGeometry",
      activationId: attachA.activationId,
      claimant: { viewId: "view-a" },
      cols: 80,
      rows: 24,
    });
    worker.emit({
      type: "routed-frames-event",
      event: {
        type: "frames-attached",
        attached: {
          sessionId: first.id,
          activationId: attachA.activationId,
          resumeToken: "resume-a",
          trfIdentity: { sessionHandle: "11", viewHandle: "12" },
          outcome: { kind: "seed-required", reason: "no-cursor" },
        },
      },
    });
    const stamp = { sceneEpoch: { cellBootId: "cell-a", modelGeneration: 1 }, sceneRevision: 1 };
    worker.emit({
      type: "routed-frames-event",
      event: {
        type: "frames-state",
        activationId: attachA.activationId,
        state: "active",
        appliedContent: stamp,
      },
    });
    worker.emit({
      type: "routed-frames-event",
      event: {
        type: "presentation-status",
        status: {
          activationId: attachA.activationId,
          workerStatusSequence: 1,
          state: "active",
          sceneContent: stamp,
          leaseTtlMs: 10_000,
        },
      },
    });
    sockets[0]!.receive(
      encodeRoutedMessage("CellActivationStatus", {
        sessionId: first.id,
        activationId: attachA.activationId,
        cellStatusSequence: 1,
        leaseTtlMs: 10_000,
        acceptedContent: stamp,
        presentation: { state: "presenting" },
        input: { state: "allowed" },
      }),
    );
    expect(runtime.routedActivation(first.id)?.presentationReady).toBe(true);
    expect(runtime.routedViewInputAllowed("view-a")).toBe(true);

    const workerMessagesBeforeInput = worker.messages.length;
    const socketMessagesBeforeInput = sockets[0]!.sent.length;
    runtime.sendKey(first.id, "view-a", {
      type: "down",
      key: "a",
      code: "KeyA",
      location: 0,
      repeat: false,
      shift: false,
      control: false,
      alt: false,
      meta: false,
      timestamp: 1,
    });
    expect(worker.messages).toHaveLength(workerMessagesBeforeInput);
    expect(sockets[0]!.sent).toHaveLength(socketMessagesBeforeInput + 1);
    expect(JSON.parse(sockets[0]!.sent.at(-1)!)).toMatchObject({
      type: "TerminalInput",
      activationId: attachA.activationId,
      operation: { kind: "key" },
    });

    sockets[0]!.receive(
      encodeRoutedMessage("CellActivationStatus", {
        sessionId: first.id,
        activationId: attachA.activationId,
        cellStatusSequence: 2,
        leaseTtlMs: 10_000,
        acceptedContent: stamp,
        presentation: { state: "presenting" },
        input: { state: "suspended", reason: "lagging" },
      }),
    );
    expect(runtime.routedActivation(first.id)?.presentationReady).toBe(true);
    expect(runtime.routedViewInputAllowed("view-a")).toBe(false);
    const afterSuspension = sockets[0]!.sent.length;
    runtime.sendText(first.id, "view-a", "blocked");
    expect(sockets[0]!.sent).toHaveLength(afterSuspension);

    worker.emit({
      type: "routed-frames-event",
      event: {
        type: "transport-closed",
        cellBootId: "cell-a",
        code: 4004,
        reason: "heartbeat timeout",
        activationIds: [attachA.activationId],
        preAuth: false,
      },
    });
    await flush();
    expect(openTicket).toHaveBeenCalledTimes(3);
    expect(worker.messages.at(-1)).toMatchObject({
      type: "routed-frames-attach",
      request: {
        activationId: attachA.activationId,
        transportGrant: { claims: { transportGrantGeneration: 2 } },
        resume: { resumeToken: "resume-a", from: stamp },
      },
    });
    runtime.dispose();
  });
});

describe("routed geometry seat", () => {
  it("tracks the holder the cell names, another client's included", async () => {
    const seat = await routedSeat();
    try {
      seat.runtime.claimResizeControl("11", "view-a", 80, 24);
      expect(seat.verbs()).toMatchObject([
        { type: "ClaimGeometry", claimant: { clientId: "window-1", viewId: "view-a" }, expectRevision: 0 },
      ]);
      expect(seat.runtime.geometryHolder("11")).toBeUndefined();

      seat.reply("GeometryCommitted", {
        holder: holder("window-1", "view-a", 1),
        geometryRevision: 1,
        cols: 80,
        rows: 24,
      });
      expect(seat.runtime.geometryHolder("11")).toEqual({
        holder: holder("window-1", "view-a", 1),
        revision: 1,
        local: true,
      });

      // A pane on another desktop took the seat. The cell does not announce
      // it here; this client's next verb draws the refusal that names it.
      seat.runtime.resize("session-a", "view-a", 100, 30);
      expect(seat.verbs().at(-1)).toMatchObject({ type: "ClaimGeometry", expectRevision: 1, cols: 100, rows: 30 });
      seat.reply("GeometryRefused", {
        code: "STALE_REVISION",
        currentHolder: holder("window-2", "remote-view", 2),
        geometryRevision: 2,
      });
      expect(seat.runtime.geometryHolder("11")).toEqual({
        holder: holder("window-2", "remote-view", 2),
        revision: 2,
        local: false,
      });

      // The same holder resizing moves only the revision: no event.
      seat.runtime.resize("session-a", "view-a", 90, 30);
      seat.reply("GeometryRefused", {
        code: "SEAT_HELD",
        currentHolder: holder("window-2", "remote-view", 2),
        geometryRevision: 3,
      });
      expect(seat.runtime.geometryHolder("11")?.revision).toBe(3);
      expect(seat.holderEvents).toEqual([
        {
          sessionId: "session-a",
          sessionHandle: "11",
          previous: undefined,
          current: { holder: holder("window-1", "view-a", 1), revision: 1, local: true },
        },
        {
          sessionId: "session-a",
          sessionHandle: "11",
          previous: { holder: holder("window-1", "view-a", 1), revision: 1, local: true },
          current: { holder: holder("window-2", "remote-view", 2), revision: 2, local: false },
        },
      ]);
    } finally {
      seat.runtime.dispose();
    }
  });

  it("clears the seat on its own release, and a refused release restores the holder the cell names", async () => {
    const seat = await routedSeat();
    try {
      seat.runtime.claimResizeControl("11", "view-a", 80, 24);
      seat.reply("GeometryCommitted", {
        holder: holder("window-1", "view-a", 1),
        geometryRevision: 1,
        cols: 80,
        rows: 24,
      });
      seat.runtime.releaseResizeControl("view-a");
      expect(seat.verbs().at(-1)).toMatchObject({
        type: "ReleaseGeometry",
        holder: holder("window-1", "view-a", 1),
      });
      expect(seat.runtime.geometryHolder("11")).toEqual({ holder: null, revision: 2, local: false });
      seat.ackHeartbeats();
      expect(seat.holderEvents.at(-1)?.current).toEqual({ holder: null, revision: 2, local: false });

      // Claim again; another client then takes the seat unseen, so the next
      // release names a stale holder and the cell refuses it.
      seat.runtime.claimResizeControl("11", "view-a", 80, 24);
      expect(seat.verbs().at(-1)).toMatchObject({ type: "ClaimGeometry", expectRevision: 2 });
      seat.reply("GeometryCommitted", {
        holder: holder("window-1", "view-a", 2),
        geometryRevision: 3,
        cols: 80,
        rows: 24,
      });
      seat.runtime.releaseResizeControl("view-a");
      expect(seat.runtime.geometryHolder("11")?.holder).toBeNull();
      seat.reply("GeometryRefused", {
        code: "NOT_HOLDER",
        currentHolder: holder("window-2", "remote-view", 5),
        geometryRevision: 4,
      });
      expect(seat.runtime.geometryHolder("11")).toEqual({
        holder: holder("window-2", "remote-view", 5),
        revision: 4,
        local: false,
      });
    } finally {
      seat.runtime.dispose();
    }
  });

  it("lands the holder's last grid when its resize claims overlap on a slow leg", async () => {
    const seat = await routedSeat();
    try {
      seat.runtime.claimResizeControl("11", "view-a", 80, 24);
      seat.reply("GeometryCommitted", {
        holder: holder("window-1", "view-a", 1),
        geometryRevision: 1,
        cols: 80,
        rows: 24,
      });
      // Two grid changes before either is answered: both claims name revision 1.
      seat.runtime.resize("session-a", "view-a", 100, 30);
      seat.runtime.resize("session-a", "view-a", 110, 32);
      expect(seat.verbs().slice(1)).toMatchObject([
        { type: "ClaimGeometry", expectRevision: 1, cols: 100, rows: 30 },
        { type: "ClaimGeometry", expectRevision: 1, cols: 110, rows: 32 },
      ]);
      seat.reply("GeometryCommitted", {
        holder: holder("window-1", "view-a", 1),
        geometryRevision: 2,
        cols: 100,
        rows: 30,
      });
      expect(seat.verbs()).toHaveLength(3);
      seat.reply("GeometryRefused", {
        code: "STALE_REVISION",
        currentHolder: holder("window-1", "view-a", 1),
        geometryRevision: 2,
      });
      // The PTY is at 100x30 but the view shows 110x32: the last grid goes
      // again, against the revision the refusal named.
      expect(seat.verbs()).toHaveLength(4);
      expect(seat.verbs()[3]).toMatchObject({ type: "ClaimGeometry", expectRevision: 2, cols: 110, rows: 32 });
      seat.reply("GeometryCommitted", {
        holder: holder("window-1", "view-a", 1),
        geometryRevision: 3,
        cols: 110,
        rows: 32,
      });
      expect(seat.verbs()).toHaveLength(4);
    } finally {
      seat.runtime.dispose();
    }
  });

  it("re-sends a grid that did not land once, not again when that is refused too", async () => {
    const seat = await routedSeat();
    try {
      seat.runtime.claimResizeControl("11", "view-a", 80, 24);
      seat.reply("GeometryCommitted", {
        holder: holder("window-1", "view-a", 1),
        geometryRevision: 1,
        cols: 80,
        rows: 24,
      });
      seat.runtime.resize("session-a", "view-a", 100, 30);
      const stale = (geometryRevision: number) => ({
        code: "STALE_REVISION",
        currentHolder: holder("window-1", "view-a", 1),
        geometryRevision,
      });
      seat.reply("GeometryRefused", stale(3));
      expect(seat.verbs()).toHaveLength(3);
      expect(seat.verbs()[2]).toMatchObject({ type: "ClaimGeometry", expectRevision: 3, cols: 100, rows: 30 });
      seat.reply("GeometryRefused", stale(4));
      expect(seat.verbs()).toHaveLength(3);
    } finally {
      seat.runtime.dispose();
    }
  });

  it("never re-sends a refused resize while another client holds the seat", async () => {
    const seat = await routedSeat();
    try {
      seat.runtime.claimResizeControl("11", "view-a", 80, 24);
      seat.reply("GeometryCommitted", {
        holder: holder("window-1", "view-a", 1),
        geometryRevision: 1,
        cols: 80,
        rows: 24,
      });
      seat.runtime.resize("session-a", "view-a", 100, 30);
      seat.reply("GeometryRefused", {
        code: "STALE_REVISION",
        currentHolder: holder("window-2", "remote-view", 2),
        geometryRevision: 2,
      });
      expect(seat.verbs()).toHaveLength(2);
    } finally {
      seat.runtime.dispose();
    }
  });

  it("stops tracking the seat when the session's last view leaves", async () => {
    const seat = await routedSeat();
    try {
      seat.runtime.claimResizeControl("11", "view-a", 80, 24);
      seat.reply("GeometryCommitted", {
        holder: holder("window-1", "view-a", 1),
        geometryRevision: 1,
        cols: 80,
        rows: 24,
      });
      seat.runtime.unregisterSession("session-a");
      expect(seat.runtime.geometryHolder("11")).toBeUndefined();
      expect(seat.holderEvents.at(-1)).toEqual({
        sessionId: "session-a",
        sessionHandle: "11",
        previous: { holder: holder("window-1", "view-a", 1), revision: 1, local: true },
        current: undefined,
      });
    } finally {
      seat.runtime.dispose();
    }
  });
});

describe("routed geometry take", () => {
  const seatHeldByWindow2 = {
    code: "SEAT_HELD",
    currentHolder: holder("window-2", "remote-view", 2),
    geometryRevision: 5,
  };

  it("claims an empty seat with one ClaimGeometry", async () => {
    const seat = await routedSeat();
    try {
      seat.runtime.takeResizeControl("11", "view-a", 80, 24);
      expect(seat.verbs()).toEqual([
        expect.objectContaining({
          type: "ClaimGeometry",
          activationId: seat.activationId,
          claimant: { clientId: "window-1", viewId: "view-a" },
          expectRevision: 0,
          cols: 80,
          rows: 24,
        }),
      ]);
    } finally {
      seat.runtime.dispose();
    }
  });

  it("takes a seat another client holds with one TransferGeometry from the holder it last saw", async () => {
    const seat = await routedSeat();
    try {
      // The holder is learned the ordinary way: a plain claim refused SEAT_HELD.
      seat.runtime.claimResizeControl("11", "view-a", 80, 24);
      seat.reply("GeometryRefused", seatHeldByWindow2);
      expect(seat.verbs()).toHaveLength(1);

      seat.runtime.takeResizeControl("11", "view-a", 100, 30);
      expect(seat.verbs().slice(1)).toEqual([
        {
          type: "TransferGeometry",
          sessionId: "session-a",
          activationId: seat.activationId,
          leaseEpoch: 4,
          from: holder("window-2", "remote-view", 2),
          to: { clientId: "window-1", viewId: "view-a" },
          expectRevision: 5,
          cols: 100,
          rows: 30,
        },
      ]);
      seat.reply("GeometryCommitted", {
        holder: holder("window-1", "view-a", 3),
        geometryRevision: 6,
        cols: 100,
        rows: 30,
      });
      expect(seat.runtime.geometryHolder("11")).toEqual({
        holder: holder("window-1", "view-a", 3),
        revision: 6,
        local: true,
      });
      expect(seat.verbs()).toHaveLength(2);
    } finally {
      seat.runtime.dispose();
    }
  });

  it("moves the seat from this client's other view with a transfer", async () => {
    const seat = await routedSeat({ views: ["view-a", "view-b"] });
    try {
      seat.runtime.claimResizeControl("11", "view-a", 80, 24);
      seat.reply("GeometryCommitted", {
        holder: holder("window-1", "view-a", 1),
        geometryRevision: 1,
        cols: 80,
        rows: 24,
      });
      seat.runtime.takeResizeControl("11", "view-b", 90, 28);
      expect(seat.verbs()).toHaveLength(2);
      expect(seat.verbs()[1]).toEqual(
        expect.objectContaining({
          type: "TransferGeometry",
          from: holder("window-1", "view-a", 1),
          to: { clientId: "window-1", viewId: "view-b" },
          expectRevision: 1,
          cols: 90,
          rows: 28,
        }),
      );
    } finally {
      seat.runtime.dispose();
    }
  });

  it("re-asserts a seat this view holds with a claim the cell commits as a resize", async () => {
    const seat = await routedSeat();
    try {
      seat.runtime.claimResizeControl("11", "view-a", 80, 24);
      seat.reply("GeometryCommitted", {
        holder: holder("window-1", "view-a", 1),
        geometryRevision: 1,
        cols: 80,
        rows: 24,
      });
      seat.runtime.takeResizeControl("11", "view-a", 80, 24);
      expect(seat.verbs()).toHaveLength(2);
      expect(seat.verbs()[1]).toEqual(
        expect.objectContaining({
          type: "ClaimGeometry",
          claimant: { clientId: "window-1", viewId: "view-a" },
          expectRevision: 1,
        }),
      );
    } finally {
      seat.runtime.dispose();
    }
  });

  it("retries once against the seat a refusal names, then lets the second refusal stand", async () => {
    const seat = await routedSeat();
    try {
      // Nothing seen yet: the take claims, and the refusal names the holder.
      seat.runtime.takeResizeControl("11", "view-a", 80, 24);
      seat.reply("GeometryRefused", seatHeldByWindow2);
      expect(seat.verbs()).toHaveLength(2);
      expect(seat.verbs()[1]).toEqual(
        expect.objectContaining({
          type: "TransferGeometry",
          from: holder("window-2", "remote-view", 2),
          expectRevision: 5,
        }),
      );

      // A third client took the seat in between: the retry is refused and stands.
      seat.reply("GeometryRefused", {
        code: "NOT_HOLDER",
        currentHolder: holder("window-3", "phone-view", 7),
        geometryRevision: 6,
      });
      expect(seat.verbs()).toHaveLength(2);
      expect(seat.runtime.geometryHolder("11")?.holder).toEqual(holder("window-3", "phone-view", 7));

      // The next take starts from the seat that refusal named.
      seat.runtime.takeResizeControl("11", "view-a", 80, 24);
      expect(seat.verbs().at(-1)).toEqual(
        expect.objectContaining({
          type: "TransferGeometry",
          from: holder("window-3", "phone-view", 7),
          expectRevision: 6,
        }),
      );
    } finally {
      seat.runtime.dispose();
    }
  });

  it("does not retry a refusal that repeats the seat the take was built on or names none", async () => {
    const seat = await routedSeat();
    try {
      seat.runtime.claimResizeControl("11", "view-a", 80, 24);
      seat.reply("GeometryRefused", seatHeldByWindow2);
      // A cell that does not allow a take to the caller refuses it with the
      // seat unchanged; asking again would only be refused again.
      seat.runtime.takeResizeControl("11", "view-a", 80, 24);
      seat.reply("GeometryRefused", {
        code: "NOT_HOLDER",
        currentHolder: holder("window-2", "remote-view", 2),
        geometryRevision: 5,
      });
      expect(seat.verbs()).toHaveLength(2);

      seat.runtime.takeResizeControl("11", "view-a", 80, 24);
      seat.reply("GeometryRefused", { code: "DESTINATION_INELIGIBLE" });
      expect(seat.verbs()).toHaveLength(3);
    } finally {
      seat.runtime.dispose();
    }
  });

  it("retries only the session's latest take", async () => {
    const seat = await routedSeat({ views: ["view-a", "view-b"] });
    try {
      seat.runtime.takeResizeControl("11", "view-a", 80, 24);
      seat.runtime.takeResizeControl("11", "view-b", 80, 24);
      expect(seat.verbs()).toHaveLength(2);

      // view-a's take is refused with news, but view-b asked later: no retry.
      seat.reply("GeometryRefused", seatHeldByWindow2);
      expect(seat.verbs()).toHaveLength(2);

      // view-b's take, refused the same way, retries.
      seat.reply("GeometryRefused", seatHeldByWindow2);
      expect(seat.verbs()).toHaveLength(3);
      expect(seat.verbs()[2]).toEqual(
        expect.objectContaining({ type: "TransferGeometry", to: { clientId: "window-1", viewId: "view-b" } }),
      );
    } finally {
      seat.runtime.dispose();
    }
  });

  it("sends a take asked before the control leg attaches when it attaches, in place of the plain claims", async () => {
    const seat = await routedSeat({ attach: false });
    try {
      seat.runtime.setFocused("11", "view-a", true, 80, 24);
      seat.runtime.claimResizeControl("11", "view-a", 80, 24);
      seat.runtime.takeResizeControl("11", "view-a", 80, 24);
      expect(seat.verbs()).toHaveLength(0);

      attachControl(seat);
      expect(seat.verbs()).toHaveLength(1);
      // It is the take, not a plain claim: a refusal naming a holder draws the transfer.
      seat.reply("GeometryRefused", seatHeldByWindow2);
      expect(seat.verbs()).toHaveLength(2);
      expect(seat.verbs()[1]).toEqual(expect.objectContaining({ type: "TransferGeometry" }));
    } finally {
      seat.runtime.dispose();
    }
  });

  it("drops a queued take when its view's focus ends, and sends nothing without the geometry right", async () => {
    const queued = await routedSeat({ attach: false });
    try {
      queued.runtime.setFocused("11", "view-a", true, 80, 24);
      queued.runtime.takeResizeControl("11", "view-a", 80, 24);
      queued.runtime.setFocused("11", "view-a", false, 80, 24);
      attachControl(queued);
      // The view still asks for resize control, so the attach sends its plain
      // claim, and a plain claim's refusal is not retried.
      expect(queued.verbs()).toHaveLength(1);
      queued.reply("GeometryRefused", seatHeldByWindow2);
      expect(queued.verbs()).toHaveLength(1);
    } finally {
      queued.runtime.dispose();
    }

    const readOnly = await routedSeat({ rights: ["input", "read"] });
    try {
      readOnly.runtime.takeResizeControl("11", "view-a", 80, 24);
      expect(readOnly.verbs()).toHaveLength(0);
    } finally {
      readOnly.runtime.dispose();
    }
  });
});

describe("a take's refusal is its announcement", () => {
  // The cell answers only the caller's control leg: a pane whose seat was
  // taken hears nothing until its own next verb is refused, and that refusal
  // names the seat. The take retries once against it, and the host never does.
  const remote = holder("window-2", "remote-view", 4);
  const phone = holder("window-3", "phone-view", 6);
  const transferToViewA = (from: ReturnType<typeof holder>, expectRevision: number) => ({
    type: "TransferGeometry",
    sessionId: "session-a",
    leaseEpoch: 4,
    from,
    to: { clientId: "window-1", viewId: "view-a" },
    expectRevision,
    cols: 80,
    rows: 24,
  });

  it("STALE_REVISION: focus back on the pane that lost the seat takes it back with one transfer", async () => {
    const seat = await routedSeat();
    try {
      // view-a held the seat; a pane on another desktop took it unannounced.
      seat.runtime.claimResizeControl("11", "view-a", 80, 24);
      seat.reply("GeometryCommitted", {
        holder: holder("window-1", "view-a", 1),
        geometryRevision: 1,
        cols: 80,
        rows: 24,
      });
      seat.runtime.takeResizeControl("11", "view-a", 80, 24);
      // It still believes it holds the seat, so its take is a resize.
      expect(seat.verbs()[1]).toMatchObject({
        type: "ClaimGeometry",
        claimant: { clientId: "window-1", viewId: "view-a" },
        expectRevision: 1,
      });
      seat.reply("GeometryRefused", { code: "STALE_REVISION", currentHolder: remote, geometryRevision: 4 });
      expect(seat.verbs()).toHaveLength(3);
      expect(seat.verbs()[2]).toEqual({ ...transferToViewA(remote, 4), activationId: seat.activationId });

      // Refused again: the runtime gives up until the host takes again.
      seat.reply("GeometryRefused", { code: "STALE_REVISION", currentHolder: phone, geometryRevision: 6 });
      expect(seat.verbs()).toHaveLength(3);
    } finally {
      seat.runtime.dispose();
    }
  });

  it("NOT_HOLDER: a transfer from a holder that moved on goes once more, from the holder the refusal names", async () => {
    const seat = await routedSeat();
    try {
      seat.runtime.claimResizeControl("11", "view-a", 80, 24);
      seat.reply("GeometryRefused", {
        code: "SEAT_HELD",
        currentHolder: holder("window-2", "remote-view", 2),
        geometryRevision: 3,
      });
      seat.runtime.takeResizeControl("11", "view-a", 80, 24);
      expect(seat.verbs()[1]).toEqual({
        ...transferToViewA(holder("window-2", "remote-view", 2), 3),
        activationId: seat.activationId,
      });
      seat.reply("GeometryRefused", { code: "NOT_HOLDER", currentHolder: phone, geometryRevision: 6 });
      expect(seat.verbs()).toHaveLength(3);
      expect(seat.verbs()[2]).toEqual({ ...transferToViewA(phone, 6), activationId: seat.activationId });

      seat.reply("GeometryRefused", { code: "NOT_HOLDER", currentHolder: remote, geometryRevision: 7 });
      expect(seat.verbs()).toHaveLength(3);
    } finally {
      seat.runtime.dispose();
    }
  });

  it("SEAT_HELD: a claim of a seat thought empty goes once more as a transfer from the holder the refusal names", async () => {
    const seat = await routedSeat();
    try {
      seat.runtime.takeResizeControl("11", "view-a", 80, 24);
      expect(seat.verbs()[0]).toMatchObject({ type: "ClaimGeometry", expectRevision: 0 });
      seat.reply("GeometryRefused", { code: "SEAT_HELD", currentHolder: remote, geometryRevision: 4 });
      expect(seat.verbs()).toHaveLength(2);
      expect(seat.verbs()[1]).toEqual({ ...transferToViewA(remote, 4), activationId: seat.activationId });

      seat.reply("GeometryRefused", { code: "SEAT_HELD", currentHolder: phone, geometryRevision: 6 });
      expect(seat.verbs()).toHaveLength(2);
    } finally {
      seat.runtime.dispose();
    }
  });

  it("draws no retry from a refusal that names no seat", async () => {
    for (const code of ["STALE_REVISION", "NOT_HOLDER", "SEAT_HELD"]) {
      const seat = await routedSeat();
      try {
        seat.runtime.takeResizeControl("11", "view-a", 80, 24);
        seat.reply("GeometryRefused", { code });
        expect(seat.verbs(), code).toHaveLength(1);
      } finally {
        seat.runtime.dispose();
      }
    }
  });

  it("claims, once, a seat a refusal names as empty", async () => {
    const seat = await routedSeat();
    try {
      seat.runtime.claimResizeControl("11", "view-a", 80, 24);
      seat.reply("GeometryRefused", { code: "SEAT_HELD", currentHolder: remote, geometryRevision: 4 });
      seat.runtime.takeResizeControl("11", "view-a", 80, 24);
      // The holder released the seat before the transfer arrived.
      seat.reply("GeometryRefused", { code: "NOT_HOLDER", geometryRevision: 5 });
      expect(seat.verbs()).toHaveLength(3);
      expect(seat.verbs()[2]).toMatchObject({
        type: "ClaimGeometry",
        claimant: { clientId: "window-1", viewId: "view-a" },
        expectRevision: 5,
      });
    } finally {
      seat.runtime.dispose();
    }
  });
});

describe("focus and the routed geometry seat (TP-R4)", () => {
  const authority = { sessionHandle: "11", viewId: "authority", cols: 80, rows: 24 };
  const mirror = { sessionHandle: "11", viewId: "mirror", cols: 120, rows: 40 };

  /** A hundred focus moves between the two surfaces, driven as TerminalSurface drives the runtime. */
  function alternateFocus(
    runtime: GhostteaTerminalRuntime,
    authorityPolicy: SurfaceFocusPolicy,
    mirrorPolicy: SurfaceFocusPolicy,
  ): void {
    let authorityFocused = false;
    let mirrorFocused = false;
    for (let index = 0; index < 100; index += 1) {
      if (index % 2 === 0) {
        syncSurfaceFocus(runtime, mirror, false, mirrorFocused, mirrorPolicy);
        mirrorFocused = false;
        syncSurfaceFocus(runtime, authority, true, authorityFocused, authorityPolicy);
        authorityFocused = true;
      } else {
        syncSurfaceFocus(runtime, authority, false, authorityFocused, authorityPolicy);
        authorityFocused = false;
        syncSurfaceFocus(runtime, mirror, true, mirrorFocused, mirrorPolicy);
        mirrorFocused = true;
      }
      // A mirror's own surface never asks to resize; the runtime refuses it anyway.
      runtime.resize("session-a", "mirror", 120 + (index % 3), 40);
    }
  }

  async function authorityAndMirror(): Promise<RoutedSeatHarness> {
    const seat = await routedSeat({ views: ["authority", "mirror"] });
    // The surfaces' claim effects: the controller claims, the mirror releases.
    seat.runtime.claimResizeControl("11", "authority", 80, 24);
    seat.runtime.releaseResizeControl("mirror");
    seat.reply("GeometryCommitted", {
      holder: holder("window-1", "authority", 1),
      geometryRevision: 1,
      cols: 80,
      rows: 24,
    });
    return seat;
  }

  it("never lets the mirror claim, take or resize, even when its host opts in", async () => {
    const seat = await authorityAndMirror();
    try {
      alternateFocus(
        seat.runtime,
        { takeGeometryOnFocus: true, controlsResize: true, interactive: true },
        // `controlsResize: false` alone keeps the mirror off the seat.
        { takeGeometryOnFocus: true, controlsResize: false, interactive: true },
      );
      const verbs = seat.verbs();
      expect(verbs.filter((message) => JSON.stringify(message).includes('"mirror"'))).toEqual([]);
      // The authority's claim, then one take per focus gain, each of its own seat.
      expect(verbs).toHaveLength(51);
      for (const message of verbs) {
        expect(message).toMatchObject({ type: "ClaimGeometry", claimant: { viewId: "authority" } });
      }
    } finally {
      seat.runtime.dispose();
    }
  });

  it("turns no focus into geometry when the host has not opted in", async () => {
    const seat = await authorityAndMirror();
    try {
      alternateFocus(
        seat.runtime,
        { takeGeometryOnFocus: false, controlsResize: true, interactive: true },
        { takeGeometryOnFocus: false, controlsResize: false, interactive: true },
      );
      expect(seat.verbs()).toHaveLength(1);
    } finally {
      seat.runtime.dispose();
    }
  });
});
