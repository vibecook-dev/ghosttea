import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { open as openFile, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { basename, join, resolve } from "node:path";
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeTheme, shell } from "electron";
import {
  allSettledWithin,
  GhostteaElectronBackend,
  GhostteaConfigDocumentConflictError,
  installGhostteaClipboardHost,
  installGhostteaLinkHost,
  installGhostteaEditShortcuts,
  type GhostteaElectronBackendOptions,
} from "@vibecook/ghosttea-electron/main";
import { LEGACY_PROFILE_ENV, PROFILE_ENV, desktopProfile } from "./profile";
import { orderNativeTabs } from "./native-tab-order";
import { DesktopTabRegistry, type SessionOwnerTransfer } from "./tab-registry";
import {
  appearanceUpdateMismatches,
  appearanceBlock,
  patchAppearanceBlock,
  validateAppearanceUpdate,
  type ManagedAppearanceUpdate,
} from "./appearance-config";
import {
  MAX_CONFIG_EDITOR_BYTES,
  assertConfigDocumentIncludesAuthorized,
  blockingConfigDiagnostics,
  serializeSupportedGhosttyConfig,
  trustedConfigEditorRendererUrl,
  validateConfigContents,
  validateConfigSaveRequest,
} from "./config-editor";

app.setName("Ghosttea");
nativeTheme.themeSource = "dark";
if (process.platform === "darwin") app.setActivationPolicy("regular");
const profile = desktopProfile(app.getPath("userData"), process.env[PROFILE_ENV] ?? process.env[LEGACY_PROFILE_ENV]);
mkdirSync(profile.electronData, { recursive: true, mode: 0o700 });
if (profile.name !== "default") {
  app.setPath("userData", profile.electronData);
  app.setPath("sessionData", profile.electronData);
  // A named profile is an isolation boundary. Do not allow a shared `.env`
  // value to collapse multiple peers onto the same Truffle identity.
  process.env.GHOSTTEA_TRUFFLE_DEVICE_NAME = `${hostname()} · ${profile.name}`;
  process.env.GHOSTTEA_TRUFFLE_STATE_DIR = profile.truffleState;
} else if (!process.env.GHOSTTEA_TRUFFLE_STATE_DIR?.trim() && !process.env.TERMINALD_TRUFFLE_STATE_DIR?.trim()) {
  process.env.GHOSTTEA_TRUFFLE_STATE_DIR = profile.truffleState;
}
const terminalConfigPath = join(app.getPath("userData"), "config.ghostty");
const DEFAULT_TERMINAL_CONFIG = [
  "# Ghosttea application overrides (Ghostty-compatible syntax).",
  "# Your existing Ghostty config files are imported before this file.",
  "# Enable Ghosttea's public-domain CRT port with:",
  "# custom-shader = ghosttea:crt",
  "# Or use the in-app Settings to choose a color theme, shader stack, or advanced override.",
  "",
].join("\n");

// Electron keys this lock from the configured user-data directory. Different
// profiles coexist; launching the same profile again activates its window.
const ownsProfile = app.requestSingleInstanceLock({ profile: profile.name });
if (!ownsProfile) app.quit();

const clipboardHost = installGhostteaClipboardHost(ipcMain, clipboard);
installGhostteaLinkHost(ipcMain, shell, (sender) => trustedManagedConfigEditorSender(sender, sender.mainFrame));

ipcMain.on("terminal-context-menu", (event, canCopy: boolean) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (!window) return;
  const send = (action: string): void => window.webContents.send("terminal-menu-action", action);
  Menu.buildFromTemplate([
    { label: "Copy", enabled: Boolean(canCopy), click: () => send("copy") },
    { label: "Paste", click: () => send("paste") },
    { type: "separator" },
    { label: "Select All", click: () => send("select-all") },
    { label: "Clear Screen", click: () => send("clear-screen") },
  ]).popup({ window });
});

ipcMain.on("terminal-toggle-fullscreen", (event) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (window) window.setFullScreen(!window.isFullScreen());
});

ipcMain.on("terminal-close-window", (event) => {
  BrowserWindow.fromWebContents(event.sender)?.close();
});

