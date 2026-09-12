import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ComponentType,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type { ConfigSnapshot, SessionSummary } from "@vibecook/ghosttea-protocol";
import { TerminalSurface, type TerminalMenuAction } from "../TerminalSurface.js";
import { DEFAULT_EFFECTS, type TerminalEffects, type TerminalTheme } from "../renderers/types.js";
import { AppearanceSettings } from "../appearance/AppearanceSettings.js";
import type {
  GhostteaAppearanceUpdate,
  GhostteaBackdropBlurBridge,
  GhostteaConfigEditorBridge,
} from "../appearance/types.js";
import { useGhostteaRuntime } from "../context.js";
import { terminalEffectsFromConfig, terminalThemeFromConfig } from "../config.js";
import { RemoteSessionPalette, type RemoteChoice } from "./RemoteSessionPalette.js";
import { RemoteSessionBanner, useInputSuppressionHint, useRemoteSessionLifecycle } from "./RemoteSessionBanner.js";
import { paneIsFrozen } from "./remote-banner.js";
import { TERMINAL_THEMES } from "./themes.js";
import {
  appendPane,
  collectDeadPanes,
  containsPane,
  equalize,
  insertPane,
  layoutId,
  leaves,
  mountSessionInPane,
  pane,
  persistedWorkspace,
  removePane,
  resizeForPane,
  restoreNode,
  updateSession,
  updateSplit,
  type PaneNode,
  type SplitAxis,
  type SplitSizing,
} from "./pane-layout.js";
import { resolveKeyEvent, routeConsumesInput } from "../bindings/action-route.js";
import { configuredBindingsForPlatform, type GhosttyBindingEntry } from "../bindings/ghostty-bindings.js";
import type { WorkspaceEffect } from "./hotkeys.js";
import { PendingPromiseCache } from "./pending-cache.js";
import { sessionsToClaim } from "./session-scope.js";
import { createPaneFocusScheduler } from "./pane-focus.js";
import { decodeWorkspaceDocument } from "./workspace-model.js";

const DEFAULT_STORAGE_KEY = "ghosttea:workspace:v1";

export function workspaceOwnsHotkey(
  active: boolean,
  root: Pick<HTMLElement, "contains"> | null,
  target: EventTarget | null,
  activeElement: Element | null,
  blocked = false,
): boolean {
  if (!active || blocked || !root) return false;
  return (
    (target instanceof Node && root.contains(target)) || (activeElement instanceof Node && root.contains(activeElement))
  );
}

export interface GhostteaWorkspacePlatform {
  platform?: string;
  defaultShell: string;
  readClipboard: () => string | Promise<string>;
  /** Report whether the active terminal pane currently has a copyable selection. */
  setCanCopy?: (canCopy: boolean) => void;
  showContextMenu: (canCopy: boolean) => void;
  toggleFullscreen: () => void;
  closeWindow: () => void;
  /** Ghostty `new_window`. Defaults to `newTab` when omitted. */
  newWindow?: (cwd?: string) => void;
  /** Ghostty `quit`. Host should quit the app process. */
  quit?: () => void;
  /** Ghostty `close_all_windows`. */
  closeAllWindows?: () => void;
  /** Ghostty `open_config` — open config in the OS editor/folder. */
  openConfig?: () => void;
  /** Ghostty `reload_config` — re-read runtime configuration. */
  reloadConfig?: () => void;
  /** Persist a profile-wide managed appearance block and reload it. */
  saveAppearance?: (update: GhostteaAppearanceUpdate) => Promise<void>;
  /** Edit only the host's profile-owned final Ghostty overlay. */
  configEditor?: GhostteaConfigEditorBridge;
  backdropBlur?: GhostteaBackdropBlurBridge;
  newTab?: (cwd?: string) => void;
  selectTab?: (target: "previous" | "next" | "last" | number) => void;
  closeTab?: () => void;
  onMenuAction: (listener: (action: TerminalMenuAction) => void) => () => void;
}

export interface GhostteaWorkspacePane {
  id: string;
  session: SessionSummary;
}

export interface GhostteaWorkspaceContext {
  activePaneId: string | undefined;
  activeSession: SessionSummary | undefined;
  panes: readonly GhostteaWorkspacePane[];
  sessions: readonly SessionSummary[];
  addSession: (session: SessionSummary, axis?: SplitAxis) => void;
  activateSession: (sessionId: string) => void;
  mountSession: (session: SessionSummary) => void;
  placeSession: (session: SessionSummary) => void;
  createSessionInActivePane: () => Promise<SessionSummary | undefined>;
  splitActive: (axis?: SplitAxis) => Promise<SessionSummary | undefined>;
}

export interface GhostteaWorkspacePaneDecoration {
  color?: string;
  label?: string;
}

export interface GhostteaPaneRehydration {
  /** The value `paneMeta` returned for this pane when the workspace was persisted, if any. */
  meta: unknown;
  /** The session id the pane referenced when it was persisted; it is no longer live. */
  sessionId: string;
  paneId: string;
}

export interface GhostteaPaneClose {
  paneId: string;
  session: SessionSummary;
  /** Unique sessions still attached in this workspace after the pane closes. */
  remainingSessionIds: readonly string[];
}

export interface GhostteaResizeCommit {
  splitId: string;
  ratio: number;
}

export interface GhostteaResizeCommitPolicy {
  /** Maximum live-reflow cadence. Defaults to 33 ms (about 30 Hz). */
  liveIntervalMs?: number;
  /** Called after the final ratio has been committed at gesture end. */
  onCommit?: (commit: GhostteaResizeCommit) => void;
}

