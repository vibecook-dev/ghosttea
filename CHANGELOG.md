# Changelog

All notable changes to Ghosttea are documented here. The Rust and npm packages
share one version.

## 0.10.2 - Unreleased

### Added

- `GhostteaTerminalMetalView.focusesInputOnScroll` (default `true`, unchanged
  behavior). A host that owns the keyboard itself turns it off, and scrolling
  the terminal by touch no longer takes keyboard focus — a swipe scrolls
  without raising the keyboard, as `focusesInputOnTap` already does for a tap.
- `GhostteaTerminalMetalView.gridAlignment` (default `.top`, unchanged
  behavior). A host showing a session whose PTY size another device holds sets
  it to `.bottom`, and the held grid's last row sits where the view's own last
  row would — the prompt stays at the foot and the empty rows go to the top; a
  taller grid clips its top rows, not its prompt. Drawing, hit testing, mouse
  reports, selection, the caret and VoiceOver's row frames move with it; the
  grid the view measures and reports does not.

## 0.10.1 - 2026-08-18

### Fixed

- Windows inherited-session environment filtering now matches the operating
  system's ASCII-case-insensitive key lookup. Case variants of Ghosttea and
  Terminald built-ins, built-in private prefixes, and host-provided private
  prefixes are removed before a ConPTY child starts; Unix environment names
  remain byte-sensitive.

### Validation

- Windows process-tree custody tests now wait on handles to the exact process
  objects instead of polling reusable numeric PIDs. The ordinary Windows
  release gate therefore proves job-object teardown without PID-reuse false
  positives; this hardening changes the witness, not runtime custody behavior.

## 0.10.0 - 2026-08-18

### Added

- Control protocol 1.15 adds an optional per-session `scrollbackBytes` cap.
  Zero disables scrollback, omission retains the daemon default, values must be
  non-negative JavaScript safe integers, and the effective local cap is echoed
  in session summaries. Clients requesting an override reject daemons older
  than 1.15 instead of pretending an unknown field was enforced.
- Control protocol 1.16 adds stable structured request failures. Both browser
  and Node clients now reject with `GhostteaRequestError`, preserving the
  byte-identical legacy message while exposing `stage`, `code`, and `osError`
  when the daemon can classify them. PTY spawn failures carry typed operating
  system errors; portable-pty open failures honestly identify only the
  `openpty` stage because that dependency has already stringified its errno.
- `ghosttea-vt` now exposes read-only packed-mode lookup, pending-wrap state,
  whole-screen and state-only recovery fragments, complete saved cursors per
  primary/alternate screen, sparse screen-selected row/state snapshots, and
  URI plus explicit/implicit hyperlink identity. These APIs recover inactive
  screens without activating them and preserve hyperlink groups across Ghostty
  page migrations.

### Changed

- `TerminalSnapshot` now carries row wrap/semantic metadata and URI hyperlink
  runs. `TerminalScreenSnapshot` and the new saved-cursor/state types retain
  cursor style, protection, pending wrap, charset, keyboard, prompt, viewport,
  and hyperlink state needed for lossless replacement-terminal recovery.
- Ghostty VT artifacts are content-addressed by the pinned upstream commit,
  exact checksum-locked patch set, and build recipe. Bundles carry those source
  patches, and release tags promote the exact reviewed macOS and Windows
  candidates instead of rebuilding different non-reproducible bytes behind
  recorded checksums. macOS builds still pin Zig scheduling, target CPU, and
  the exact Xcode archive normalizer to minimize host and runner-toolchain drift.

### Compatibility

- This is a 0.x minor release because adding public fields to Rust snapshot
  structs is source-breaking for downstream exhaustive struct literals. Update
  such literals to initialize `TerminalSnapshot.row_metadata` and
  `TerminalSnapshot.hyperlinks`, or use defaults/construction helpers.
- Older daemons remain usable when no per-session scrollback override is
  requested. Their missing session-summary field is accepted; remote replicas
  report `scrollbackBytes: null`. Existing error message and `Error.name`
  behavior is unchanged, while callers may opt into the structured metadata.