ipcMain.on("terminal-new-window", (event, cwd: unknown) => {
  void createWindow({
    initialCwd: typeof cwd === "string" && cwd.trim() ? cwd : undefined,
  }).catch((error) => console.error("failed to create window", error));
});

ipcMain.on("terminal-quit", () => {
  app.quit();
});

ipcMain.on("terminal-close-all-windows", () => {
  for (const window of BrowserWindow.getAllWindows()) window.close();
});

ipcMain.on("terminal-open-config", (event) => {
  if (externalBackendConfigured()) {
    void showExternalConfigOwnershipMessage(event.sender, "open");
    return;
  }
  void openManagedTerminalConfig().catch((error) => console.error("failed to open terminal config", error));
});

ipcMain.on("terminal-reload-config", (event) => {
  if (externalBackendConfigured()) {
    void showExternalConfigOwnershipMessage(event.sender, "reload");
    return;
  }
  void ensureBackend()
    .then(() => backend!.automation.reloadConfig())
    .catch((error) => console.error("failed to reload terminal config", error));
});

ipcMain.handle("terminal-save-appearance", async (event, payload: unknown) => {
  await requireManagedConfigEditor(event);
  await saveManagedAppearance(validateAppearanceUpdate(payload));
});

ipcMain.handle("terminal-config-editor-load", async (event) => {
  await requireManagedConfigEditor(event);
  const [document, config] = await Promise.all([
    backend!.automation.getConfigDocument(),
    backend!.automation.getConfig(),
  ]);
  assertProfileConfigDocument(document.path);
  return { document, config };
});

ipcMain.handle("terminal-config-editor-validate", async (event, payload: unknown) => {
  await requireManagedConfigEditor(event);
  const contents = validateConfigContents(payload);
  const current = await backend!.automation.getConfigDocument();
  assertProfileConfigDocument(current.path);
  return validateManagedConfigCandidate(current, contents);
});

ipcMain.handle("terminal-config-editor-save", async (event, payload: unknown) => {
  await requireManagedConfigEditor(event);
  const request = validateConfigSaveRequest(payload);
  const current = await backend!.automation.getConfigDocument();
  assertProfileConfigDocument(current.path);
  const validation = await validateManagedConfigCandidate(current, request.contents);
  if (validation.blockingErrors.length > 0) {
    throw new Error(validation.blockingErrors.map((diagnostic) => diagnostic.message).join("\n"));
  }
  try {
    const update = await backend!.automation.replaceConfigDocument(request.expectedRevision, request.contents);
    assertProfileConfigDocument(update.document.path);
    return { status: "saved", document: update.document, config: update.config } as const;
  } catch (error) {
    if (!(error instanceof GhostteaConfigDocumentConflictError)) throw error;
    assertProfileConfigDocument(error.document.path);
    return { status: "conflict", document: error.document } as const;
  }
});

ipcMain.handle("terminal-config-editor-import-ghostty", async (event) => {
  await requireManagedConfigEditor(event);
  // An empty candidate removes only the Ghosttea overlay while retaining the
  // detected Ghostty roots and their includes in the validation projection.
  const inherited = await backend!.automation.validateConfigDocument("");
  const sources = inherited.config.sources.filter((source) => source.kind !== "ghosttea-overlay");
  if (sources.length === 0) {
    return { status: "unavailable", message: "No Ghostty configuration files were detected." } as const;
  }
  const contents = serializeSupportedGhosttyConfig(inherited.config);
  try {
    validateConfigContents(contents);
  } catch {
    return {
      status: "unavailable",
      message: "The supported Ghostty settings exceed Ghosttea's 64 KiB profile-overlay limit.",
    } as const;
  }
  return {
    status: "selected",
    name: sources.length === 1 ? basename(sources[0]!.path) : `${sources.length} detected Ghostty sources`,
    contents,
    notice:
      "Generated supported overrides from the effective Ghostty settings. Source files, private paths, unsupported keys, and relative includes were not copied.",
  } as const;
});