export interface GhostteaWorkspaceProps {
  platform: GhostteaWorkspacePlatform;
  storageKey?: string;
  sidebar?: ComponentType<{ workspace: GhostteaWorkspaceContext }>;
  /**
   * Viewer-local color and opacity override. When omitted, the live configuration
   * snapshot remains authoritative.
   */
  theme?: TerminalTheme;
  /**
   * Viewer-local shader override. When omitted, effects continue to come from the
   * live configuration snapshot. Keep this value referentially stable when practical;
   * Ghosttea also retains semantically equivalent values to avoid redundant redraws.
   */
  effects?: TerminalEffects;
  decoratePane?: ((session: SessionSummary, paneId: string) => GhostteaWorkspacePaneDecoration | undefined) | undefined;
  /** Attach durable, embedder-defined data to a pane as it is persisted; opaque to Ghosttea. */
  paneMeta?: ((session: SessionSummary, paneId: string) => unknown) | undefined;
  /**
   * Called at load for a persisted pane whose session is no longer live. Return a live session
   * to keep the pane (and its splits) in place, or null to drop it (the default behavior).
   * Panes are resolved concurrently and applied in tree order.
   */
  onRehydratePane?:
    ((context: GhostteaPaneRehydration) => Promise<SessionSummary | null> | SessionSummary | null) | undefined;
  /**
   * Notifies the embedder after a non-final pane is removed. Session lifetime
   * is host policy because the same PTY may be mirrored in another pane/window.
   */
  onPaneClose?: ((context: GhostteaPaneClose) => void) | undefined;
  onActiveSessionChange?: (session: SessionSummary | undefined) => void;
  createSplitSession?: (activeSession: SessionSummary, axis: SplitAxis) => Promise<SessionSummary>;
  /** Size new splits by halving the active pane (default) or equalizing its row/column. */
  splitSizing?: SplitSizing;
  enableRemoteSessions?: boolean;
  active?: boolean;
  showTitlebar?: boolean;
  claimExistingSessions?: boolean;
  initialCwd?: string;
  onSessionsChange?: (sessionIds: readonly string[]) => void;
  resizeCommitPolicy?: GhostteaResizeCommitPolicy;
}

interface InitialWorkspace {
  layout: PaneNode;
  activePaneId: string;
  zoomedPaneId: string | null;
}

/** Internal test seam for the workspace's host/config/default precedence. */
export function resolveWorkspaceEffects(
  effects: TerminalEffects | undefined,
  config: Pick<ConfigSnapshot, "renderer"> | undefined,
): TerminalEffects {
  return effects ?? (config ? terminalEffectsFromConfig(config) : DEFAULT_EFFECTS);
}

/** Canonicalize renderer semantics so equivalent host objects share a memo dependency. */
export function workspaceEffectsKey(effects: TerminalEffects): string {
  return JSON.stringify([effects.postProcess, effects.animate ?? false, effects.shaderEffects ?? []]);
}

function workspaceEffectsFromKey(key: string): TerminalEffects {
  const [postProcess, animate, shaderEffects] = JSON.parse(key) as [
    TerminalEffects["postProcess"],
    boolean,
    NonNullable<TerminalEffects["shaderEffects"]>,
  ];
  return { postProcess, animate, shaderEffects };
}

function windowTitle(session: SessionSummary | undefined): string {
  if (!session) return "Ghosttea";
  const title = session.title?.trim();
  if (title) return title;
  const executable = session.executable.split(/[\\/]/).pop();
  return executable || "Ghosttea";
}

export async function initializeWorkspace(
  terminalRuntime: ReturnType<typeof useGhostteaRuntime>,
  storageKey: string,
  defaultShell: string,
  claimExistingSessions: boolean,
  initialCwd: string | undefined,
  rehydratePane: (context: GhostteaPaneRehydration) => Promise<SessionSummary | null> | SessionSummary | null,
): Promise<InitialWorkspace> {
  await terminalRuntime.connect();
  const sessions = await terminalRuntime.listSessions();
  const byId = new Map(sessions.map((session) => [session.id, session]));
  let saved:
    { version?: unknown; root?: unknown; layout?: unknown; activePaneId?: unknown; zoomedPaneId?: unknown } | undefined;
  let hasSavedWorkspace = false;
  try {
    const serialized = localStorage.getItem(storageKey);
    if (serialized) {
      saved = JSON.parse(serialized) as typeof saved;
      hasSavedWorkspace = true;
    }
  } catch (error) {
    console.warn("[terminal-runtime] ignored invalid saved workspace", error);
  }
  const decodedSaved = decodeWorkspaceDocument(saved);
  const savedRoot = decodedSaved?.root ?? (saved?.version === undefined ? saved?.layout : undefined);
  const revivals = new Map<string, SessionSummary>();
  const rehydrations = new Map<string, Promise<SessionSummary | null>>();
  await Promise.all(
    collectDeadPanes(savedRoot, byId).map(async (dead) => {
      try {
        let rehydration = rehydrations.get(dead.sessionId);
        if (!rehydration) {
          // A session may be mirrored into several panes. Recreate its PTY once
          // and bind every saved pane to the same replacement session.
          rehydration = Promise.resolve().then(() =>
            rehydratePane({ meta: dead.meta, sessionId: dead.sessionId, paneId: dead.paneId }),
          );
          rehydrations.set(dead.sessionId, rehydration);
        }
        const session = await rehydration;
        if (session) revivals.set(dead.paneId, session);
      } catch (cause) {
        console.warn("[terminal-runtime] pane rehydration failed; dropping pane", cause);
      }
    }),
  );
  for (const session of new Map([...revivals.values()].map((value) => [value.id, value])).values()) {
    terminalRuntime.registerSession(session);
  }
  let layout = restoreNode(savedRoot, byId, revivals);
  const attached = new Set(leaves(layout ?? undefined).map((leaf) => leaf.session.id));
  for (const session of sessionsToClaim(sessions, attached, claimExistingSessions && !hasSavedWorkspace)) {
    const next = pane(layoutId("pane"), session);
    layout = layout ? appendPane(layout, next) : next;
  }
  if (!layout) {
    const session = await terminalRuntime.createSession({
      executable: defaultShell,
      args: [],
      ...(initialCwd ? { cwd: initialCwd } : {}),
      environment: { mode: "inherit" },
      cols: 100,
      rows: 30,
      persistence: "terminate-with-app",
      programKind: "interactive-shell",
    });
    layout = pane(layoutId("pane"), session);
  }
  const savedActive =
    decodedSaved?.activePaneId ?? (typeof saved?.activePaneId === "string" ? saved.activePaneId : undefined);
  const activePaneId = savedActive && containsPane(layout, savedActive) ? savedActive : leaves(layout)[0]!.id;
  const savedZoom = decodedSaved?.zoomedPaneId ?? (typeof saved?.zoomedPaneId === "string" ? saved.zoomedPaneId : null);
  const zoomedPaneId = savedZoom && containsPane(layout, savedZoom) ? savedZoom : null;
  return { layout, activePaneId, zoomedPaneId };
}

