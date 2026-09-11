export const PROTOCOL_MAJOR = 1;
export const PROTOCOL_MINOR = 16;
export const SESSION_SCROLLBACK_PROTOCOL_MINOR = 15;
export const STRUCTURED_ERROR_PROTOCOL_MINOR = 16;
export const CONFIG_SCHEMA_VERSION = 1;
export const CONFIG_DOCUMENT_SCHEMA_VERSION = 1;

export * from "./routed.js";

export type ConfigDiagnosticSeverity = "info" | "warning" | "error";
export type ConfigSupport = "applied" | "parsed" | "unsupported";
export type ConfigSourceKind = "ghostty-default" | "included" | "ghosttea-overlay";
export type RendererPostProcess = "none" | "better-crt";

export interface ConfigCompatibility {
  ghosttyVersion: string;
  ghosttyCommit: string;
  knownKeyCount: number;
}

export interface ConfigSource {
  path: string;
  kind: ConfigSourceKind;
}

export interface ConfigDiagnostic {
  severity: ConfigDiagnosticSeverity;
  code: string;
  message: string;
  source?: string;
  line?: number;
  key?: string;
}

export interface ConfiguredKey {
  key: string;
  support: ConfigSupport;
  occurrences: number;
}

export interface TerminalConfig {
  scrollbackBytes: number;
  foreground: [number, number, number];
  background: [number, number, number];
  cursor: [number, number, number];
  /** Sparse overrides layered over libghostty's default 256-color palette. */
  palette?: PaletteConfigEntry[];
}

export interface PaletteConfigEntry {
  index: number;
  color: [number, number, number];
}

export interface RendererConfig {
  linkUrl?: boolean;
  foreground: [number, number, number];
  background: [number, number, number];
  cursor: [number, number, number];
  cursorText?: [number, number, number];
  selectionBackground: [number, number, number];
  selectionForeground: [number, number, number];
  palette?: PaletteConfigEntry[];
  backgroundOpacity?: number;
  backgroundOpacityCells?: boolean;
  fontSize: number;
  fontFamilies: string[];
  paddingX: [number, number];
  paddingY: [number, number];
  postProcess: RendererPostProcess;
  /** Ordered IDs resolved by Ghosttea's bundled WGSL shader registry. */
  shaderEffects?: string[];
  customShaderAnimation?: boolean;
  customShaderPaths: string[];
}

export interface ConfigKeybinding {
  trigger: string;
  action: string;
}

export interface WorkspaceConfig {
  keybindings: ConfigKeybinding[];
  clearKeybindings: boolean;
}

/** Versioned, platform-neutral projection of a Ghostty-syntax configuration. */
export interface ConfigSnapshot {
  schemaVersion: number;
  revision: string;
  compatibility: ConfigCompatibility;
  sources: ConfigSource[];
  diagnostics: ConfigDiagnostic[];
  configuredKeys: ConfiguredKey[];
  terminal: TerminalConfig;
  renderer: RendererConfig;
  workspace: WorkspaceConfig;
}

/** Exact UTF-8 contents of the daemon's app-owned final overlay. */
export interface ConfigDocument {
  schemaVersion: number;
  revision: string;
  path: string;
  exists: boolean;
  contents: string;
}

export interface ConfigDocumentValidation {
  documentRevision: string;
  config: ConfigSnapshot;
}

export interface ConfigDocumentUpdate {
  document: ConfigDocument;
  config: ConfigSnapshot;
}

/** How long a session outlives the thing that asked for it. */
export type SessionPersistence = "terminate-with-app" | "keep-until-exit" | "keep-until-explicit-close";

export type SessionActivityKind = "shell-idle" | "foreground-job" | "unknown";
export type SessionActivitySource = "shell-integration" | "process-group" | "unsupported";
export type SessionActivityConfidence = "authoritative" | "heuristic";

export interface SessionActivity {
  kind: SessionActivityKind;
  source: SessionActivitySource;
  confidence: SessionActivityConfidence;
  rootProcessGroupId: number | null;
  foregroundProcessGroupId: number | null;
  observedAtMs: number;
}

export function unknownSessionActivity(): SessionActivity {
  return {
    kind: "unknown",
    source: "unsupported",
    confidence: "heuristic",
    rootProcessGroupId: null,
    foregroundProcessGroupId: null,
    observedAtMs: 0,
  };
}

/**
 * How much of a session a selection could reach. Open by design: a daemon may
 * report a scope this client predates, and a hint it does not recognize is
 * ignored rather than treated as a protocol violation.
 */
export type SelectionScopeKind = "viewport" | "scrollback" | (string & {});

/** Viewer-side lifecycle of a session replicated from a remote host. */
export type RemoteSessionState = "opening" | "live" | "synchronizing" | "reconnecting" | "suspended" | "ended";

/** Why a remote session reached its terminal state. Claimed only on evidence. */
export type RemoteSessionEndReason =
  "session-closed" | "session-exited" | "session-unavailable" | "host-restarted" | "host-shutdown" | "closed-locally";

export interface RemoteSessionExit {
  code: number | null;
}

export type RemoteViewState = "pending" | "attached" | "failed";