ipcMain.handle("terminal-config-editor-import-file", async (event) => {
  await requireManagedConfigEditor(event);
  const owner = BrowserWindow.fromWebContents(event.sender);
  const options: Electron.OpenDialogOptions = {
    title: "Import Ghostty configuration",
    properties: ["openFile"],
    filters: [
      { name: "Ghostty configuration", extensions: ["ghostty", "conf", "config"] },
      { name: "All files", extensions: ["*"] },
    ],
  };
  const selection = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
  const path = selection.filePaths[0];
  if (selection.canceled || !path) return { status: "cancelled" } as const;
  return {
    status: "selected",
    name: basename(path),
    contents: await readConfigImport(path),
    notice:
      "Imported text is staged as a draft. Active config-file directives must stay in their current order or be cleared; edit include structure through the externally opened profile config.",
  } as const;
});

ipcMain.handle("terminal-config-editor-export-file", async (event, payload: unknown) => {
  await requireManagedConfigEditor(event);
  const contents = validateConfigContents(payload);
  const owner = BrowserWindow.fromWebContents(event.sender);
  const options = {
    title: "Export Ghostty configuration",
    defaultPath: join(app.getPath("documents"), "ghosttea-config.ghostty"),
    filters: [{ name: "Ghostty configuration", extensions: ["ghostty"] }],
  };
  const selection = owner ? await dialog.showSaveDialog(owner, options) : await dialog.showSaveDialog(options);
  if (selection.canceled || !selection.filePath) return { status: "cancelled" } as const;
  await writeFile(selection.filePath, contents, { encoding: "utf8", mode: 0o600 });
  return { status: "saved", path: selection.filePath } as const;
});

ipcMain.on("terminal-config-editor-dirty", (event, payload: unknown) => {
  if (
    typeof payload !== "boolean" ||
    externalBackendConfigured() ||
    !trustedManagedConfigEditorSender(event.sender, event.senderFrame)
  ) {
    return;
  }
  if (payload) dirtyConfigEditorSenders.add(event.sender);
  else dirtyConfigEditorSenders.delete(event.sender);
});

ipcMain.on("terminal-new-tab", (event, cwd: unknown) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (!window) return;
  void createWindow({ tabOf: window, initialCwd: typeof cwd === "string" && cwd.trim() ? cwd : undefined }).catch(
    (error) => console.error("failed to create tab", error),
  );
});

ipcMain.on("terminal-select-tab", (event, target: unknown) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (!window) return;
  if (target === "previous") {
    if (process.platform === "darwin") window.selectPreviousTab();
    else focusRelativeTab(window, -1);
  } else if (target === "next") {
    if (process.platform === "darwin") window.selectNextTab();
    else focusRelativeTab(window, 1);
  } else if (target === "last" || (typeof target === "number" && Number.isSafeInteger(target))) {
    const current = tabs.get(window);
    if (!current) return;
    const group = tabs.group(current.groupId);
    const orderedWindows = orderNativeTabs(group.map((record) => record.window));
    if (orderedWindows.length === 0) return;
    if (target === "last") {
      focusTab(orderedWindows[orderedWindows.length - 1]);
      return;
    }
    // Ghostty goto_tab: indexes above the tab count select the last tab.
    const index = Math.min(Math.max(target, 1), orderedWindows.length) - 1;
    focusTab(orderedWindows[index]);
  }
});

ipcMain.on("terminal-close-tab", (event) => {
  BrowserWindow.fromWebContents(event.sender)?.close();
});

ipcMain.on("terminal-close-pane-session", (event, sessionId: unknown, remainingSessionIds: unknown) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (
    !window ||
    typeof sessionId !== "string" ||
    !sessionId ||
    !Array.isArray(remainingSessionIds) ||
    !remainingSessionIds.every((id) => typeof id === "string")
  ) {
    return;
  }

  // Update this viewport atomically with the close notification, then end the
  // PTY only when no pane in any window still mirrors it.
  if (!tabs.closePaneSession(window, sessionId, remainingSessionIds)) return;
  void backend?.automation
    .terminate(sessionId, "user")
    .catch((error) => console.warn(`[terminal-runtime] failed to terminate closed pane ${sessionId}`, error));
});