## 0.9.4 - 2026-08-16

### Changed

- Local control protocol minor 14 makes application-owner closure a transfer
  transaction. Surviving layout references and owner-aware live view
  attachments are reconciled under the daemon's creation/closure lock before
  the old owner is tombstoned; mirrored sessions move to a live window, while
  only genuinely unreferenced sessions terminate. New Electron clients refuse
  the unsafe owner-close operation against older daemons and limit their
  compatibility cleanup to sessions no surviving window references.
- Managed Electron shutdown is now awaitable. The app keeps control endpoints
  intact until `ghosttead` exits, and a bounded hard kill remains after the
  daemon's ten-second drain allowance. A supervised daemon also watches a
  parent-owned stdin pipe, so an Electron crash or force termination triggers
  the same drain even when no signal or application cleanup runs.

### Fixed

- Unix PTY termination pins the root process's birth identity at spawn and
  revalidates every process and process group at each escalation rung. PID and
  PGID reuse can no longer redirect a late signal into an unrelated process,
  reparented survivors remain discovery roots for later descendants, and
  groups are addressed only inside a proven detached terminal session.
- Closing a pane or native window no longer terminates a session that is still
  mirrored in another surviving pane. The final pane remains the lifecycle
  boundary, including sessions whose original creation window no longer lists
  them in its own current layout.

## 0.9.3 - 2026-08-09

### Fixed

- **A repeat `cargo build` is a no-op again for every crate that links
  ghosttea.** `ghosttea-vt-sys`'s build script declared three paths under its
  own `OUT_DIR` as `rerun-if-changed` inputs — the downloaded release bundle and
  the library and header tree it extracts. Cargo writes the fingerprint
  reference before the script finishes populating `OUT_DIR`, so those paths were
  unconditionally newer than it: the unit invalidated itself on every build,
  re-downloaded and re-extracted the artifact, and dragged `ghosttea-vt`,
  `ghosttea-core`, `ghosttea`, and the embedding crate through a full recompile
  behind it. Each declaration is now made where the artifact's provenance is
  known, so only genuine inputs are declared — a caller's
  `GHOSTTEA_GHOSTTY_VT_BUNDLE` file, a `GHOSTTY_VT_PREFIX` tree, or a repository
  install tree — and never the script's own output. The downloaded bundle needs
  no declaration of its own: `artifacts.json`, already an input, pins its URL,
  size, and SHA-256, so the manifest is a complete fingerprint of those bytes.
  Verification is unchanged, every byte is still checked, and the environment
  contract is untouched; embedders consume the fix by bumping the pin. Builds
  from a repository checkout never showed the symptom, which is why it survived
  to 0.9.2 — only consumers taking the download path were affected.
- A repository install tree for a target marked `reproducible: false` now
  relinks when its static archive changes. The library was previously declared
  as an input only on the path that also checksummed it, so on those targets a
  local Ghostty rebuild left the stale archive linked.

## 0.9.2 - 2026-08-05

### Changed

- **Rust consumers must move their `truffle-core` pin.** Ghosttea now pins
  `truffle-core = "=0.7.12"`, up from `=0.7.11`. The pin is exact by design —
  every crate sharing an application-owned Truffle node must resolve the same
  version and source so its `Node` type is identical — so a consumer still
  pinned to `=0.7.11` cannot resolve alongside this release and must move too.
  That is a loud resolver error rather than a silent type mismatch, which is
  what the exact pin is for. The upgrade itself carries a single sidecar fix
  confining static routes to a rooted filesystem and records no breaking API
  changes.
- Advance the Swift package lock to the `truffle-v0.7.12` tag. Every hash-locked
  input is byte-identical at the new revision — the Truffle license, the
  TailscaleKit binary artifact URL and checksum, and the pinned libtailscale
  revision — so only the recorded revision string differs.

## 0.9.1 - 2026-08-04

### Added

- Embedding hosts can pass `effects` to `GhostteaWorkspace` alongside `theme`,
  giving each viewer independent shader selection and animation without writing
  visual preferences into a shared Ghostty configuration document. An omitted
  prop retains the existing config-derived behavior, and effects remain isolated
  per rendered surface even when multiple viewers attach to one session.
