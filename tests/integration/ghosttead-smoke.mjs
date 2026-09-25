import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { GhostteaAutomationClient, GhostteaConfigDocumentConflictError } from "@vibecook/ghosttea-client";
import { localEndpoints } from "../../bench/lib/ipc-endpoints.mjs";

if (process.platform === "win32") {
  // The transport itself is covered on Windows by the `ipc` tests in the
  // ghosttea crate. This fixture additionally drives POSIX shells and python3
  // and asserts signal-based exit semantics, so porting it needs a
  // platform-specific fixture rather than substituted paths.
  console.log("SKIP ghosttead smoke: the session fixture requires a POSIX shell");
  process.exit(0);
}

const root = resolve(import.meta.dirname, "../..");
const runtimeDir = mkdtempSync(join(tmpdir(), "ghosttead-smoke-"));
const { controlSocket, frameSocket } = localEndpoints(runtimeDir);
const configPath = join(runtimeDir, "config.ghostty");
writeFileSync(
  configPath,
  "scrollback-limit = 123456\ncustom-shader = ghosttea:better-crt\nkeybind = clear\nkeybind = super+t=previous_tab\n",
  "utf8",
);
const token = "smoke-test-token";
const child = spawn("cargo", ["run", "--quiet", "--manifest-path", "native/ghosttead/Cargo.toml"], {
  cwd: root,
  env: {
    ...process.env,
    GHOSTTEA_CONTROL_SOCKET: controlSocket,
    GHOSTTEA_FRAME_SOCKET: frameSocket,
    GHOSTTEA_AUTH_TOKEN: token,
    GHOSTTEA_CONFIG_PATH: configPath,
    GHOSTTEA_TRUFFLE_ENABLED: "0",
    GHOSTTEA_PARENT_WATCH: "1",
  },
  stdio: ["pipe", "pipe", "inherit"],
});
let automationClient;
let testPassed = false;
let parentShutdownError;

function packet(bytes) {
  const body = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const result = Buffer.allocUnsafe(body.length + 4);
  result.writeUInt32LE(body.length);
  result.set(body, 4);
  return result;
}

function packets(socket) {
  const queue = [];
  const waiting = [];
  let buffered = Buffer.alloc(0);
  socket.on("data", (chunk) => {
    buffered = Buffer.concat([buffered, chunk]);
    while (buffered.length >= 4) {
      const length = buffered.readUInt32LE(0);
      if (buffered.length < length + 4) break;
      const body = buffered.subarray(4, length + 4);
      buffered = buffered.subarray(length + 4);
      const waiter = waiting.shift();
      if (waiter) waiter(body);
      else queue.push(body);
    }
  });
  return () =>
    queue.length ? Promise.resolve(queue.shift()) : new Promise((resolvePacket) => waiting.push(resolvePacket));
}

function sections(frame) {
  const result = new Map();
  const count = frame.readUInt16LE(60);
  for (let index = 0; index < count; index += 1) {
    const base = 64 + index * 16;
    const kind = frame.readUInt16LE(base);
    const offset = frame.readUInt32LE(base + 4);
    const length = frame.readUInt32LE(base + 8);
    result.set(kind, frame.subarray(offset, offset + length));
  }
  return result;
}

function scrollbarState(frame) {
  const payload = sections(frame).get(8);
  if (!payload || payload.length !== 24) return null;
  return {
    total: Number(payload.readBigUInt64LE(0)),
    offset: Number(payload.readBigUInt64LE(8)),
    length: Number(payload.readBigUInt64LE(16)),
  };
}

function glyphFormats(frame) {
  const payload = sections(frame).get(1);
  if (!payload) return [];
  const formats = [];
  const count = payload.readUInt32LE(0);
  let offset = 4;
  for (let index = 0; index < count; index += 1) {
    formats.push(payload.readUInt8(offset + 12));
    offset += 20 + payload.readUInt32LE(offset + 16);
  }
  return formats;
}

function rowStyleIds(frame) {
  const payload = sections(frame).get(3);
  if (!payload) return [];
  const styles = [];
  const count = payload.readUInt16LE(0);
  let offset = 2;
  for (let row = 0; row < count; row += 1) {
    const textLength = payload.readUInt32LE(offset + 10);
    const glyphCount = payload.readUInt16LE(offset + 14);
    const styleCount = payload.readUInt16LE(offset + 16);
    offset += 18 + textLength;
    for (let glyph = 0; glyph < glyphCount; glyph += 1) {
      styles.push(payload.readUInt32LE(offset + 4));
      offset += 28;
    }
    offset += styleCount * 8;
  }
  return styles;
}

function terminalStyles(frame) {
  const payload = sections(frame).get(2);
  if (!payload) return [];
  const result = [];
  const count = payload.readUInt32LE(0);
  for (let index = 0; index < count; index += 1) {
    const offset = 4 + index * 16;
    result.push({
      id: payload.readUInt32LE(offset),
      flags: payload.readUInt16LE(offset + 4),
      foregroundKind: payload.readUInt8(offset + 6),
      backgroundKind: payload.readUInt8(offset + 7),
    });
  }
  return result;
}

async function open(path) {
  const socket = connect(path);
  await new Promise((resolveConnected, reject) => {
    socket.once("connect", resolveConnected);
    socket.once("error", reject);
  });
  const next = packets(socket);
  socket.write(packet(token));
  const response = await next();
  if (response.toString() !== "ok") throw new Error("authentication failed");
  return { socket, next };
}