ipcMain.on("terminal-tab-sessions", (event, sessionIds: unknown) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (!window || !Array.isArray(sessionIds) || !sessionIds.every((id) => typeof id === "string")) return;
  tabs.updateSessions(window, sessionIds);
});

ipcMain.on("terminal-tab-active-cwd", (event, cwd: unknown) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (!window) return;
  tabs.updateActiveCwd(window, typeof cwd === "string" && cwd.trim() ? cwd : undefined);
});

const tabs = new DesktopTabRegistry<BrowserWindow>();
let backend: GhostteaElectronBackend | undefined;
const dirtyConfigEditorSenders = new Set<Electron.WebContents>();
const pendingDraftCloseConfirmations = new WeakMap<BrowserWindow, Promise<void>>();
let quitDraftConfirmation: Promise<void> | undefined;
let discardDraftsApprovedForQuit = false;
let quitting = false;
let quitCleanupComplete = false;
let quitCleanup: Promise<void> | undefined;
const QUIT_CLEANUP_TIMEOUT_MS = 5_000;
const closingSessionOwners = new Set<Promise<void>>();
let recoveringBackend: Promise<void> | undefined;
let lastFocusedWindow: BrowserWindow | undefined;

function externalBackendConfigured(): boolean {
  return Boolean(
    process.env.GHOSTTEA_EXTERNAL_CONTROL_SOCKET &&
    process.env.GHOSTTEA_EXTERNAL_FRAME_SOCKET &&
    process.env.GHOSTTEA_EXTERNAL_AUTH_TOKEN,
  );
}

async function showExternalConfigOwnershipMessage(
  sender: Electron.WebContents,
  action: "open" | "reload",
): Promise<void> {
  const owner = BrowserWindow.fromWebContents(sender);
  const options = {
    type: "info" as const,
    title: "Configuration managed externally",
    message: `Ghosttea cannot ${action} this configuration`,
    detail:
      "This window is connected to an externally managed daemon. Open or reload the configuration from the process that started that daemon.",
    buttons: ["OK"],
  };
  if (owner) await dialog.showMessageBox(owner, options);
  else await dialog.showMessageBox(options);
}

async function requireManagedConfigEditor(event: Electron.IpcMainInvokeEvent): Promise<void> {
  const { sender, senderFrame } = event;
  if (!trustedManagedConfigEditorSender(sender, senderFrame)) {
    throw new Error("Configuration editor is unavailable for this sender");
  }
  if (externalBackendConfigured()) {
    await showExternalConfigOwnershipMessage(sender, "reload");
    throw new Error("Configuration is managed by the external Ghosttea daemon");
  }
  if (!BrowserWindow.fromWebContents(sender)) throw new Error("Configuration editor is unavailable for this sender");
  await ensureBackend();
}

function trustedManagedConfigEditorSender(
  sender: Electron.WebContents,
  senderFrame: Electron.WebFrameMain | null,
): boolean {
  return Boolean(
    senderFrame &&
    senderFrame === sender.mainFrame &&
    BrowserWindow.fromWebContents(sender) &&
    trustedConfigEditorRendererUrl(
      senderFrame.url,
      process.env.ELECTRON_RENDERER_URL,
      resolve(__dirname, "../renderer/index.html"),
    ),
  );
}

async function confirmDiscardConfigDraft(owner: BrowserWindow, quittingApp = false): Promise<boolean> {
  const count = [...dirtyConfigEditorSenders].filter((sender) => !sender.isDestroyed()).length;
  const result = await dialog.showMessageBox(owner, {
    type: "warning",
    title: "Unsaved Ghostty configuration",
    message: quittingApp
      ? `Discard ${count === 1 ? "the unsaved configuration draft" : `${count} unsaved configuration drafts`} and quit?`
      : "Discard the unsaved configuration draft and close this window?",
    detail: "The draft has not been written to disk. This action cannot be undone.",
    buttons: ["Keep Editing", quittingApp ? "Discard and Quit" : "Discard and Close"],
    defaultId: 0,
    cancelId: 0,
  });
  return result.response === 1;
}

