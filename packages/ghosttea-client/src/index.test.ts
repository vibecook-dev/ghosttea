import { EventEmitter } from "node:events";
import type { Socket } from "node:net";
import { beforeEach, describe, expect, it, vi } from "vitest";

const commands: Record<string, unknown>[] = [];
let socketBehavior: "normal" | "close-during-auth" | "silent-auth" = "normal";
let serverProtocolMinor = 12;
let lastSocket: FakeSocket | undefined;

const config = {
  schemaVersion: 1,
  revision: "config-1",
  compatibility: {
    ghosttyVersion: "1.3.1",
    ghosttyCommit: "332b2aef",
    knownKeyCount: 202,
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
  workspace: { keybindings: [], clearKeybindings: false },
};

const document = {
  schemaVersion: 1,
  revision: "document-1",
  path: "/tmp/config.ghostty",
  exists: true,
  contents: "# exact\r\n",
};

function packet(value: string | object): Buffer {
  const body = Buffer.from(typeof value === "string" ? value : JSON.stringify(value));
  const framed = Buffer.allocUnsafe(4 + body.byteLength);
  framed.writeUInt32LE(body.byteLength, 0);
  framed.set(body, 4);
  return framed;
}

class FakeSocket extends EventEmitter {
  #authenticated = false;

  write(framed: Buffer): boolean {
    const length = framed.readUInt32LE(0);
    const body = framed.subarray(4, 4 + length);
    if (!this.#authenticated) {
      expect(body.toString()).toBe("secret");
      this.#authenticated = true;
      if (socketBehavior === "close-during-auth") queueMicrotask(() => this.emit("close"));
      else if (socketBehavior === "normal") queueMicrotask(() => this.emit("data", packet("ok")));
      return true;
    }
    const command = JSON.parse(body.toString()) as Record<string, unknown>;
    commands.push(command);
    const requestId = command.requestId;
    if (command.type === "hello") {
      queueMicrotask(() =>
        this.emit(
          "data",
          packet({
            requestId,
            type: "hello",
            protocolMajor: 1,
            protocolMinor: serverProtocolMinor,
            serverBuild: "test",
          }),
        ),
      );
    } else if (command.type === "get-config-document") {
      queueMicrotask(() => this.emit("data", packet({ requestId, type: "config-document", document })));
    } else if (command.type === "validate-config-document") {
      queueMicrotask(() =>
        this.emit(
          "data",
          packet({
            requestId,
            type: "config-document-validation",
            documentRevision: "candidate-2",
            config,
          }),
        ),
      );
    } else if (command.type === "replace-config-document") {
      queueMicrotask(() => {
        if (command.expectedRevision === "stale") {
          this.emit("data", packet({ requestId, type: "config-document-conflict", document }));
        } else {
          this.emit(
            "data",
            packet({
              requestId,
              type: "config-document-updated",
              document: { ...document, revision: "document-2", contents: command.contents },
              config,
            }),
          );
        }
      });
    } else if (command.type === "release-session") {
      queueMicrotask(() => this.emit("data", packet({ requestId, type: "session-release", state: "attached" })));
    } else if (command.type === "get-automation-state") {
      queueMicrotask(() =>
        this.emit(
          "data",
          packet({ requestId, type: "automation-state", sessionId: command.sessionId, humanInputEpoch: 4 }),
        ),
      );
    } else if (command.type === "automation-input") {
      queueMicrotask(() =>
        this.emit(
          "data",
          packet({
            requestId,
            type: "automation-input-result",
            sessionId: command.sessionId,
            accepted: true,
            humanInputEpoch: 4,
            inputSequence: 9,
            reason: null,
          }),
        ),
      );
    } else if (command.type === "create-session") {
      const options = command.options as Record<string, unknown>;
      queueMicrotask(() =>
        this.emit(
          "data",
          packet({
            requestId,
            type: "session-created",
            session: {
              id: "created",
              handle: "2",
              executable: options.executable,
              cols: options.cols,
              rows: options.rows,
              exited: false,
              readWrite: true,
              title: null,
              cwd: null,
              bellCount: 0,
              pid: 11,
              createdAtMs: 1,
              exitCode: null,
              exitSignal: null,
              requestedTermination: null,
              exitOutcome: null,
              ownerId: null,
              persistence: options.persistence,
              scrollbackBytes: options.scrollbackBytes ?? 10_000_000,
              activity: {
                kind: "unknown",
                source: "unsupported",
                confidence: "heuristic",
                rootProcessGroupId: null,
                foregroundProcessGroupId: null,
                observedAtMs: 0,
              },
            },
          }),
        ),
      );
    } else if (command.type === "get-session") {
      queueMicrotask(() =>
        this.emit(
          "data",
          packet({
            requestId,
            type: "session",
            session: {
              id: command.sessionId,
              handle: "1",
              executable: "/bin/zsh",
              cols: 80,
              rows: 24,
              exited: false,
              readWrite: true,
              title: null,
              cwd: null,
              bellCount: 0,
              pid: 10,
              createdAtMs: 1,
              exitCode: null,
              exitSignal: null,
              requestedTermination: null,
              exitOutcome: null,
              ownerId: null,
            },
          }),
        ),
      );
    } else if (command.type === "get-remote-session-state" || command.type === "reconnect-remote-session") {
      queueMicrotask(() =>
        this.emit(
          "data",
          packet({
            requestId,
            type: "remote-session-state",
            lifecycleSeq: 4,
            deviceId: "device",
            deviceName: "studio-mac",
            state: "suspended",
            reason: null,
            exit: null,
            attempt: 2,
            nextRetryMs: null,
            lastContactMs: 30_000,
            controller: null,
            controlRevision: 0,
            cols: 80,
            rows: 24,
            layoutEpoch: 1,
            views: [],
          }),
        ),
      );
    } else if (command.type === "close-session-owner") {
      queueMicrotask(() => this.emit("data", packet({ requestId, type: "ok" })));
    } else if (command.type === "terminate") {
      queueMicrotask(() => {
        if (command.sessionId === "missing" || command.sessionId === "classified") {
          this.emit(
            "data",
            packet({
              requestId,
              type: "error",
              message: "unknown session",
              ...(command.sessionId === "classified"
                ? { stage: "spawn", code: "executable-not-found", osError: 2 }
                : {}),
            }),
          );
          return;
        }
        this.emit("data", packet({ requestId, type: "ok" }));
        this.emit(
          "data",
          packet({
            requestId: 0,
            type: "session-exited",
            sessionId: command.sessionId,
            exitCode: null,
            exitSignal: "SIGTERM",
            requestedTermination: command.source,
            exitOutcome: "application-terminated",
          }),
        );
      });
    }
    return true;
  }

  destroy(): this {
    queueMicrotask(() => this.emit("close"));
    return this;
  }
}

vi.mock("node:net", () => ({
  createConnection: vi.fn(() => {
    const socket = new FakeSocket();
    lastSocket = socket;
    queueMicrotask(() => socket.emit("connect"));
    return socket as unknown as Socket;
  }),
}));

import { GhostteaAutomationClient, GhostteaConfigDocumentConflictError } from "./index.js";

describe("GhostteaAutomationClient", () => {
  beforeEach(() => {
    commands.splice(0);
    socketBehavior = "normal";
    serverProtocolMinor = 12;
  });

  it("reads, validates, and compare-and-swaps exact configuration documents", async () => {
    const client = new GhostteaAutomationClient({ controlSocket: "control.sock", authToken: "secret" });
    await expect(client.getConfigDocument()).resolves.toEqual(document);
    await expect(client.validateConfigDocument("# candidate\r\n")).resolves.toMatchObject({
      documentRevision: "candidate-2",
      config: { revision: "config-1" },
    });
    await expect(client.replaceConfigDocument("document-1", "# replacement\r\n")).resolves.toMatchObject({
      document: { revision: "document-2", contents: "# replacement\r\n" },
      config: { revision: "config-1" },
    });
    await expect(client.replaceConfigDocument("stale", "# clobber\r\n")).rejects.toMatchObject({
      name: "GhostteaConfigDocumentConflictError",
      document,
    } satisfies Partial<GhostteaConfigDocumentConflictError>);
    expect(commands.map((command) => command.type)).toEqual([
      "hello",
      "get-config-document",
      "validate-config-document",
      "replace-config-document",
      "replace-config-document",
    ]);
    client.dispose();
  });

  it("rejects document operations locally against an older daemon", async () => {
    serverProtocolMinor = 10;
    const client = new GhostteaAutomationClient({ controlSocket: "control.sock", authToken: "secret" });
    await expect(client.getConfigDocument()).rejects.toThrow("requires protocol 1.11");
    await expect(client.request({ type: "get-config-document" })).rejects.toThrow("requires protocol 1.11");
    expect(commands.map((command) => command.type)).toEqual(["hello"]);
    client.dispose();
  });

  it("never sends remote lifecycle commands to a daemon that predates them", async () => {
    // 1.11 shipped the configuration document API; a daemon there would close
    // the socket on an unknown command rather than answering it.
    serverProtocolMinor = 11;
    const client = new GhostteaAutomationClient({ controlSocket: "control.sock", authToken: "secret" });
    await expect(client.request({ type: "get-remote-session-state", sessionId: "session" })).rejects.toThrow(
      "requires protocol 1.12",
    );
    await expect(client.request({ type: "reconnect-remote-session", sessionId: "session" })).rejects.toThrow(
      "requires protocol 1.12",
    );
    await expect(client.request({ type: "retry-remote-view", sessionId: "session", viewId: "view" })).rejects.toThrow(
      "requires protocol 1.12",
    );
    expect(commands.map((command) => command.type)).toEqual(["hello"]);
    client.dispose();
  });

  it("keeps a configuration-document-era pairing alive on the events 1.11 defined", async () => {
    // The released 1.11 client decodes config events but not lifecycle ones,
    // so the daemon withholds the latter (its own gate). This side of the
    // contract: at a negotiated 1.11 the connection keeps serving config
    // traffic and never puts a 1.12 command on the wire.
    serverProtocolMinor = 11;
    const client = new GhostteaAutomationClient({ controlSocket: "control.sock", authToken: "secret" });
    const announced: unknown[] = [];
    client.on("config-changed", (event) => announced.push(event));
    await client.connect();

    lastSocket?.emit("data", packet({ requestId: 0, type: "config-changed", config }));
    await new Promise((resolve) => queueMicrotask(() => resolve(undefined)));
    expect(announced).toHaveLength(1);
    expect(client.connected).toBe(true);

    await expect(client.request({ type: "get-remote-session-state", sessionId: "session" })).rejects.toThrow(
      "requires protocol 1.12",
    );
    expect(commands.map((command) => command.type)).toEqual(["hello"]);
    expect(client.connected).toBe(true);
    client.dispose();
  });

  it("reconciles remote session state against a daemon that speaks 1.12", async () => {
    const client = new GhostteaAutomationClient({ controlSocket: "control.sock", authToken: "secret" });
    await expect(client.request({ type: "get-remote-session-state", sessionId: "session" })).resolves.toMatchObject({
      type: "remote-session-state",
      state: "suspended",
      deviceName: "studio-mac",
    });
    expect(commands.map((command) => command.type)).toEqual(["hello", "get-remote-session-state"]);
    client.dispose();
  });

  it("closes an application session owner atomically", async () => {
    serverProtocolMinor = 14;
    const client = new GhostteaAutomationClient({ controlSocket: "control.sock", authToken: "secret" });
    await client.closeSessionOwner("tab-a", [{ sessionId: "session", ownerId: "tab-b" }]);
    expect(commands.at(-1)).toMatchObject({
      type: "close-session-owner",
      ownerId: "tab-a",
      transfers: [{ sessionId: "session", ownerId: "tab-b" }],
    });
    client.dispose();
  });

  it("refuses unsafe owner closure against a pre-transfer daemon", async () => {
    serverProtocolMinor = 13;
    const client = new GhostteaAutomationClient({ controlSocket: "control.sock", authToken: "secret" });
    await expect(client.closeSessionOwner("tab-a")).rejects.toThrow("requires protocol 1.14");
    expect(commands.map((command) => command.type)).toEqual(["hello"]);
    client.dispose();
  });

  it("gates and validates per-session scrollback before sending create", async () => {
    const options = {
      executable: "/bin/sh",
      args: [],
      cols: 80,
      rows: 24,
      persistence: "keep-until-exit" as const,
    };
    serverProtocolMinor = 14;
    const legacy = new GhostteaAutomationClient({ controlSocket: "control.sock", authToken: "secret" });
    await expect(legacy.createSession({ ...options, scrollbackBytes: 0 })).rejects.toThrow("requires protocol 1.15");
    expect(legacy.serverProtocolMinor).toBe(14);
    expect(legacy.structuredErrorsSupported).toBe(false);
    expect(commands.map((command) => command.type)).toEqual(["hello"]);
    legacy.dispose();

    commands.splice(0);
    serverProtocolMinor = 16;
    const current = new GhostteaAutomationClient({ controlSocket: "control.sock", authToken: "secret" });
    await expect(current.createSession({ ...options, scrollbackBytes: 0 })).resolves.toMatchObject({
      scrollbackBytes: 0,
    });
    expect(current.serverProtocolMinor).toBe(16);
    expect(current.structuredErrorsSupported).toBe(true);
    await expect(current.createSession({ ...options, scrollbackBytes: Number.MAX_SAFE_INTEGER + 1 })).rejects.toThrow(
      "safe integer",
    );
    expect(commands.filter((command) => command.type === "create-session")).toHaveLength(1);
    current.dispose();
  });

  it("refuses conditional release and correlated creation before lifecycle protocol 1.18", async () => {
    serverProtocolMinor = 17;
    const client = new GhostteaAutomationClient({ controlSocket: "control.sock", authToken: "secret" });
    await expect(client.releaseSession("session", "unused")).rejects.toThrow("requires protocol 1.18");
    await expect(
      client.createSession({ executable: "/bin/sh", args: [], cols: 80, rows: 24, creationId: "birth" }),
    ).rejects.toThrow("requires protocol 1.18");
    expect(commands.map((command) => command.type)).toEqual(["hello"]);
    client.dispose();
  });

  it("returns the owner's conditional release decision without converting attachment into a kill", async () => {
    serverProtocolMinor = 18;
    const client = new GhostteaAutomationClient({ controlSocket: "control.sock", authToken: "secret" });
    await expect(client.releaseSession("session", "unused")).resolves.toBe("attached");
    expect(commands.at(-1)).toMatchObject({ type: "release-session", sessionId: "session", condition: "unused" });
    client.dispose();
  });

  it("surfaces structured daemon error metadata", async () => {
    serverProtocolMinor = 16;
    const client = new GhostteaAutomationClient({ controlSocket: "control.sock", authToken: "secret" });
    await expect(client.terminate("classified")).rejects.toMatchObject({
      name: "Error",
      message: "unknown session",
      stage: "spawn",
      code: "executable-not-found",
      osError: 2,
    });
    expect(client.serverProtocolMinor).toBe(16);
    expect(client.structuredErrorsSupported).toBe(true);
    client.dispose();
    expect(client.serverProtocolMinor).toBeUndefined();
    expect(client.structuredErrorsSupported).toBe(false);
  });

  it("sends epoch-gated automation without claiming view authority", async () => {
    const client = new GhostteaAutomationClient({ controlSocket: "control.sock", authToken: "secret" });
    const result = await client.pasteAndSubmit("session", "hello");
    expect(result).toMatchObject({ accepted: true, humanInputEpoch: 4, inputSequence: 9 });
    expect(commands.map((command) => command.type)).toEqual(["hello", "get-automation-state", "automation-input"]);
    expect(commands[2]).toMatchObject({
      sessionId: "session",
      expectedHumanInputEpoch: 4,
      operation: { kind: "paste", text: "hello", submit: true },
    });
    expect(commands.some((command) => command.type === "attach-session" || command.type === "focus-and-resize")).toBe(
      false,
    );
    client.dispose();
  });

  it("rejects an authentication close and reconnects cleanly", async () => {
    const client = new GhostteaAutomationClient({ controlSocket: "control.sock", authToken: "secret" });
    socketBehavior = "close-during-auth";
    await expect(client.connect()).rejects.toThrow("closed during authentication");

    socketBehavior = "normal";
    await expect(client.connect()).resolves.toBeUndefined();
    expect(commands.map((command) => command.type)).toEqual(["hello"]);
    client.dispose();
  });

  it("times out a silent authentication peer and reconnects cleanly", async () => {
    const client = new GhostteaAutomationClient(
      { controlSocket: "control.sock", authToken: "secret" },
      { connectTimeoutMs: 5 },
    );
    socketBehavior = "silent-auth";
    await expect(client.connect()).rejects.toThrow("timed out during authentication");

    socketBehavior = "normal";
    await expect(client.connect()).resolves.toBeUndefined();
    expect(commands.map((command) => command.type)).toEqual(["hello"]);
    client.dispose();
  });

  it("waits for rich exit metadata when terminating a session", async () => {
    const client = new GhostteaAutomationClient({ controlSocket: "control.sock", authToken: "secret" });
    await expect(client.terminateAndWait("session")).resolves.toMatchObject({
      sessionId: "session",
      requestedTermination: "application",
      exitOutcome: "application-terminated",
    });
    expect(commands.map((command) => command.type)).toEqual(["hello", "get-session", "terminate"]);
    client.dispose();
  });

  it("cancels the exit waiter when termination is rejected", async () => {
    const client = new GhostteaAutomationClient({ controlSocket: "control.sock", authToken: "secret" });
    await expect(client.terminateAndWait("missing", "application", 50)).rejects.toThrow("unknown session");
    expect(client.listenerCount("session-exited")).toBe(0);
    client.dispose();
  });
});