- The theme catalog, catalog source and revision, built-in themes, shader
  metadata, unavailable-upstream list, and appearance types are now documented
  as the supported UI-independent host appearance contract. Export shapes are
  semver-protected while catalog contents and shader availability remain
  explicitly revisioned and extensible.

### Changed

- Semantically equivalent host effect objects retain a stable renderer value,
  preventing parent rerenders from causing redundant terminal invalidations.
  Animated effects continue to honor the existing WebGPU focus and occlusion
  gate, so hidden workspaces schedule no shader frames.
- The SwiftPM native target is republished as
  `ghosttea-apple-native-9aaf82fbe5d3` from the exact 0.9.1 sources. Native
  provenance inputs now trigger the published-artifact audit directly, and the
  workflow rejects publication outside the protected `release/*` convention
  before starting an expensive Apple build.

## 0.9.0 - 2026-08-03

### Added

- A shared terminal-appearance system for desktop and iOS. Settings now expose
  terminal-layer background opacity, a pinned catalog of 602 Ghostty-compatible
  color themes, and four distributable shader ports: Better CRT, CRT, VHS, and
  Sparks from Fire. WebGPU and Metal use the same configuration semantics,
  including animated effects and transparent cell backgrounds, while preserving
  each platform's native renderer and lifecycle.
- Advanced Ghostty configuration editing on both app tracks. The raw editor
  validates and applies changes continuously, reports line-specific diagnostics,
  and supports importing the local Ghostty config or another file and exporting
  the result. A friendly editor covers the commonly supported colors, opacity,
  typography, scrollback, padding, and keybinding fields with controls such as
  native color pickers, while retaining unknown raw configuration entries.
- License and provenance metadata for the bundled theme catalog, shader ports,
  and additional symbol/text-presentation fonts. Upstream shaders without clear
  redistribution terms remain named but unavailable instead of being silently
  redistributed.

### Changed

- A shared session now carries terminal semantics rather than the host's visual
  choices. Desktop keeps its own theme, opacity, and shaders, while an attached
  iPhone consistently renders that same session with the phone's local settings.
  Indexed and default cell colors remain distinguishable across the compact
  protocol so either viewer can resolve them through its own palette.
- The iOS terminal surface now matches desktop interaction more closely:
  controller takeover resizes the PTY to the phone viewport, touch scrolling has
  momentum, and a selection remains anchored to terminal rows while content
  scrolls. Completing a native long-press selection uses the terminal selection
  RPC and places the selected text on the iPhone clipboard.
- The macOS Electron window again exposes visible native title-bar chrome and
  traffic-light controls while preserving the draggable region and clickable
  settings control.

### Fixed

- Terminal symbols such as text-presentation emoji, mathematical glyphs, and
  status marks render through deterministic bundled fallbacks on iOS instead of
  becoming colorful emoji or missing-glyph boxes.
- A terminal whose process exited could deadlock during its final refresh when
  selection publication tried to snapshot a still-locked model. The refresh now
  releases the model guard before executing update effects, so exit events and
  cleanup complete on macOS and Windows.

## 0.8.0 - 2026-08-01

### Added