function guardDirtyConfigEditorClose(window: BrowserWindow, event: Electron.Event): void {
  if (!dirtyConfigEditorSenders.has(window.webContents)) return;
  event.preventDefault();
  if (pendingDraftCloseConfirmations.has(window)) return;
  const confirmation = confirmDiscardConfigDraft(window)
    .then((discard) => {
      if (!discard || window.isDestroyed()) return;
      dirtyConfigEditorSenders.delete(window.webContents);
      window.close();
    })
    .finally(() => pendingDraftCloseConfirmations.delete(window));
  pendingDraftCloseConfirmations.set(window, confirmation);
}

function assertProfileConfigDocument(path: string): void {
  if (resolve(path) !== resolve(terminalConfigPath)) {
    throw new Error("ghosttead returned a configuration path outside this Electron profile");
  }
}

async function validateManagedConfigCandidate(
  current: Awaited<ReturnType<GhostteaElectronBackend["automation"]["getConfigDocument"]>>,
  contents: string,
) {
  assertConfigDocumentIncludesAuthorized(current.contents, contents);
  const [baseline, validation] = await Promise.all([
    backend!.automation.validateConfigDocument(current.contents),
    backend!.automation.validateConfigDocument(contents),
  ]);
  return {
    ...validation,
    blockingErrors: blockingConfigDiagnostics(baseline.config.diagnostics, validation.config.diagnostics, current.path),
  };
}

async function readConfigImport(path: string): Promise<string> {
  const file = await openFile(path, "r");
  try {
    const metadata = await file.stat();
    if (!metadata.isFile()) throw new Error("Imported configuration must be a regular file");
    if (metadata.size > MAX_CONFIG_EDITOR_BYTES) {
      throw new Error(`Imported configuration is ${metadata.size} bytes; maximum is ${MAX_CONFIG_EDITOR_BYTES} bytes`);
    }
    const bytes = await file.readFile();
    if (bytes.byteLength > MAX_CONFIG_EDITOR_BYTES) {
      throw new Error(
        `Imported configuration is ${bytes.byteLength} bytes; maximum is ${MAX_CONFIG_EDITOR_BYTES} bytes`,
      );
    }
    try {
      return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      throw new Error("Imported configuration is not valid UTF-8 text");
    }
  } finally {
    await file.close();
  }
}

async function openManagedTerminalConfig(): Promise<void> {
  await ensureBackend();
  let document = await backend!.automation.getConfigDocument();
  if (!document.exists) {
    try {
      document = (await backend!.automation.replaceConfigDocument(document.revision, DEFAULT_TERMINAL_CONFIG)).document;
    } catch (error) {
      if (!(error instanceof GhostteaConfigDocumentConflictError) || !error.document.exists) throw error;
      document = error.document;
    }
  }
  if (resolve(document.path) !== resolve(terminalConfigPath)) {
    throw new Error("ghosttead returned a configuration path outside this Electron profile");
  }
  const message = await shell.openPath(document.path);
  if (message) throw new Error(message);
}

async function saveManagedAppearance(update: ManagedAppearanceUpdate): Promise<void> {
  await ensureBackend();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const document = await backend!.automation.getConfigDocument();
    assertProfileConfigDocument(document.path);
    const base = document.exists ? document.contents : DEFAULT_TERMINAL_CONFIG;
    const candidate = patchAppearanceBlock(base, appearanceBlock(update));
    const validation = await validateManagedConfigCandidate(document, candidate);
    if (validation.blockingErrors.length > 0) {
      throw new Error(validation.blockingErrors.map((diagnostic) => diagnostic.message).join("\n"));
    }
    const mismatches = appearanceUpdateMismatches(validation.config.renderer, update);
    if (mismatches.length > 0) {
      throw new Error(
        `Appearance settings are overridden by an included configuration layer: ${mismatches.join(", ")}`,
      );
    }
    try {
      await backend!.automation.replaceConfigDocument(document.revision, candidate);
      return;
    } catch (error) {
      if (!(error instanceof GhostteaConfigDocumentConflictError) || attempt === 2) throw error;
    }
  }
}