export interface RemoteControllerInfo {
  viewId: string;
  controlEpoch: number;
}

export interface RemoteViewRecord {
  viewId: string;
  /** Monotonic per view; consumers drop anything at or below the last applied. */
  viewStateSeq: number;
  viewState: RemoteViewState;
  /**
   * Null whenever the view is not attached. There is no authoritative epoch or
   * access level without a live attachment, and inventing either reintroduces
   * the stale-epoch bug this schema exists to prevent.
   */
  attachmentEpoch: number | null;
  readWrite: boolean | null;
  error: string | null;
  retryable: boolean | null;
}

export interface RemoteSessionLifecycle {
  /** Monotonic per session; orders every lifecycle transition. */
  lifecycleSeq: number;
  deviceId: string;
  deviceName: string;
  state: RemoteSessionState;
  reason: RemoteSessionEndReason | null;
  exit: RemoteSessionExit | null;
  attempt: number | null;
  nextRetryMs: number | null;
  lastContactMs: number | null;
}

/** Complete client state for one remote session, rebuilt from the daemon. */
export interface RemoteSessionStateSnapshot extends RemoteSessionLifecycle {
  controller: RemoteControllerInfo | null;
  /** 0 means "legacy host, unknown": revisioned authorities start at 1. */
  controlRevision: number;
  cols: number;
  rows: number;
  layoutEpoch: number;
  views: RemoteViewRecord[];
}

export type SessionEnvironment =
  { mode: "inherit"; overrides?: Record<string, string> } | { mode: "clean"; variables: Record<string, string> };

export type TerminationSource = "user" | "application" | "service-shutdown";

export type ExitOutcome =
  | "completed"
  | "crashed"
  | "signaled"
  | "user-terminated"
  | "application-terminated"
  | "service-terminated"
  | "unknown";

export type AutomationInputOperation =
  { kind: "text"; text: string } | { kind: "paste"; text: string; submit: boolean } | { kind: "interrupt" };

export interface CreateSessionOptions {
  executable: string;
  args: string[];
  cwd?: string;
  /** @deprecated Prefer the explicit environment policy. */
  env?: Record<string, string>;
  environment?: SessionEnvironment;
  cols: number;
  rows: number;
  persistence: SessionPersistence;
  /**
   * Helps activity detection distinguish an interactive shell that owns the
   * foreground process group from a directly launched application.
   */
  programKind?: "interactive-shell" | "application" | "auto";
  /** Application-defined lifecycle owner, such as an Electron tab ID. */
  ownerId?: string;
  /**
   * Per-session scrollback cap in bytes. Zero disables scrollback; absence
   * delegates to the daemon's current global default. Requires protocol 1.15.
   */
  scrollbackBytes?: number;
}

