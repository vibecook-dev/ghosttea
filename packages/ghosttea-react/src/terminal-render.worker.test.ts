import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_ROUTED_PROTOCOL_LIMITS,
  DEFAULT_ROUTED_RECEIVER_CAPACITIES,
  encodeRoutedMessage,
  encodeRoutedPresentationEnvelope,
  routedCrc32c,
} from "@vibecook/ghosttea-protocol";
import {
  FRAME_HEADER_BYTES,
  FRAME_MAGIC,
  FRAME_PROTOCOL_VERSION,
  FrameFlag,
  SectionKind,
} from "@vibecook/ghosttea-frame";

const renderer = vi.hoisted(() => ({
  mount: vi.fn(),
  unmount: vi.fn(),
  resize: vi.fn(),
  render: vi.fn(),
  renderBatch: vi.fn((_entries: ReadonlyArray<{ id: string; view: { effects?: unknown } }>) => []),
}));

const webgpu = vi.hoisted(() => ({ enabled: false }));

class FakeRoutedSocket extends EventTarget {
  readyState = 0;
  binaryType = "blob";
  readonly sent: string[] = [];

  send(data: string): void {
    this.sent.push(data);
  }

  open(): void {
    this.readyState = 1;
    this.dispatchEvent(new Event("open"));
  }

  receive(data: string | ArrayBuffer): void {
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

function identityOnlyFrame(sessionHandle: bigint, viewHandle: bigint): ArrayBuffer {
  const buffer = new ArrayBuffer(FRAME_HEADER_BYTES);
  const view = new DataView(buffer);
  view.setUint32(0, FRAME_MAGIC, true);
  view.setUint16(4, FRAME_PROTOCOL_VERSION, true);
  view.setBigUint64(8, sessionHandle, true);
  view.setBigUint64(16, viewHandle, true);
  view.setBigUint64(24, 1n, true);
  view.setBigUint64(32, 1n, true);
  view.setBigUint64(40, 1n, true);
  view.setBigUint64(48, 1n, true);
  view.setUint16(56, 80, true);
  view.setUint16(58, 24, true);
  return buffer;
}

function minimalFullFrame(sessionHandle: bigint, viewHandle: bigint): ArrayBuffer {
  const rowOffset = FRAME_HEADER_BYTES + 3 * 16;
  const cursorOffset = rowOffset + 2;
  const scrollbarOffset = cursorOffset + 8;
  const buffer = new ArrayBuffer(scrollbarOffset + 24);
  const view = new DataView(buffer);
  view.setUint32(0, FRAME_MAGIC, true);
  view.setUint16(4, FRAME_PROTOCOL_VERSION, true);
  view.setUint16(6, FrameFlag.FullSnapshot, true);
  view.setBigUint64(8, sessionHandle, true);
  view.setBigUint64(16, viewHandle, true);
  view.setBigUint64(24, 1n, true);
  view.setBigUint64(32, 1n, true);
  view.setBigUint64(40, 1n, true);
  view.setBigUint64(48, 1n, true);
  view.setUint16(56, 80, true);
  view.setUint16(58, 24, true);
  view.setUint16(60, 3, true);
  view.setUint16(FRAME_HEADER_BYTES, SectionKind.RowReplacements, true);
  view.setUint16(FRAME_HEADER_BYTES + 2, 1, true);
  view.setUint32(FRAME_HEADER_BYTES + 4, rowOffset, true);
  view.setUint32(FRAME_HEADER_BYTES + 8, 2, true);
  view.setUint32(FRAME_HEADER_BYTES + 12, 0, true);
  view.setUint16(FRAME_HEADER_BYTES + 16, SectionKind.CursorState, true);
  view.setUint32(FRAME_HEADER_BYTES + 20, cursorOffset, true);
  view.setUint32(FRAME_HEADER_BYTES + 24, 8, true);
  view.setUint32(FRAME_HEADER_BYTES + 28, 1, true);
  view.setUint16(FRAME_HEADER_BYTES + 32, SectionKind.ScrollbarState, true);
  view.setUint32(FRAME_HEADER_BYTES + 36, scrollbarOffset, true);
  view.setUint32(FRAME_HEADER_BYTES + 40, 24, true);
  view.setUint32(FRAME_HEADER_BYTES + 44, 1, true);
  view.setUint16(rowOffset, 0, true);
  view.setBigUint64(scrollbarOffset, 24n, true);
  view.setBigUint64(scrollbarOffset + 8, 0n, true);
  view.setBigUint64(scrollbarOffset + 16, 24n, true);
  return buffer;
}

function oneGlyphFrame(handle: bigint, pixel: number): ArrayBuffer {
  const base = minimalFullFrame(handle, handle);
  const old = new DataView(base);
  const buffer = new ArrayBuffer(base.byteLength + 16 + 25);
  const view = new DataView(buffer);
  new Uint8Array(buffer).set(new Uint8Array(base, 0, FRAME_HEADER_BYTES + 48));
  view.setUint16(6, FrameFlag.FullSnapshot | FrameFlag.CatalogReset, true);
  view.setUint16(60, 4, true);
  for (let section = 0; section < 3; section++) {
    const offset = FRAME_HEADER_BYTES + section * 16 + 4;
    view.setUint32(offset, old.getUint32(offset, true) + 16, true);
  }
  new Uint8Array(buffer).set(new Uint8Array(base, FRAME_HEADER_BYTES + 48), FRAME_HEADER_BYTES + 64);
  const descriptor = FRAME_HEADER_BYTES + 48;
  const payload = base.byteLength + 16;
  view.setUint16(descriptor, SectionKind.GlyphDefinitions, true);
  view.setUint32(descriptor + 4, payload, true);
  view.setUint32(descriptor + 8, 25, true);
  view.setUint32(descriptor + 12, 1, true);
  view.setUint32(payload, 1, true);
  view.setUint32(payload + 4, 1, true);
  view.setUint16(payload + 8, 1, true);
  view.setUint16(payload + 10, 1, true);
  view.setUint32(payload + 20, 1, true);
  view.setUint8(payload + 24, pixel);
  return buffer;
}

function textFrame(lines: string[], sequence: bigint, reset = false): ArrayBuffer {
  const texts = lines.map((line) => new TextEncoder().encode(line));
  const offset = FRAME_HEADER_BYTES + 32;
  const rowBytes = 2 + texts.reduce((sum, text) => sum + 18 + text.length, 0);
  const buffer = new ArrayBuffer(offset + rowBytes + 8);
  const v = new DataView(buffer);
  v.setUint32(0, FRAME_MAGIC, true);
  v.setUint16(4, FRAME_PROTOCOL_VERSION, true);
  v.setUint16(6, FrameFlag.FullSnapshot | (reset ? FrameFlag.CatalogReset : 0), true);
  for (const at of [8, 16, 24, 32, 48]) v.setBigUint64(at, 1n, true);
  v.setBigUint64(40, sequence, true);
  v.setUint16(56, 80, true);
  v.setUint16(58, lines.length, true);
  v.setUint16(60, 2, true);
  v.setUint16(FRAME_HEADER_BYTES, SectionKind.RowReplacements, true);
  v.setUint16(FRAME_HEADER_BYTES + 2, 1, true);
  v.setUint32(FRAME_HEADER_BYTES + 4, offset, true);
  v.setUint32(FRAME_HEADER_BYTES + 8, rowBytes, true);
  v.setUint32(FRAME_HEADER_BYTES + 12, lines.length, true);
  v.setUint16(FRAME_HEADER_BYTES + 16, SectionKind.CursorState, true);
  v.setUint32(FRAME_HEADER_BYTES + 20, offset + rowBytes, true);
  v.setUint32(FRAME_HEADER_BYTES + 24, 8, true);
  v.setUint32(FRAME_HEADER_BYTES + 28, 1, true);
  v.setUint16(offset, lines.length, true);
  let at = offset + 2;
  for (const [row, text] of texts.entries()) {
    v.setUint16(at, row, true);
    v.setBigUint64(at + 2, sequence, true);
    v.setUint32(at + 10, text.length, true);
    new Uint8Array(buffer).set(text, at + 18);
    at += 18 + text.length;
  }
  return buffer;
}

vi.mock("./renderers/canvas-renderer.js", () => ({
  CanvasTerminalRenderer: class {
    readonly kind = "canvas2d" as const;
    readonly mount = renderer.mount;
    readonly unmount = renderer.unmount;
    readonly resize = renderer.resize;
    readonly render = renderer.render;
    readonly renderBatch = renderer.renderBatch;
  },
}));

vi.mock("./renderers/webgpu-renderer.js", () => ({
  WebGpuTerminalRenderer: class {
    static async create() {
      if (!webgpu.enabled) throw new Error("WebGPU disabled by test");
      return {
        kind: "webgpu" as const,
        mount: renderer.mount,
        unmount: renderer.unmount,
        resize: renderer.resize,
        render: renderer.render,
        renderBatch: renderer.renderBatch,
      };
    }
  },
}));

describe("terminal render worker surfaces", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    webgpu.enabled = false;
  });