- Saved workspace layouts survive an application restart. `GhostteaWorkspace`
  persisted geometry plus a session id per pane and silently dropped any pane
  whose session was no longer alive — after a restart that was every pane, and
  the whole saved layout resolved to nothing. Two optional props close the
  gap: `paneMeta` attaches durable, embedder-defined data to a pane as it is
  persisted, and `onRehydratePane` is asked — before the split collapse — to
  supply a live replacement session for a pane whose saved session is gone.
  A revived pane keeps its exact place, splits, and saved ratios, because
  Ghosttea keeps doing the restoring; the embedder only answers what session
  goes where. Dead panes resolve concurrently and apply in tree order, and
  declining (or failing) falls back to the previous drop-and-collapse. With
  the props unset, the persisted document and restore behavior are unchanged
  byte for byte, so no schema version bump. (#48)

### Changed

- The GhostteaKit native artifact is republished as
  `ghosttea-apple-native-e464e4ac38c4` and pinned by the root `Package.swift`.
  Content addressing covers the crate manifests compiled into the artifact,
  so the workspace version bump moves the digest even though no Rust source
  changed in this release.

## 0.7.0 - 2026-08-01

### Added

- Remote sessions survive their host going away. A per-session lifecycle —
  live, synchronizing, reconnecting, suspended, ended with a reason — replaces
  the frozen replica and silently discarded keystrokes that an outage used to
  leave behind. Reconnection is automatic with full-jitter backoff, resume is
  same-tick when the host returns, and input outside live is rejected with
  visible feedback rather than queued against a session that may have moved on.
- Outage detection in seconds instead of half a minute. Reconnect-capable
  peers run an idle-triggered heartbeat: a quiet connection is probed after
  3 s of silence and declared dead at 6 s, scoped per connection incarnation
  so a replayed or misdelivered pong can never vouch for a broken link.
  Measured on a real tailnet, detection fell from 24.0 s to 3.5 s. Busy
  connections never probe, and pre-0.7 peers keep the advertisement path.
- Reconnection cannot resurrect the past. Every attach attempt carries an
  ordered generation fenced by connection-id watermarks, the host enforces the
  attachment epoch uniformly across input, resize, control, cleanup, and state
  streams, and a superseded handler can neither publish stale state nor detach
  its successor. Sessions that end while a viewer is away report why —
  bounded tombstones distinguish a process that exited from a session that was
  closed, hosts say goodbye on clean shutdown, and a restarted host reads as
  host-restarted rather than a mystery outage.
- Terminal control changes hands without fights. The controller carries an
  always-present revision, clears are announced rather than silent, and
  reclaiming control after a reconnect compares-and-swaps against the observed
  revision — a pane that lost a race is told who won instead of stealing the
  seat back. Deliberate user claims keep last-write-wins semantics.
- iOS parity. The compact transport speaks the same reconnect protocol —
  takeover, heartbeat, typed attach rejections, goodbyes — and GhostteaKit
  gains a per-attachment lifecycle actor with the same fencing, orderly
  background suspend on scene phase, reconnect banners with honest end
  reasons, and copy that extracts from the retained frame while offline.
- A cross-language interop suite. A real Rust compact host and the real Swift
  client meet over loopback TCP in CI-runnable tests covering takeover
  recovery from a frozen host, a legacy pairing left unprobed, fenced control
  claims, selection round-trips, and the shutdown goodbye — each side proven
  against the other rather than against its own expectations.

### Changed

- Tunnel protocol minor 6, negotiated per connection with the hello now
  answering the computed minimum on both transports — the two ends of a
  mixed-version connection previously disagreed about what they had agreed
  on. Mixed pairings degrade to the pre-0.7 behavior by construction.
- Local control protocol minor 13. Control claims can carry an expected
  revision, and a fenced claim that loses receives the new control-rejected
  answer naming the winner; a daemon below 13 never sees the field and keeps
  unconditional claims.
- Host QUIC identity is bound to the tailnet's own WhoIs answer instead of a
  source-address registry lookup that rotted for relay-routed peers, closing
  0.6's documented within-tailnet impersonation caveat.
- Session listings report attachable from session state — it was hardcoded
  true — and ghosttead drains on SIGTERM/SIGINT, announcing shutdown to
  connected viewers before sessions end and reporting whether the goodbye
  went out.
- The GhostteaKit native artifact is republished as
  `ghosttea-apple-native-6672c03dfd43` — the first published through the
  CI-authoritative attested pipeline rather than a workstation. Four phases of
  reconnect work compile into every slice, so the Apple plane needed rebuilt
  bytes rather than only a version bump; the root `Package.swift` pins the new
  content digest.

## 0.6.2 - 2026-07-30

### Fixed

- Shifted keys send the character the keyboard layout produced. The key encoder
  reported that the layout consumed no modifiers, and Ghostty sends a key's text
  verbatim only when the modifiers left after removing the consumed ones are
  empty — so every shifted keypress looked like a modified one and fell through
  to an escape sequence keyed on the _unshifted_ codepoint. `Shift`+`/` encoded
  as `CSI 47;2u`, which is "the `/` key plus shift", and a client that cannot map
  a keycode back through the layout inserted `/` for `?`.

  Nothing showed this in a plain shell, because the fast path that sends text is
  only bypassed once a client enables the Kitty keyboard protocol. Clients that
  request alternate-key reporting recovered the character from the `47:63`
  alternate; clients that request only escape-code disambiguation had nothing to
  recover from. Letters were unaffected either way, since a client can uppercase
  those itself — punctuation cannot be derived without the layout, so `?` `!` `@`
  `~` `|` `:` `"` and the shifted digits were all affected.

  Shift is now reported as consumed exactly when the layout translated it into
  different text. The escape sequence still reports every modifier actually held,
  so genuinely modified keys are unchanged.

- The cursor no longer parks in the top-left corner while scrolled up.
  libghostty answers "do the terminal modes show a cursor" and "is the cursor
  inside the rows being rendered" separately, documenting the position as
  undefined when the second is false. Both were forwarded as one, so scrolling
  the cursor into the scrollback drew it at (0, 0) until the viewport returned to
  the bottom.
- `CSI 0 q` no longer stops the cursor blinking for the rest of the session. A
  blinking cursor is this terminal's default, but libghostty resolves both
  `CSI 0 q` and a terminal reset against a separate default-blink option that is
  off unless set, so the default survived only until the first program asked for
  the default cursor. An explicit request for a steady cursor is still honored.
- Terminating a Unix session whose background children hold the PTY slave now
  concludes. The reader never saw end of file, so the exit was never observed, no
  session-exited event fired, and three threads plus the terminal model leaked
  per session. The reader now polls the master alongside a shutdown pipe, the
  escalation signals the foreground process group as well as the root group, and
  it waits on an exit latch rather than fixed sleeps.
- Session creation no longer serializes globally behind the closed-owner mutex,
  closing an owner no longer holds that mutex across mesh network calls, and one
  failed termination no longer strands the owner's remaining sessions.

### Changed

- Control protocol 1.8. A client that lags the event stream now receives an
  events-lost notice instead of having events silently dropped, the event channel
  is deeper, and the control forwarder re-announces current state after a lag.
  The React runtime reconciles against `list-sessions` on that notice, retiring
  sessions whose exits were lost.
- Mesh discovery commands run off the connection loop so a slow peer cannot
  stall input queued behind them, both listeners time out unauthenticated
  connections, frame publishing shares one buffer instead of copying, and the
  supervisor escalates to `SIGKILL` when the daemon outlives `SIGTERM`.
- The GhostteaKit native artifact is republished as
  `ghosttea-apple-native-c134a0bb09d6`. The VT shim carrying the three fixes
  above compiles into every slice, so the Apple plane needed rebuilt bytes rather
  than only a version bump. Artifact bytes are never replaced in place, so this
  is a new content digest under a new tag, and the root `Package.swift` pins it.

## 0.6.1 - 2026-07-29

### Fixed

- GhostteaKit can be consumed by version. 0.6.0 pinned Truffle by bare Git
  revision, and SwiftPM forbids a version-resolved package from depending on a
  revision-pinned one, so every `from:`/`exact:` consumer — including the usage
  example 0.6.0 shipped — failed to resolve:

  ```
  package 'ghosttea' is required using a stable-version but 'ghosttea'
  depends on an unstable-version package 'truffle'
  ```

  Only `revision:` consumers worked. The pin is now
  `.package(url:exact:"0.7.11")`, which resolves the same commit through
  Truffle's plain `v0.7.11` tag, so the build is byte-for-byte what 0.6.0
  resolved — the artifact digests and release BOM are unchanged. `exact:` rather
  than `from:` keeps Truffle's lockstep discipline.

  Nothing caught this before release because both surfaces that were exercised
  are exempt from the rule: `apple/GhostteaApp` consumes the package by relative
  path, and resolving the repository _as the root package_ is not a
  consumed-by-version resolution. The App Store readiness gate now asserts the
  resolved pin carries a version, so reverting to a revision pin fails the
  release instead of silently breaking semver consumption again.

## 0.6.0 - 2026-07-29

### Changed

- **Breaking for Rust consumers.** `ghosttea-truffle` now pins
  `truffle-core = "=0.7.11"`, up from `=0.7.8`. The pin is exact by design —
  every crate sharing an application-owned Truffle node must resolve the same
  version and source so its `Node` type is identical — so a consumer still
  pinned to `=0.7.8` cannot resolve alongside this release and must move too.
  That is a loud resolver error rather than a silent type mismatch, which is
  what the exact pin is for. The Swift package follows the same revision.

  0.7.9 adds transport-derived caller identity (`whois(addr)`, node serve
  headers, QUIC accept identity). 0.7.10 replaces value-correlated sidecar RPC
  waiters with a reply broker keyed on request id, fixing an event burst that
  could surface a misleading timeout, two concurrent port-0 listens stealing
  each other's confirmations, and a synchronous failure burning a full 10s
  timeout. The QUIC peer handshake is unchanged between these releases, so this
  does not move the wire between an already-attached phone and desktop.

### Added

- GhostteaKit resolves as a SwiftPM URL dependency. It could previously only be
  consumed by relative path, because its manifest lived in a subdirectory and
  both the native XCFramework and the parity fonts were gitignored — and since
  `GhostteaCore` depends on both, a clean checkout failed at package-graph load
  for every product, including the pure-Swift ones. A root `Package.swift` now
  sources the XCFramework from a checksum-verified release asset, and the fonts
  ship in the tree.

  ```swift
  .package(url: "https://github.com/vibecook-dev/ghosttea.git", from: "0.6.0"),
  .product(name: "GhostteaTerminal", package: "ghosttea"),
  ```

  The dependency identity is `ghosttea`, which SwiftPM derives from the URL.
  The artifact is published under a content-addressed tag rather than a release
  version, because `.binaryTarget(url:checksum:)` needs a checksum already valid
  at the commit SwiftPM resolves and release assets are built after their
  release commit; only a change to the native sources moves it.

## 0.5.2 - 2026-07-28

### Fixed

- `@vibecook/ghosttead` works when a bundler inlines it. The resolver's
  direct `node_modules` walk runs from wherever the code actually sits, so a
  bundle under pnpm's layout found no platform package — and the failure was
  misreported as a pruned optional dependency. Resolution now recovers by
  locating the installed `@vibecook/ghosttead` from the bundle's own
  position and resolving the platform package from that directory's real
  path; only when the package itself is unreachable does it fail, naming
  bundling as the cause and `external` and `GHOSTTEAD_BIN` as the ways out.
- `@vibecook/ghosttead` and `@vibecook/ghosttea-native-tabs` can be
  `require()`d. Both packages exported only an `import` condition, so a
  CommonJS Electron main bundle could not consume them even when marked
  external. Their exports now carry a `require` condition for the same ESM
  module, which Node 22.12+ loads natively.

## 0.5.1 - 2026-07-28

### Fixed

- The prebuilt `ghosttead` daemon links harfbuzz statically. 0.5.0's macOS
  binary linked `/opt/homebrew/opt/harfbuzz/lib/libharfbuzz.0.dylib` and
  aborted in dyld on any machine without that formula, which is every machine
  0.5.0 promised would need neither this repository nor a toolchain. The cause
  was `harfbuzz-sys` probing pkg-config unless `HARFBUZZ_SYS_NO_PKG_CONFIG` is
  set: the release runner carries harfbuzz, so it linked against a prefix only
  the builder has, while a developer machine without the formula falls through
  and links the vendored source. The release now sets that variable on both
  platforms, so what ships no longer depends on what the runner happens to
  have installed.
- The release asserts that the daemon links nothing outside `/System` and
  `/usr/lib` before publishing it. Running the daemon on the runner that built
  it cannot catch a missing library that the runner itself supplies, so this
  gate checks the linkage instead — for every dependency, not only harfbuzz.

## 0.5.0 - 2026-07-27

### Added

- The `ghosttead` daemon ships prebuilt on npm. `@vibecook/ghosttead` resolves
  the binary for the current platform from `@vibecook/ghosttead-darwin-arm64`
  or `@vibecook/ghosttead-win32-x64`, honors the `GHOSTTEAD_BIN` override, and
  fails closed with the reason when it cannot resolve. Desktop consumers no
  longer need this repository checked out beside them, or a Rust toolchain.
- The macOS native window-tab ordering addon ships prebuilt as
  `@vibecook/ghosttea-native-tabs`, one universal (arm64 + x86_64) N-API
  binary that loads in every Node and Electron. Off macOS its exports return
  null, which is the contract consumers already code to.
- `ghosttead --version` prints the release the binary came from — its first
  and only argument; configuration stays entirely in the environment.
- A post-publish smoke workflow installs the published version from the
  registry on macOS, Windows, and Linux, runs the daemon, and loads the
  addon, so a release is verified as consumers receive it, not only as CI
  built it.

## 0.4.0 - 2026-07-25

### Added

- Support Windows as a desktop target. The pinned Ghostty VT core is now built
  and published for `x86_64-pc-windows-msvc`, and the same release gate runs on
  a Windows runner.

### Changed

- **Breaking.** `TerminalServiceListeners::new` takes `ipc::Listener` values
  instead of `tokio::net::UnixListener`. Windows has no filesystem socket that
  a client can dial, so the control and frame channels are named pipes there
  and the listener type had to stop naming one platform's transport. On Unix
  `ipc::Listener` converts from a `UnixListener` through `From`, so a host that
  binds its own socket adds `.into()`.
- A host supplying its own listeners now calls `ipc::remove_stale_endpoint`
  before binding, which is what `TerminalService::bind` has always done on its
  behalf. Only Unix has anything to remove; skipping it left a restarting
  embedder binding onto its own stale socket.

### Fixed

- Windows sessions report their exit. ConPTY holds its output pipe open until
  the pseudoconsole closes, so no session ever left the registry or delivered an
  exit code.
- Terminating a session reaches everything it started rather than only the
  process the PTY spawned.

## 0.3.0 - 2026-07-24

### Changed

- Pin the registry release of Truffle 0.7.6, replacing 0.7.2. Applications
  sharing an application-owned Truffle node must resolve the same version.
  The upgrade carries the Apple mesh runtime, accepted-peer identity, and
  listener-teardown fixes from 0.7.3 through 0.7.6, and introduces no
  breaking API changes.
- Advance the Swift package lock to the `truffle-v0.7.6` tag. Every
  hash-locked input—the TailscaleKit privacy manifest, libtailscale patch,
  materializer contracts, and pinned libtailscale revision—is byte-identical
  to the previous lock.

## 0.2.0 - 2026-07-23

### Added

- Separate Node, Electron, and React integration packages.
- Mounted-or-pinned frame subscriptions with explicit renderer-side session
  unregistration.
- Negotiated renderer/worker frame credits, targeted gap recovery, and bounded
  resynchronization concurrency.
- Catalog generations and bounded renderer glyph/style retention.
- Native and renderer lifecycle churn coverage, including process RSS and thread
  guardrails.
- Always-on desktop release, minimum-Rust, packaging, and dependency-audit CI
  gates.

### Fixed

- Release all per-session input and activity actors after natural PTY exit.
- Bound closed-owner and frame-gap lifecycle archives without steady-state
  allocation.
- Prevent inactive sessions from continuing to receive and decode terminal
  frames.
- Cap performance-measurement samples and retained CPU glyph pixels.

### Performance

- Preserve frame bytes through native fanout with shared ownership.
- Coalesce transport pressure behind byte credits without regressing the
  established native benchmark threshold.

## 0.1.0

- Initial Ghosttea protocol, frame decoder, browser client, Rust terminal
  service, and pinned Ghostty VT artifact.