export function isValidScrollbackBytes(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

/** Re-home a session before its current application owner is closed. */
export interface SessionOwnerTransfer {
  sessionId: string;
  ownerId: string;
}

export type ClientCommand =
  | { requestId: number; type: "hello"; protocolMajor: number; protocolMinor: number; clientBuild: string }
  | { requestId: number; type: "get-config" }
  | { requestId: number; type: "reload-config" }
  | { requestId: number; type: "get-config-document" }
  | { requestId: number; type: "validate-config-document"; contents: string }
  | {
      requestId: number;
      type: "replace-config-document";
      expectedRevision: string;
      contents: string;
    }
  | { requestId: number; type: "create-session"; options: CreateSessionOptions }
  | { requestId: number; type: "list-sessions" }
  | { requestId: number; type: "list-remote-hosts" }
  | { requestId: number; type: "list-remote-sessions"; deviceId: string }
  | {
      requestId: number;
      type: "open-remote-session";
      deviceId: string;
      remoteSessionId: string;
      cols: number;
      rows: number;
      ownerId?: string;
    }
  | { requestId: number; type: "get-remote-session-state"; sessionId: string }
  /** One-shot resume attempt: re-dial, re-attach, and report the outcome. */
  | { requestId: number; type: "reconnect-remote-session"; sessionId: string }
  | { requestId: number; type: "retry-remote-view"; sessionId: string; viewId: string }
  | { requestId: number; type: "get-session"; sessionId: string }
  | { requestId: number; type: "refresh-session"; sessionId: string }
  | { requestId: number; type: "attach-session"; sessionId: string; viewId: string; ownerId?: string }
  | { requestId: number; type: "detach-session"; sessionId: string; viewId: string }
  | (ViewInputIdentity & { requestId: number; type: "send-text"; sessionId: string; text: string })
  | (ViewInputIdentity & { requestId: number; type: "paste"; sessionId: string; text: string })
  | (ViewInputIdentity & { requestId: number; type: "send-key"; sessionId: string; event: TerminalKeyEvent })
  | (ViewInputIdentity & { requestId: number; type: "send-mouse"; sessionId: string; event: TerminalMouseEvent })
  | (ViewInputIdentity & { requestId: number; type: "scroll"; sessionId: string; rows: number })
  | (ViewInputIdentity & { requestId: number; type: "scroll-to"; sessionId: string; row: number })
  | (ViewInputIdentity & { requestId: number; type: "focus"; sessionId: string; focused: boolean })
  | {
      requestId: number;
      type: "focus-and-resize";
      sessionId: string;
      viewId: string;
      attachmentEpoch: number;
      cols: number;
      rows: number;
      /**
       * Take control only if the controller revision is still the one this
       * client observed, so a claim or a clear that intervened rejects instead
       * of silently overwriting. Omitted is an unconditional last-write-wins
       * claim — the only thing a host without revisions understands, and what
       * a deliberate user action still sends.
       *
       * Never derived from revision 0, which means "legacy, unknown".
       */
      expectedControlRevision?: number;
    }
  | {
      requestId: number;
      type: "resize";
      sessionId: string;
      viewId: string;
      attachmentEpoch: number;
      controlEpoch: number;
      resizeSequence: number;
      cols: number;
      rows: number;
    }
  | {
      requestId: number;
      type: "set-colors";
      sessionId: string;
      foreground: [number, number, number];
      background: [number, number, number];
      cursor: [number, number, number];
    }
  | {
      requestId: number;
      type: "selection-text";
      sessionId: string;
      viewId: string;
      attachmentEpoch: number;
      startColumn: number;
      startRow: number;
      endColumn: number;
      endRow: number;
      selectAll: boolean;
    }
  | (ViewInputIdentity & { requestId: number; type: "interrupt"; sessionId: string })
  | { requestId: number; type: "get-automation-state"; sessionId: string }
  | {
      requestId: number;
      type: "automation-input";
      sessionId: string;
      expectedHumanInputEpoch: number;
      operation: AutomationInputOperation;
    }
  | { requestId: number; type: "terminate"; sessionId: string; source?: TerminationSource }
  /** Re-class a live, locally governed session; answered with the updated summary. */
  | { requestId: number; type: "set-persistence"; sessionId: string; persistence: SessionPersistence }
  | {
      requestId: number;
      type: "close-session-owner";
      ownerId: string;
      /** Layout-known survivors; live attached views provide a second authority. */
      transfers?: SessionOwnerTransfer[];
    };

export type PrivilegedConfigDocumentCommand = Extract<
  ClientCommand,
  {
    type: "get-config-document" | "validate-config-document" | "replace-config-document";
  }
>;

const RENDERER_CLIENT_COMMAND_TYPES = [
  "hello",
  "get-config",
  "reload-config",
  "create-session",
  "list-sessions",
  "list-remote-hosts",
  "list-remote-sessions",
  "open-remote-session",
  "get-remote-session-state",
  "reconnect-remote-session",
  "retry-remote-view",
  "get-session",
  "refresh-session",
  "attach-session",
  "detach-session",
  "send-text",
  "paste",
  "send-key",
  "send-mouse",
  "scroll",
  "scroll-to",
  "focus",
  "focus-and-resize",
  "resize",
  "set-colors",
  "selection-text",
  "interrupt",
  "get-automation-state",
  "automation-input",
  "terminate",
  "set-persistence",
  "close-session-owner",
] as const satisfies readonly ClientCommand["type"][];

/**
 * Commands accepted from an untrusted renderer through the Electron bridge.
 *
 * This is derived from an explicit allowlist so newly added daemon commands
 * remain unavailable to renderers until their trust boundary has been
 * reviewed.
 */
export type RendererClientCommand = Extract<ClientCommand, { type: (typeof RENDERER_CLIENT_COMMAND_TYPES)[number] }>;

const RENDERER_CLIENT_COMMAND_TYPE_SET: ReadonlySet<string> = new Set(RENDERER_CLIENT_COMMAND_TYPES);

export function isRendererClientCommandAllowed(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    RENDERER_CLIENT_COMMAND_TYPE_SET.has(String((value as { type?: unknown }).type))
  );
}

export interface SessionSummary {
  id: string;
  handle: string;
  executable: string;
  cols: number;
  rows: number;
  exited: boolean;
  readWrite: boolean;
  title: string | null;
  cwd: string | null;
  bellCount: number;
  pid: number | null;
  createdAtMs: number;
  exitCode: number | null;
  exitSignal: string | null;
  requestedTermination: TerminationSource | null;
  exitOutcome: ExitOutcome | null;
  ownerId: string | null;
  /**
   * The retention class this session is governed by, or `null` for a replica
   * of a session another host governs. Also `null` from daemons older than
   * protocol 1.9, which did not report it.
   */
  persistence: SessionPersistence | null;
  /**
   * Effective local cap. Absent from pre-1.15 daemons and null for replicas
   * whose retention is governed by another host.
   */
  scrollbackBytes?: number | null;
  activity: SessionActivity;
}

export interface ViewInputIdentity {
  viewId: string;
  attachmentEpoch: number;
  inputSequence: number;
}

export interface SharedSessionSummary {
  sessionId: string;
  title: string;
  cwdLabel: string | null;
  running: boolean;
  attachable: boolean;
  readWrite: boolean;
  createdAtMs: number;
  activity: SessionActivity;
}

export interface RemoteHostSummary {
  deviceId: string;
  deviceName: string;
  online: boolean;
  protocolMajor: number;
  protocolMinor: number;
  hostInstanceId: string;
  sessions: SharedSessionSummary[];
}

