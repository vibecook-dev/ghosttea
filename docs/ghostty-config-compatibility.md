# Ghostty configuration compatibility

Ghosttea uses one versioned Rust configuration engine on the daemon, Electron,
and Apple FFI paths. The compatibility target is released Ghostty 1.3.1 at
commit `332b2aefc6e72d363aa93ab6ecfc86eeeeb5ed28`. This config pin is
deliberately separate from the unreleased Ghostty source used to build the VT
library.

The goal is safe migration, not optimistic parsing. Every configured key is
reported as `applied`, `parsed`, or `unsupported`, and malformed or unknown
values remain visible in structured diagnostics.

## Sources and precedence

Ghosttea follows the
[pinned Ghostty 1.3.1 source order](https://github.com/ghostty-org/ghostty/blob/332b2aefc6e72d363aa93ab6ecfc86eeeeb5ed28/src/config/Config.zig#L4064-L4130):

1. `$XDG_CONFIG_HOME/ghostty/config` (legacy)
2. `$XDG_CONFIG_HOME/ghostty/config.ghostty`
3. On macOS, `~/Library/Application Support/com.mitchellh.ghostty/config` (legacy)
4. On macOS, `~/Library/Application Support/com.mitchellh.ghostty/config.ghostty`
5. An optional Ghosttea-owned `config.ghostty` overlay

On Windows, `LOCALAPPDATA` is Ghostty's fallback when `XDG_CONFIG_HOME` is
unset; elsewhere `~/.config` is used. Missing standard files are ignored.
`config-file` includes are relative to their containing file, are
processed through the same
[breadth-first queue](https://github.com/ghostty-org/ghostty/blob/332b2aefc6e72d363aa93ab6ecfc86eeeeb5ed28/src/config/Config.zig#L4210-L4300)
as Ghostty, expand `~/`, support both `?optional/path` and
`?"optional path"`, and reject repeated recursive targets. An unquoted empty
`config-file` value clears the pending include queue. Includes from the
standard Ghostty files are fully resolved before the Ghosttea overlay, keeping
that app-owned file as the final layer. Empty values reset a key. Keys are
case-sensitive and comments are valid only on their own line, matching
Ghostty. UTF-8 byte-order marks and bare CLI-style boolean options are
accepted.

The desktop overlay lives in Electron's profile-specific user-data directory.
`open_config` asks the managed daemon to create that exact file through the
configuration document API, then opens it. Existing Ghostty files are read
automatically before it, so users do not need to copy their configuration just
to try Ghosttea.

## Current behavior

Electron terminal links apply `link-url` (default `true`). This controls plain
URL matching; OSC 8 targets remain clickable when it is false. The host must
provide `platform.openExternal` and use a daemon that emits TRF1 link targets.

| Area                                             | Daemon / Electron                                                                                                                                     | Swift / Metal                                                                                                                                                                |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Foreground, background, cursor, selection colors | Fixed colors are applied live; dynamic `cell-foreground`/`cell-background` references are diagnosed as parsed until per-cell rendering is implemented | Device config applies live to local SSH and shared sessions; protocol minor 8 keeps defaults and indexed colors semantic while application-owned truecolor remains unchanged |
| `cursor-text`, `palette`                         | Applied live. Sparse palette entries override libghostty's default 256-color table; the Settings catalog writes entries 0–15                          | Applied live from the device config. Shared palette cells are re-resolved locally without rebuilding text shapes or losing selection and patch continuity                    |
| `background-opacity`, `background-opacity-cells` | WebGPU and Canvas2D preserve premultiplied alpha; macOS Electron windows expose it to the desktop. Explicit cell backgrounds follow the cells toggle  | Applied to the Metal terminal layer for local and shared terminals; iOS does not make the app window itself transparent                                                      |
| `scrollback-limit`                               | Applied to new sessions; default is Ghostty's 10,000,000 bytes                                                                                        | Available through `GhostteaTerminalConfiguration(config:)`; the core default is 10,000,000 bytes, while the iOS app may deliberately impose its device memory budget         |
| `keybind`                                        | Mutations overlay the pinned 93-entry platform table; `clear`, blank reset, `unbind`, supported single-stroke actions, and `unconsumed:` are applied  | Preserved in the shared API; the Swift workspace still has a smaller hand-written action router                                                                              |
| `window-padding-x/y`                             | Parsed, not yet used by the fixed desktop cell geometry                                                                                               | Applied by `GhostteaTerminalMetalView.applyConfiguration(_:)`                                                                                                                |
| `font-family`, `font-size`                       | Parsed, but runtime font metrics are still selected at process startup                                                                                | `font-size` scales shaping and grid metrics and atomically reshapes a live shared replica; arbitrary `font-family` values remain diagnosed because Apple uses bundled fonts  |
| `custom-shader`, `custom-shader-animation`       | Namespaced built-ins compose in declaration order through ping-pong WebGPU passes. Canvas fallback and arbitrary Ghostty GLSL are unsupported         | Namespaced built-ins compose in declaration order through Metal passes and remain device-owned in shared sessions; arbitrary Ghostty shader paths are diagnosed/preserved    |

Other recognized keys—including `theme`, shell integration, and most
window/application behavior—are currently reported
as `unsupported`; importing them never creates a false success signal.

Color parsing uses Ghostty's full X11 catalog. It also accepts Ghostty's newer
9- and 12-digit precision and `rgb:`/`rgbi:` forms as a forward-compatible
syntax extension to the 1.3.1 config release. `transparent` is not a Ghostty
color and is rejected instead of being silently converted to black.

Shader effects are off by default. Namespaced built-ins may be stacked:

```text
custom-shader = ghosttea:crt
custom-shader = ghosttea:vhs
custom-shader-animation = true
```

The current registry also contains `ghosttea:sparks-from-fire` and the legacy
`ghosttea:better-crt` compatibility effect. These values are Ghosttea
extensions. Normal Ghostty GLSL paths are preserved in the snapshot but are
not executed: silently treating arbitrary GLSL as a bundled WGSL effect would
be incorrect. The settings dialog shows upstream shader names whose licensing
has not been cleared, but does not bundle or enable them.

The linked `ghostty.style` project seeds its built-in gallery from
`mbadolato/iTerm2-Color-Schemes`. The desktop Appearance dialog packages a
pinned 602-theme snapshot of that source for deterministic offline use,
expands the selected theme into Ghostty color and palette keys, and updates a
marked managed block through the configuration document compare-and-swap API.
It never rewrites the rest of the user's file or executes community-provided
configuration text.

The desktop Settings dialog also has an Advanced editor for the exact
profile-owned overlay. Its Raw config tab validates a draft after a short
debounce, reports diagnostics and loaded source layers, and previews the last
valid view-owned color/effect projection without writing on each keystroke.
Save & load is an explicit compare-and-swap operation, so an edit made by
another process opens a conflict view instead of being overwritten. Import
from Ghostty generates a portable snapshot of settings in Ghosttea's supported
projection; it does not copy private source paths, relative includes, or
unsupported source text. File imports are bounded UTF-8 drafts with explicit
Replace or Append choices, and exports use the host's native save dialog.
Active `config-file` directives in the owned overlay can be preserved exactly
or cleared in-app. Reordering, partially removing, or adding include operations
requires opening the profile config in an external editor; this keeps
real-time renderer validation from activating a filesystem read through direct
paths or include-queue resets. Every loaded source must be a bounded regular
UTF-8 file, with aggregate include limits as defense in depth. Errors
introduced by the draft block Save & load, while unchanged errors in inherited
Ghostty roots remain visible without making the owned overlay permanently
read-only.

The Friendly editor changes that same raw draft through a visible managed
block, emitting only the setting groups the user actually changes. It supplies
color pickers plus opacity, typography, padding, scrollback, and keybinding
controls. Reset removes only that block. Colors, opacity, and
WebGPU effects preview live; scrollback applies to new sessions, while desktop
font changes remain startup-only and padding remains parsed-only. If an
included layer shadows a friendly override, the UI identifies the mismatched
fields and directs the user to the raw/source view instead of claiming the
change worked.

Appearance and Advanced drafts are mutually exclusive within one Settings
session. An Advanced save refreshes Appearance before that page can apply, and
an external configuration change requires an explicit reload-or-rebase choice
when Appearance has pending edits. Workspace shortcuts pause while Settings is
open. Electron also mirrors Advanced dirty state in main, so pane/window close
and application quit cannot bypass the discard confirmation.

Desktop key sequences, key tables, chained actions, and the full
`all:`/`global:`/`performable:` semantics are preserved in the snapshot but are
not applied yet. An unsupported action never replaces a working default
binding. Ghosttea's product-owned `super+shift+o` remote-session shortcut
currently takes precedence if an imported config uses the same trigger.

## APIs

Protocol 1.10 adds:

- `get-config` → a `config` response
- `reload-config` → a `config` response and, when changed, a pushed
  `config-changed` event
- `configRevision` on the hello response as the capability signal

The JSON object is `ghosttea-config` schema version 1 and is represented by
`ConfigSnapshot` in TypeScript and `GhostteaConfigSnapshot` in Swift. Apple
loads it through `ghosttea_config_load_json`, the same Rust implementation used
by `ghosttead`.

Protocol 1.11 adds a separate, lossless `ghosttea-config-document` schema:

- `get-config-document` returns the exact UTF-8 app overlay, its path,
  existence state, and a raw-content revision.
- `validate-config-document` projects candidate contents through the same
  layered loader without touching disk or changing the live snapshot.
- `replace-config-document` requires the revision returned by the last read.
  It either installs the exact candidate with an atomic same-directory
  replacement and reloads configuration, or returns
  `config-document-conflict` with the current document.

The document API never reconstructs source text from `ConfigSnapshot`, so
comments, ordering, unknown Ghostty keys, includes, line endings, and reset
expressions survive unchanged. Missing and existing-empty files have different
revisions. Writes use a private same-directory temporary file and replace the
destination only after a second revision check; on Unix the resulting overlay
is mode `0600`. Documents are capped at 64 KiB so requests and worst-case JSON
escaping stay within the authenticated control protocol's packet quota.
This is an optimistic concurrency contract: strict compare-and-swap requires
all writers to use the API, because unrelated editors do not honor its lock.

This is deliberately a privileged local API. It can address only the daemon's
explicit final overlay, never imported Ghostty roots or included files, and it
is not exposed over Truffle. The generic Electron renderer-to-daemon bridge
uses an explicit command allowlist that rejects these operations. The desktop
app exposes a separate, purpose-built Settings IPC facade: main owns the fixed
profile path, validates the 64 KiB text/revision payloads, performs validation
before writes, accepts only the trusted top-level application frame, returns
conflicts as data, and owns native import/export file dialogs. The renderer
never supplies a destination path or an arbitrary daemon command, and may not
introduce an unapproved include target. Electron omits the editing capability
entirely when attached to an externally managed daemon.
Node hosts use `GhostteaAutomationClient`; Swift embedders continue to load a
user-selected overlay URL through
`GhostteaConfiguration.load`.

Truffle terminal protocol 1.5 adds a host-authoritative
`TerminalPresentationConfig` at view attachment and a
`configuration-changed` state message. The projection contains only colors,
font size and family names, padding, and the supported post-process mode. It
never exposes host configuration paths, diagnostics, keybindings, scrollback
policy, or custom shader paths; only a count is retained so Apple can surface
that those shaders are unavailable. A configuration change is followed by a
full logical snapshot so a client can rebuild its shaping runtime before
accepting more patches. Clients connected to pre-1.5 hosts retain their
device-local presentation.

Reload immediately updates model colors and desktop presentation. Scrollback
limits apply only to new sessions. Parsed startup-only settings remain visible
so a settings UI can explain that a restart or future implementation is
required.

The iOS app loads one immutable device snapshot at launch from
`Library/Application Support/Ghosttea/config.ghostty` inside its container,
after the standard Ghostty-compatible layers. That revision configures every
local SSH pane. Shared desktop sessions instead adopt the desktop host's
redacted presentation at attach and on reload, while their input bindings and
retention policy remain local to the appropriate owner. The configured
scrollback limit is honored up to the app's device-specific memory cap. iOS
reload and a document-picker import flow remain future work.

## Upgrade discipline

`native/ghostty-config.lock.json` pins the released config commit, relevant
source hashes, projected defaults, generated key catalog, and X11 color table.
`scripts/sync-ghostty-config-schema.mjs` regenerates those files from the clean
pinned checkout. The offline upgrade gate verifies their hashes independently
from `native/ghostty.lock.json`, so a VT vendor upgrade cannot silently redefine
the migration contract.

The canonical syntax and source behavior are documented by
[Ghostty configuration](https://ghostty.org/docs/config), and individual option
semantics by the
[Ghostty option reference](https://ghostty.org/docs/config/reference).