async function withTimeout(promise, label, timeoutMs = 5_000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function nextControlResponse(control, requestId) {
  for (;;) {
    const message = JSON.parse((await withTimeout(control.next(), `control response ${requestId}`)).toString());
    if (message.requestId === requestId) return message;
  }
}

async function nextControlEvent(control, type, predicate = () => true) {
  for (;;) {
    const message = JSON.parse((await withTimeout(control.next(), `control event ${type}`)).toString());
    if (message.requestId === 0 && message.type === type && predicate(message)) return message;
  }
}

function nextInput(view) {
  view.inputSequence += 1;
  return {
    viewId: view.viewId,
    attachmentEpoch: view.attachmentEpoch,
    inputSequence: view.inputSequence,
  };
}

function nextResize(view) {
  view.resizeSequence += 1;
  return {
    viewId: view.viewId,
    attachmentEpoch: view.attachmentEpoch,
    controlEpoch: view.controlEpoch,
    resizeSequence: view.resizeSequence,
  };
}

try {
  await withTimeout(
    new Promise((resolveReady, reject) => {
      child.stdout.on("data", (chunk) => {
        if (String(chunk).includes("ghosttead ready")) resolveReady();
      });
      child.once("exit", (code) => reject(new Error(`ghosttead exited early (${code})`)));
    }),
    "ghosttead startup",
    60_000,
  );

  automationClient = new GhostteaAutomationClient({ controlSocket, authToken: token });
  const initialConfig = await automationClient.getConfig();
  if (
    initialConfig.schemaVersion !== 1 ||
    initialConfig.compatibility.ghosttyVersion !== "1.3.1" ||
    initialConfig.terminal.scrollbackBytes !== 123_456 ||
    initialConfig.renderer.postProcess !== "better-crt" ||
    !initialConfig.workspace.clearKeybindings ||
    initialConfig.workspace.keybindings[0]?.action !== "previous_tab"
  ) {
    throw new Error(`shared configuration was not projected: ${JSON.stringify(initialConfig)}`);
  }
  const initialDocument = await automationClient.getConfigDocument();
  if (!initialDocument.exists || !initialDocument.contents.includes("custom-shader = ghosttea:better-crt")) {
    throw new Error(`raw configuration document was not preserved: ${JSON.stringify(initialDocument)}`);
  }
  const replacementContents = [
    "# This comment and the CRLF line endings must survive exactly.",
    "future-ghostty-option = preserved",
    "scrollback-limit = 654321",
    "",
  ].join("\r\n");
  const validation = await automationClient.validateConfigDocument(replacementContents);
  if (
    validation.config.terminal.scrollbackBytes !== 654_321 ||
    !validation.config.diagnostics.some((diagnostic) => diagnostic.code === "unknown-key") ||
    validation.documentRevision === initialDocument.revision
  ) {
    throw new Error(`configuration candidate was not validated: ${JSON.stringify(validation)}`);
  }

  const externalContents = "# changed outside the API\nscrollback-limit = 222222\n";
  writeFileSync(configPath, externalContents, "utf8");
  let conflictDocument;
  try {
    await automationClient.replaceConfigDocument(initialDocument.revision, "scrollback-limit = 999999\n");
    throw new Error("stale configuration replacement unexpectedly succeeded");
  } catch (error) {
    if (!(error instanceof GhostteaConfigDocumentConflictError)) throw error;
    conflictDocument = error.document;
  }
  if (conflictDocument.contents !== externalContents) {
    throw new Error(`configuration conflict did not return current contents: ${JSON.stringify(conflictDocument)}`);
  }

  const configChanged = new Promise((resolveChanged) => {
    automationClient.once("config-changed", resolveChanged);
  });
  const update = await automationClient.replaceConfigDocument(conflictDocument.revision, replacementContents);
  const reloadedConfig = await automationClient.reloadConfig();
  const pushedConfig = await withTimeout(configChanged, "config-changed event");
  if (
    reloadedConfig.revision === initialConfig.revision ||
    reloadedConfig.terminal.scrollbackBytes !== 654_321 ||
    reloadedConfig.renderer.postProcess !== "none" ||
    reloadedConfig.workspace.clearKeybindings ||
    reloadedConfig.workspace.keybindings.length !== 0 ||
    pushedConfig.config.revision !== reloadedConfig.revision ||
    update.config.revision !== reloadedConfig.revision ||
    update.document.contents !== replacementContents ||
    (await automationClient.getConfigDocument()).contents !== replacementContents
  ) {
    throw new Error(
      `shared configuration document did not replace and reload: ${JSON.stringify({
        reloadedConfig,
        pushedConfig,
        update,
      })}`,
    );
  }
  const automatedSession = await automationClient.createSession({
    executable: "/bin/sh",
    args: [],
    environment: { mode: "clean", variables: { PATH: process.env.PATH ?? "/usr/bin:/bin" } },
    cols: 40,
    rows: 8,
    persistence: "terminate-with-app",
  });
  const automatedExit = automationClient.waitForExit(automatedSession.id, 5_000);
  const automatedInput = await automationClient.pasteAndSubmit(
    automatedSession.id,
    "printf 'ghosttea-node-client-ok\\n'; exit 0",
  );
  if (!automatedInput.accepted) throw new Error("Node client automation input was rejected");
  const automatedExitEvent = await automatedExit;
  if (automatedExitEvent.exitCode !== 0 || automatedExitEvent.exitOutcome !== "completed") {
    throw new Error(`Node client observed incorrect exit metadata: ${JSON.stringify(automatedExitEvent)}`);
  }

  const control = await open(controlSocket);
  const frames = await open(frameSocket);
  const frameHandles = new Set();
  const pendingFrameSubscriptions = new Set();
  const nextFrameChannelPacket = frames.next;
  frames.next = async () => {
    for (;;) {
      const candidate = await nextFrameChannelPacket();
      if (candidate.length >= 4 && candidate.readUInt32LE(0) === 0x31465254) return candidate;
      let message;
      try {
        message = JSON.parse(candidate.toString());
      } catch {
        throw new Error("ghosttead emitted an invalid frame-channel packet");
      }
      if (message.type === "subscription-ack" && pendingFrameSubscriptions.delete(message.requestId)) continue;
      if (message.type === "frame-gap") {
        throw new Error(`ghosttead dropped ${message.skipped} frame(s) during the integration smoke test`);
      }
      throw new Error(`ghosttead emitted an unexpected frame-channel message: ${JSON.stringify(message)}`);
    }
  };
  let frameSubscriptionRequestId = 1;
  const subscribeFrames = (handle) => {
    frameHandles.add(handle);
    const requestId = frameSubscriptionRequestId++;
    pendingFrameSubscriptions.add(requestId);
    frames.socket.write(
      packet(
        JSON.stringify({
          type: "subscribe",
          requestId,
          sessionHandles: [...frameHandles],
        }),
      ),
    );
  };
  control.socket.write(
    packet(
      JSON.stringify({
        requestId: 1,
        type: "create-session",
        options: {
          executable: "/bin/sh",
          args: [],
          env: {},
          cols: 80,
          rows: 20,
          persistence: "terminate-with-app",
          programKind: "interactive-shell",
        },
      }),
    ),
  );
  const created = await nextControlResponse(control, 1);
  if (created.type !== "session-created") throw new Error(`create failed: ${JSON.stringify(created)}`);
  subscribeFrames(created.session.handle);
  if (
    !Number.isInteger(created.session.pid) ||
    created.session.pid <= 0 ||
    !Number.isInteger(created.session.createdAtMs)
  ) {
    throw new Error(`session lifecycle metadata missing: ${JSON.stringify(created.session)}`);
  }
  if (
    created.session.exitCode !== null ||
    created.session.exitSignal !== null ||
    created.session.requestedTermination !== null ||
    created.session.exitOutcome !== null
  ) {
    throw new Error("running session reported exit metadata");
  }
  if (
    created.session.activity?.kind !== "shell-idle" ||
    created.session.activity.source !== "process-group" ||
    created.session.activity.confidence !== "heuristic" ||
    !Number.isInteger(created.session.activity.rootProcessGroupId) ||
    created.session.activity.rootProcessGroupId !== created.session.activity.foregroundProcessGroupId
  ) {
    throw new Error(`interactive shell activity metadata was incorrect: ${JSON.stringify(created.session.activity)}`);
  }
  const primaryView = {
    viewId: "smoke-primary",
    attachmentEpoch: 0,
    inputSequence: 0,
    resizeSequence: 0,
    controlEpoch: 0,
  };
  control.socket.write(
    packet(
      JSON.stringify({
        requestId: 2,
        type: "attach-session",
        sessionId: created.session.id,
        viewId: primaryView.viewId,
      }),
    ),
  );
  const attached = await nextControlResponse(control, 2);
  if (attached.type !== "view-attached") throw new Error(`attach failed: ${JSON.stringify(attached)}`);
  primaryView.attachmentEpoch = attached.attachmentEpoch;
  const activityControl = await open(controlSocket);
  activityControl.socket.write(
    packet(
      JSON.stringify({
        requestId: 1,
        type: "hello",
        protocolMajor: 1,
        protocolMinor: 6,
        clientBuild: "activity-smoke",
      }),
    ),
  );
  const activityHello = await nextControlResponse(activityControl, 1);
  if (activityHello.type !== "hello" || activityHello.protocolMinor < 6) {
    throw new Error(`activity protocol negotiation failed: ${JSON.stringify(activityHello)}`);
  }
  control.socket.write(
    packet(
      JSON.stringify({
        requestId: 3,
        type: "send-text",
        sessionId: created.session.id,
        ...nextInput(primaryView),
        text: "sleep 1\r",
      }),
    ),
  );
  await nextControlResponse(control, 3);
  const foregroundActivity = await nextControlEvent(
    activityControl,
    "session-activity-changed",
    (event) => event.sessionId === created.session.id && event.activity?.kind === "foreground-job",
  );
  if (foregroundActivity.activity.foregroundProcessGroupId === foregroundActivity.activity.rootProcessGroupId) {
    throw new Error(`foreground process group was not exposed: ${JSON.stringify(foregroundActivity.activity)}`);
  }
  await nextControlEvent(
    activityControl,
    "session-activity-changed",
    (event) => event.sessionId === created.session.id && event.activity?.kind === "shell-idle",
  );
  activityControl.socket.end();
  control.socket.write(
    packet(
      JSON.stringify({
        requestId: 4,
        type: "send-text",
        sessionId: created.session.id,
        ...nextInput(primaryView),
        text: "printf 'ghostty-smoke\\n'\r",
      }),
    ),
  );
  await nextControlResponse(control, 4);
  const deadline = Date.now() + 5_000;
  let found = false;
  while (Date.now() < deadline && !found) {
    const frame = await Promise.race([
      frames.next(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("frame timeout")), 5_000)),
    ]);
    if (
      frame.readUInt32LE(0) !== 0x31465254 ||
      frame.readUInt16LE(60) !== 8 ||
      frame.readUInt16LE(64) !== 1 ||
      frame.readUInt16LE(80) !== 2 ||
      frame.readUInt16LE(96) !== 3 ||
      frame.readUInt16LE(144) !== 8 ||
      frame.readUInt16LE(160) !== 5 ||
      frame.readUInt16LE(176) !== 12
    ) {
      throw new Error("ghosttead did not emit the Phase 4 native-glyph frame layout");
    }
    found = frame.includes(Buffer.from("ghostty-smoke"));
  }
  if (!found) throw new Error("PTY output was not present in a binary snapshot");

  let requestId = 5;
  control.socket.write(
    packet(
      JSON.stringify({
        requestId: requestId++,
        type: "get-automation-state",
        sessionId: created.session.id,
      }),
    ),
  );
  const automationBeforeHuman = await nextControlResponse(control, requestId - 1);
  if (automationBeforeHuman.type !== "automation-state") throw new Error("automation state was unavailable");
  control.socket.write(
    packet(
      JSON.stringify({
        requestId: requestId++,
        type: "send-text",
        sessionId: created.session.id,
        ...nextInput(primaryView),
        text: "x",
      }),
    ),
  );
  await nextControlResponse(control, requestId - 1);
  control.socket.write(
    packet(
      JSON.stringify({
        requestId: requestId++,
        type: "automation-input",
        sessionId: created.session.id,
        expectedHumanInputEpoch: automationBeforeHuman.humanInputEpoch,
        operation: { kind: "paste", text: "printf automation-conflict", submit: true },
      }),
    ),
  );
  const conflict = await nextControlResponse(control, requestId - 1);
  if (conflict.type !== "automation-input-result" || conflict.accepted || conflict.reason !== "human-input-conflict") {
    throw new Error(`automation was not rejected after human input: ${JSON.stringify(conflict)}`);
  }
  control.socket.write(
    packet(
      JSON.stringify({
        requestId: requestId++,
        type: "interrupt",
        sessionId: created.session.id,
        ...nextInput(primaryView),
      }),
    ),
  );
  await nextControlResponse(control, requestId - 1);
  control.socket.write(
    packet(JSON.stringify({ requestId: requestId++, type: "get-automation-state", sessionId: created.session.id })),
  );
  const automationReady = await nextControlResponse(control, requestId - 1);
  control.socket.write(
    packet(
      JSON.stringify({
        requestId: requestId++,
        type: "automation-input",
        sessionId: created.session.id,
        expectedHumanInputEpoch: automationReady.humanInputEpoch,
        operation: { kind: "paste", text: "printf 'ghosttea-automation-ok\\n'", submit: true },
      }),
    ),
  );
  const automationAccepted = await nextControlResponse(control, requestId - 1);
  if (automationAccepted.type !== "automation-input-result" || !automationAccepted.accepted) {
    throw new Error(`atomic automation input failed: ${JSON.stringify(automationAccepted)}`);
  }
  let foundAutomation = false;
  while (!foundAutomation) {
    const frame = await Promise.race([
      frames.next(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("automation frame timeout")), 5_000)),
    ]);
    foundAutomation = frame.includes(Buffer.from("ghosttea-automation-ok"));
  }

  control.socket.write(
    packet(
      JSON.stringify({
        requestId: requestId++,
        type: "create-session",
        options: {
          executable: "/bin/sh",
          args: [
            "-c",
            'printf \'env-safe=%s secret=%s term=%s\\n\' "$SAFE" "${GHOSTTEA_AUTH_TOKEN-unset}" "$TERM"; sleep 2',
          ],
          environment: { mode: "clean", variables: { SAFE: "allowed" } },
          cols: 80,
          rows: 8,
          persistence: "terminate-with-app",
        },
      }),
    ),
  );
  const cleanEnvironment = await nextControlResponse(control, requestId - 1);
  if (cleanEnvironment.type !== "session-created") throw new Error("clean environment session creation failed");
  subscribeFrames(cleanEnvironment.session.handle);
  control.socket.write(
    packet(
      JSON.stringify({
        requestId: requestId++,
        type: "attach-session",
        sessionId: cleanEnvironment.session.id,
        viewId: "smoke-clean-env",
      }),
    ),
  );
  await nextControlResponse(control, requestId - 1);
  control.socket.write(
    packet(JSON.stringify({ requestId: requestId++, type: "refresh-session", sessionId: cleanEnvironment.session.id })),
  );
  await nextControlResponse(control, requestId - 1);
  let foundCleanEnvironment = false;
  while (!foundCleanEnvironment) {
    const frame = await Promise.race([
      frames.next(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("clean environment frame timeout")), 5_000)),
    ]);
    foundCleanEnvironment =
      frame.readBigUInt64LE(8).toString() === cleanEnvironment.session.handle &&
      frame.includes(Buffer.from("env-safe=allowed secret=unset term=xterm-256color"));
  }

  control.socket.write(
    packet(JSON.stringify({ requestId: requestId++, type: "refresh-session", sessionId: created.session.id })),
  );
  const refreshed = await nextControlResponse(control, requestId - 1);
  if (refreshed.type !== "ok") throw new Error(`refresh failed: ${JSON.stringify(refreshed)}`);
  let foundFullRefresh = false;
  const refreshDeadline = Date.now() + 5_000;
  while (Date.now() < refreshDeadline && !foundFullRefresh) {
    const frame = await Promise.race([
      frames.next(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("refresh frame timeout")), 5_000)),
    ]);
    foundFullRefresh =
      frame.readBigUInt64LE(8).toString() === created.session.handle && (frame.readUInt16LE(6) & 1) !== 0;
  }
  if (!foundFullRefresh) throw new Error("explicit refresh did not emit a full snapshot");

  control.socket.write(
    packet(
      JSON.stringify({
        requestId: requestId++,
        type: "send-text",
        sessionId: created.session.id,
        ...nextInput(primaryView),
        text: "printf '\\033[1mbold\\033[0m \\033[31mred\\033[0m ffi é 😀 界\\n'\r",
      }),
    ),
  );
  await nextControlResponse(control, requestId - 1);
  const shapingDeadline = Date.now() + 5_000;
  let shapingVerified = false;
  while (Date.now() < shapingDeadline && !shapingVerified) {
    const frame = await Promise.race([
      frames.next(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("shaping frame timeout")), 5_000)),
    ]);
    if (!frame.includes(Buffer.from("bold red ffi"))) continue;
    const formats = glyphFormats(frame);
    const glyphStyles = new Set(rowStyleIds(frame));
    const styles = terminalStyles(frame);
    const hasBold = styles.some((style) => (style.flags & 1) !== 0 && glyphStyles.has(style.id));
    const hasForeground = styles.some((style) => style.foregroundKind === 1 && glyphStyles.has(style.id));
    const hasExpectedFormats = formats.includes(0) && (process.platform !== "darwin" || formats.includes(1));
    shapingVerified = hasExpectedFormats && hasBold && hasForeground;
  }
  if (!shapingVerified)
    throw new Error("native shaping frame did not include alpha/color glyphs plus bold/foreground styles");

  control.socket.write(
    packet(
      JSON.stringify({
        requestId: requestId++,
        type: "focus-and-resize",
        sessionId: created.session.id,
        viewId: primaryView.viewId,
        attachmentEpoch: primaryView.attachmentEpoch,
        cols: 80,
        rows: 20,
      }),
    ),
  );
  const claimed = await nextControlResponse(control, requestId - 1);
  if (claimed.type !== "control-claimed") throw new Error(`control claim failed: ${JSON.stringify(claimed)}`);
  primaryView.controlEpoch = claimed.controlEpoch;
  control.socket.write(
    packet(
      JSON.stringify({
        requestId: requestId++,
        type: "resize",
        sessionId: created.session.id,
        ...nextResize(primaryView),
        cols: 43,
        rows: 11,
      }),
    ),
  );
  const resizeResponse = await nextControlResponse(control, requestId - 1);
  if (resizeResponse.type !== "ok") throw new Error(`resize failed: ${JSON.stringify(resizeResponse)}`);
  let foundResizeFrame = false;
  const resizeDeadline = Date.now() + 5_000;
  while (Date.now() < resizeDeadline && !foundResizeFrame) {
    const frame = await Promise.race([
      frames.next(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("resize frame timeout")), 5_000)),
    ]);
    foundResizeFrame =
      frame.readBigUInt64LE(8).toString() === created.session.handle &&
      frame.readUInt16LE(56) === 43 &&
      frame.readUInt16LE(58) === 11;
  }
  if (!foundResizeFrame) throw new Error("resized grid dimensions were not published");
  control.socket.write(
    packet(
      JSON.stringify({
        requestId: requestId++,
        type: "send-text",
        sessionId: created.session.id,
        ...nextInput(primaryView),
        text: "stty size\r",
      }),
    ),
  );
  await nextControlResponse(control, requestId - 1);

  control.socket.write(
    packet(
      JSON.stringify({
        requestId: requestId++,
        type: "resize",
        sessionId: created.session.id,
        ...nextResize(primaryView),
        cols: 65_536,
        rows: 20,
      }),
    ),
  );
  const invalidResize = await nextControlResponse(control, requestId - 1);
  if (invalidResize.type !== "error") throw new Error("out-of-range resize was accepted");
  let foundPtyResize = false;
  const ptyResizeDeadline = Date.now() + 5_000;
  while (Date.now() < ptyResizeDeadline && !foundPtyResize) {
    const frame = await Promise.race([
      frames.next(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("PTY resize timeout")), 5_000)),
    ]);
    foundPtyResize =
      frame.readBigUInt64LE(8).toString() === created.session.handle && frame.includes(Buffer.from("11 43"));
  }
  if (!foundPtyResize) throw new Error("PTY did not observe the resized rows and columns");
  control.socket.write(
    packet(
      JSON.stringify({
        requestId: requestId++,
        type: "resize",
        sessionId: created.session.id,
        ...nextResize(primaryView),
        cols: 80,
        rows: 20,
      }),
    ),
  );
  await nextControlResponse(control, requestId - 1);

  const input = [
    ["KeyE", "e"],
    ["KeyC", "c"],
    ["KeyH", "h"],
    ["KeyO", "o"],
    ["Space", " "],
    ["KeyG", "g"],
    ["KeyH", "h"],
    ["KeyO", "o"],
    ["KeyS", "s"],
    ["KeyT", "t"],
    ["KeyT", "t"],
    ["KeyY", "y"],
    ["Minus", "-"],
    ["KeyK", "k"],
    ["KeyE", "e"],
    ["KeyY", "y"],
    ["Minus", "-"],
    ["KeyI", "i"],
    ["KeyN", "n"],
    ["KeyP", "p"],
    ["KeyU", "u"],
    ["KeyT", "t"],
    ["Enter", "Enter"],
  ];
  for (const [code, key] of input) {
    control.socket.write(
      packet(
        JSON.stringify({
          requestId: requestId++,
          type: "send-key",
          sessionId: created.session.id,
          ...nextInput(primaryView),
          event: {
            type: "down",
            key,
            code,
            location: 0,
            repeat: false,
            shift: false,
            control: false,
            alt: false,
            meta: false,
            timestamp: 0,
          },
        }),
      ),
    );
    const response = await nextControlResponse(control, requestId - 1);
    if (response.type !== "ok") throw new Error(`key input failed: ${JSON.stringify(response)}`);
    control.socket.write(
      packet(
        JSON.stringify({
          requestId: requestId++,
          type: "send-key",
          sessionId: created.session.id,
          ...nextInput(primaryView),
          event: {
            type: "up",
            key,
            code,
            location: 0,
            repeat: false,
            shift: false,
            control: false,
            alt: false,
            meta: false,
            timestamp: 0,
          },
        }),
      ),
    );
    const releaseResponse = await nextControlResponse(control, requestId - 1);
    if (releaseResponse.type !== "ok") throw new Error(`key release failed: ${JSON.stringify(releaseResponse)}`);
  }
  const keyDeadline = Date.now() + 5_000;
  let foundKeyInput = false;
  while (Date.now() < keyDeadline && !foundKeyInput) {
    const frame = await Promise.race([
      frames.next(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("key frame timeout")), 5_000)),
    ]);
    foundKeyInput = frame.includes(Buffer.from("ghostty-key-input"));
  }
  if (!foundKeyInput) throw new Error("libghostty key input was not present in a binary snapshot");

  control.socket.write(
    packet(
      JSON.stringify({
        requestId: requestId++,
        type: "create-session",
        options: {
          executable: "/usr/bin/python3",
          args: [
            "-c",
            "import os,tty; tty.setraw(0); os.write(1,b'\\x1b[?1000h\\x1b[?1006h'); data=b''\nwhile len(data)<9: data+=os.read(0,9-len(data))\nos.write(1,data.hex().encode())",
          ],
          env: {},
          cols: 80,
          rows: 20,
          persistence: "terminate-with-app",
        },
      }),
    ),
  );
  const mouseCreated = await nextControlResponse(control, requestId - 1);
  if (mouseCreated.type !== "session-created")
    throw new Error(`mouse session create failed: ${JSON.stringify(mouseCreated)}`);
  subscribeFrames(mouseCreated.session.handle);
  const mouseView = { viewId: "smoke-mouse", attachmentEpoch: 0, inputSequence: 0 };
  control.socket.write(
    packet(
      JSON.stringify({
        requestId: requestId++,
        type: "attach-session",
        sessionId: mouseCreated.session.id,
        viewId: mouseView.viewId,
      }),
    ),
  );
  const mouseAttached = await nextControlResponse(control, requestId - 1);
  if (mouseAttached.type !== "view-attached") throw new Error("mouse session attach failed");
  mouseView.attachmentEpoch = mouseAttached.attachmentEpoch;
  const mouseModeDeadline = Date.now() + 5_000;
  let mouseMode = false;
  while (Date.now() < mouseModeDeadline && !mouseMode) {
    const frame = await Promise.race([
      frames.next(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("mouse mode frame timeout")), 5_000)),
    ]);
    mouseMode =
      frame.readBigUInt64LE(8).toString() === mouseCreated.session.handle && (frame.readUInt16LE(6) & 2) !== 0;
  }
  if (!mouseMode) throw new Error("terminal frame did not advertise application mouse tracking");
  control.socket.write(
    packet(
      JSON.stringify({
        requestId: requestId++,
        type: "send-mouse",
        sessionId: mouseCreated.session.id,
        ...nextInput(mouseView),
        event: {
          action: "press",
          button: 1,
          x: 16,
          y: 22,
          screenWidth: 668,
          screenHeight: 404,
          cellWidth: 8,
          cellHeight: 19,
          paddingLeft: 14,
          paddingTop: 12,
          shift: false,
          control: false,
          alt: false,
          meta: false,
        },
      }),
    ),
  );
  const mouseResponse = await nextControlResponse(control, requestId - 1);
  if (mouseResponse.type !== "ok") throw new Error(`mouse input failed: ${JSON.stringify(mouseResponse)}`);
  const mouseDeadline = Date.now() + 5_000;
  let foundMouse = false;
  while (Date.now() < mouseDeadline && !foundMouse) {
    const frame = await Promise.race([
      frames.next(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("mouse frame timeout")), 5_000)),
    ]);
    foundMouse =
      frame.readBigUInt64LE(8).toString() === mouseCreated.session.handle &&
      frame.includes(Buffer.from("1b5b3c303b313b314d"));
  }
  if (!foundMouse) throw new Error("application mouse event did not reach the PTY");

  control.socket.write(
    packet(
      JSON.stringify({
        requestId: requestId++,
        type: "create-session",
        options: {
          executable: "/usr/bin/python3",
          args: [
            "-c",
            "import os,tty; tty.setraw(0); os.write(1,b'interrupt-ready'); data=os.read(0,1); os.write(1,data.hex().encode())",
          ],
          env: {},
          cols: 80,
          rows: 20,
          persistence: "terminate-with-app",
        },
      }),
    ),
  );
  const interruptCreated = await nextControlResponse(control, requestId - 1);
  if (interruptCreated.type !== "session-created")
    throw new Error(`interrupt session create failed: ${JSON.stringify(interruptCreated)}`);
  subscribeFrames(interruptCreated.session.handle);
  const interruptView = { viewId: "smoke-interrupt", attachmentEpoch: 0, inputSequence: 0 };
  control.socket.write(
    packet(
      JSON.stringify({
        requestId: requestId++,
        type: "attach-session",
        sessionId: interruptCreated.session.id,
        viewId: interruptView.viewId,
      }),
    ),
  );
  const interruptAttached = await nextControlResponse(control, requestId - 1);
  if (interruptAttached.type !== "view-attached") throw new Error("interrupt session attach failed");
  interruptView.attachmentEpoch = interruptAttached.attachmentEpoch;
  let interruptReady = false;
  while (!interruptReady) {
    const frame = await Promise.race([
      frames.next(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("interrupt ready timeout")), 5_000)),
    ]);
    interruptReady =
      frame.readBigUInt64LE(8).toString() === interruptCreated.session.handle &&
      frame.includes(Buffer.from("interrupt-ready"));
  }
  control.socket.write(
    packet(
      JSON.stringify({
        requestId: requestId++,
        type: "interrupt",
        sessionId: interruptCreated.session.id,
        ...nextInput(interruptView),
      }),
    ),
  );
  const interruptResponse = await nextControlResponse(control, requestId - 1);
  if (interruptResponse.type !== "ok") throw new Error(`interrupt failed: ${JSON.stringify(interruptResponse)}`);
  let foundInterrupt = false;
  while (!foundInterrupt) {
    const frame = await Promise.race([
      frames.next(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("interrupt frame timeout")), 5_000)),
    ]);
    foundInterrupt =
      frame.readBigUInt64LE(8).toString() === interruptCreated.session.handle && frame.includes(Buffer.from("03"));
  }

  control.socket.write(
    packet(
      JSON.stringify({
        requestId: requestId++,
        type: "send-text",
        sessionId: created.session.id,
        ...nextInput(primaryView),
        text: "printf '\\033]52;c;aW50ZWdyYXRpb24tY29weQ==\\007'\r",
      }),
    ),
  );
  await nextControlResponse(control, requestId - 1);
  const clipboardDeadline = Date.now() + 5_000;
  let foundClipboard = false;
  while (Date.now() < clipboardDeadline && !foundClipboard) {
    const frame = await Promise.race([
      frames.next(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("clipboard frame timeout")), 5_000)),
    ]);
    const clipboard = sections(frame).get(11);
    if (clipboard && clipboard.length >= 4) {
      const length = clipboard.readUInt32LE(0);
      foundClipboard = clipboard.subarray(4, 4 + length).toString() === "integration-copy";
    }
  }
  if (!foundClipboard) throw new Error("OSC 52 clipboard write did not reach the frame transport");

  control.socket.write(
    packet(
      JSON.stringify({
        requestId: requestId++,
        type: "send-text",
        sessionId: created.session.id,
        ...nextInput(primaryView),
        text: "i=0; while [ $i -lt 300 ]; do echo flood-$i; i=$((i+1)); done; echo ghostty-flood-done\r",
      }),
    ),
  );
  await nextControlResponse(control, requestId - 1);
  const floodDeadline = Date.now() + 8_000;
  let foundFloodTail = false;
  let bottomScrollbar = null;
  while (Date.now() < floodDeadline && !foundFloodTail) {
    const frame = await Promise.race([
      frames.next(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("flood frame timeout")), 8_000)),
    ]);
    foundFloodTail = frame.includes(Buffer.from("ghostty-flood-done"));
    if (foundFloodTail) bottomScrollbar = scrollbarState(frame);
  }
  if (!foundFloodTail) throw new Error("latest row-replacement frame did not remain current under output flood");
  if (
    !bottomScrollbar ||
    bottomScrollbar.total <= bottomScrollbar.length ||
    bottomScrollbar.offset + bottomScrollbar.length !== bottomScrollbar.total
  ) {
    throw new Error("terminal frame did not expose bottom-anchored scrollbar state");
  }

  control.socket.write(
    packet(
      JSON.stringify({
        requestId: requestId++,
        type: "scroll",
        sessionId: created.session.id,
        ...nextInput(primaryView),
        rows: -10,
      }),
    ),
  );
  await nextControlResponse(control, requestId - 1);
  const scrollDeadline = Date.now() + 5_000;
  let foundHistory = false;
  let historyScrollbar = null;
  while (Date.now() < scrollDeadline && !foundHistory) {
    const frame = await Promise.race([
      frames.next(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("scroll frame timeout")), 5_000)),
    ]);
    foundHistory = frame.includes(Buffer.from("flood-")) && !frame.includes(Buffer.from("ghostty-flood-done"));
    if (foundHistory) historyScrollbar = scrollbarState(frame);
  }
  if (!foundHistory) throw new Error("scrollback viewport did not move into session history");
  if (!historyScrollbar || historyScrollbar.offset >= bottomScrollbar.offset) {
    throw new Error("scrollbar offset did not follow the history viewport");
  }

  control.socket.write(
    packet(
      JSON.stringify({
        requestId: requestId++,
        type: "scroll-to",
        sessionId: created.session.id,
        ...nextInput(primaryView),
        row: bottomScrollbar.offset,
      }),
    ),
  );
  await nextControlResponse(control, requestId - 1);
  const restoreDeadline = Date.now() + 5_000;
  let restoredBottom = false;
  while (Date.now() < restoreDeadline && !restoredBottom) {
    const frame = await Promise.race([
      frames.next(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("absolute scroll frame timeout")), 5_000)),
    ]);
    restoredBottom = scrollbarState(frame)?.offset === bottomScrollbar.offset;
  }
  if (!restoredBottom) throw new Error("absolute scrollbar position did not restore the bottom viewport");

  if (process.platform !== "win32") {
    control.socket.write(
      packet(
        JSON.stringify({
          requestId: requestId++,
          type: "create-session",
          options: {
            executable: "/bin/sh",
            args: ["-c", "trap '' INT TERM; sleep 60 & wait"],
            environment: { mode: "clean", variables: { PATH: process.env.PATH ?? "/usr/bin:/bin" } },
            cols: 20,
            rows: 4,
            persistence: "terminate-with-app",
          },
        }),
      ),
    );
    const stubborn = await nextControlResponse(control, requestId - 1);
    if (stubborn.type !== "session-created" || !Number.isInteger(stubborn.session.pid)) {
      throw new Error(`stubborn process creation failed: ${JSON.stringify(stubborn)}`);
    }
    subscribeFrames(stubborn.session.handle);
    control.socket.write(
      packet(
        JSON.stringify({
          requestId: requestId++,
          type: "terminate",
          sessionId: stubborn.session.id,
          source: "application",
        }),
      ),
    );
    if ((await nextControlResponse(control, requestId - 1)).type !== "ok") {
      throw new Error("stubborn process termination was rejected");
    }
    const terminated = await Promise.race([
      nextControlEvent(control, "session-exited", (event) => event.sessionId === stubborn.session.id),
      new Promise((_, reject) => setTimeout(() => reject(new Error("process-group termination timeout")), 10_000)),
    ]);
    if (terminated.requestedTermination !== "application" || terminated.exitOutcome !== "application-terminated") {
      throw new Error(`termination metadata was not classified: ${JSON.stringify(terminated)}`);
    }
    try {
      process.kill(-stubborn.session.pid, 0);
      throw new Error("terminated PTY process group still exists");
    } catch (error) {
      if (error instanceof Error && error.message === "terminated PTY process group still exists") throw error;
      if (!(error && typeof error === "object" && "code" in error && error.code === "ESRCH")) throw error;
    }
  }

  control.socket.write(
    packet(
      JSON.stringify({
        requestId: requestId++,
        type: "send-text",
        sessionId: created.session.id,
        ...nextInput(primaryView),
        text: "exit\r",
      }),
    ),
  );
  await nextControlResponse(control, requestId - 1);
  const exited = await Promise.race([
    nextControlEvent(control, "session-exited", (event) => event.sessionId === created.session.id),
    new Promise((_, reject) => setTimeout(() => reject(new Error("session exit event timeout")), 5_000)),
  ]);
  if (exited.sessionId !== created.session.id) throw new Error("wrong session exit event");
  if (exited.exitCode !== 0 || exited.exitSignal !== null || exited.exitOutcome !== "completed") {
    throw new Error(`normal exit metadata was incorrect: ${JSON.stringify(exited)}`);
  }
  control.socket.write(packet(JSON.stringify({ requestId: requestId++, type: "list-sessions" })));
  const remaining = await nextControlResponse(control, requestId - 1);
  if (remaining.type !== "sessions" || remaining.sessions.some((session) => session.id === created.session.id)) {
    throw new Error("exited terminate-with-app session remained in the registry");
  }

  control.socket.write(
    packet(
      JSON.stringify({
        requestId: requestId++,
        type: "create-session",
        options: {
          executable: "/bin/sh",
          args: ["-c", "exit 7"],
          env: {},
          cols: 20,
          rows: 4,
          persistence: "keep-until-explicit-close",
        },
      }),
    ),
  );
  const retained = await nextControlResponse(control, requestId - 1);
  if (retained.type !== "session-created") throw new Error("retained session creation failed");
  subscribeFrames(retained.session.handle);
  const retainedExit = await Promise.race([
    nextControlEvent(control, "session-exited", (event) => event.sessionId === retained.session.id),
    new Promise((_, reject) => setTimeout(() => reject(new Error("retained session exit timeout")), 5_000)),
  ]);
  control.socket.write(packet(JSON.stringify({ requestId: requestId++, type: "list-sessions" })));
  const withRetained = await nextControlResponse(control, requestId - 1);
  if (
    withRetained.type !== "sessions" ||
    !withRetained.sessions.some(
      (session) =>
        session.id === retained.session.id &&
        session.exited &&
        session.exitCode === 7 &&
        session.exitOutcome === "crashed",
    ) ||
    retainedExit.exitCode !== 7 ||
    retainedExit.exitOutcome !== "crashed"
  ) {
    throw new Error("keep-until-explicit-close session was not retained");
  }
  control.socket.write(
    packet(JSON.stringify({ requestId: requestId++, type: "terminate", sessionId: retained.session.id })),
  );
  if ((await nextControlResponse(control, requestId - 1)).type !== "ok")
    throw new Error("retained session close failed");

  // Re-policy: a session born disposable is promoted while it runs, and the
  // promotion — not the class it was created with — decides retention when the
  // child exits on its own. (A wire `terminate` is the *explicit close* that
  // keep-until-explicit-close names, so retention is only observable across a
  // natural exit; the child sleeps to leave room to reclassify it first, and
  // the set-persistence response below proves the reclassification landed
  // while the session was still alive.)
  control.socket.write(
    packet(
      JSON.stringify({
        requestId: requestId++,
        type: "create-session",
        options: {
          executable: "/bin/sh",
          args: ["-c", "sleep 3"],
          env: {},
          cols: 20,
          rows: 4,
          persistence: "keep-until-exit",
        },
      }),
    ),
  );
  const promoted = await nextControlResponse(control, requestId - 1);
  if (promoted.type !== "session-created") throw new Error("promotable session creation failed");
  if (promoted.session.persistence !== "keep-until-exit") {
    throw new Error(`create did not report its class: ${JSON.stringify(promoted.session.persistence)}`);
  }
  subscribeFrames(promoted.session.handle);

  control.socket.write(
    packet(
      JSON.stringify({
        requestId: requestId++,
        type: "set-persistence",
        sessionId: promoted.session.id,
        persistence: "keep-until-explicit-close",
      }),
    ),
  );
  const reclassified = await nextControlResponse(control, requestId - 1);
  if (reclassified.type !== "session" || reclassified.session.persistence !== "keep-until-explicit-close") {
    throw new Error(`set-persistence did not report the applied class: ${JSON.stringify(reclassified)}`);
  }

  await Promise.race([
    nextControlEvent(control, "session-exited", (event) => event.sessionId === promoted.session.id),
    new Promise((_, reject) => setTimeout(() => reject(new Error("promoted session exit timeout")), 20_000)),
  ]);

  control.socket.write(packet(JSON.stringify({ requestId: requestId++, type: "list-sessions" })));
  const afterPromotion = await nextControlResponse(control, requestId - 1);
  const survivor = afterPromotion.sessions?.find((session) => session.id === promoted.session.id);
  if (!survivor || !survivor.exited) {
    throw new Error("a session promoted to keep-until-explicit-close was not retained after exit");
  }
  if (survivor.persistence !== "keep-until-explicit-close") {
    throw new Error(`retained session lost its class: ${JSON.stringify(survivor.persistence)}`);
  }
  control.socket.write(
    packet(JSON.stringify({ requestId: requestId++, type: "terminate", sessionId: promoted.session.id })),
  );
  if ((await nextControlResponse(control, requestId - 1)).type !== "ok")
    throw new Error("promoted session close failed");

  testPassed = true;
  console.log("ghosttead smoke test passed");
} finally {
  automationClient?.dispose();
  const exited =
    child.exitCode !== null || child.signalCode !== null
      ? Promise.resolve()
      : new Promise((resolveExit) => child.once("exit", resolveExit));
  child.stdin.end();
  try {
    await withTimeout(exited, "ghosttead parent-channel shutdown", 15_000);
  } catch (error) {
    child.kill("SIGKILL");
    if (testPassed) parentShutdownError = error;
  } finally {
    rmSync(runtimeDir, { recursive: true, force: true });
  }
}

if (parentShutdownError) throw parentShutdownError;