export type ServerEvent =
  | {
      requestId: number;
      type: "hello";
      protocolMajor: number;
      protocolMinor: number;
      serverBuild: string;
      /** Absent on daemons before protocol 1.10. */
      configRevision?: string;
    }
  | { requestId: number; type: "config"; config: ConfigSnapshot }
  | { requestId: number; type: "config-document"; document: ConfigDocument }
  | {
      requestId: number;
      type: "config-document-validation";
      documentRevision: string;
      config: ConfigSnapshot;
    }
  | {
      requestId: number;
      type: "config-document-updated";
      document: ConfigDocument;
      config: ConfigSnapshot;
    }
  | {
      requestId: number;
      type: "config-document-conflict";
      document: ConfigDocument;
    }
  | { requestId: number; type: "session-created"; session: SessionSummary }
  | { requestId: number; type: "session"; session: SessionSummary }
  | { requestId: number; type: "sessions"; sessions: SessionSummary[] }
  | { requestId: number; type: "remote-hosts"; hosts: RemoteHostSummary[] }
  | { requestId: number; type: "remote-sessions"; deviceId: string; sessions: SharedSessionSummary[] }
  | {
      requestId: number;
      type: "view-attached";
      sessionId: string;
      viewId: string;
      attachmentEpoch: number;
      readWrite: boolean;
      /**
       * Places this response inside the per-view ordering fence. Absent from
       * daemons before protocol 1.12, whose responses apply directly.
       */
      viewStateSeq?: number;
    }
  | ({ requestId: number; type: "remote-session-state" } & RemoteSessionStateSnapshot)
  | ({ requestId: number; type: "view-state"; sessionId: string } & RemoteViewRecord)
  | {
      requestId: number;
      type: "control-claimed";
      sessionId: string;
      controllerViewId: string;
      controlEpoch: number;
      /** Absent from daemons before protocol 1.13. */
      controlRevision?: number;
      cols: number;
      rows: number;
      layoutEpoch: number;
    }
  /**
   * A compare-and-swap claim lost to a change that landed first, answered with
   * the state that beat it. Distinct from `control-claimed` because that shape
   * cannot say "nobody holds control" — the one outcome §4.2.3 allows a client
   * to retry. Reachable only in answer to a claim that carried
   * `expectedControlRevision`, which keeps it away from clients that predate it.
   */
  | {
      requestId: number;
      type: "control-rejected";
      sessionId: string;
      controller: RemoteControllerInfo | null;
      controlRevision: number;
      cols: number;
      rows: number;
      layoutEpoch: number;
    }
  | { requestId: number; type: "automation-state"; sessionId: string; humanInputEpoch: number }
  | {
      requestId: number;
      type: "selection-text";
      text: string;
      /**
       * What the daemon could reach. `viewport` means the answer came from a
       * frozen replica's retained screen, so scrollback is not included.
       * Absent from daemons that always answered from the host.
       */
      scope?: SelectionScopeKind;
    }
  | {
      requestId: number;
      type: "automation-input-result";
      sessionId: string;
      accepted: boolean;
      humanInputEpoch: number;
      inputSequence: number | null;
      reason: "human-input-conflict" | null;
    }
  | { requestId: number; type: "ok" }
  | {
      requestId: number;
      type: "error";
      message: string;
      /** Stable failing operation, available from protocol 1.16 daemons. */
      stage?: string;
      /** Stable service classification when the failure site knows one. */
      code?: string;
      /** Raw platform error number while a typed OS error is still present. */
      osError?: number;
    }
  | { requestId: 0; type: "bridge-error"; message: string }
  | {
      requestId: 0;
      type: "session-exited";
      sessionId: string;
      exitCode: number | null;
      exitSignal: string | null;
      requestedTermination: TerminationSource | null;
      exitOutcome: ExitOutcome;
    }
  | {
      requestId: 0;
      type: "control-changed";
      sessionId: string;
      controllerViewId: string;
      controlEpoch: number;
      cols: number;
      rows: number;
      layoutEpoch: number;
    }
  | ({ requestId: 0; type: "remote-session-state-changed"; sessionId: string } & RemoteSessionLifecycle)
  | ({ requestId: 0; type: "view-state-changed"; sessionId: string } & RemoteViewRecord)
  /**
   * Supersedes `control-changed` for clients that negotiated protocol 1.12.
   * Unlike it, this can say "no controller", which is the only way a lost
   * controller clear can ever be repaired.
   */
  | {
      requestId: 0;
      type: "control-state";
      sessionId: string;
      controller: RemoteControllerInfo | null;
      controlRevision: number;
      cols: number;
      rows: number;
      layoutEpoch: number;
    }
  | { requestId: 0; type: "session-activity-changed"; sessionId: string; activity: SessionActivity }
  | { requestId: 0; type: "config-changed"; config: ConfigSnapshot }
  /**
   * The daemon produced events faster than this client drained them and the
   * overflow was dropped. Any of the lost events could have been a
   * session-exited, so consumers should re-list sessions and reconcile.
   */
  | { requestId: 0; type: "events-lost"; skipped: number };

