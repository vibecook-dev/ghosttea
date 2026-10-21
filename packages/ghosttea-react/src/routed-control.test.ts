import { describe, expect, it } from "vitest";
import {
  DEFAULT_ROUTED_PROTOCOL_LIMITS,
  encodeRoutedMessage,
  type RoutedCellTransportGrant,
  type RoutedSessionAttachGrant,
} from "@vibecook/ghosttea-protocol";
import { RoutedControlTransport, type RoutedControlTransportEvent } from "./routed-control";

class FakeSocket extends EventTarget {
  readyState = 0;
  readonly sent: string[] = [];

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
    const event = new Event("close") as Event & { code: number; reason: string };
    Object.assign(event, { code, reason });
    this.dispatchEvent(event);
  }
}

const cellBootId = "cell-a";
const transportGrant: RoutedCellTransportGrant = {
  protected: {
    v: 1,
    typ: "CellTransportGrant",
    iss: "fieldd",
    alg: "HS256",
    kid: { cellBootId, keyGeneration: 1 },
  },
  claims: {
    audienceCellBootId: cellBootId,
    clientId: "client-a",
    connectionSetId: "set-a",
    allowedChannels: ["control", "frames"],
    transportGrantGeneration: 1,
    issuedAt: 1,
    expiresAt: 2,
    nonce: "nonce-a",
  },
  mac: "opaque",
};
const attachGrant: RoutedSessionAttachGrant = {
  protected: {
    v: 1,
    typ: "SessionAttachGrant",
    iss: "fieldd",
    alg: "HS256",
    kid: { cellBootId, keyGeneration: 1 },
  },
  claims: {
    audienceCellBootId: cellBootId,
    clientId: "client-a",
    sessionId: "session-a",
    leaseEpoch: 1,
    routeRevision: 1,
    grantGeneration: 1,
    rights: ["input", "read"],
    issuedAt: 1,
    expiresAt: 2,
  },
  mac: "opaque",
};

function attach(transport: RoutedControlTransport): void {
  transport.attach({
    cellBootId,
    controlUrl: "ws://127.0.0.1/control",
    transportGrant,
    attachGrant,
    activationId: "activation-a",
    initialDemand: { mode: "live" },
  });
}