function backendOptions(): GhostteaElectronBackendOptions {
  const externalControl = process.env.GHOSTTEA_EXTERNAL_CONTROL_SOCKET;
  const externalFrames = process.env.GHOSTTEA_EXTERNAL_FRAME_SOCKET;
  const externalToken = process.env.GHOSTTEA_EXTERNAL_AUTH_TOKEN;
  if (externalControl && externalFrames && externalToken) {
    return {
      mode: "external",
      connection: { controlSocket: externalControl, frameSocket: externalFrames, authToken: externalToken },
    };
  }

  const repositoryRoot = resolve(app.getAppPath(), "../..");
  const developmentSidecar = resolve(
    repositoryRoot,
    "../p008/truffle/packages/sidecar-slim",
    process.platform === "win32" ? "sidecar-slim.exe" : "sidecar-slim",
  );
  const configuredBinary =
    process.env.GHOSTTEAD_BIN ??
    process.env.TERMINALD_BIN ??
    (app.isPackaged
      ? join(process.resourcesPath, "bin", process.platform === "win32" ? "ghosttead.exe" : "ghosttead")
      : undefined);
  const environment = {
    GHOSTTEA_CONFIG_PATH: terminalConfigPath,
    ...(!process.env.TRUFFLE_SIDECAR_PATH && !app.isPackaged && existsSync(developmentSidecar)
      ? { TRUFFLE_SIDECAR_PATH: developmentSidecar }
      : {}),
  };
  return {
    mode: "managed",
    daemon: {
      binary: configuredBinary
        ? { kind: "executable", path: configuredBinary }
        : {
            kind: "cargo",
            manifestPath: join(repositoryRoot, "native/ghosttead/Cargo.toml"),
            release: (process.env.GHOSTTEA_DEV_PROFILE ?? process.env.TERMINALD_DEV_PROFILE) !== "debug",
          },
      environment,
    },
  };
}

async function ensureBackend(): Promise<void> {
  if (!backend) {
    backend = new GhostteaElectronBackend(backendOptions());
    backend.on("unexpected-exit", ({ source, code, signal }) => {
      if (quitting) return;
      console.error(`${source} exited unexpectedly (${code ?? signal ?? "unknown"}); restarting`);
      void recoverBackend();
    });
  }
  if (!backend.running) await backend.start();
}

function recoverBackend(): Promise<void> {
  recoveringBackend ??= (async () => {
    let lastError: unknown;
    for (let attempt = 0; attempt < 5 && !quitting; attempt += 1) {
      try {
        await ensureBackend();
        for (const record of tabs.records()) {
          if (!record.window.isDestroyed()) record.window.webContents.reload();
        }
        return;
      } catch (error) {
        lastError = error;
        await new Promise((resolveDelay) => setTimeout(resolveDelay, Math.min(5_000, 250 * 2 ** attempt)));
      }
    }
    if (lastError) console.error("terminal backend recovery failed", lastError);
  })().finally(() => {
    recoveringBackend = undefined;
  });
  return recoveringBackend;
}