const initializations = new PendingPromiseCache<object, InitialWorkspace>();

function sharedInitialization(
  terminalRuntime: ReturnType<typeof useGhostteaRuntime>,
  storageKey: string,
  defaultShell: string,
  claimExistingSessions: boolean,
  initialCwd: string | undefined,
  rehydratePane: (context: GhostteaPaneRehydration) => Promise<SessionSummary | null> | SessionSummary | null,
): Promise<InitialWorkspace> {
  const key = `${storageKey}\u0000${defaultShell}\u0000${claimExistingSessions}\u0000${initialCwd ?? ""}`;
  return initializations.get(terminalRuntime, key, () =>
    initializeWorkspace(terminalRuntime, storageKey, defaultShell, claimExistingSessions, initialCwd, rehydratePane),
  );
}

interface WorkspacePaneProps {
  paneId: string;
  session: SessionSummary;
  active: boolean;
  zoomed: boolean;
  hiddenByZoom: boolean;
  workspaceActive: boolean;
  platform: GhostteaWorkspacePlatform;
  theme: TerminalTheme;
  effects: TerminalEffects;
  bindings: readonly GhosttyBindingEntry[];
  decoration: GhostteaWorkspacePaneDecoration | undefined;
  onActivate: () => void;
  onClose: () => void;
  onBrowseDevice: (deviceId: string) => void;
}

function WorkspacePane({
  paneId,
  session,
  active,
  zoomed,
  hiddenByZoom,
  workspaceActive,
  platform,
  theme,
  effects,
  bindings,
  decoration,
  onActivate,
  onClose,
  onBrowseDevice,
}: WorkspacePaneProps) {
  const terminalRuntime = useGhostteaRuntime();
  const lifecycle = useRemoteSessionLifecycle(session.id);
  const hint = useInputSuppressionHint(session.id);
  const [retrying, setRetrying] = useState(false);
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const retry = useCallback((): void => {
    setRetrying(true);
    void terminalRuntime
      .reconnectRemoteSession(session.id)
      .catch((cause: unknown) => console.error("[terminal-runtime] remote session reconnect failed", cause))
      .finally(() => {
        if (aliveRef.current) setRetrying(false);
      });
  }, [session.id, terminalRuntime]);

  const frozen = paneIsFrozen(lifecycle);
  const paneStyle = decoration?.color ? ({ "--ghostty-pane-color": decoration.color } as CSSProperties) : undefined;
  return (
    <div
      className={`ghostty-pane${active ? " is-active" : ""}${zoomed ? " is-zoomed" : ""}${frozen ? " is-frozen" : ""}`}
      data-pane-id={paneId}
      data-pane-accent={decoration?.color ? "true" : undefined}
      style={paneStyle}
      onPointerDown={onActivate}
    >
      {lifecycle ? (
        <RemoteSessionBanner
          lifecycle={lifecycle}
          hint={hint}
          retrying={retrying}
          onRetry={retry}
          onClose={onClose}
          onBrowse={() => onBrowseDevice(lifecycle.deviceId)}
        />
      ) : null}
      <TerminalSurface
        session={session}
        theme={theme}
        effects={effects}
        bindings={bindings}
        active={active}
        {...(platform.platform ? { platform: platform.platform } : {})}
        visible={workspaceActive && !hiddenByZoom}
        controlsResize={!hiddenByZoom}
        onActivate={onActivate}
        readClipboard={platform.readClipboard}
        {...(active && platform.setCanCopy ? { onCopyAvailabilityChange: platform.setCanCopy } : {})}
        onContextMenu={platform.showContextMenu}
        onToggleFullscreen={platform.toggleFullscreen}
        onMenuAction={platform.onMenuAction}
      />
      {decoration?.label ? <span className="ghostty-pane-badge">{decoration.label}</span> : null}
      {!session.readWrite ? <span className="ghostty-pane-access">View only</span> : null}
    </div>
  );
}

interface SplitViewProps {
  node: PaneNode;
  activePaneId: string;
  workspaceActive: boolean;
  zoomedPaneId: string | null;
  platform: GhostteaWorkspacePlatform;
  theme: TerminalTheme;
  effects: TerminalEffects;
  bindings: readonly GhosttyBindingEntry[];
  onActivate: (paneId: string) => void;
  onClosePane: (paneId: string) => void;
  onBrowseDevice: (deviceId: string) => void;
  decoratePane?: ((session: SessionSummary, paneId: string) => GhostteaWorkspacePaneDecoration | undefined) | undefined;
  resizeLiveIntervalMs: number;
  onRatio: (splitId: string, ratio: number, commit: boolean) => void;
}