export interface TerminalKeyEvent {
  type: "down" | "up";
  key: string;
  code: string;
  location: number;
  repeat: boolean;
  shift: boolean;
  control: boolean;
  alt: boolean;
  meta: boolean;
  timestamp: number;
  /** Layout-aware Unicode codepoint for this physical key with modifiers removed. */
  unshiftedCodepoint?: number;
}

export interface TerminalMouseEvent {
  action: "press" | "release" | "motion";
  button: number;
  x: number;
  y: number;
  screenWidth: number;
  screenHeight: number;
  cellWidth: number;
  cellHeight: number;
  paddingLeft: number;
  paddingTop: number;
  shift: boolean;
  control: boolean;
  alt: boolean;
  meta: boolean;
}

export interface TerminalScrollbarState {
  /** Total rows in scrollback plus the active screen. */
  total: number;
  /** First visible row, measured from the top of scrollback. */
  offset: number;
  /** Number of visible terminal rows. */
  length: number;
}

export function isServerEvent(value: unknown): value is ServerEvent {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  if (
    !Number.isSafeInteger(candidate.requestId) ||
    (candidate.requestId as number) < 0 ||
    typeof candidate.type !== "string"
  )
    return false;
  const validPersistence = (persistence: unknown): boolean =>
    persistence === "terminate-with-app" ||
    persistence === "keep-until-exit" ||
    persistence === "keep-until-explicit-close";
  const validTerminationSource = (source: unknown): boolean =>
    source === null || source === "user" || source === "application" || source === "service-shutdown";
  const validExitOutcome = (outcome: unknown): boolean =>
    outcome === "completed" ||
    outcome === "crashed" ||
    outcome === "signaled" ||
    outcome === "user-terminated" ||
    outcome === "application-terminated" ||
    outcome === "service-terminated" ||
    outcome === "unknown";
  const validActivity = (activity: unknown): activity is SessionActivity => {
    if (!activity || typeof activity !== "object") return false;
    const value = activity as Record<string, unknown>;
    return (
      (value.kind === "shell-idle" || value.kind === "foreground-job" || value.kind === "unknown") &&
      (value.source === "shell-integration" || value.source === "process-group" || value.source === "unsupported") &&
      (value.confidence === "authoritative" || value.confidence === "heuristic") &&
      (value.rootProcessGroupId === null || Number.isSafeInteger(value.rootProcessGroupId)) &&
      (value.foregroundProcessGroupId === null || Number.isSafeInteger(value.foregroundProcessGroupId)) &&
      Number.isSafeInteger(value.observedAtMs) &&
      (value.observedAtMs as number) >= 0
    );
  };
  const normalizeActivity = (summary: Record<string, unknown>): boolean => {
    if (summary.activity === undefined) summary.activity = unknownSessionActivity();
    return validActivity(summary.activity);
  };
  /** Daemons before protocol 1.9 report no class; that reads as "unknown", not invalid. */
  const normalizePersistence = (summary: Record<string, unknown>): boolean => {
    if (summary.persistence === undefined) summary.persistence = null;
    return summary.persistence === null || validPersistence(summary.persistence);
  };
  const validSession = (session: unknown): boolean => {
    if (!session || typeof session !== "object") return false;
    const summary = session as Record<string, unknown>;
    return (
      typeof summary.id === "string" &&
      typeof summary.handle === "string" &&
      typeof summary.executable === "string" &&
      Number.isSafeInteger(summary.cols) &&
      Number.isSafeInteger(summary.rows) &&
      typeof summary.exited === "boolean" &&
      typeof summary.readWrite === "boolean" &&
      (summary.title === null || typeof summary.title === "string") &&
      (summary.cwd === null || typeof summary.cwd === "string") &&
      Number.isSafeInteger(summary.bellCount) &&
      (summary.pid === null || Number.isSafeInteger(summary.pid)) &&
      Number.isSafeInteger(summary.createdAtMs) &&
      (summary.exitCode === null || Number.isSafeInteger(summary.exitCode)) &&
      (summary.exitSignal === null || typeof summary.exitSignal === "string") &&
      validTerminationSource(summary.requestedTermination) &&
      (summary.exitOutcome === null || validExitOutcome(summary.exitOutcome)) &&
      (summary.ownerId === null || typeof summary.ownerId === "string") &&
      normalizePersistence(summary) &&
      (summary.scrollbackBytes === undefined ||
        summary.scrollbackBytes === null ||
        (Number.isSafeInteger(summary.scrollbackBytes) && Number(summary.scrollbackBytes) >= 0)) &&
      normalizeActivity(summary)
    );
  };
  const validSharedSession = (session: unknown): boolean => {
    if (!session || typeof session !== "object") return false;
    const summary = session as Record<string, unknown>;
    return (
      typeof summary.sessionId === "string" &&
      typeof summary.title === "string" &&
      (summary.cwdLabel === null || typeof summary.cwdLabel === "string") &&
      typeof summary.running === "boolean" &&
      typeof summary.attachable === "boolean" &&
      typeof summary.readWrite === "boolean" &&
      Number.isSafeInteger(summary.createdAtMs) &&
      normalizeActivity(summary)
    );
  };
  const nullableInteger = (value: unknown): boolean => value === null || Number.isSafeInteger(value);
  const validController = (controller: unknown): boolean => {
    if (controller === null) return true;
    if (!controller || typeof controller !== "object") return false;
    const value = controller as Record<string, unknown>;
    return typeof value.viewId === "string" && Number.isSafeInteger(value.controlEpoch);
  };
  const validLifecycle = (candidate: Record<string, unknown>): boolean =>
    Number.isSafeInteger(candidate.lifecycleSeq) &&
    typeof candidate.deviceId === "string" &&
    typeof candidate.deviceName === "string" &&
    ["opening", "live", "synchronizing", "reconnecting", "suspended", "ended"].includes(String(candidate.state)) &&
    (candidate.reason === null ||
      [
        "session-closed",
        "session-exited",
        "session-unavailable",
        "host-restarted",
        "host-shutdown",
        "closed-locally",
      ].includes(String(candidate.reason))) &&
    (candidate.exit === null ||
      (Boolean(candidate.exit) &&
        typeof candidate.exit === "object" &&
        nullableInteger((candidate.exit as Record<string, unknown>).code))) &&
    nullableInteger(candidate.attempt) &&
    nullableInteger(candidate.nextRetryMs) &&
    nullableInteger(candidate.lastContactMs);
  const validViewRecord = (view: unknown): boolean => {
    if (!view || typeof view !== "object") return false;
    const record = view as Record<string, unknown>;
    return (
      typeof record.viewId === "string" &&
      Number.isSafeInteger(record.viewStateSeq) &&
      ["pending", "attached", "failed"].includes(String(record.viewState)) &&
      nullableInteger(record.attachmentEpoch) &&
      (record.readWrite === null || typeof record.readWrite === "boolean") &&
      (record.error === null || typeof record.error === "string") &&
      (record.retryable === null || typeof record.retryable === "boolean")
    );
  };
  const validByteColor = (color: unknown): boolean =>
    Array.isArray(color) &&
    color.length === 3 &&
    color.every((component) => Number.isSafeInteger(component) && component >= 0 && component <= 255);
  const validPalette = (palette: unknown): boolean =>
    Array.isArray(palette) &&
    palette.every(
      (entry) =>
        Boolean(entry) &&
        typeof entry === "object" &&
        Number.isSafeInteger((entry as Record<string, unknown>).index) &&
        Number((entry as Record<string, unknown>).index) >= 0 &&
        Number((entry as Record<string, unknown>).index) <= 255 &&
        validByteColor((entry as Record<string, unknown>).color),
    );
  const validPair = (pair: unknown): boolean =>
    Array.isArray(pair) &&
    pair.length === 2 &&
    pair.every((component) => typeof component === "number" && Number.isFinite(component) && component >= 0);
  const validConfig = (config: unknown): config is ConfigSnapshot => {
    if (!config || typeof config !== "object") return false;
    const snapshot = config as Record<string, unknown>;
    if (!snapshot.compatibility || typeof snapshot.compatibility !== "object") return false;
    const compatibility = snapshot.compatibility as Record<string, unknown>;
    if (!snapshot.terminal || typeof snapshot.terminal !== "object") return false;
    const terminal = snapshot.terminal as Record<string, unknown>;
    if (!snapshot.renderer || typeof snapshot.renderer !== "object") return false;
    const renderer = snapshot.renderer as Record<string, unknown>;
    if (!snapshot.workspace || typeof snapshot.workspace !== "object") return false;
    const workspace = snapshot.workspace as Record<string, unknown>;
    return (
      snapshot.schemaVersion === CONFIG_SCHEMA_VERSION &&
      typeof snapshot.revision === "string" &&
      typeof compatibility.ghosttyVersion === "string" &&
      typeof compatibility.ghosttyCommit === "string" &&
      Number.isSafeInteger(compatibility.knownKeyCount) &&
      Number(compatibility.knownKeyCount) >= 0 &&
      Array.isArray(snapshot.sources) &&
      snapshot.sources.every(
        (source) =>
          Boolean(source) &&
          typeof source === "object" &&
          typeof (source as Record<string, unknown>).path === "string" &&
          ["ghostty-default", "included", "ghosttea-overlay"].includes(
            String((source as Record<string, unknown>).kind),
          ),
      ) &&
      Array.isArray(snapshot.diagnostics) &&
      snapshot.diagnostics.every(
        (diagnostic) =>
          Boolean(diagnostic) &&
          typeof diagnostic === "object" &&
          ["info", "warning", "error"].includes(String((diagnostic as Record<string, unknown>).severity)) &&
          typeof (diagnostic as Record<string, unknown>).code === "string" &&
          typeof (diagnostic as Record<string, unknown>).message === "string" &&
          ((diagnostic as Record<string, unknown>).source === undefined ||
            typeof (diagnostic as Record<string, unknown>).source === "string") &&
          ((diagnostic as Record<string, unknown>).line === undefined ||
            Number.isSafeInteger((diagnostic as Record<string, unknown>).line)) &&
          ((diagnostic as Record<string, unknown>).key === undefined ||
            typeof (diagnostic as Record<string, unknown>).key === "string"),
      ) &&
      Array.isArray(snapshot.configuredKeys) &&
      snapshot.configuredKeys.every(
        (key) =>
          Boolean(key) &&
          typeof key === "object" &&
          typeof (key as Record<string, unknown>).key === "string" &&
          ["applied", "parsed", "unsupported"].includes(String((key as Record<string, unknown>).support)) &&
          Number.isSafeInteger((key as Record<string, unknown>).occurrences) &&
          Number((key as Record<string, unknown>).occurrences) >= 0,
      ) &&
      Number.isSafeInteger(terminal.scrollbackBytes) &&
      Number(terminal.scrollbackBytes) >= 0 &&
      validByteColor(terminal.foreground) &&
      validByteColor(terminal.background) &&
      validByteColor(terminal.cursor) &&
      (terminal.palette === undefined || validPalette(terminal.palette)) &&
      validByteColor(renderer.foreground) &&
      validByteColor(renderer.background) &&
      validByteColor(renderer.cursor) &&
      (renderer.cursorText === undefined || validByteColor(renderer.cursorText)) &&
      validByteColor(renderer.selectionBackground) &&
      validByteColor(renderer.selectionForeground) &&
      (renderer.palette === undefined || validPalette(renderer.palette)) &&
      (renderer.backgroundOpacity === undefined ||
        (typeof renderer.backgroundOpacity === "number" &&
          Number.isFinite(renderer.backgroundOpacity) &&
          renderer.backgroundOpacity >= 0 &&
          renderer.backgroundOpacity <= 1)) &&
      (renderer.backgroundOpacityCells === undefined || typeof renderer.backgroundOpacityCells === "boolean") &&
      (renderer.linkUrl === undefined || typeof renderer.linkUrl === "boolean") &&
      typeof renderer.fontSize === "number" &&
      Number.isFinite(renderer.fontSize) &&
      renderer.fontSize > 0 &&
      Array.isArray(renderer.fontFamilies) &&
      renderer.fontFamilies.every((family) => typeof family === "string") &&
      validPair(renderer.paddingX) &&
      validPair(renderer.paddingY) &&
      (renderer.postProcess === "none" || renderer.postProcess === "better-crt") &&
      (renderer.shaderEffects === undefined ||
        (Array.isArray(renderer.shaderEffects) && renderer.shaderEffects.every((id) => typeof id === "string"))) &&
      (renderer.customShaderAnimation === undefined || typeof renderer.customShaderAnimation === "boolean") &&
      Array.isArray(renderer.customShaderPaths) &&
      renderer.customShaderPaths.every((path) => typeof path === "string") &&
      Array.isArray(workspace.keybindings) &&
      workspace.keybindings.every(
        (binding) =>
          Boolean(binding) &&
          typeof binding === "object" &&
          typeof (binding as Record<string, unknown>).trigger === "string" &&
          typeof (binding as Record<string, unknown>).action === "string",
      ) &&
      typeof workspace.clearKeybindings === "boolean"
    );
  };
  const validConfigDocument = (document: unknown): document is ConfigDocument => {
    if (!document || typeof document !== "object") return false;
    const value = document as Record<string, unknown>;
    return (
      value.schemaVersion === CONFIG_DOCUMENT_SCHEMA_VERSION &&
      typeof value.revision === "string" &&
      value.revision.length > 0 &&
      typeof value.path === "string" &&
      typeof value.exists === "boolean" &&
      typeof value.contents === "string"
    );
  };
  switch (candidate.type) {
    case "hello":
      return (
        typeof candidate.protocolMajor === "number" &&
        typeof candidate.protocolMinor === "number" &&
        typeof candidate.serverBuild === "string" &&
        (candidate.configRevision === undefined || typeof candidate.configRevision === "string")
      );
    case "config":
      return validConfig(candidate.config);
    case "config-document":
    case "config-document-conflict":
      return validConfigDocument(candidate.document);
    case "config-document-validation":
      return typeof candidate.documentRevision === "string" && validConfig(candidate.config);
    case "config-document-updated":
      return validConfigDocument(candidate.document) && validConfig(candidate.config);
    case "session-created":
    case "session":
      return validSession(candidate.session);
    case "sessions":
      return Array.isArray(candidate.sessions) && candidate.sessions.every(validSession);
    case "remote-hosts":
      return (
        Array.isArray(candidate.hosts) &&
        candidate.hosts.every((host) => {
          if (!host || typeof host !== "object") return false;
          const summary = host as Record<string, unknown>;
          return (
            typeof summary.deviceId === "string" &&
            typeof summary.deviceName === "string" &&
            typeof summary.online === "boolean" &&
            Number.isSafeInteger(summary.protocolMajor) &&
            Number.isSafeInteger(summary.protocolMinor) &&
            typeof summary.hostInstanceId === "string" &&
            Array.isArray(summary.sessions) &&
            summary.sessions.every(validSharedSession)
          );
        })
      );
    case "remote-sessions":
      return (
        typeof candidate.deviceId === "string" &&
        Array.isArray(candidate.sessions) &&
        candidate.sessions.every(validSharedSession)
      );
    case "view-attached":
      return (
        typeof candidate.sessionId === "string" &&
        typeof candidate.viewId === "string" &&
        Number.isSafeInteger(candidate.attachmentEpoch) &&
        typeof candidate.readWrite === "boolean" &&
        (candidate.viewStateSeq === undefined || Number.isSafeInteger(candidate.viewStateSeq))
      );
    case "remote-session-state":
      return (
        validLifecycle(candidate) &&
        validController(candidate.controller) &&
        Number.isSafeInteger(candidate.controlRevision) &&
        Number.isSafeInteger(candidate.cols) &&
        Number.isSafeInteger(candidate.rows) &&
        Number.isSafeInteger(candidate.layoutEpoch) &&
        Array.isArray(candidate.views) &&
        candidate.views.every(validViewRecord)
      );
    case "view-state":
      return typeof candidate.sessionId === "string" && validViewRecord(candidate);
    case "remote-session-state-changed":
      return candidate.requestId === 0 && typeof candidate.sessionId === "string" && validLifecycle(candidate);
    case "view-state-changed":
      return candidate.requestId === 0 && typeof candidate.sessionId === "string" && validViewRecord(candidate);
    case "control-state":
      return (
        candidate.requestId === 0 &&
        typeof candidate.sessionId === "string" &&
        validController(candidate.controller) &&
        Number.isSafeInteger(candidate.controlRevision) &&
        Number.isSafeInteger(candidate.cols) &&
        Number.isSafeInteger(candidate.rows) &&
        Number.isSafeInteger(candidate.layoutEpoch)
      );
    case "control-claimed":
      return (
        typeof candidate.sessionId === "string" &&
        typeof candidate.controllerViewId === "string" &&
        Number.isSafeInteger(candidate.controlEpoch) &&
        (candidate.controlRevision === undefined || Number.isSafeInteger(candidate.controlRevision)) &&
        Number.isSafeInteger(candidate.cols) &&
        Number.isSafeInteger(candidate.rows) &&
        Number.isSafeInteger(candidate.layoutEpoch)
      );
    case "control-rejected":
      return (
        typeof candidate.sessionId === "string" &&
        validController(candidate.controller) &&
        Number.isSafeInteger(candidate.controlRevision) &&
        Number.isSafeInteger(candidate.cols) &&
        Number.isSafeInteger(candidate.rows) &&
        Number.isSafeInteger(candidate.layoutEpoch)
      );
    case "automation-state":
      return typeof candidate.sessionId === "string" && Number.isSafeInteger(candidate.humanInputEpoch);
    case "selection-text":
      // Any string is accepted: a scope this client predates is a hint it can
      // ignore, and rejecting it here would destroy the socket over a copy.
      return (
        typeof candidate.text === "string" && (candidate.scope === undefined || typeof candidate.scope === "string")
      );
    case "automation-input-result":
      return (
        typeof candidate.sessionId === "string" &&
        typeof candidate.accepted === "boolean" &&
        Number.isSafeInteger(candidate.humanInputEpoch) &&
        (candidate.inputSequence === null || Number.isSafeInteger(candidate.inputSequence)) &&
        (candidate.reason === null || candidate.reason === "human-input-conflict")
      );
    case "ok":
      return true;
    case "error":
      return (
        typeof candidate.message === "string" &&
        (candidate.stage === undefined || typeof candidate.stage === "string") &&
        (candidate.code === undefined || typeof candidate.code === "string") &&
        (candidate.osError === undefined || Number.isSafeInteger(candidate.osError))
      );
    case "bridge-error":
      return candidate.requestId === 0 && typeof candidate.message === "string";
    case "session-exited":
      return (
        candidate.requestId === 0 &&
        typeof candidate.sessionId === "string" &&
        (candidate.exitCode === null || Number.isSafeInteger(candidate.exitCode)) &&
        (candidate.exitSignal === null || typeof candidate.exitSignal === "string") &&
        validTerminationSource(candidate.requestedTermination) &&
        validExitOutcome(candidate.exitOutcome)
      );
    case "control-changed":
      return (
        candidate.requestId === 0 &&
        typeof candidate.sessionId === "string" &&
        typeof candidate.controllerViewId === "string" &&
        Number.isSafeInteger(candidate.controlEpoch) &&
        Number.isSafeInteger(candidate.cols) &&
        Number.isSafeInteger(candidate.rows) &&
        Number.isSafeInteger(candidate.layoutEpoch)
      );
    case "session-activity-changed":
      return candidate.requestId === 0 && typeof candidate.sessionId === "string" && validActivity(candidate.activity);
    case "config-changed":
      return candidate.requestId === 0 && validConfig(candidate.config);
    case "events-lost":
      return candidate.requestId === 0 && Number.isSafeInteger(candidate.skipped);
    default:
      return false;
  }
}

/** Destinations accepted by the built-in terminal link UI and Electron opener. */
export function terminalLinkUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 8192 || /[\s\p{Cc}]/u.test(value)) return null;
  try {
    const url = new URL(value);
    if (!["http:", "https:", "mailto:", "ftp:", "ftps:"].includes(url.protocol)) return null;
    if (url.protocol === "mailto:" ? !url.pathname : !url.hostname) return null;
    return url.href;
  } catch {
    return null;
  }
}
