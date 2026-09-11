# `@vibecook/ghosttea-react`

React terminal surface, renderer runtime, and worker-owned WebGPU renderer for
Ghosttea.

The package keeps terminal frames off the React and Electron main-process hot
paths. Create one runtime per renderer window, provide it through
`GhostteaProvider`, and share it across terminal surfaces.

Import `@vibecook/ghosttea-react/styles.css` once in the renderer entrypoint.

## Terminal links

Provide `platform.openExternal(url)` to enable Command-hover/click on macOS
and Ctrl-hover/click elsewhere. Links are underlined per pane, and a successful
click is consumed before TUI mouse reporting. Modifier release, window blur,
dragging, and changing terminal output cancel an in-progress link click. The
underline overlay works with both WebGPU and Canvas rendering.

The updated daemon supplies plain URL matches and explicit OSC 8 destinations,
including cell ranges for wrapped links and Unicode text. `link-url = false`
disables plain URL matches while retaining OSC 8. Built-in opening accepts
HTTP, HTTPS, mailto, FTP and FTPS destinations. No interaction is enabled when
the host omits the callback or the frame producer lacks link metadata (including
legacy logical replicas).

Electron hosts use `installGhostteaLinkHost(ipcMain, shell, isTrusted)` from
`@vibecook/ghosttea-electron/main` and expose
`createGhostteaLinkBridge(ipcRenderer).openExternal` from the preload. The trust
callback should admit only the app's terminal renderer URL; the helper also
rejects subframe senders and validates URL schemes in the main process.

## Routed terminal transport

The additive `transport: "routed"` mode connects one control WebSocket and one
frames WebSocket per `cellBootId`, then multiplexes session activations over
each connection set. Main owns activation IDs, leases, replacement and
recovery. The render worker owns the frames socket, presentation-envelope
validation, byte credits, bounded transfer staging, TRF1 identity checks, and
scene apply. Presentation bytes are never relayed through main.

```ts
const runtime = createGhostteaTerminalRuntime({
  transport: "routed",
  platform,
  host: {
    openTicket: (sessionId, options) => fieldd.openTicket(sessionId, options),
    renewAttach: (request) => fieldd.renewAttach(request),
    listSessions: () => fieldd.listSessions(),
    getSession: (sessionId) => fieldd.getSession(sessionId),
    createSession: (options) => fieldd.createSession(options),
    terminate: (sessionId, source) => fieldd.terminate(sessionId, source),
    onExtensionMessage: (message, context) => hostExtensions.receive(message, context),
  },
});
```

When `getSession` is present, each routed `frame-committed` signal arms the
same coalesced 200 ms metadata refresh used by the ports transport. Reads for a
session never overlap, `null` is a no-op, and a late response cannot overwrite
a newer registration or event. Hosts can also project authoritative lifecycle
facts directly with `runtime.applySessionEvent(event)`. The exported
`RoutedSessionEvent` union covers full-summary updates, activity changes, exits
with complete exit facts, and non-terminating removal.

`onExtensionMessage` is deliberately strict. It receives only an unknown
tagged object from an authenticated control leg, unchanged and with its
`cellBootId`/`connectionSetId` context. Known protocol messages still use the
built-in decoder, and malformed, wrong-leg, oversized, binary, or pre-accept
messages retain their protocol-close behavior. Omitting the callback keeps
unknown tags closed as before.

The ticket guard accepts only loopback `ws://`/`wss://` endpoints without a
query or fragment, and checks route/grant/session binding before dialing. A
frames-leg recovery asks `openTicket` for a fresh transport grant before using
the negotiated `resume` capability; consumed grant nonces are never replayed.
The worker uses its own global `WebSocket`. The optional `websocketFactory`
customizes the main-thread control leg for tests or host instrumentation.

Read `runtime.routedActivation(sessionId)` or listen for
`routed-activation-state` and `routed-view-readiness`. `PresentationReady` and
`InputAllowed` are deliberately separate: the local scene must cover the
cell's accepted content, both local status leases must be live, and input also
requires the cell's input dimension, a current input right, and a writable
client view. `TerminalSurface` accepts `inputPolicy="read-only"` (or
`readWrite={false}`) to remove input locally without affecting presentation.

The published VibeField T1 contract currently has no terminal-input wire tag.
Accordingly, routed input stays closed unless the host supplies `encodeInput`
for an extension it has negotiated with its cell; Ghosttea does not invent an
incompatible message. When supplied, the encoded keystroke is sent directly
on the main-thread control socket with no worker `postMessage` hop.

Focus changes only rendering priority and demand urgency. Geometry changes
require an explicit `controlsResize`/`claimResizeControl` path, so a focused
mirror cannot resize the PTY. Production counters are available through
`readPerformanceCounters()` without opening a measurement window or draining
the GPU. The existing port-pair transport remains the default rollback path.