  afterEach(() => vi.unstubAllGlobals());

  it("says once per handle when a committed frame first puts something on screen", async () => {
    const postMessage = vi.fn();
    vi.stubGlobal("self", { postMessage, requestAnimationFrame: (_cb: FrameRequestCallback) => 1 });
    await import("./terminal-render.worker.js");
    const dispatch = (data: unknown) => self.onmessage!({ data } as MessageEvent);
    const drawn = () => postMessage.mock.calls.filter(([message]) => message?.type === "session-drawn");
    // A blank screen (empty and all-space rows) is committed, but has not drawn.
    dispatch({ type: "frame", packet: textFrame(["", "   "], 1n) });
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "frame-committed", sessionHandle: "1" }));
    expect(drawn()).toEqual([]);
    dispatch({ type: "frame", packet: textFrame(["╭─ Codex", ""], 2n) });
    dispatch({ type: "frame", packet: textFrame(["╭─ Codex", "› "], 3n) });
    expect(drawn()).toEqual([[{ type: "session-drawn", sessionHandle: "1" }]]);
    // Dropped and seen again, the handle can announce its first paint again.
    dispatch({ type: "drop-session", sessionHandle: "1" });
    dispatch({ type: "frame", packet: textFrame(["again"], 4n) });
    expect(drawn()).toHaveLength(2);
  });

  it("paints a cached session at its mount geometry and waits for a nonzero hidden-pane size", async () => {
    const raf: FrameRequestCallback[] = [];
    vi.stubGlobal("self", { postMessage: vi.fn(), requestAnimationFrame: (cb: FrameRequestCallback) => raf.push(cb) });
    await import("./terminal-render.worker.js");
    const dispatch = (data: unknown) => self.onmessage!({ data } as MessageEvent);
    const settle = async () => {
      for (let i = 0; i < 20; i += 1) await Promise.resolve();
    };
    dispatch({ type: "renderer-config", forceCanvasFallback: true });
    dispatch({ type: "frame", packet: textFrame(["cached"], 1n) });
    dispatch({
      type: "mount",
      surfaceId: "fresh",
      sessionHandle: "1",
      canvas: {},
      size: { width: 643, height: 417, dpr: 2 },
    });
    dispatch({
      type: "mount",
      surfaceId: "hidden",
      sessionHandle: "1",
      canvas: {},
      size: { width: 0, height: 0, dpr: 2 },
    });
    await settle();
    raf.splice(0).forEach((cb) => cb(0));
    await settle();
    expect(renderer.resize).toHaveBeenCalledWith("fresh", { width: 643, height: 417, dpr: 2 });
    const painted = () => renderer.renderBatch.mock.calls.flatMap(([entries]) => entries.map(({ id }) => id));
    expect(painted()).toContain("fresh");
    expect(painted()).not.toContain("hidden");
    dispatch({ type: "resize", surfaceId: "hidden", width: 643, height: 417, dpr: 2 });
    raf.splice(0).forEach((cb) => cb(0));
    await settle();
    expect(painted()).toContain("hidden");
  });

  it("composes scrolling before a paint and fences reset, layout and selection changes", async () => {
    const raf: FrameRequestCallback[] = [];
    const scope = {
      onmessage: null as ((event: MessageEvent) => void) | null,
      postMessage: vi.fn(),
      requestAnimationFrame: (callback: FrameRequestCallback) => raf.push(callback),
    };
    vi.stubGlobal("self", scope);
    await import("./terminal-render.worker.js");
    const dispatch = (data: unknown) => scope.onmessage?.({ data } as MessageEvent);
    const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
    const paints: Array<{ full: boolean; rows: number[]; scrollRows?: number }> = [];
    renderer.renderBatch.mockImplementation((entries) => {
      for (const { view } of entries) {
        const damage = (view as unknown as import("./renderers/types.js").RenderView).damage!;
        paints.push({ ...damage, rows: [...damage.rows] });
      }
      return [];
    });
    const paint = async () => {
      raf.splice(0).forEach((callback) => callback(0));
      await settle();
      return paints.at(-1)!;
    };
    dispatch({ type: "renderer-config", forceCanvasFallback: true });
    dispatch({
      type: "mount",
      surfaceId: "a",
      sessionHandle: "1",
      canvas: {},
      size: { width: 800, height: 600, dpr: 2 },
    });
    await settle();
    dispatch({ type: "frame", packet: textFrame(["a", "b", "c", "d", "e"], 1n) });
    expect((await paint()).full).toBe(true);
    dispatch({ type: "frame", packet: textFrame(["b", "c", "d", "e", "f"], 2n) });
    dispatch({ type: "frame", packet: textFrame(["c", "d", "e", "f", "g"], 3n) });
    expect(await paint()).toMatchObject({ full: false, scrollRows: 2 });
    expect(paints.at(-1)!.rows).toEqual(expect.arrayContaining([3, 4]));
    dispatch({
      type: "selection",
      sessionHandle: "1",
      surfaceId: "a",
      selection: { anchor: { row: 2, column: 0 }, focus: { row: 3, column: 4 } },
    });
    expect(await paint()).toMatchObject({ full: false, rows: [2, 3] });
    dispatch({ type: "frame", packet: textFrame(["d", "e", "f", "g", "h"], 4n) });
    expect((await paint()).full).toBe(true);
    dispatch({ type: "selection", sessionHandle: "1", surfaceId: "a", selection: null });
    await paint();
    dispatch({ type: "frame", packet: textFrame(["e", "f", "g", "h", "i"], 5n, true) });
    expect((await paint()).full).toBe(true);
    const layout = textFrame(["f", "g", "h", "i", "j"], 6n);
    new DataView(layout).setBigUint64(32, 2n, true);
    dispatch({ type: "frame", packet: layout });
    expect((await paint()).full).toBe(true);
    renderer.renderBatch.mockImplementation(() => []);
  });

  it("isolates glyph pixels and GPU IDs across engines and a dropped session", async () => {
    const scope = {
      onmessage: null as ((event: MessageEvent) => void) | null,
      postMessage: vi.fn(),
      requestAnimationFrame: (callback: FrameRequestCallback): number => {
        callback(performance.now());
        return 1;
      },
    };
    vi.stubGlobal("self", scope);
    await import("./terminal-render.worker.js");
    const dispatch = (data: unknown): void => scope.onmessage?.({ data } as MessageEvent);
    dispatch({ type: "renderer-config", forceCanvasFallback: true });
    for (const handle of ["1", "2"])
      dispatch({
        type: "mount",
        surfaceId: handle,
        sessionHandle: handle,
        canvas: {},
        size: { width: 800, height: 600, dpr: 2 },
      });
    await new Promise((resolve) => setTimeout(resolve, 0));
    dispatch({ type: "frame", packet: oneGlyphFrame(1n, 17) });
    dispatch({ type: "frame", packet: oneGlyphFrame(2n, 231) });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const glyph = (id: string) => {
      const calls = renderer.renderBatch.mock.calls.flatMap(([entries]) => entries);
      const entry = calls.reverse().find((entry) => entry.id === id)!;
      return (
        entry.view as unknown as { glyphDefinitions: Map<number, { id: number; pixels: Uint8Array }> }
      ).glyphDefinitions.get(1)!;
    };
    const first = glyph("1");
    const second = glyph("2");
    expect(first.pixels[0]).toBe(17);
    expect(second.pixels[0]).toBe(231);
    expect(first.id).not.toBe(second.id);
    dispatch({ type: "drop-session", sessionHandle: "1" });
    dispatch({
      type: "mount",
      surfaceId: "1",
      sessionHandle: "1",
      canvas: {},
      size: { width: 800, height: 600, dpr: 2 },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    dispatch({ type: "frame", packet: oneGlyphFrame(1n, 99) });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(glyph("1").pixels[0]).toBe(99);
    expect(glyph("1").id).not.toBe(first.id);
  });

  it.each(["catalog reset", "resync"])(
    "reuses GPU IDs through a direct %s and releases removed glyphs",
    async (kind) => {
      const scope = {
        onmessage: null as ((event: MessageEvent) => void) | null,
        postMessage: vi.fn(),
        requestAnimationFrame: (callback: FrameRequestCallback): number => {
          callback(performance.now());
          return 1;
        },
      };
      vi.stubGlobal("self", scope);
      await import("./terminal-render.worker.js");
      const dispatch = (data: unknown): void => scope.onmessage?.({ data } as MessageEvent);
      const settle = (): Promise<unknown> => new Promise((resolve) => setTimeout(resolve, 0));
      const definitions = () => {
        const entry = renderer.renderBatch.mock.calls.flatMap(([entries]) => entries).at(-1)!;
        return (entry.view as unknown as { glyphDefinitions: Map<number, { id: number }> }).glyphDefinitions;
      };
      const send = async (sequence: bigint, withGlyph = true, epoch = 1n) => {
        const packet = withGlyph ? oneGlyphFrame(11n, 17) : minimalFullFrame(11n, 11n);
        const view = new DataView(packet);
        view.setUint16(6, FrameFlag.FullSnapshot | (kind === "catalog reset" ? FrameFlag.CatalogReset : 0), true);
        view.setBigUint64(24, epoch, true);
        view.setBigUint64(40, sequence, true);
        if (kind === "resync") dispatch({ type: "expect-full", sessionHandle: "11" });
        dispatch({ type: "frame", packet });
        await settle();
      };
      dispatch({ type: "renderer-config", forceCanvasFallback: true });
      dispatch({
        type: "mount",
        surfaceId: "11",
        sessionHandle: "11",
        canvas: {},
        size: { width: 800, height: 600, dpr: 2 },
      });
      await settle();
      await send(1n);
      const firstId = definitions().get(1)!.id;
      for (let sequence = 2n; sequence <= 5n; sequence++) {
        await send(sequence);
        expect(definitions().get(1)!.id).toBe(firstId);
      }
      await send(6n, false);
      expect(definitions().size).toBe(0);
      await send(7n);
      const reintroducedId = definitions().get(1)!.id;
      expect(reintroducedId).not.toBe(firstId);
      // Reusing a handle with a new engine epoch must not reuse its GPU identity.
      await send(1n, true, 2n);
      expect(definitions().get(1)!.id).not.toBe(reintroducedId);
    },
  );

  it("keeps native glyph identity stable across full frames from the same cell", async () => {
    const scope = {
      onmessage: null as ((event: MessageEvent) => void) | null,
      postMessage: vi.fn(),
      requestAnimationFrame: (callback: FrameRequestCallback): number => {
        callback(performance.now());
        return 1;
      },
    };
    const sockets: FakeRoutedSocket[] = [];
    vi.stubGlobal("self", scope);
    vi.stubGlobal(
      "WebSocket",
      class extends FakeRoutedSocket {
        constructor(_url: string) {
          super();
          sockets.push(this);
        }
      },
    );
    await import("./terminal-render.worker.js");
    const dispatch = (data: unknown): void => scope.onmessage?.({ data } as MessageEvent);
    dispatch({ type: "renderer-config", forceCanvasFallback: true });
    dispatch({
      type: "mount",
      surfaceId: "11",
      sessionHandle: "11",
      canvas: {},
      size: { width: 800, height: 600, dpr: 2 },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const protectedBase = {
      v: 1 as const,
      iss: "fieldd" as const,
      alg: "HS256" as const,
      kid: { cellBootId: "cell-a", keyGeneration: 1 },
    };
    const transportGrant = {
      protected: { ...protectedBase, typ: "CellTransportGrant" as const },
      claims: {
        audienceCellBootId: "cell-a",
        clientId: "window-a",
        connectionSetId: "set-a",
        allowedChannels: ["control", "frames"] as const,
        transportGrantGeneration: 1,
        issuedAt: 1,
        expiresAt: 2,
        nonce: "nonce-a",
      },
      mac: "opaque",
    };
    const attachGrant = {
      protected: { ...protectedBase, typ: "SessionAttachGrant" as const },
      claims: {
        audienceCellBootId: "cell-a",
        clientId: "window-a",
        sessionId: "session-a",
        leaseEpoch: 4,
        routeRevision: 1,
        grantGeneration: 1,
        rights: ["input", "read"] as const,
        issuedAt: 1,
        expiresAt: 2,
      },
      mac: "opaque",
    };

    dispatch({
      type: "routed-frames-attach",
      request: {
        cellBootId: "cell-a",
        sessionHandle: "11",
        framesUrl: "ws://127.0.0.1/frames",
        transportGrant,
        attachGrant,
        activationId: "activation-a",
        capabilities: ["resume"],
      },
    });
    const socket = sockets[0]!;
    socket.open();
    socket.receive(
      encodeRoutedMessage("ConnectionAccepted", {
        selectedProtocolVersion: { major: 1, minor: 0 },
        connectionSetId: "set-a",
        channel: "frames",
        legGeneration: 1,
        heartbeatTtlMs: 15_000,
        creditEpoch: 1,
        initialWindows: DEFAULT_ROUTED_RECEIVER_CAPACITIES,
        protocolLimits: DEFAULT_ROUTED_PROTOCOL_LIMITS,
        capabilities: ["resume"],
      }),
    );
    socket.receive(
      encodeRoutedMessage("FramesLegAttached", {
        sessionId: "session-a",
        activationId: "activation-a",
        resumeToken: "resume-a",
        trfIdentity: { sessionHandle: "11", viewHandle: "11" },
        outcome: { kind: "seed-required", reason: "no-cursor" },
      }),
    );

    const ids: number[] = [];
    const stamp = (seq: number) => ({ sceneEpoch: { cellBootId: "cell-a", modelGeneration: 1 }, sceneRevision: seq });
    for (let seq = 1; seq <= 5; seq++) {
      const packet = oneGlyphFrame(11n, 17);
      new DataView(packet).setBigUint64(40, BigInt(seq), true);
      socket.receive(
        encodeRoutedPresentationEnvelope(
          {
            creditEpoch: 1,
            activationSequence: seq,
            sessionId: "session-a",
            activationId: "activation-a",
            leaseEpoch: 4,
            kind: "trf1-frame",
            baseContent: seq === 1 ? null : stamp(seq - 1),
            resultContent: stamp(seq),
          },
          new Uint8Array(packet),
        ).buffer as ArrayBuffer,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
      const entry = renderer.renderBatch.mock.calls
        .flatMap(([entries]) => entries)
        .reverse()
        .find((entry) => entry.id === "11")!;
      const defs = (entry.view as unknown as { glyphDefinitions: Map<number, { id: number }> }).glyphDefinitions;
      ids.push(defs.get(1)!.id);
    }
    socket.close();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(new Set(ids).size).toBe(1);
  });

  it("says a routed session's mouse modes when a committed frame changes them", async () => {
    const scope = {
      onmessage: null as ((event: MessageEvent) => void) | null,
      postMessage: vi.fn(),
      requestAnimationFrame: (callback: FrameRequestCallback): number => {
        callback(performance.now());
        return 1;
      },
    };
    const sockets: FakeRoutedSocket[] = [];
    vi.stubGlobal("self", scope);
    vi.stubGlobal(
      "WebSocket",
      class extends FakeRoutedSocket {
        constructor(_url: string) {
          super();
          sockets.push(this);
        }
      },
    );
    await import("./terminal-render.worker.js");
    const dispatch = (data: unknown): void => scope.onmessage?.({ data } as MessageEvent);
    dispatch({ type: "renderer-config", forceCanvasFallback: true });
    const protectedBase = {
      v: 1 as const,
      iss: "fieldd" as const,
      alg: "HS256" as const,
      kid: { cellBootId: "cell-a", keyGeneration: 1 },
    };
    dispatch({
      type: "routed-frames-attach",
      request: {
        cellBootId: "cell-a",
        sessionHandle: "11",
        framesUrl: "ws://127.0.0.1/frames",
        transportGrant: {
          protected: { ...protectedBase, typ: "CellTransportGrant" as const },
          claims: {
            audienceCellBootId: "cell-a",
            clientId: "window-a",
            connectionSetId: "set-a",
            allowedChannels: ["control", "frames"] as const,
            transportGrantGeneration: 1,
            issuedAt: 1,
            expiresAt: 2,
            nonce: "nonce-a",
          },
          mac: "opaque",
        },
        attachGrant: {
          protected: { ...protectedBase, typ: "SessionAttachGrant" as const },
          claims: {
            audienceCellBootId: "cell-a",
            clientId: "window-a",
            sessionId: "session-a",
            leaseEpoch: 4,
            routeRevision: 1,
            grantGeneration: 1,
            rights: ["input", "read"] as const,
            issuedAt: 1,
            expiresAt: 2,
          },
          mac: "opaque",
        },
        activationId: "activation-a",
        capabilities: ["resume"],
      },
    });
    const socket = sockets[0]!;
    socket.open();
    socket.receive(
      encodeRoutedMessage("ConnectionAccepted", {
        selectedProtocolVersion: { major: 1, minor: 0 },
        connectionSetId: "set-a",
        channel: "frames",
        legGeneration: 1,
        heartbeatTtlMs: 15_000,
        creditEpoch: 1,
        initialWindows: DEFAULT_ROUTED_RECEIVER_CAPACITIES,
        protocolLimits: DEFAULT_ROUTED_PROTOCOL_LIMITS,
        capabilities: ["resume"],
      }),
    );
    socket.receive(
      encodeRoutedMessage("FramesLegAttached", {
        sessionId: "session-a",
        activationId: "activation-a",
        resumeToken: "resume-a",
        trfIdentity: { sessionHandle: "11", viewHandle: "11" },
        outcome: { kind: "seed-required", reason: "no-cursor" },
      }),
    );
    const stamp = (seq: number) => ({ sceneEpoch: { cellBootId: "cell-a", modelGeneration: 1 }, sceneRevision: seq });
    const frame = async (seq: number, mouseTracking: boolean): Promise<void> => {
      const packet = minimalFullFrame(11n, 11n);
      const header = new DataView(packet);
      header.setUint16(6, FrameFlag.FullSnapshot | (mouseTracking ? FrameFlag.MouseTracking : 0), true);
      header.setBigUint64(40, BigInt(seq), true);
      socket.receive(
        encodeRoutedPresentationEnvelope(
          {
            creditEpoch: 1,
            activationSequence: seq,
            sessionId: "session-a",
            activationId: "activation-a",
            leaseEpoch: 4,
            kind: "trf1-frame",
            baseContent: seq === 1 ? null : stamp(seq - 1),
            resultContent: stamp(seq),
          },
          new Uint8Array(packet),
        ).buffer as ArrayBuffer,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    };
    // codex turns mouse reporting on; a second frame with it on says nothing
    // new; turning it off is said too.
    await frame(1, true);
    await frame(2, true);
    await frame(3, false);
    const said = scope.postMessage.mock.calls
      .map(([message]) => message as { type: string })
      .filter((message) => message.type === "terminal-modes");
    expect(said).toEqual([
      { type: "terminal-modes", sessionHandle: "11", mouseTracking: true },
      { type: "terminal-modes", sessionHandle: "11", mouseTracking: false },
    ]);
    socket.close();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

  it("mounts and redraws multiple surfaces backed by one session snapshot", async () => {
    const workerScope = {
      onmessage: null as ((event: MessageEvent) => void) | null,
      postMessage: vi.fn(),
      requestAnimationFrame: (callback: FrameRequestCallback): number => {
        callback(performance.now());
        return 1;
      },
    };
    vi.stubGlobal("self", workerScope);
    await import("./terminal-render.worker.js");
    const dispatch = (data: unknown): void => workerScope.onmessage?.({ data } as MessageEvent);

    dispatch({ type: "renderer-config", forceCanvasFallback: true });
    dispatch({
      type: "mount",
      surfaceId: "view-a",
      sessionHandle: "session",
      canvas: {},
      size: { width: 800, height: 600, dpr: 2 },
    });
    dispatch({
      type: "mount",
      surfaceId: "view-b",
      sessionHandle: "session",
      canvas: {},
      size: { width: 800, height: 600, dpr: 2 },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    dispatch({ type: "force-full-redraw", sessionHandle: "session" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(renderer.mount.mock.calls.map(([surfaceId]) => surfaceId)).toEqual(["view-a", "view-b"]);
    expect(renderer.renderBatch).toHaveBeenCalledWith([
      expect.objectContaining({ id: "view-a" }),
      expect.objectContaining({ id: "view-b" }),
    ]);
  });

  it("passes committed grid dimensions to every surface independently of canvas size", async () => {
    const workerScope = {
      onmessage: null as ((event: MessageEvent) => void) | null,
      postMessage: vi.fn(),
      requestAnimationFrame: (callback: FrameRequestCallback): number => {
        callback(performance.now());
        return 1;
      },
    };
    vi.stubGlobal("self", workerScope);
    await import("./terminal-render.worker.js");
    const dispatch = (data: unknown): void => workerScope.onmessage?.({ data } as MessageEvent);
    const settle = (): Promise<unknown> => new Promise((resolve) => setTimeout(resolve, 0));
    dispatch({ type: "renderer-config", forceCanvasFallback: true });
    dispatch({
      type: "mount",
      surfaceId: "view-a",
      sessionHandle: "11",
      canvas: {},
      size: { width: 800, height: 600, dpr: 2 },
    });
    await settle();
    dispatch({ type: "frame", packet: minimalFullFrame(11n, 12n) });
    await settle();
    expect(renderer.renderBatch).toHaveBeenLastCalledWith([
      expect.objectContaining({
        id: "view-a",
        view: expect.objectContaining({ cols: 80, rows: Array(24).fill("") }),
      }),
    ]);
    dispatch({
      type: "resize",
      surfaceId: "view-a",
      width: 706,
      height: 510,
      dpr: 2,
    });
    await settle();
    expect(renderer.renderBatch).toHaveBeenLastCalledWith([
      expect.objectContaining({
        id: "view-a",
        view: expect.objectContaining({ cols: 80 }),
      }),
    ]);
    const replacement = minimalFullFrame(11n, 12n);
    const header = new DataView(replacement);
    header.setBigUint64(32, 2n, true);
    header.setBigUint64(40, 2n, true);
    header.setUint16(56, 89, true);
    dispatch({ type: "frame", packet: replacement });
    await settle();
    expect(renderer.renderBatch).toHaveBeenLastCalledWith([
      expect.objectContaining({
        id: "view-a",
        view: expect.objectContaining({ cols: 89 }),
      }),
    ]);
  });

  it("keeps shader effects isolated between two surfaces for one session", async () => {
    const workerScope = {
      onmessage: null as ((event: MessageEvent) => void) | null,
      postMessage: vi.fn(),
      requestAnimationFrame: (callback: FrameRequestCallback): number => {
        callback(performance.now());
        return 1;
      },
    };
    vi.stubGlobal("self", workerScope);
    await import("./terminal-render.worker.js");
    const dispatch = (data: unknown): void => workerScope.onmessage?.({ data } as MessageEvent);
    const settle = (): Promise<unknown> => new Promise((resolve) => setTimeout(resolve, 0));
    const localEffects = {
      postProcess: "none",
      shaderEffects: ["ghosttea:vhs"],
      animate: true,
    } as const;
    const configEffects = {
      postProcess: "none",
      shaderEffects: ["ghosttea:crt"],
      animate: false,
    } as const;

    dispatch({ type: "renderer-config", forceCanvasFallback: true });
    dispatch({
      type: "mount",
      surfaceId: "view-local",
      sessionHandle: "session",
      canvas: {},
      size: { width: 800, height: 600, dpr: 2 },
    });
    dispatch({
      type: "mount",
      surfaceId: "view-config",
      sessionHandle: "session",
      canvas: {},
      size: { width: 800, height: 600, dpr: 2 },
    });
    await settle();
    dispatch({ type: "effects", surfaceId: "view-local", sessionHandle: "session", effects: localEffects });
    dispatch({ type: "effects", surfaceId: "view-config", sessionHandle: "session", effects: configEffects });
    await settle();
    renderer.renderBatch.mockClear();

    dispatch({ type: "force-full-redraw", sessionHandle: "session" });
    await settle();

    const entries = renderer.renderBatch.mock.calls.at(-1)?.[0] as
      Array<{ id: string; view: { effects: unknown } }> | undefined;
    expect(entries?.find((entry) => entry.id === "view-local")?.view.effects).toEqual(localEffects);
    expect(entries?.find((entry) => entry.id === "view-config")?.view.effects).toEqual(configEffects);
  });

  it("does not schedule shader animation for an occluded surface", async () => {
    webgpu.enabled = true;
    const animationFrames: FrameRequestCallback[] = [];
    const requestAnimationFrame = vi.fn((callback: FrameRequestCallback): number => {
      animationFrames.push(callback);
      return animationFrames.length;
    });
    const workerScope = {
      onmessage: null as ((event: MessageEvent) => void) | null,
      postMessage: vi.fn(),
      requestAnimationFrame,
    };
    vi.stubGlobal("self", workerScope);
    await import("./terminal-render.worker.js");
    const dispatch = (data: unknown): void => workerScope.onmessage?.({ data } as MessageEvent);
    const settle = (): Promise<unknown> => new Promise((resolve) => setTimeout(resolve, 0));

    dispatch({ type: "renderer-config", forceCanvasFallback: false });
    dispatch({
      type: "mount",
      surfaceId: "hidden-view",
      sessionHandle: "session",
      canvas: {},
      size: { width: 800, height: 600, dpr: 2 },
    });
    await settle();
    expect(workerScope.postMessage).toHaveBeenCalledWith({ type: "renderer-status", backend: "webgpu" });
    while (animationFrames.length > 0) animationFrames.shift()!(performance.now());
    await settle();
    requestAnimationFrame.mockClear();

    dispatch({ type: "visibility", surfaceId: "hidden-view", sessionHandle: "session", visible: false });
    dispatch({ type: "focus", surfaceId: "hidden-view", sessionHandle: "session", focused: true });
    dispatch({
      type: "effects",
      surfaceId: "hidden-view",
      sessionHandle: "session",
      effects: { postProcess: "none", shaderEffects: ["ghosttea:vhs"], animate: true },
    });
    await settle();

    expect(requestAnimationFrame).not.toHaveBeenCalled();
  });

  it("routes redraws through session membership and removes stale memberships", async () => {
    const workerScope = {
      onmessage: null as ((event: MessageEvent) => void) | null,
      postMessage: vi.fn(),
      requestAnimationFrame: (callback: FrameRequestCallback): number => {
        callback(performance.now());
        return 1;
      },
    };
    vi.stubGlobal("self", workerScope);
    await import("./terminal-render.worker.js");
    const dispatch = (data: unknown): void => workerScope.onmessage?.({ data } as MessageEvent);
    const settle = (): Promise<unknown> => new Promise((resolve) => setTimeout(resolve, 0));

    dispatch({ type: "renderer-config", forceCanvasFallback: true });
    dispatch({
      type: "mount",
      surfaceId: "view-a",
      sessionHandle: "session-a",
      canvas: {},
      size: { width: 800, height: 600, dpr: 2 },
    });
    dispatch({
      type: "mount",
      surfaceId: "view-b",
      sessionHandle: "session-a",
      canvas: {},
      size: { width: 800, height: 600, dpr: 2 },
    });
    dispatch({
      type: "mount",
      surfaceId: "view-c",
      sessionHandle: "session-b",
      canvas: {},
      size: { width: 800, height: 600, dpr: 2 },
    });
    await settle();
    renderer.renderBatch.mockClear();

    dispatch({ type: "force-full-redraw", sessionHandle: "session-a" });
    await settle();
    expect(renderer.renderBatch).toHaveBeenLastCalledWith([
      expect.objectContaining({ id: "view-a" }),
      expect.objectContaining({ id: "view-b" }),
    ]);

    renderer.renderBatch.mockClear();
    dispatch({ type: "unmount", surfaceId: "view-a" });
    dispatch({ type: "force-full-redraw", sessionHandle: "session-a" });
    await settle();
    expect(renderer.renderBatch).toHaveBeenLastCalledWith([expect.objectContaining({ id: "view-b" })]);

    renderer.renderBatch.mockClear();
    dispatch({ type: "drop-session", sessionHandle: "session-a" });
    dispatch({ type: "force-full-redraw", sessionHandle: "session-a" });
    await settle();
    expect(renderer.unmount).toHaveBeenCalledWith("view-b");
    expect(renderer.renderBatch).not.toHaveBeenCalled();

    dispatch({ type: "force-full-redraw", sessionHandle: "session-b" });
    await settle();
    expect(renderer.renderBatch).toHaveBeenLastCalledWith([expect.objectContaining({ id: "view-c" })]);
  });

  it("returns byte credits after frame processing and requests full state after a transport gap", async () => {
    const workerScope = {
      onmessage: null as ((event: MessageEvent) => void) | null,
      postMessage: vi.fn(),
      requestAnimationFrame: (callback: FrameRequestCallback): number => {
        callback(performance.now());
        return 1;
      },
    };
    vi.stubGlobal("self", workerScope);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await import("./terminal-render.worker.js");
    const dispatch = (data: unknown): void => workerScope.onmessage?.({ data } as MessageEvent);

    dispatch({ type: "frame-gap", sessionHandles: ["session-a", "session-b"] });
    dispatch({ type: "frame", packet: new ArrayBuffer(7) });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(workerScope.postMessage).toHaveBeenCalledWith({
      type: "frame-resync-needed",
      sessionHandle: "session-a",
    });
    expect(workerScope.postMessage).toHaveBeenCalledWith({
      type: "frame-resync-needed",
      sessionHandle: "session-b",
    });
    expect(workerScope.postMessage).toHaveBeenCalledWith({ type: "frame-credit", bytes: 7 });
    error.mockRestore();
  });

  it.each([
    {
      label: "mismatched TRF1 identity",
      transfer: false,
      full: false,
      targetScrollbackRows: 0,
      rejected: true,
      expectedDecodes: 0,
    },
    {
      label: "non-full transfer snapshot",
      transfer: true,
      full: false,
      targetScrollbackRows: 0,
      rejected: true,
      expectedDecodes: 0,
    },
    {
      label: "mismatched transfer scrollback layout",
      transfer: true,
      full: true,
      targetScrollbackRows: 1,
      rejected: true,
      expectedDecodes: 1,
    },
    {
      label: "full transfer snapshot",
      transfer: true,
      full: true,
      targetScrollbackRows: 0,
      rejected: false,
      expectedDecodes: 1,
    },
  ])(
    "validates a routed $label before mutating a scene",
    async ({ transfer, full, targetScrollbackRows, rejected, expectedDecodes }) => {
      const workerScope = {
        onmessage: null as ((event: MessageEvent) => void) | null,
        postMessage: vi.fn(),
        requestAnimationFrame: (_callback: FrameRequestCallback): number => 1,
      };
      const sockets: FakeRoutedSocket[] = [];
      vi.stubGlobal("self", workerScope);
      vi.stubGlobal(
        "WebSocket",
        class extends FakeRoutedSocket {
          constructor(_url: string) {
            super();
            sockets.push(this);
          }
        },
      );
      await import("./terminal-render.worker.js");
      const dispatch = (data: unknown): void => workerScope.onmessage?.({ data } as MessageEvent);
      const protectedBase = {
        v: 1 as const,
        iss: "fieldd" as const,
        alg: "HS256" as const,
        kid: { cellBootId: "cell-a", keyGeneration: 1 },
      };
      const transportGrant = {
        protected: { ...protectedBase, typ: "CellTransportGrant" as const },
        claims: {
          audienceCellBootId: "cell-a",
          clientId: "window-a",
          connectionSetId: "set-a",
          allowedChannels: ["control", "frames"] as const,
          transportGrantGeneration: 1,
          issuedAt: 1,
          expiresAt: 2,
          nonce: "nonce-a",
        },
        mac: "opaque",
      };
      const attachGrant = {
        protected: { ...protectedBase, typ: "SessionAttachGrant" as const },
        claims: {
          audienceCellBootId: "cell-a",
          clientId: "window-a",
          sessionId: "session-a",
          leaseEpoch: 4,
          routeRevision: 1,
          grantGeneration: 1,
          rights: ["input", "read"] as const,
          issuedAt: 1,
          expiresAt: 2,
        },
        mac: "opaque",
      };

      dispatch({
        type: "routed-frames-attach",
        request: {
          cellBootId: "cell-a",
          sessionHandle: "11",
          framesUrl: "ws://127.0.0.1/frames",
          transportGrant,
          attachGrant,
          activationId: "activation-a",
          capabilities: ["resume"],
        },
      });
      const socket = sockets[0]!;
      socket.open();
      socket.receive(
        encodeRoutedMessage("ConnectionAccepted", {
          selectedProtocolVersion: { major: 1, minor: 0 },
          connectionSetId: "set-a",
          channel: "frames",
          legGeneration: 1,
          heartbeatTtlMs: 15_000,
          creditEpoch: 1,
          initialWindows: DEFAULT_ROUTED_RECEIVER_CAPACITIES,
          protocolLimits: DEFAULT_ROUTED_PROTOCOL_LIMITS,
          capabilities: ["resume"],
        }),
      );
      socket.receive(
        encodeRoutedMessage("FramesLegAttached", {
          sessionId: "session-a",
          activationId: "activation-a",
          resumeToken: "resume-a",
          trfIdentity: { sessionHandle: "11", viewHandle: "12" },
          outcome: { kind: "seed-required", reason: "no-cursor" },
        }),
      );
      const resultContent = {
        sceneEpoch: { cellBootId: "cell-a", modelGeneration: 1 },
        sceneRevision: 1,
      };
      const packet = new Uint8Array(full ? minimalFullFrame(11n, 12n) : identityOnlyFrame(transfer ? 11n : 99n, 12n));
      if (transfer) {
        socket.receive(
          encodeRoutedPresentationEnvelope(
            {
              creditEpoch: 1,
              activationSequence: 1,
              sessionId: "session-a",
              activationId: "activation-a",
              leaseEpoch: 4,
              kind: "transfer-begin",
              baseContent: null,
              resultContent,
              transfer: {
                transferId: "seed-a",
                kind: "seed",
                totalBytes: packet.byteLength,
                chunkCount: 1,
                targetLayout: { cols: 80, rows: 24, scrollbackRows: targetScrollbackRows },
                checksum: { alg: "crc32c", value: routedCrc32c(packet) },
              },
            },
            new Uint8Array(),
          ).buffer as ArrayBuffer,
        );
        socket.receive(
          encodeRoutedPresentationEnvelope(
            {
              creditEpoch: 1,
              activationSequence: 2,
              sessionId: "session-a",
              activationId: "activation-a",
              leaseEpoch: 4,
              kind: "transfer-chunk",
              transfer: { transferId: "seed-a", chunkIndex: 0, byteOffset: 0 },
            },
            packet,
          ).buffer as ArrayBuffer,
        );
        socket.receive(
          encodeRoutedPresentationEnvelope(
            {
              creditEpoch: 1,
              activationSequence: 3,
              sessionId: "session-a",
              activationId: "activation-a",
              leaseEpoch: 4,
              kind: "transfer-end",
              transfer: { transferId: "seed-a" },
            },
            new Uint8Array(),
          ).buffer as ArrayBuffer,
        );
      } else {
        socket.receive(
          encodeRoutedPresentationEnvelope(
            {
              creditEpoch: 1,
              activationSequence: 1,
              sessionId: "session-a",
              activationId: "activation-a",
              leaseEpoch: 4,
              kind: "trf1-frame",
              baseContent: null,
              resultContent,
            },
            packet,
          ).buffer as ArrayBuffer,
        );
      }
      await Promise.resolve();

      dispatch({ type: "performance-counters", requestId: 8 });
      if (rejected) {
        expect(workerScope.postMessage).toHaveBeenCalledWith({
          type: "routed-frames-event",
          event: expect.objectContaining({
            type: "frames-state",
            activationId: "activation-a",
            state: "failed",
            reason: "PROTOCOL",
          }),
        });
        expect(workerScope.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "frame-committed" }));
        expect(workerScope.postMessage).toHaveBeenCalledWith({
          type: "performance-counters",
          requestId: 8,
          snapshot: expect.objectContaining({
            frames: expect.objectContaining({ received: 1, decodes: expectedDecodes, applies: 0 }),
            sessions:
              expectedDecodes === 0 ? {} : { "11": expect.objectContaining({ received: 1, decodes: 1, applies: 0 }) },
          }),
        });
      } else {
        expect(workerScope.postMessage).toHaveBeenCalledWith(
          expect.objectContaining({ type: "frame-committed", sessionHandle: "11", fullSnapshot: true }),
        );
        expect(workerScope.postMessage).toHaveBeenCalledWith({
          type: "performance-counters",
          requestId: 8,
          snapshot: expect.objectContaining({
            frames: expect.objectContaining({ received: 1, full: 1, decodes: 1, applies: 1 }),
            sessions: { "11": expect.objectContaining({ received: 1, full: 1, decodes: 1, applies: 1 }) },
          }),
        });
      }
    },
  );

  it("reads monotonic production counters without opening a sample window or settling the GPU", async () => {
    const workerScope = {
      onmessage: null as ((event: MessageEvent) => void) | null,
      postMessage: vi.fn(),
      requestAnimationFrame: (_callback: FrameRequestCallback): number => 1,
    };
    vi.stubGlobal("self", workerScope);
    await import("./terminal-render.worker.js");
    for (let requestId = 0; requestId < 10; requestId += 1) {
      workerScope.onmessage?.({ data: { type: "performance-counters", requestId } } as MessageEvent);
      expect(workerScope.postMessage).toHaveBeenCalledWith({
        type: "performance-counters",
        requestId,
        snapshot: expect.objectContaining({
          backend: "starting",
          frames: expect.objectContaining({ received: 0, decodes: 0, applies: 0 }),
          renderer: { queueSubmits: 0, presents: 0 },
          flow: { creditBytesReturned: 0, creditBatchesReturned: 0 },
        }),
      });
    }
    expect(workerScope.postMessage).toHaveBeenCalledTimes(10);
    expect(renderer.render).not.toHaveBeenCalled();
    expect(renderer.renderBatch).not.toHaveBeenCalled();
  });
});