describe("main-thread routed control transport", () => {
  function replacementFixture() {
    const sockets: FakeSocket[] = [];
    const events: RoutedControlTransportEvent[] = [];
    const transport = new RoutedControlTransport({
      socketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket as unknown as WebSocket;
      },
      emit: (event) => events.push(event),
    });
    let generation = 0;
    const open = (activationId: string) => {
      transport.attach({
        cellBootId,
        controlUrl: "ws://127.0.0.1/control",
        transportGrant,
        attachGrant: {
          ...attachGrant,
          claims: { ...attachGrant.claims, grantGeneration: ++generation, expiresAt: Date.now() + 60_000 },
        },
        activationId,
        replacePreviousActivation: true,
        initialDemand: { mode: "live" },
      });
    };
    const connect = () => {
      const socket = sockets.at(-1)!;
      socket.open();
      socket.receive(
        encodeRoutedMessage("ConnectionAccepted", {
          selectedProtocolVersion: { major: 1, minor: 0 },
          connectionSetId: "set-a",
          channel: "control",
          legGeneration: sockets.length,
          heartbeatTtlMs: 15_000,
          protocolLimits: DEFAULT_ROUTED_PROTOCOL_LIMITS,
          capabilities: ["resume"],
        }),
      );
      return socket;
    };
    const accepted = (socket: FakeSocket, activationId: string, grantGenerationAccepted: number) => {
      socket.receive(
        encodeRoutedMessage("ControlLegAttached", {
          sessionId: "session-a",
          activationId,
          grantGenerationAccepted,
          rights: ["input", "read"],
        }),
      );
    };
    const attaches = (socket: FakeSocket) =>
      socket.sent.map((line) => JSON.parse(line)).filter((m) => m.type === "AttachControlLeg");
    return { transport, events, open, connect, accepted, attaches };
  }

  it("replaces the native attachment after the last local view detached", () => {
    const h = replacementFixture();
    try {
      h.open("old");
      const socket = h.connect();
      h.accepted(socket, "old", 1);
      h.transport.detach("old");
      h.open("new");
      expect(h.attaches(socket).at(-1)).toMatchObject({ activationId: "new", replacesActivationId: "old" });
      h.accepted(socket, "new", 2);
      h.transport.detach("new");
      h.open("third");
      expect(h.attaches(socket).at(-1)).toMatchObject({ activationId: "third", replacesActivationId: "new" });
    } finally {
      h.transport.dispose();
    }
  });

  it("waits for a detached pending attach before replacing its accepted identity", () => {
    const h = replacementFixture();
    try {
      h.open("old");
      const socket = h.connect();
      h.transport.detach("old");
      h.open("new");
      expect(h.attaches(socket)).toHaveLength(1);
      h.accepted(socket, "old", 1);
      expect(h.attaches(socket).at(-1)).toMatchObject({ activationId: "new", replacesActivationId: "old" });
      expect(h.events.filter((event) => event.type === "control-attached")).toHaveLength(0);
      h.accepted(socket, "new", 2);
      expect(h.events.at(-1)).toMatchObject({ type: "control-attached", attached: { activationId: "new" } });
    } finally {
      h.transport.dispose();
    }
  });

  it("keeps the admitted predecessor after a replacement was refused", () => {
    const h = replacementFixture();
    try {
      h.open("old");
      const socket = h.connect();
      h.accepted(socket, "old", 1);
      h.transport.detach("old");
      h.open("refused");
      h.transport.detach("refused");
      h.open("retry");
      socket.receive(
        encodeRoutedMessage("AttachRefused", { activationId: "refused", code: "CAPACITY", retryable: true }),
      );
      expect(h.attaches(socket).at(-1)).toMatchObject({ activationId: "retry", replacesActivationId: "old" });
      h.accepted(socket, "retry", 3);
      expect(socket.readyState).toBe(1);
    } finally {
      h.transport.dispose();
    }
  });

  it("coalesces queued remounts and keeps their demand local until the attach is sent", () => {
    const h = replacementFixture();
    try {
      h.open("old");
      const socket = h.connect();
      h.transport.detach("old");
      h.open("skipped");
      h.transport.detach("skipped");
      h.open("latest");
      const sent = socket.sent.length;
      expect(h.transport.declareDemand("latest", { mode: "none" })).toBeUndefined();
      expect(socket.sent).toHaveLength(sent);
      h.accepted(socket, "old", 1);
      expect(h.attaches(socket)).toHaveLength(2);
      expect(h.attaches(socket).at(-1)).toMatchObject({
        activationId: "latest",
        replacesActivationId: "old",
        initialDemand: { mode: "none" },
      });
    } finally {
      h.transport.dispose();
    }
  });

  it("forgets a detached predecessor when the cell revokes it", () => {
    const h = replacementFixture();
    try {
      h.open("old");
      const socket = h.connect();
      h.accepted(socket, "old", 1);
      h.transport.detach("old");
      socket.receive(
        encodeRoutedMessage("CellActivationStatus", {
          sessionId: "session-a",
          activationId: "old",
          cellStatusSequence: 2,
          leaseTtlMs: 1,
          presentation: { state: "revoked", reason: "leg-dead" },
          input: { state: "revoked", reason: "leg-dead" },
        }),
      );
      h.open("fresh");
      expect(h.attaches(socket).at(-1)).toMatchObject({ activationId: "fresh" });
      expect(h.attaches(socket).at(-1).replacesActivationId).toBeUndefined();
      expect(h.events.filter((event) => event.type === "cell-status")).toHaveLength(0);
    } finally {
      h.transport.dispose();
    }
  });

  it("serializes renewal against the grant actually sent before a late attach reply", () => {
    const h = replacementFixture();
    try {
      h.open("old");
      const socket = h.connect();
      h.transport.renew("old", { ...attachGrant, claims: { ...attachGrant.claims, grantGeneration: 2 } });
      expect(h.attaches(socket)).toHaveLength(1);
      h.accepted(socket, "old", 1);
      expect(socket.readyState).toBe(1);
      expect(h.attaches(socket)).toHaveLength(2);
      expect(h.attaches(socket)[1].attachGrant.claims.grantGeneration).toBe(2);
      expect(h.attaches(socket)[1].replacesActivationId).toBeUndefined();
      h.accepted(socket, "old", 2);
      expect(h.events.filter((event) => event.type === "control-attached")).toHaveLength(2);
    } finally {
      h.transport.dispose();
    }
  });

  it("does not replace an attach that never reached the socket or a dead connection", () => {
    const h = replacementFixture();
    try {
      h.open("never-sent");
      h.transport.detach("never-sent");
      h.open("first");
      const socket = h.connect();
      expect(h.attaches(socket)).toHaveLength(1);
      expect(h.attaches(socket)[0].replacesActivationId).toBeUndefined();
      h.accepted(socket, "first", 2);
      h.transport.detach("first");
      socket.close();
      h.open("fresh");
      const next = h.connect();
      expect(h.attaches(next)[0].replacesActivationId).toBeUndefined();
    } finally {
      h.transport.dispose();
    }
  });

  it("delivers unknown authenticated control messages only when extension ingress is enabled", () => {
    const socket = new FakeSocket();
    const events: RoutedControlTransportEvent[] = [];
    const transport = new RoutedControlTransport({
      socketFactory: () => socket as unknown as WebSocket,
      acceptExtensionMessages: true,
      emit: (event) => events.push(event),
    });
    attach(transport);
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
    const message = { type: "HostSessionNotice", sessionId: "session-a", revision: 3 };
    socket.receive(JSON.stringify(message));

    expect(events.at(-1)).toEqual({
      type: "extension-message",
      message,
      context: { cellBootId: "cell-a", connectionSetId: "set-a", channel: "control" },
    });
    expect(socket.readyState).toBe(1);
    transport.dispose();
  });

  it("keeps unknown messages closed before authentication and when extension ingress is disabled", () => {
    const preAuthSocket = new FakeSocket();
    const preAuthEvents: RoutedControlTransportEvent[] = [];
    const preAuth = new RoutedControlTransport({
      socketFactory: () => preAuthSocket as unknown as WebSocket,
      acceptExtensionMessages: true,
      emit: (event) => preAuthEvents.push(event),
    });
    attach(preAuth);
    preAuthSocket.open();
    preAuthSocket.receive(JSON.stringify({ type: "HostSessionNotice" }));
    expect(preAuthEvents.at(-1)).toMatchObject({ type: "transport-closed", code: 4003, preAuth: false });

    const disabledSocket = new FakeSocket();
    const disabledEvents: RoutedControlTransportEvent[] = [];
    const disabled = new RoutedControlTransport({
      socketFactory: () => disabledSocket as unknown as WebSocket,
      emit: (event) => disabledEvents.push(event),
    });
    attach(disabled);
    disabledSocket.open();
    disabledSocket.receive(
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
    disabledSocket.receive(JSON.stringify({ type: "HostSessionNotice" }));
    expect(disabledEvents.at(-1)).toMatchObject({ type: "transport-closed", code: 4003, preAuth: false });

    preAuth.dispose();
    disabled.dispose();
  });

  it("does not reclassify a known wrong-leg message as an extension", () => {
    const socket = new FakeSocket();
    const events: RoutedControlTransportEvent[] = [];
    const transport = new RoutedControlTransport({
      socketFactory: () => socket as unknown as WebSocket,
      acceptExtensionMessages: true,
      emit: (event) => events.push(event),
    });
    attach(transport);
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
    const outboundAttach = socket.sent.at(-1)!;
    socket.receive(outboundAttach);

    expect(events.at(-1)).toMatchObject({ type: "transport-closed", code: 4003, preAuth: false });
    expect(events.some((event) => event.type === "extension-message")).toBe(false);
    transport.dispose();
  });

  it("keeps malformed, known-invalid, binary, and oversized ingress closed", () => {
    const reject = (
      deliver: (socket: FakeSocket) => void,
      maxControlMessageBytes = DEFAULT_ROUTED_PROTOCOL_LIMITS.maxControlMessageBytes,
    ) => {
      const socket = new FakeSocket();
      const events: RoutedControlTransportEvent[] = [];
      const transport = new RoutedControlTransport({
        socketFactory: () => socket as unknown as WebSocket,
        acceptExtensionMessages: true,
        emit: (event) => events.push(event),
      });
      attach(transport);
      socket.open();
      socket.receive(
        encodeRoutedMessage("ConnectionAccepted", {
          selectedProtocolVersion: { major: 1, minor: 0 },
          connectionSetId: "set-a",
          channel: "control",
          legGeneration: 1,
          heartbeatTtlMs: 15_000,
          protocolLimits: { ...DEFAULT_ROUTED_PROTOCOL_LIMITS, maxControlMessageBytes },
          capabilities: ["resume"],
        }),
      );
      deliver(socket);
      expect(events.at(-1)).toMatchObject({ type: "transport-closed", code: 4003, preAuth: false });
      expect(events.some((event) => event.type === "extension-message")).toBe(false);
      transport.dispose();
    };

    reject((socket) => socket.receive("{"));
    reject((socket) => socket.receive(JSON.stringify({ type: "CellActivationStatus" })));
    reject((socket) => socket.dispatchEvent(new MessageEvent("message", { data: new Uint8Array([1, 2, 3]).buffer })));
    reject((socket) => socket.receive(JSON.stringify({ type: "HostSessionNotice", payload: "x".repeat(128) })), 64);
  });

  it("closes a leg whose heartbeat acknowledgements stop", async () => {
    const socket = new FakeSocket();
    const events: RoutedControlTransportEvent[] = [];
    const transport = new RoutedControlTransport({
      socketFactory: () => socket as unknown as WebSocket,
      emit: (event) => events.push(event),
    });
    attach(transport);
    socket.open();
    socket.receive(
      encodeRoutedMessage("ConnectionAccepted", {
        selectedProtocolVersion: { major: 1, minor: 0 },
        connectionSetId: "set-a",
        channel: "control",
        legGeneration: 1,
        heartbeatTtlMs: 10,
        protocolLimits: DEFAULT_ROUTED_PROTOCOL_LIMITS,
        capabilities: ["resume"],
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(events).toContainEqual({
      type: "transport-closed",
      cellBootId,
      code: 4004,
      reason: "heartbeat timeout",
      activationIds: ["activation-a"],
      preAuth: false,
    });
    transport.dispose();
  });

  it("preserves structured refusals and distinguishes a silent pre-auth close", () => {
    const refusalSocket = new FakeSocket();
    const refusalEvents: RoutedControlTransportEvent[] = [];
    const refused = new RoutedControlTransport({
      socketFactory: () => refusalSocket as unknown as WebSocket,
      emit: (event) => refusalEvents.push(event),
    });
    attach(refused);
    refusalSocket.open();
    refusalSocket.receive(encodeRoutedMessage("ConnectionRefused", { code: "SET_CHANNEL_BUSY", retryable: true }));
    expect(refusalEvents.at(-1)).toMatchObject({
      type: "transport-closed",
      preAuth: false,
      refusal: { code: "SET_CHANNEL_BUSY", retryable: true },
    });

    const preAuthSocket = new FakeSocket();
    const preAuthEvents: RoutedControlTransportEvent[] = [];
    const preAuth = new RoutedControlTransport({
      socketFactory: () => preAuthSocket as unknown as WebSocket,
      emit: (event) => preAuthEvents.push(event),
    });
    attach(preAuth);
    preAuthSocket.open();
    preAuthSocket.close(1008, "");
    expect(preAuthEvents.at(-1)).toMatchObject({ type: "transport-closed", code: 1008, preAuth: true });
    refused.dispose();
    preAuth.dispose();
  });

  it("rejects control attach acknowledgements that exceed the bound grant", () => {
    const socket = new FakeSocket();
    const events: RoutedControlTransportEvent[] = [];
    const transport = new RoutedControlTransport({
      socketFactory: () => socket as unknown as WebSocket,
      emit: (event) => events.push(event),
    });
    attach(transport);
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
    socket.receive(
      encodeRoutedMessage("ControlLegAttached", {
        sessionId: "session-a",
        activationId: "activation-a",
        grantGenerationAccepted: 1,
        rights: ["geometry", "input", "read"],
      }),
    );

    expect(events).toContainEqual(
      expect.objectContaining({ type: "transport-closed", code: 4003, activationIds: ["activation-a"] }),
    );
    expect(events.some((event) => event.type === "control-attached")).toBe(false);
    transport.dispose();
  });

  it("does not let a fire-and-forget release consume another activation's geometry reply", () => {
    const socket = new FakeSocket();
    const events: RoutedControlTransportEvent[] = [];
    const transport = new RoutedControlTransport({
      socketFactory: () => socket as unknown as WebSocket,
      emit: (event) => events.push(event),
    });
    attach(transport);
    const activationB = "activation-b";
    transport.attach({
      cellBootId,
      controlUrl: "ws://127.0.0.1/control",
      transportGrant,
      attachGrant: {
        ...attachGrant,
        claims: { ...attachGrant.claims, sessionId: "session-b" },
      },
      activationId: activationB,
      initialDemand: { mode: "live" },
    });
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
    expect(
      transport.releaseGeometry("activation-a", {
        sessionId: "session-a",
        activationId: "activation-a",
        leaseEpoch: 1,
        holder: { clientId: "client-a", viewId: "view-a", holderGeneration: 1 },
      }),
    ).toBe(true);
    expect(
      transport.claimGeometry(activationB, {
        sessionId: "session-b",
        activationId: activationB,
        leaseEpoch: 1,
        claimant: { clientId: "client-a", viewId: "view-b" },
        cols: 80,
        rows: 24,
        expectRevision: 0,
      }),
    ).toBe(true);
    socket.receive(
      encodeRoutedMessage("GeometryCommitted", {
        holder: { clientId: "client-a", viewId: "view-b", holderGeneration: 1 },
        geometryRevision: 1,
        cols: 80,
        rows: 24,
      }),
    );

    expect(events.at(-1)).toMatchObject({ type: "geometry-committed", activationId: activationB });
    transport.dispose();
  });

  it("gives a refused release its own refusal instead of the next request's reply", () => {
    const { socket, events, transport } = twoActivationTransport();
    expect(transport.releaseGeometry("activation-a", release("activation-a", "session-a"))).toBe(true);
    const sent = socket.sent.slice(-2).map((text) => JSON.parse(text) as { type: string; sequence?: number });
    expect(sent.map((message) => message.type)).toEqual(["ReleaseGeometry", "LegHeartbeat"]);
    expect(transport.claimGeometry("activation-b", claim("activation-b", "session-b"), "claim-b")).toBe(true);

    // The holder moved on before the release arrived: the cell refuses it.
    socket.receive(
      encodeRoutedMessage("GeometryRefused", {
        code: "NOT_HOLDER",
        currentHolder: { clientId: "client-z", viewId: "view-z", holderGeneration: 3 },
        geometryRevision: 7,
      }),
    );
    socket.receive(encodeRoutedMessage("LegHeartbeatAck", { sequence: sent[1]!.sequence! }));
    socket.receive(
      encodeRoutedMessage("GeometryCommitted", {
        holder: { clientId: "client-a", viewId: "view-b", holderGeneration: 1 },
        geometryRevision: 1,
        cols: 80,
        rows: 24,
      }),
    );

    const replies = events.filter((event) => event.type === "geometry-refused" || event.type === "geometry-committed");
    expect(replies).toMatchObject([
      { type: "geometry-refused", activationId: "activation-a", request: { kind: "release" } },
      { type: "geometry-committed", activationId: "activation-b", request: { kind: "claim", context: "claim-b" } },
    ]);
    transport.dispose();
  });

  it("settles a silent release on its fence, so a later refusal reaches its own request", () => {
    const { socket, events, transport } = twoActivationTransport();
    transport.releaseGeometry("activation-a", release("activation-a", "session-a"));
    const fence = JSON.parse(socket.sent.at(-1)!) as { type: string; sequence: number };
    expect(fence.type).toBe("LegHeartbeat");
    transport.claimGeometry("activation-b", claim("activation-b", "session-b"), "claim-b");

    // The release succeeded silently; the fence's ack proves it before the
    // claim's refusal arrives.
    socket.receive(encodeRoutedMessage("LegHeartbeatAck", { sequence: fence.sequence }));
    socket.receive(
      encodeRoutedMessage("GeometryRefused", {
        code: "SEAT_HELD",
        currentHolder: { clientId: "client-z", viewId: "view-z", holderGeneration: 3 },
        geometryRevision: 8,
      }),
    );

    expect(events.at(-1)).toMatchObject({
      type: "geometry-refused",
      activationId: "activation-b",
      request: { kind: "claim", context: "claim-b" },
      refused: { code: "SEAT_HELD" },
    });
    transport.dispose();
  });

  it("hands a claim's and a transfer's context back with the reply each one earns", () => {
    const { socket, events, transport } = twoActivationTransport();
    const takeContext = { take: 1 };
    transport.claimGeometry("activation-a", claim("activation-a", "session-a"));
    transport.transferGeometry(
      "activation-a",
      {
        sessionId: "session-a",
        activationId: "activation-a",
        leaseEpoch: 1,
        from: { clientId: "client-z", viewId: "view-z", holderGeneration: 3 },
        to: { clientId: "client-a", viewId: "view-a" },
        expectRevision: 7,
        cols: 100,
        rows: 30,
      },
      takeContext,
    );
    socket.receive(
      encodeRoutedMessage("GeometryRefused", {
        code: "SEAT_HELD",
        currentHolder: { clientId: "client-z", viewId: "view-z", holderGeneration: 3 },
        geometryRevision: 7,
      }),
    );
    socket.receive(
      encodeRoutedMessage("GeometryCommitted", {
        holder: { clientId: "client-a", viewId: "view-a", holderGeneration: 4 },
        geometryRevision: 8,
        cols: 100,
        rows: 30,
      }),
    );

    const replies = events.filter((event) => event.type === "geometry-refused" || event.type === "geometry-committed");
    expect(replies).toHaveLength(2);
    expect(replies[0]).toMatchObject({ activationId: "activation-a", request: { kind: "claim" } });
    expect(replies[0]).not.toHaveProperty("request.context");
    expect(replies[1]).toMatchObject({ activationId: "activation-a", request: { kind: "transfer" } });
    expect((replies[1] as { request?: { context?: unknown } }).request?.context).toBe(takeContext);
    transport.dispose();
  });
});

function twoActivationTransport(): {
  socket: FakeSocket;
  events: RoutedControlTransportEvent[];
  transport: RoutedControlTransport;
} {
  const socket = new FakeSocket();
  const events: RoutedControlTransportEvent[] = [];
  const transport = new RoutedControlTransport({
    socketFactory: () => socket as unknown as WebSocket,
    emit: (event) => events.push(event),
  });
  attach(transport);
  transport.attach({
    cellBootId,
    controlUrl: "ws://127.0.0.1/control",
    transportGrant,
    attachGrant: { ...attachGrant, claims: { ...attachGrant.claims, sessionId: "session-b" } },
    activationId: "activation-b",
    initialDemand: { mode: "live" },
  });
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
  return { socket, events, transport };
}

function release(activationId: string, sessionId: string) {
  return {
    sessionId,
    activationId,
    leaseEpoch: 1,
    holder: { clientId: "client-a", viewId: "view-a", holderGeneration: 1 },
  };
}

function claim(activationId: string, sessionId: string) {
  return {
    sessionId,
    activationId,
    leaseEpoch: 1,
    claimant: { clientId: "client-a", viewId: "view-b" },
    cols: 80,
    rows: 24,
    expectRevision: 0,
  };
}