function SplitView({
  node,
  activePaneId,
  workspaceActive,
  zoomedPaneId,
  platform,
  theme,
  effects,
  bindings,
  onActivate,
  onClosePane,
  onBrowseDevice,
  decoratePane,
  resizeLiveIntervalMs,
  onRatio,
}: SplitViewProps) {
  const splitRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{
    pointerId: number;
    lastSentAt: number;
    pendingRatio: number | undefined;
    timer: number | undefined;
  } | null>(null);

  useEffect(
    () => () => {
      const timer = dragRef.current?.timer;
      if (timer !== undefined) window.clearTimeout(timer);
    },
    [],
  );

  if (node.kind === "pane") {
    return (
      <WorkspacePane
        paneId={node.id}
        session={node.session}
        active={workspaceActive && node.id === activePaneId}
        zoomed={node.id === zoomedPaneId}
        hiddenByZoom={zoomedPaneId !== null && node.id !== zoomedPaneId}
        workspaceActive={workspaceActive}
        platform={platform}
        theme={theme}
        effects={effects}
        bindings={bindings}
        decoration={decoratePane?.(node.session, node.id)}
        onActivate={() => onActivate(node.id)}
        onClose={() => onClosePane(node.id)}
        onBrowseDevice={onBrowseDevice}
      />
    );
  }

  const zoomedInFirst = zoomedPaneId !== null && containsPane(node.first, zoomedPaneId);
  const zoomedInSecond = zoomedPaneId !== null && containsPane(node.second, zoomedPaneId);
  const style =
    node.axis === "horizontal"
      ? {
          gridTemplateColumns: zoomedInFirst
            ? "1fr 0 0"
            : zoomedInSecond
              ? "0 0 1fr"
              : `${node.ratio}fr 1px ${1 - node.ratio}fr`,
        }
      : {
          gridTemplateRows: zoomedInFirst
            ? "1fr 0 0"
            : zoomedInSecond
              ? "0 0 1fr"
              : `${node.ratio}fr 1px ${1 - node.ratio}fr`,
        };

  const updateRatio = (event: ReactPointerEvent<HTMLDivElement>, commit = false): void => {
    const drag = dragRef.current;
    if (drag?.pointerId !== event.pointerId || !splitRef.current) return;
    const bounds = splitRef.current.getBoundingClientRect();
    const raw =
      node.axis === "horizontal"
        ? (event.clientX - bounds.left) / Math.max(1, bounds.width)
        : (event.clientY - bounds.top) / Math.max(1, bounds.height);
    const ratio = Math.max(0.1, Math.min(0.9, raw));
    const now = performance.now();
    if (commit) {
      if (drag.timer !== undefined) window.clearTimeout(drag.timer);
      drag.timer = undefined;
      drag.pendingRatio = undefined;
      drag.lastSentAt = now;
      onRatio(node.id, ratio, true);
      return;
    }
    const interval = Math.max(0, resizeLiveIntervalMs);
    if (interval === 0 || now - drag.lastSentAt >= interval) {
      drag.lastSentAt = now;
      onRatio(node.id, ratio, false);
      return;
    }
    drag.pendingRatio = ratio;
    if (drag.timer !== undefined) return;
    drag.timer = window.setTimeout(
      () => {
        const current = dragRef.current;
        if (current !== drag || current.pendingRatio === undefined) return;
        const pending = current.pendingRatio;
        current.pendingRatio = undefined;
        current.timer = undefined;
        current.lastSentAt = performance.now();
        onRatio(node.id, pending, false);
      },
      Math.max(0, interval - (now - drag.lastSentAt)),
    );
  };

  return (
    <div ref={splitRef} className={`ghostty-split is-${node.axis}`} style={style as CSSProperties}>
      <SplitView
        key={node.first.id}
        {...{
          node: node.first,
          activePaneId,
          workspaceActive,
          zoomedPaneId,
          platform,
          theme,
          effects,
          bindings,
          onActivate,
          onClosePane,
          onBrowseDevice,
          decoratePane,
          resizeLiveIntervalMs,
          onRatio,
        }}
      />
      <div
        className="ghostty-split-divider"
        onPointerDown={(event) => {
          dragRef.current = {
            pointerId: event.pointerId,
            lastSentAt: -Infinity,
            pendingRatio: undefined,
            timer: undefined,
          };
          event.currentTarget.setPointerCapture(event.pointerId);
          event.preventDefault();
        }}
        onPointerMove={(event) => updateRatio(event)}
        onPointerUp={(event) => {
          updateRatio(event, true);
          if (event.currentTarget.hasPointerCapture(event.pointerId))
            event.currentTarget.releasePointerCapture(event.pointerId);
          dragRef.current = null;
        }}
        onPointerCancel={() => {
          const timer = dragRef.current?.timer;
          if (timer !== undefined) window.clearTimeout(timer);
          dragRef.current = null;
        }}
      />
      <SplitView
        key={node.second.id}
        {...{
          node: node.second,
          activePaneId,
          workspaceActive,
          zoomedPaneId,
          platform,
          theme,
          effects,
          bindings,
          onActivate,
          onClosePane,
          onBrowseDevice,
          decoratePane,
          resizeLiveIntervalMs,
          onRatio,
        }}
      />
    </div>
  );
}

