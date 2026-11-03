import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_ROUTED_PROTOCOL_LIMITS,
  encodeRoutedMessage,
  type RoutedCellTransportGrant,
  type RoutedSessionAttachGrant,
} from "@vibecook/ghosttea-protocol";
import { RoutedControlTransport } from "./routed-control";

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

const selection = { startColumn: 0, startRow: 0, endColumn: 79, endRow: 159, selectAll: true };
const transports: RoutedControlTransport[] = [];
afterEach(() => {
  for (const t of transports.splice(0)) t.dispose();
  vi.useRealTimers();
});
function fixture(negotiated = true) {
  const socket = new FakeSocket();
  const transport = new RoutedControlTransport({
    socketFactory: () => socket as unknown as WebSocket,
    emit: () => undefined,
  });
  transports.push(transport);
  transport.attach({
    cellBootId,
    controlUrl: "ws://localhost/control",
    transportGrant,
    attachGrant: { ...attachGrant, claims: { ...attachGrant.claims, rights: ["read"] } },
    activationId: "activation-a",
    initialDemand: { mode: "live" },
    capabilities: ["selection-text"],
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
      capabilities: negotiated ? ["selection-text"] : [],
    }),
  );
  const requests = () =>
    socket.sent
      .map((text) => JSON.parse(text) as { type: string; requestId: string })
      .filter((message) => message.type === "SelectionTextRequest");
  const answer = (requestId: string, fields: Record<string, unknown>) =>
    socket.receive(
      JSON.stringify({
        type: "SelectionTextResult",
        requestId,
        sessionId: "session-a",
        activationId: "activation-a",
        leaseEpoch: 1,
        ...fields,
      }),
    );
  return { transport, socket, requests, answer };
}
describe("routed selection reads", () => {
  it("does not send an unknown verb to an older host", async () => {
    const f = fixture(false);
    await expect(f.transport.selectionText("activation-a", selection)).rejects.toThrow("unavailable");
    expect(f.requests()).toHaveLength(0);
    expect(f.socket.readyState).toBe(1);
  });
  it("copies Unicode for a read-only grant and correlates out-of-order replies", async () => {
    const f = fixture();
    const first = f.transport.selectionText("activation-a", selection);
    const second = f.transport.selectionText("activation-a", { ...selection, selectAll: false });
    const requests = f.requests();
    f.answer(requests[1]!.requestId, { text: "" });
    f.answer(requests[0]!.requestId, { text: "中 é 👩‍💻 🛙X\nrow 160" });
    await expect(first).resolves.toBe("中 é 👩‍💻 🛙X\nrow 160");
    await expect(second).resolves.toBe("");
  });
  it("rejects a reply bound to a different session and closes the offending leg", async () => {
    const f = fixture();
    const answer = expect(f.transport.selectionText("activation-a", selection)).rejects.toThrow("detached");
    f.answer(f.requests()[0]!.requestId, { sessionId: "other-session", text: "private" });
    await answer;
    expect(f.socket.readyState).toBe(3);
  });
  it("bounds pending reads, cancels on detach, and ignores late replies", async () => {
    const f = fixture();
    const pending = Array.from({ length: 16 }, () =>
      expect(f.transport.selectionText("activation-a", selection)).rejects.toThrow("detached"),
    );
    await expect(f.transport.selectionText("activation-a", selection)).rejects.toThrow("Too many");
    f.transport.detach("activation-a");
    await Promise.all(pending);
    f.answer(f.requests()[0]!.requestId, { text: "late" });
    expect(f.socket.readyState).toBe(1);
  });
  it("times out and cancels reads on connection loss without replay", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const timed = expect(f.transport.selectionText("activation-a", selection)).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(5_001);
    await timed;
    const closed = expect(f.transport.selectionText("activation-a", selection)).rejects.toThrow("detached");
    f.socket.close();
    await closed;
  });
  it("reports oversized copies without truncating text or disconnecting", async () => {
    const f = fixture();
    const pending = expect(f.transport.selectionText("activation-a", selection)).rejects.toThrow("too large");
    f.answer(f.requests()[0]!.requestId, { error: "TOO_LARGE" });
    await pending;
    expect(f.socket.readyState).toBe(1);
  });
});