For applications that want the complete Ghostty-style desktop experience, use
`GhostteaWorkspace` from `@vibecook/ghosttea-react/workspace` and import
`@vibecook/ghosttea-react/workspace.css`. It owns the titlebar, persisted pane
tree, split/focus/resize hotkeys, remote-session palette, and terminal focus
semantics. An optional sidebar component receives the active session plus
`addSession`/`activateSession` actions, so application UI can sit beside the
terminal without creating a parallel terminal layout or transport.

The workspace entry point also exports the versioned, UI-independent pane and
tab reducers used for cross-platform restoration and conformance. Their JSON
documents contain only stable layout IDs and opaque session IDs; resolve those
IDs against live sessions in the host rather than persisting transport or
credential state.

Ghostty-style application shortcuts expose stable `ghosttea.workspace.*`
command IDs through `workspaceCommandId`. These IDs are shared with the Swift
workspace package even where platform-default key bindings eventually differ.

Default macOS keybinds are table-driven from the Ghostty ground-truth dump
(`src/bindings/fixtures/keybinds-macos-default.json`, refreshed via
`npm run extract:ghostty-ux`).

Protocol 1.10 supplies the shared versioned Ghostty configuration snapshot.
The daemon applies scrollback and model colors, while `GhostteaWorkspace`
applies presentation colors, single-stroke keybind mutations, and the opt-in
post-process effect automatically. Lower-level hosts can use
`terminalThemeFromConfig` and `terminalEffectsFromConfig`. See the repository's
[`Ghostty configuration compatibility`](../../docs/ghostty-config-compatibility.md)
matrix for deliberate gaps.

Desktop hosts may provide the exported `GhostteaConfigEditorBridge` through
`GhostteaWorkspacePlatform.configEditor`. The workspace then adds an Advanced
Settings section with a lossless raw overlay editor and a friendly managed
form. The bridge is intentionally capability-shaped: the host owns document
scope, validation, compare-and-swap persistence, and native import/export
dialogs; the React package owns only draft state and presentation. The raw
editor preserves untouched mixed line endings and source bytes, reports
inherited versus draft-blocking diagnostics separately, and can notify native
hosts while an unsaved draft needs close/quit protection.

## Host-local appearance contract

Embedding hosts may keep visual preferences with the viewer instead of writing
them into a shared Ghostty configuration document. `GhostteaWorkspace` accepts
independent `theme` and `effects` props for that purpose. Each supplied prop is
authoritative for every pane in that workspace; an omitted prop continues to
come from the current configuration snapshot, then falls back to Ghosttea's
default when no snapshot is available:

```text
host prop > preview/live ConfigSnapshot > Ghosttea default
```

This is facet-by-facet: a host can override colors and opacity while retaining
config-derived shaders, or override shaders while retaining config-derived
colors. A supplied prop also outranks the corresponding preview from the
config-backed internal Settings dialog. Hosts that own viewer-local appearance
should therefore render their own controls and pass stable `theme`/`effects`
values; Ghosttea retains semantically equivalent effects to prevent redundant
surface invalidation when a parent rerenders.

The following UI-independent exports from
`@vibecook/ghosttea-react/workspace` are the supported data contract for hosts
that build appearance controls in their own design system:

- `GHOSTTY_COLOR_THEMES`, `GHOSTTY_THEME_CATALOG_SOURCE`, and
  `GHOSTTY_THEME_CATALOG_REVISION`
- `GHOSTTEA_SHADER_OPTIONS` (including `id`, `license`, and `animated`) and
  `UNAVAILABLE_UPSTREAM_SHADERS`
- `TERMINAL_THEMES`
- `GhostteaColorTheme`, `GhostteaShaderOption`, `GhostteaAppearanceUpdate`, and
  the exported configuration-editor types

Renderer-facing `TerminalTheme`, `TerminalEffects`, and
`TerminalShaderEffect` remain exported from the package root. Hosts may also
derive those types from `GhostteaWorkspaceProps["theme"]` and
`GhostteaWorkspaceProps["effects"]`.

Export names and TypeScript shapes follow the package's semver policy. Data is
deliberately allowed to evolve: themes may be added, removed, or reordered when
the catalog revision changes; shader options may be added, and names may move
from the unavailable list once redistribution is cleared. Persist theme names
and shader IDs rather than array positions, use the catalog revision as a cache
or differ key, and treat the unavailable list as informational rather than a
feature entitlement.

Architecture:

1. **Match** — `matchGhostteaBinding` (Ghostty defaults + extensions)
2. **Route** — `resolveKeyEvent` → `workspace` | `terminal` | `platform` | `unhandled`
3. **Execute** — Workspace owns chrome/platform/unhandled; TerminalSurface owns terminal effects

**⌘⇧O** (`super+shift+o`) is a Ghosttea product extension (remote sessions) and is kept outside Ghostty defaults.

Open / deferred Ghostty UX work (font-size protocol, search, undo, jump_to_prompt, mouse goldens, etc.) is tracked in the monorepo at [`bench/ghostty-ux/OPEN-ITEMS.md`](../../bench/ghostty-ux/OPEN-ITEMS.md).
