import { describe, expect, it } from "vitest";
import { isRendererClientCommandAllowed, isServerEvent, terminalLinkUrl, unknownSessionActivity } from "./index";

describe("isServerEvent forward compatibility", () => {
  it("tolerates fields it has never heard of, so an additive daemon change is not fatal", () => {
    // A rejected event destroys the socket, so anything the daemon may add
    // later has to pass a client that predates it.
    expect(isServerEvent({ requestId: 1, type: "selection-text", text: "copied", unheardOf: { nested: 1 } })).toBe(
      true,
    );
    expect(isServerEvent({ requestId: 1, type: "selection-text", text: "copied", scope: "viewport" })).toBe(true);
    // Including a value of a field it does know, added after this client shipped.
    expect(isServerEvent({ requestId: 1, type: "selection-text", text: "copied", scope: "command-output" })).toBe(true);
    expect(isServerEvent({ requestId: 0, type: "session-activity-changed", sessionId: "s", activity: undefined })).toBe(
      false,
    );
  });
});

describe("isServerEvent", () => {
  it("allows reviewed renderer commands and rejects privileged or unknown commands", () => {
    expect(isRendererClientCommandAllowed({ requestId: 1, type: "get-config" })).toBe(true);
    expect(isRendererClientCommandAllowed({ requestId: 2, type: "replace-config-document" })).toBe(false);
    expect(isRendererClientCommandAllowed({ requestId: 3, type: "future-command" })).toBe(false);
    expect(isRendererClientCommandAllowed({ requestId: 4, type: "reconnect-remote-session" })).toBe(true);
    expect(isRendererClientCommandAllowed({ requestId: 5, type: "get-remote-session-state" })).toBe(true);
    expect(isRendererClientCommandAllowed({ requestId: 6, type: "retry-remote-view" })).toBe(true);
  });

  const config = {
    schemaVersion: 1,
    revision: "abc123",
    compatibility: {
      ghosttyVersion: "1.3.1",
      ghosttyCommit: "f8041e7",
      knownKeyCount: 200,
    },
    sources: [{ path: "/tmp/config.ghostty", kind: "ghosttea-overlay" }],
    diagnostics: [],
    configuredKeys: [{ key: "background", support: "applied", occurrences: 1 }],
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
  const document = {
    schemaVersion: 1,
    revision: "raw-123",
    path: "/tmp/config.ghostty",
    exists: true,
    contents: "# exact comment\r\nbackground = 112233\r\n",
  };
  const lifecycle = {
    sessionId: "session",
    lifecycleSeq: 7,
    deviceId: "device",
    deviceName: "studio-mac",
    state: "reconnecting",
    reason: null,
    exit: null,
    attempt: 3,
    nextRetryMs: 4_000,
    lastContactMs: 12_000,
  };
  const viewRecord = {
    viewId: "view",
    viewStateSeq: 12,
    viewState: "attached",
    attachmentEpoch: 9,
    readWrite: true,
    error: null,
    retryable: null,
  };
  const controlFields = {
    controller: { viewId: "view", controlEpoch: 5 },
    controlRevision: 17,
    cols: 120,
    rows: 40,
    layoutEpoch: 3,
  };
  const controlState = { sessionId: "session", ...controlFields };
  const remoteSessionState = { ...lifecycle, ...controlFields, views: [viewRecord] };

  it("accepts validated responses and unsolicited lifecycle events", () => {
    expect(
      isServerEvent({ requestId: 1, type: "hello", protocolMajor: 1, protocolMinor: 0, serverBuild: "test" }),
    ).toBe(true);
    expect(
      isServerEvent({
        requestId: 0,
        type: "session-exited",
        sessionId: "session",
        exitCode: 0,
        exitSignal: null,
        requestedTermination: null,
        exitOutcome: "completed",
      }),
    ).toBe(true);
    expect(isServerEvent({ requestId: 4, type: "config", config })).toBe(true);
    expect(isServerEvent({ requestId: 0, type: "config-changed", config })).toBe(true);
    expect(isServerEvent({ requestId: 5, type: "config-document", document })).toBe(true);
    expect(
      isServerEvent({
        requestId: 6,
        type: "config-document-validation",
        documentRevision: "candidate-456",
        config,
      }),
    ).toBe(true);
    expect(isServerEvent({ requestId: 7, type: "config-document-updated", document, config })).toBe(true);
    expect(isServerEvent({ requestId: 8, type: "config-document-conflict", document })).toBe(true);
    expect(
      isServerEvent({
        requestId: 0,
        type: "session-activity-changed",
        sessionId: "session",
        activity: {
          kind: "foreground-job",
          source: "process-group",
          confidence: "heuristic",
          rootProcessGroupId: 42,
          foregroundProcessGroupId: 43,
          observedAtMs: 100,
        },
      }),
    ).toBe(true);
    expect(isServerEvent({ requestId: 0, type: "bridge-error", message: "disconnected" })).toBe(true);
    expect(
      isServerEvent({
        requestId: 9,
        type: "error",
        message: "failed to spawn PTY command",
        stage: "spawn",
        code: "executable-not-found",
        osError: 2,
      }),
    ).toBe(true);
    expect(isServerEvent({ requestId: 0, type: "remote-session-state-changed", ...lifecycle })).toBe(true);
    // A fresh remote open is reported as `opening` until its first snapshot.
    expect(isServerEvent({ requestId: 0, type: "remote-session-state-changed", ...lifecycle, state: "opening" })).toBe(
      true,
    );
    expect(
      isServerEvent({ requestId: 12, type: "remote-session-state", ...remoteSessionState, state: "opening" }),
    ).toBe(true);
    expect(
      isServerEvent({
        requestId: 0,
        type: "remote-session-state-changed",
        ...lifecycle,
        state: "ended",
        reason: "session-exited",
        exit: { code: 1 },
      }),
    ).toBe(true);
    expect(isServerEvent({ requestId: 0, type: "view-state-changed", sessionId: "session", ...viewRecord })).toBe(true);
    expect(
      isServerEvent({
        requestId: 0,
        type: "view-state-changed",
        sessionId: "session",
        ...viewRecord,
        viewState: "failed",
        attachmentEpoch: null,
        readWrite: null,
        error: "view-invalid",
        retryable: true,
      }),
    ).toBe(true);
    // Both outcomes of a compare-and-swap claim, exactly as the daemon writes
    // them. An answer this client could not decode would destroy the socket.
    expect(
      isServerEvent({
        requestId: 7,
        type: "control-claimed",
        sessionId: "session",
        controllerViewId: "view",
        controlEpoch: 5,
        controlRevision: 18,
        cols: 120,
        rows: 40,
        layoutEpoch: 3,
      }),
    ).toBe(true);
    expect(
      isServerEvent({
        requestId: 8,
        type: "control-rejected",
        sessionId: "session",
        controller: { viewId: "view-2", controlEpoch: 6 },
        controlRevision: 19,
        cols: 120,
        rows: 40,
        layoutEpoch: 3,
      }),
    ).toBe(true);
    // The retryable rejection: nobody holds control at a newer revision.
    expect(
      isServerEvent({
        requestId: 9,
        type: "control-rejected",
        sessionId: "session",
        controller: null,
        controlRevision: 20,
        cols: 120,
        rows: 40,
        layoutEpoch: 3,
      }),
    ).toBe(true);
    expect(isServerEvent({ requestId: 0, type: "control-state", ...controlState })).toBe(true);
    expect(isServerEvent({ requestId: 0, type: "control-state", ...controlState, controller: null })).toBe(true);
    expect(isServerEvent({ requestId: 9, type: "remote-session-state", ...remoteSessionState })).toBe(true);
    expect(isServerEvent({ requestId: 10, type: "view-state", sessionId: "session", ...viewRecord })).toBe(true);
    expect(
      isServerEvent({
        requestId: 11,
        type: "view-attached",
        sessionId: "session",
        viewId: "view",
        attachmentEpoch: 4,
        readWrite: true,
        viewStateSeq: 12,
      }),
    ).toBe(true);
    expect(
      isServerEvent({
        requestId: 0,
        type: "control-changed",
        sessionId: "session",
        controllerViewId: "view",
        controlEpoch: 2,
        cols: 120,
        rows: 40,
        layoutEpoch: 3,
      }),
    ).toBe(true);
    expect(
      isServerEvent({
        requestId: 3,
        type: "automation-input-result",
        sessionId: "session",
        accepted: false,
        humanInputEpoch: 7,
        inputSequence: null,
        reason: "human-input-conflict",
      }),
    ).toBe(true);
    expect(
      isServerEvent({
        requestId: 2,
        type: "remote-hosts",
        hosts: [
          {
            deviceId: "device-a",
            deviceName: "Studio",
            online: true,
            protocolMajor: 1,
            protocolMinor: 0,
            hostInstanceId: "host-a",
            sessions: [
              {
                sessionId: "session-a",
                title: "codex",
                cwdLabel: "/work",
                running: true,
                attachable: true,
                readWrite: false,
                createdAtMs: 42,
              },
            ],
          },
        ],
      }),
    ).toBe(true);
  });

  it("normalizes activity omitted by an older peer to unknown", () => {
    const message = {
      requestId: 1,
      type: "sessions",
      sessions: [
        {
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
          pid: 42,
          createdAtMs: 1,
          exitCode: null,
          exitSignal: null,
          requestedTermination: null,
          exitOutcome: null,
          ownerId: null,
        },
      ],
    };

    expect(isServerEvent(message)).toBe(true);
    expect(message.sessions[0]).toMatchObject({ activity: unknownSessionActivity() });
  });

  it("accepts absent legacy, null replica, and safe local scrollback echoes", () => {
    const base = {
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
      pid: 42,
      createdAtMs: 1,
      exitCode: null,
      exitSignal: null,
      requestedTermination: null,
      exitOutcome: null,
      ownerId: null,
    };
    for (const session of [base, { ...base, scrollbackBytes: null }, { ...base, scrollbackBytes: 0 }]) {
      expect(isServerEvent({ requestId: 1, type: "session", session })).toBe(true);
    }
    expect(
      isServerEvent({
        requestId: 1,
        type: "session",
        session: { ...base, scrollbackBytes: Number.MAX_SAFE_INTEGER + 1 },
      }),
    ).toBe(false);
  });

  it("rejects unknown and structurally incomplete messages", () => {
    expect(isServerEvent({ requestId: 1, type: "surprise" })).toBe(false);
    expect(isServerEvent({ requestId: 1.5, type: "ok" })).toBe(false);
    expect(isServerEvent({ requestId: 1, type: "error", message: "no", osError: 1.5 })).toBe(false);
    expect(isServerEvent({ requestId: 1, type: "session", session: { id: "missing-fields" } })).toBe(false);
    expect(isServerEvent({ requestId: 0, type: "session-exited", sessionId: 3, exitCode: null })).toBe(false);
    expect(isServerEvent({ requestId: 2, type: "remote-sessions", deviceId: "device-a", sessions: [{}] })).toBe(false);
    expect(
      isServerEvent({
        requestId: 0,
        type: "config-changed",
        config: { ...config, renderer: { ...config.renderer, postProcess: "mystery" } },
      }),
    ).toBe(false);
    expect(isServerEvent({ requestId: 4, type: "config", config: { ...config, schemaVersion: 2 } })).toBe(false);
    expect(
      isServerEvent({
        requestId: 5,
        type: "config-document",
        document: { ...document, schemaVersion: 2 },
      }),
    ).toBe(false);
    expect(
      isServerEvent({
        requestId: 6,
        type: "config-document-validation",
        documentRevision: 7,
        config,
      }),
    ).toBe(false);
    expect(
      isServerEvent({
        requestId: 0,
        type: "session-activity-changed",
        sessionId: "session",
        activity: {
          kind: "idle",
          source: "process-group",
          confidence: "heuristic",
          rootProcessGroupId: 42,
          foregroundProcessGroupId: 42,
          observedAtMs: 100,
        },
      }),
    ).toBe(false);
    expect(isServerEvent({ requestId: 0, type: "remote-session-state-changed", ...lifecycle, state: "dozing" })).toBe(
      false,
    );
    expect(isServerEvent({ requestId: 0, type: "remote-session-state-changed", ...lifecycle, reason: "bored" })).toBe(
      false,
    );
    expect(
      isServerEvent({ requestId: 0, type: "remote-session-state-changed", ...lifecycle, deviceName: undefined }),
    ).toBe(false);
    expect(
      isServerEvent({
        requestId: 0,
        type: "view-state-changed",
        sessionId: "session",
        ...viewRecord,
        viewStateSeq: "1",
      }),
    ).toBe(false);
    expect(
      isServerEvent({
        requestId: 0,
        type: "view-state-changed",
        sessionId: "session",
        ...viewRecord,
        viewState: "gone",
      }),
    ).toBe(false);
    expect(
      isServerEvent({ requestId: 0, type: "control-state", ...controlState, controller: { viewId: "view" } }),
    ).toBe(false);
    expect(isServerEvent({ requestId: 9, type: "remote-session-state", ...remoteSessionState, views: [{}] })).toBe(
      false,
    );
    expect(
      isServerEvent({
        requestId: 11,
        type: "view-attached",
        sessionId: "session",
        viewId: "view",
        attachmentEpoch: 4,
        readWrite: true,
        viewStateSeq: null,
      }),
    ).toBe(false);
  });
});

describe("terminalLinkUrl", () => {
  it.each([
    ["https://example.com", "https://example.com/"],
    ["mailto:team@example.com", "mailto:team@example.com"],
    ["file:///tmp/source.ts", "file:///tmp/source.ts"],
    ["file:///tmp/my%20project/source.ts#L42", "file:///tmp/my%20project/source.ts#L42"],
    ["file://localhost/tmp/source.ts", "file:///tmp/source.ts"],
    ["file://workstation/tmp/source.ts", "file://workstation/tmp/source.ts"],
  ])("accepts and normalizes %s", (input, expected) => {
    expect(terminalLinkUrl(input)).toBe(expected);
  });

  it.each([
    "javascript:alert(1)",
    "data:text/html,hello",
    "file:relative.ts",
    "file:/tmp/source.ts",
    "/tmp/source.ts",
    "https://example.com/\n",
  ])("rejects %s", (input) => {
    expect(terminalLinkUrl(input)).toBeNull();
  });
});