function focusMainWindow(): void {
  const window =
    BrowserWindow.getFocusedWindow() ??
    (lastFocusedWindow && !lastFocusedWindow.isDestroyed() ? lastFocusedWindow : tabs.records()[0]?.window);
  if (!window || window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  if (process.platform === "darwin") app.focus({ steal: true });
  window.show();
  window.focus();
}

function focusTab(window: BrowserWindow | undefined): void {
  if (!window || window.isDestroyed()) return;
  window.show();
  window.focus();
}

function focusRelativeTab(window: BrowserWindow, offset: -1 | 1): void {
  const current = tabs.get(window);
  if (!current) return;
  const group = tabs.group(current.groupId);
  const index = group.findIndex((record) => record.window === window);
  if (index < 0 || group.length < 2) return;
  focusTab(group[(index + offset + group.length) % group.length]?.window);
}

async function closeSessionOwner(
  ownerId: string,
  fallbackSessionIds: ReadonlySet<string>,
  transfers: readonly SessionOwnerTransfer[] = [],
): Promise<void> {
  const client = backend?.automation;
  if (!client) return;
  try {
    await client.closeSessionOwner(ownerId, transfers);
  } catch (ownerError) {
    console.warn(`[terminal-runtime] failed to close tab session owner ${ownerId}`, ownerError);
    // An older external daemon cannot transfer ownership safely. End only the
    // sessions no surviving window references; preserving a mirror is more
    // important than eagerly reclaiming an old-daemon session.
    const orderedSessionIds = [...fallbackSessionIds];
    const results = await Promise.allSettled(
      orderedSessionIds.map(async (sessionId) => {
        await client.terminate(sessionId, "user");
      }),
    );
    results.forEach((result, index) => {
      if (result.status === "rejected") {
        const sessionId = orderedSessionIds[index];
        console.warn(`[terminal-runtime] failed to terminate closed-tab session ${sessionId}`, result.reason);
      }
    });
  }
}

function terminateClosedTabSessions(
  ownerId: string,
  fallbackSessionIds: ReadonlySet<string>,
  transfers: readonly SessionOwnerTransfer[],
): void {
  if (quitting || !backend) return;
  const task = closeSessionOwner(ownerId, fallbackSessionIds, transfers);
  closingSessionOwners.add(task);
  void task.finally(() => closingSessionOwners.delete(task));
}

interface CreateWindowOptions {
  tabOf?: BrowserWindow;
  initialCwd?: string | undefined;
  claimExistingSessions?: boolean;
}

async function createWindow(options: CreateWindowOptions = {}): Promise<BrowserWindow> {
  await ensureBackend();

  const parentRecord = options.tabOf ? tabs.get(options.tabOf) : undefined;
  const groupId = parentRecord?.groupId ?? `ghosttea-${profile.name}-${randomUUID()}`;
  const tabId = randomUUID();
  const claimExistingSessions = options.claimExistingSessions ?? tabs.records().length === 0;
  const additionalArguments = [
    `--ghosttea-tab-id=${tabId}`,
    `--ghosttea-tab-claim-existing=${claimExistingSessions ? "1" : "0"}`,
    `--ghosttea-managed-config-editor=${externalBackendConfigured() ? "0" : "1"}`,
    ...(options.initialCwd ? [`--ghosttea-tab-cwd=${encodeURIComponent(options.initialCwd)}`] : []),
  ];

  const window = new BrowserWindow({
    width: 800,
    height: 600,
    minWidth: 320,
    minHeight: 180,
    show: false,
    title: "Ghosttea",
    // Transparent BrowserWindows are immutable after construction. Keep the
    // macOS surface alpha-capable even when the active theme is opaque so a
    // later config reload can lower background-opacity without recreating it.
    backgroundColor: process.platform === "darwin" ? "#00000000" : "#282c34",
    transparent: process.platform === "darwin",
    // A transparent macOS window leaves the default titlebar surface visually
    // empty. Extend content into it so the renderer can paint a visible bar,
    // while hiddenInset keeps the native traffic-light controls available.
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    ...(process.platform === "darwin" ? { tabbingIdentifier: groupId, trafficLightPosition: { x: 12, y: 8 } } : {}),
    acceptFirstMouse: true,
    fullscreenable: true,
    autoHideMenuBar: process.platform !== "darwin",
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      backgroundThrottling: true,
      additionalArguments,
    },
  });
  const windowWebContents = window.webContents;
  const record = tabs.add(window, tabId, groupId);
  if (options.tabOf && process.platform === "darwin" && !options.tabOf.isDestroyed()) {
    options.tabOf.addTabbedWindow(window);
  }
  const revealWindow = (): void => {
    if (window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    if (process.platform === "darwin") app.focus({ steal: true });
    window.show();
    window.focus();
    if (!app.isPackaged) {
      const bounds = window.getBounds();
      console.log(
        `[terminal-runtime] window revealed: visible=${window.isVisible()} focused=${window.isFocused()} bounds=${bounds.x},${bounds.y} ${bounds.width}x${bounds.height}`,
      );
    }
  };
  window.once("ready-to-show", revealWindow);
  window.on("focus", () => {
    lastFocusedWindow = window;
  });
  window.on("new-window-for-tab", () => {
    void createWindow({ tabOf: window, initialCwd: record.activeCwd }).catch((error) =>
      console.error("failed to create native tab", error),
    );
  });
  window.once("closed", () => {
    dirtyConfigEditorSenders.delete(windowWebContents);
    const closed = tabs.delete(window);
    if (lastFocusedWindow === window) lastFocusedWindow = undefined;
    if (!closed) return;
    terminateClosedTabSessions(closed.id, tabs.unreferencedSessionIds(closed.sessionIds), tabs.sessionOwnerTransfers());
  });
  window.on("close", (event) => guardDirtyConfigEditorClose(window, event));
  window.webContents.on("preload-error", (_event, preloadPath, error) => {
    console.error(`[terminal-runtime] preload failed at ${preloadPath}: ${error.stack ?? error.message}`);
  });
  window.webContents.on("did-start-navigation", (_event, _url, isInPlace, isMainFrame) => {
    if (isMainFrame && !isInPlace) dirtyConfigEditorSenders.delete(windowWebContents);
  });
  // Terminal selections live in the render worker rather than the DOM, so
  // Electron's native edit role cannot copy them. Route the shortcut through
  // the same renderer command path as the terminal context menu.
  installGhostteaEditShortcuts(
    window.webContents,
    (command) => window.webContents.send("terminal-menu-action", command),
    process.platform,
    (command) => command !== "copy" || clipboardHost.canCopy(window.webContents),
  );

  if (!app.isPackaged) {
    window.webContents.on("console-message", (details) => {
      if (details.message.startsWith("[terminal-runtime]")) {
        console.log(details.message);
      }
    });
  }

  window.webContents.on("did-finish-load", () => {
    if (window.isDestroyed() || !backend?.running) return;
    console.log("[terminal-runtime] renderer loaded; transferring ports");
    backend.attachRenderer(window.webContents);
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    await window.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    await window.loadFile(join(__dirname, "../renderer/index.html"));
  }
  // `ready-to-show` can be delayed indefinitely while an initially hidden
  // WebGPU renderer continuously paints. Loading has completed at this point,
  // so reveal explicitly while keeping the event listener as the fast path.
  revealWindow();
  return window;
}

app
  .whenReady()
  .then(() => {
    if (!ownsProfile) return;
    return createWindow();
  })
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (tabs.records().length === 0) {
    void createWindow({ claimExistingSessions: true }).catch((error) =>
      console.error("failed to recreate window", error),
    );
  } else {
    focusMainWindow();
  }
});