export function GhostteaWorkspace({
  platform,
  storageKey = DEFAULT_STORAGE_KEY,
  sidebar,
  theme,
  effects: effectsOverride,
  decoratePane,
  paneMeta,
  onRehydratePane,
  onPaneClose,
  onActiveSessionChange,
  createSplitSession,
  splitSizing = "halves",
  enableRemoteSessions = true,
  active = true,
  showTitlebar = true,
  claimExistingSessions = true,
  initialCwd,
  onSessionsChange,
  resizeCommitPolicy,
}: GhostteaWorkspaceProps) {
  const Sidebar = sidebar;
  const terminalRuntime = useGhostteaRuntime();
  const [config, setConfig] = useState<ConfigSnapshot | undefined>(terminalRuntime.configSnapshot);
  const [configPreview, setConfigPreview] = useState<ConfigSnapshot>();
  const [layout, setLayout] = useState<PaneNode>();
  const [activePaneId, setActivePaneId] = useState<string>();
  const [zoomedPaneId, setZoomedPaneId] = useState<string | null>(null);
  const [error, setError] = useState<string>();
  const [operationError, setOperationError] = useState<string>();
  const [focused, setFocused] = useState(document.hasFocus());
  const [remotePaletteOpen, setRemotePaletteOpen] = useState(false);
  const [appearanceSettingsOpen, setAppearanceSettingsOpen] = useState(false);
  const [remotePaletteDeviceId, setRemotePaletteDeviceId] = useState<string>();
  const creatingSessionRef = useRef(false);
  const workspaceRef = useRef<HTMLElement>(null);
  const layoutRef = useRef<PaneNode | undefined>(undefined);
  const activePaneIdRef = useRef<string | undefined>(undefined);
  const mountedRef = useRef(true);
  const activePane = useMemo(
    () => leaves(layout).find((candidate) => candidate.id === activePaneId),
    [layout, activePaneId],
  );
  const panes = useMemo<readonly GhostteaWorkspacePane[]>(
    () => leaves(layout).map((leaf) => ({ id: leaf.id, session: leaf.session })),
    [layout],
  );
  const sessions = useMemo(() => panes.map((leaf) => leaf.session), [panes]);
  const title = useMemo(() => windowTitle(activePane?.session), [activePane?.session]);
  const renderConfig = configPreview ?? config;
  const resolvedTheme = useMemo(
    () => theme ?? (renderConfig ? terminalThemeFromConfig(renderConfig) : TERMINAL_THEMES.midnight),
    [renderConfig, theme],
  );
  const nextEffects = useMemo<TerminalEffects>(
    () => resolveWorkspaceEffects(effectsOverride, renderConfig),
    [effectsOverride, renderConfig],
  );
  const effectsKey = workspaceEffectsKey(nextEffects);
  const effects = useMemo<TerminalEffects>(() => workspaceEffectsFromKey(effectsKey), [effectsKey]);
  const bindings = useMemo(
    () => configuredBindingsForPlatform(config?.workspace, platform.platform),
    [config?.workspace, platform.platform],
  );

  useEffect(() => {
    const update = (event: Event): void => {
      setConfig((event as CustomEvent<ConfigSnapshot>).detail);
    };
    terminalRuntime.addEventListener("config-changed", update);
    void terminalRuntime.getConfig().then((snapshot) => {
      if (snapshot) setConfig(snapshot);
    });
    return () => terminalRuntime.removeEventListener("config-changed", update);
  }, [terminalRuntime]);

  // The initialization promise is cached per (runtime, key); keep the rehydrate callback out of
  // the effect deps via a stable wrapper so an unstable prop identity cannot re-run initialization.
  const onRehydratePaneRef = useRef(onRehydratePane);
  useEffect(() => {
    onRehydratePaneRef.current = onRehydratePane;
  }, [onRehydratePane]);
  const rehydratePane = useCallback(
    (context: GhostteaPaneRehydration) => onRehydratePaneRef.current?.(context) ?? null,
    [],
  );

  useEffect(() => {
    let mounted = true;
    mountedRef.current = true;
    void sharedInitialization(
      terminalRuntime,
      storageKey,
      platform.defaultShell,
      claimExistingSessions,
      initialCwd,
      rehydratePane,
    ).then(
      (workspace) => {
        if (!mounted) return;
        setLayout(workspace.layout);
        setActivePaneId(workspace.activePaneId);
        setZoomedPaneId(workspace.zoomedPaneId);
      },
      (cause) => {
        if (mounted) setError(cause instanceof Error ? cause.message : String(cause));
      },
    );
    return () => {
      mounted = false;
      mountedRef.current = false;
    };
  }, [claimExistingSessions, initialCwd, platform.defaultShell, rehydratePane, storageKey, terminalRuntime]);

  useEffect(() => {
    layoutRef.current = layout;
    activePaneIdRef.current = activePaneId;
    if (!layout || !activePaneId) return;
    try {
      localStorage.setItem(
        storageKey,
        JSON.stringify(persistedWorkspace(layout, activePaneId, zoomedPaneId, paneMeta)),
      );
    } catch (cause) {
      console.warn("[terminal-runtime] failed to save workspace", cause);
    }
  }, [activePaneId, layout, paneMeta, storageKey, zoomedPaneId]);

  useEffect(() => {
    const update = (event: Event): void => {
      const session = (event as CustomEvent<SessionSummary>).detail;
      setLayout((current) => (current ? updateSession(current, session) : current));
    };
    terminalRuntime.addEventListener("session-metadata", update);
    return () => terminalRuntime.removeEventListener("session-metadata", update);
  }, [terminalRuntime]);

  useEffect(() => {
    document.title = title;
  }, [title]);

  useEffect(() => {
    onActiveSessionChange?.(activePane?.session);
  }, [activePane?.session, onActiveSessionChange]);

  useEffect(() => {
    onSessionsChange?.(sessions.map((session) => session.id));
  }, [onSessionsChange, sessions]);

  useEffect(() => {
    const onFocus = (): void => setFocused(true);
    const onBlur = (): void => setFocused(false);
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  const focusPane = useCallback((paneId: string): void => {
    const target = Array.from(workspaceRef.current?.querySelectorAll<HTMLElement>("[data-pane-id]") ?? []).find(
      (element) => element.dataset.paneId === paneId,
    );
    target?.querySelector<HTMLTextAreaElement>(".terminal-input")?.focus({ preventScroll: true });
  }, []);
  const [paneFocus] = useState(() => createPaneFocusScheduler(window));
  useEffect(() => paneFocus.cancel, [paneFocus]);
  useEffect(() => {
    if (!active) paneFocus.cancel();
  }, [active, paneFocus]);

  const activatePane = useCallback(
    (paneId: string): void => {
      activePaneIdRef.current = paneId;
      setActivePaneId(paneId);
      paneFocus.request(paneId, focusPane);
    },
    [focusPane, paneFocus],
  );

  const activateSession = useCallback(
    (sessionId: string): void => {
      const target = leaves(layoutRef.current).find((candidate) => candidate.session.id === sessionId);
      if (target) activatePane(target.id);
    },
    [activatePane],
  );

  const mountSession = useCallback(
    (session: SessionSummary): void => {
      terminalRuntime.registerSession(session);
      const current = layoutRef.current;
      const paneId = activePaneIdRef.current;
      if (!current || !paneId) return;
      const updated = mountSessionInPane(current, paneId, session);
      layoutRef.current = updated;
      setLayout(updated);
      setZoomedPaneId(null);
      setOperationError(undefined);
      activatePane(paneId);
    },
    [activatePane, terminalRuntime],
  );
  const placeSession = mountSession;

  const addSession = useCallback(
    (session: SessionSummary, axis: SplitAxis = "horizontal"): void => {
      terminalRuntime.registerSession(session);
      const current = layoutRef.current;
      const existing = leaves(current).find((candidate) => candidate.session.id === session.id);
      if (existing) {
        activatePane(existing.id);
        return;
      }
      const next = pane(layoutId("pane"), session);
      const updated = insertPane(current, next, activePaneIdRef.current, axis, layoutId("split"), splitSizing);
      // Commit the ref synchronously so multiple agent/session callbacks in
      // one React turn compose instead of each splitting the same stale tree.
      layoutRef.current = updated;
      setLayout(updated);
      setZoomedPaneId(null);
      setOperationError(undefined);
      activatePane(next.id);
    },
    [activatePane, splitSizing, terminalRuntime],
  );

  const newSplit = useCallback(
    async (axis: SplitAxis = "horizontal"): Promise<SessionSummary | undefined> => {
      const current = layoutRef.current;
      const active = leaves(current).find((candidate) => candidate.id === activePaneIdRef.current);
      if (!current || !active || creatingSessionRef.current) return undefined;
      creatingSessionRef.current = true;
      try {
        const session = createSplitSession
          ? await createSplitSession(active.session, axis)
          : await terminalRuntime.createSession({
              executable: platform.defaultShell,
              args: [],
              ...(active.session.cwd ? { cwd: active.session.cwd } : {}),
              environment: { mode: "inherit" },
              cols: active.session.cols,
              rows: active.session.rows,
              persistence: "terminate-with-app",
              programKind: "interactive-shell",
            });
        if (!mountedRef.current || !layoutRef.current || !containsPane(layoutRef.current, active.id)) {
          terminalRuntime.terminate(session.id);
          return undefined;
        }
        addSession(session, axis);
        return session;
      } catch (cause) {
        setOperationError(cause instanceof Error ? cause.message : String(cause));
        return undefined;
      } finally {
        creatingSessionRef.current = false;
      }
    },
    [addSession, createSplitSession, platform.defaultShell, terminalRuntime],
  );

  const createSessionInActivePane = useCallback(async (): Promise<SessionSummary | undefined> => {
    const current = layoutRef.current;
    const active = leaves(current).find((candidate) => candidate.id === activePaneIdRef.current);
    if (!current || !active || creatingSessionRef.current) return undefined;
    creatingSessionRef.current = true;
    try {
      const session = createSplitSession
        ? await createSplitSession(active.session, "horizontal")
        : await terminalRuntime.createSession({
            executable: platform.defaultShell,
            args: [],
            ...(active.session.cwd ? { cwd: active.session.cwd } : {}),
            environment: { mode: "inherit" },
            cols: active.session.cols,
            rows: active.session.rows,
            persistence: "terminate-with-app",
            programKind: "interactive-shell",
          });
      const latest = layoutRef.current;
      if (!mountedRef.current || !latest || !containsPane(latest, active.id)) {
        terminalRuntime.terminate(session.id);
        return undefined;
      }
      terminalRuntime.registerSession(session);
      const updated = mountSessionInPane(latest, active.id, session);
      layoutRef.current = updated;
      setLayout(updated);
      setZoomedPaneId(null);
      setOperationError(undefined);
      activatePane(active.id);
      return session;
    } catch (cause) {
      setOperationError(cause instanceof Error ? cause.message : String(cause));
      return undefined;
    } finally {
      creatingSessionRef.current = false;
    }
  }, [activatePane, createSplitSession, platform.defaultShell, terminalRuntime]);

  const focusRelative = useCallback(
    (offset: number): void => {
      if (zoomedPaneId) return;
      const panes = leaves(layout);
      const current = panes.findIndex((candidate) => candidate.id === activePaneId);
      if (panes.length < 2 || current < 0) return;
      activatePane(panes[(current + offset + panes.length) % panes.length]!.id);
    },
    [activatePane, activePaneId, layout, zoomedPaneId],
  );

  const focusDirection = useCallback(
    (direction: "left" | "right" | "up" | "down"): void => {
      if (zoomedPaneId) return;
      const elements = Array.from(workspaceRef.current?.querySelectorAll<HTMLElement>("[data-pane-id]") ?? []);
      const current = elements.find((element) => element.dataset.paneId === activePaneId);
      if (!current) return;
      const source = current.getBoundingClientRect();
      const sourceX = source.left + source.width / 2;
      const sourceY = source.top + source.height / 2;
      let best: { id: string; score: number } | undefined;
      for (const element of elements) {
        const id = element.dataset.paneId;
        if (!id || id === activePaneId) continue;
        const rect = element.getBoundingClientRect();
        const dx = rect.left + rect.width / 2 - sourceX;
        const dy = rect.top + rect.height / 2 - sourceY;
        const forward = direction === "left" ? -dx : direction === "right" ? dx : direction === "up" ? -dy : dy;
        if (forward <= 0) continue;
        const cross = direction === "left" || direction === "right" ? Math.abs(dy) : Math.abs(dx);
        const score = forward + cross * 2;
        if (!best || score < best.score) best = { id, score };
      }
      if (best) activatePane(best.id);
    },
    [activatePane, activePaneId, zoomedPaneId],
  );

  const closePane = useCallback(
    (paneId: string): void => {
      const current = layoutRef.current;
      const panes = leaves(current);
      const target = panes.find((candidate) => candidate.id === paneId);
      if (!current || !target || creatingSessionRef.current) return;
      if (panes.length === 1) {
        platform.closeWindow();
        return;
      }
      const index = panes.findIndex((candidate) => candidate.id === target.id);
      const next = panes[index === panes.length - 1 ? index - 1 : index + 1]!;
      const remaining = removePane(current, target.id);
      if (!remaining) return;
      setLayout(remaining);
      setZoomedPaneId(null);
      activatePane(next.id);
      onPaneClose?.({
        paneId: target.id,
        session: target.session,
        remainingSessionIds: [...new Set(leaves(remaining).map((pane) => pane.session.id))],
      });
    },
    [activatePane, onPaneClose, platform],
  );

  const closeActivePane = useCallback((): void => {
    if (activePaneIdRef.current) closePane(activePaneIdRef.current);
  }, [closePane]);

  const browseDeviceSessions = useCallback(
    (deviceId: string): void => {
      if (!enableRemoteSessions) return;
      setRemotePaletteDeviceId(deviceId);
      setRemotePaletteOpen(true);
    },
    [enableRemoteSessions],
  );

  const openRemoteChoice = useCallback(
    async (choice: RemoteChoice): Promise<void> => {
      const current = layoutRef.current;
      const active = leaves(current).find((candidate) => candidate.id === activePaneIdRef.current);
      if (!current || !active || creatingSessionRef.current) return;
      creatingSessionRef.current = true;
      try {
        const session = await terminalRuntime.openRemoteSession(
          choice.host.deviceId,
          choice.session.sessionId,
          active.session.cols,
          active.session.rows,
          choice.host.deviceName,
        );
        if (!mountedRef.current || !layoutRef.current || !containsPane(layoutRef.current, active.id)) {
          terminalRuntime.terminate(session.id);
          return;
        }
        addSession(session, "horizontal");
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        setOperationError(message);
        throw cause;
      } finally {
        creatingSessionRef.current = false;
      }
    },
    [addSession, terminalRuntime],
  );

  const executeWorkspaceCommand = useCallback(
    (command: WorkspaceEffect): void => {
      if (command.type === "new-tab") {
        platform.newTab?.(activePane?.session.cwd ?? undefined);
      } else if (command.type === "select-tab") {
        platform.selectTab?.(command.target);
      } else if (command.type === "close-tab") {
        platform.closeTab?.();
      } else if (command.type === "remote-sessions") {
        if (enableRemoteSessions) {
          setRemotePaletteDeviceId(undefined);
          setRemotePaletteOpen(true);
        }
      } else if (command.type === "split") {
        void newSplit(command.axis);
      } else if (command.type === "focus-relative") {
        focusRelative(command.offset);
      } else if (command.type === "focus-direction") {
        focusDirection(command.direction);
      } else if (command.type === "resize") {
        if (activePaneId) {
          setLayout((current) =>
            current ? resizeForPane(current, activePaneId, command.axis, command.delta)[0] : current,
          );
        }
      } else if (command.type === "equalize") {
        setLayout((current) => (current ? equalize(current) : current));
      } else if (command.type === "toggle-zoom") {
        setZoomedPaneId((current) => (current ? null : (activePaneId ?? null)));
      } else if (command.type === "close-pane") {
        closeActivePane();
      }
    },
    [
      activePane?.session.cwd,
      activePaneId,
      closeActivePane,
      enableRemoteSessions,
      focusDirection,
      focusRelative,
      newSplit,
      platform,
    ],
  );

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (
        !workspaceOwnsHotkey(active, workspaceRef.current, event.target, document.activeElement, appearanceSettingsOpen)
      ) {
        return;
      }

      // Workspace owns chrome/platform/unhandled only; terminal effects stay on TerminalSurface.
      const routed = resolveKeyEvent(event, {
        extensions: true,
        ...(platform.platform !== undefined ? { platform: platform.platform } : {}),
        bindings,
        scopes: ["workspace", "platform", "unhandled"],
      });
      if (!routed) return;

      // After a successful match, always consume. Missing hooks no-op the effect
      // but must not leak Ghostty app binds into the PTY (review P0).
      const consume = (): void => {
        if (routeConsumesInput(routed)) {
          event.preventDefault();
          event.stopPropagation();
        }
      };

      if (remotePaletteOpen) {
        if (routed.kind === "workspace" && routed.command.type === "remote-sessions") {
          setRemotePaletteOpen(false);
        }
        // Drop other app binds while the palette is open; still consume them.
        consume();
        return;
      }

      if (routed.kind === "workspace") {
        if (!(routed.command.type === "remote-sessions" && !enableRemoteSessions)) {
          if (!(routed.command.type === "new-tab" && !platform.newTab)) {
            if (!(routed.command.type === "select-tab" && !platform.selectTab)) {
              if (!(routed.command.type === "close-tab" && !platform.closeTab)) {
                executeWorkspaceCommand(routed.command);
              }
            }
          }
        }
      } else if (routed.kind === "platform") {
        if (routed.effect.type === "toggle_fullscreen") platform.toggleFullscreen();
        else if (routed.effect.type === "close_window") platform.closeWindow();
        else if (routed.effect.type === "close_all_windows") {
          (platform.closeAllWindows ?? platform.closeWindow)();
        } else if (routed.effect.type === "new_window") {
          (platform.newWindow ?? platform.newTab)?.(activePane?.session.cwd ?? undefined);
        } else if (routed.effect.type === "quit") {
          (platform.quit ?? platform.closeWindow)();
        } else if (routed.effect.type === "open_config") {
          platform.openConfig?.();
        } else if (routed.effect.type === "reload_config") {
          void terminalRuntime.reloadConfig().catch((cause: unknown) => {
            console.error("[terminal-runtime] configuration reload failed", cause);
            platform.reloadConfig?.();
          });
        }
      }
      // unhandled: consume only (prevent PTY leakage for non-performable app binds)

      consume();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [
    active,
    activePane?.session.cwd,
    appearanceSettingsOpen,
    bindings,
    enableRemoteSessions,
    executeWorkspaceCommand,
    platform,
    remotePaletteOpen,
    terminalRuntime,
  ]);

  const workspaceContext = useMemo<GhostteaWorkspaceContext>(
    () => ({
      activePaneId,
      activeSession: activePane?.session,
      panes,
      sessions,
      addSession,
      activateSession,
      mountSession,
      placeSession,
      createSessionInActivePane,
      splitActive: newSplit,
    }),
    [
      activePane?.session,
      activePaneId,
      activateSession,
      addSession,
      createSessionInActivePane,
      mountSession,
      newSplit,
      panes,
      placeSession,
      sessions,
    ],
  );

  const settingsButton =
    platform.saveAppearance || platform.configEditor ? (
      <button
        type="button"
        className="ghosttea-settings-button"
        aria-label="Open settings"
        title="Settings"
        disabled={!config}
        onClick={() => setAppearanceSettingsOpen(true)}
      >
        ⚙
      </button>
    ) : null;

  return (
    <main
      ref={workspaceRef}
      className={`ghostty-window${active && focused ? " is-focused" : ""}${showTitlebar ? " has-titlebar" : ""}`}
    >
      {showTitlebar ? (
        <header className="ghostty-titlebar" aria-label={title}>
          <span className="ghostty-title">{title}</span>
          {settingsButton}
        </header>
      ) : (
        settingsButton
      )}
      <div className="ghosttea-workspace-body">
        <section className="terminal-host">
          {error ? (
            <div className="terminal-error" role="alert">
              {error}
            </div>
          ) : layout && activePaneId ? (
            <SplitView
              key={layout.id}
              node={layout}
              activePaneId={activePaneId}
              workspaceActive={active}
              zoomedPaneId={zoomedPaneId}
              platform={platform}
              theme={resolvedTheme}
              effects={effects}
              bindings={bindings}
              onActivate={activatePane}
              onClosePane={closePane}
              onBrowseDevice={browseDeviceSessions}
              decoratePane={decoratePane}
              resizeLiveIntervalMs={resizeCommitPolicy?.liveIntervalMs ?? 33}
              onRatio={(splitId, ratio, commit) => {
                setLayout((current) =>
                  current ? updateSplit(current, splitId, (split) => ({ ...split, ratio })) : current,
                );
                if (commit) resizeCommitPolicy?.onCommit?.({ splitId, ratio });
              }}
            />
          ) : null}
          {operationError ? (
            <div className="terminal-operation-error" role="status">
              {operationError}
            </div>
          ) : null}
          {remotePaletteOpen ? (
            <RemoteSessionPalette
              {...(remotePaletteDeviceId ? { deviceId: remotePaletteDeviceId } : {})}
              onClose={() => {
                setRemotePaletteOpen(false);
                setRemotePaletteDeviceId(undefined);
              }}
              onOpen={openRemoteChoice}
            />
          ) : null}
        </section>
        {Sidebar ? (
          <aside className="ghosttea-workspace-sidebar">
            <Sidebar workspace={workspaceContext} />
          </aside>
        ) : null}
      </div>
      {appearanceSettingsOpen && (platform.saveAppearance || platform.configEditor) && config ? (
        <AppearanceSettings
          config={config}
          onClose={() => setAppearanceSettingsOpen(false)}
          {...(platform.saveAppearance ? { onSave: platform.saveAppearance } : {})}
          {...(platform.configEditor ? { configEditor: platform.configEditor } : {})}
          {...(platform.backdropBlur ? { backdropBlur: platform.backdropBlur } : {})}
          onPreview={setConfigPreview}
        />
      ) : null}
    </main>
  );
}