app.on("second-instance", (_event, _argv, _workingDirectory, additionalData) => {
  if ((additionalData as { profile?: unknown }).profile !== profile.name) return;
  focusMainWindow();
});

app.on("before-quit", (event) => {
  if (!discardDraftsApprovedForQuit) {
    const dirtyWindows = BrowserWindow.getAllWindows().filter((window) =>
      dirtyConfigEditorSenders.has(window.webContents),
    );
    if (dirtyWindows.length > 0) {
      event.preventDefault();
      if (!quitDraftConfirmation) {
        const owner = (
          lastFocusedWindow && dirtyWindows.includes(lastFocusedWindow) ? lastFocusedWindow : dirtyWindows[0]
        )!;
        quitDraftConfirmation = confirmDiscardConfigDraft(owner, true)
          .then((discard) => {
            if (!discard) return;
            dirtyConfigEditorSenders.clear();
            discardDraftsApprovedForQuit = true;
            app.quit();
          })
          .finally(() => {
            quitDraftConfirmation = undefined;
          });
      }
      return;
    }
  }
  if (quitCleanupComplete) {
    quitting = true;
    return;
  }
  event.preventDefault();
  if (quitCleanup) return;
  quitting = true;
  const ownerClosures = tabs.records().map((record) => closeSessionOwner(record.id, record.sessionIds));
  quitCleanup = allSettledWithin([...closingSessionOwners, ...ownerClosures], QUIT_CLEANUP_TIMEOUT_MS).then(
    async (settled) => {
      if (!settled) console.warn("terminal session cleanup timed out during quit");
      try {
        await backend?.stop();
      } catch (error) {
        console.error("terminal backend shutdown failed", error);
      }
      quitCleanupComplete = true;
      app.quit();
    },
  );
});
