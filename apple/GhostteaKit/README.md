# GhostteaKit

This directory is the Apple-side Phase 0 integration package for the iOS terminal project described in [`draft/ios-terminal-design.md`](../../draft/ios-terminal-design.md).

It proves the pinned upstream `libghostty-vt`, shared Rust text engine, and
production `ghosttea-core` model on Apple targets. `GhostteaCore` is the safe
Swift boundary over the versioned `ghosttea-ffi` C ABI and its ordered effect
arena. The package also contains the host-neutral, demand-driven
`GhostteaTransport` contract and the pinned libssh2/OpenSSL nonblocking SSH
implementation selected by the Phase 0 gate.
`GhostteaSession` is the production orchestration boundary that binds any such
transport to one core terminal while preserving effect, input, resize, and
lifecycle ordering.
The raw Ghostty, Rust, and libssh2 APIs are explicitly not application
contracts.

`GhostteaConfiguration.load` exposes the same versioned Ghostty-syntax
configuration snapshot as the desktop daemon. It can import Ghostty's standard
files plus an app-owned overlay; `GhostteaTerminalConfiguration(config:)`,
`GhostteaTerminal.apply(config:)`, and
`GhostteaTerminalMetalView.applyConfiguration(_:)` apply the currently
supported terminal and presentation fields. The exact support matrix is in
[`docs/ghostty-config-compatibility.md`](../../docs/ghostty-config-compatibility.md).
`GhostteaRuntime(config:)` applies the resolved font size to shaping and grid
metrics. The iOS app loads one snapshot at launch and passes it through both
shared and SSH terminal paths.

`GhostteaCredentials` defines the first persistent-secret boundary. It stores
opaque credential references in Apple's device-only, non-synchronizing
data-protection Keychain. The SSH adapter resolves password, private-key, and
passphrase bytes only during authentication and passes private keys to
libssh2's in-memory API without a filesystem path. The policy and
remaining product integration work are recorded in
[`Compatibility/credential-security-policy.md`](Compatibility/credential-security-policy.md).

Phase 9 release inputs are tracked in a deterministic CycloneDX inventory.
[`Compatibility/release-hardening.md`](Compatibility/release-hardening.md)
defines its direct/static and 89-crate Apple-target scope, exact drift check,
reviewed compiler lock, independent CI schema validation, fail-closed SSH
approval gate, and accepted release-only deferrals. Those deferrals keep their
release gates active while implementation continues.
[`Compatibility/swift-rendering-performance.md`](Compatibility/swift-rendering-performance.md)
maps the measured desktop/native rendering and Truffle optimizations onto the
Swift retained-state, Metal, atlas, and Apple compact-stream paths. The
production app bundles the byte-identical BOM and a
105-component human-readable notice assembled from 94 exact license documents;
its archive verifier checks both resources before accepting the artifact. It
also emits deterministic source/lock, archive/app/dSYM, executable UUID,
signature, and checksum evidence. The same validator safely extracts an
optional exported IPA, requires archive parity and Apple Distribution signing,
and records every unmet release policy instead of overstating eligibility.
The App Store gate separately pins the app and TailscaleKit privacy manifests,
audits required-reason symbols in the built bundles, declares embedded
non-Apple cryptography honestly, and keeps privacy-label, export-documentation,
and reviewer-access decisions fail closed.
`GhostteaDiagnostics` provides the production app's crash-surviving support
record. Its typed schema cannot accept raw error text or terminal/session data;
the bounded file is replaced atomically under complete iOS file protection and
is available through the app's About sheet.
Ghostty source updates follow the checked
[`Compatibility/ghostty-upgrade-procedure.md`](Compatibility/ghostty-upgrade-procedure.md):
the source/font pins, native artifact identity, parity fixtures, release BOM,
Apple rebuilds, performance evidence, and desktop/iOS Truffle interop are one
reviewed change rather than an independent version bump.
[`Compatibility/fuzzing.md`](Compatibility/fuzzing.md) records the fixed-seed
C-ABI and Swift TRF1 mutation gates, retained hostile inputs, output/arena
invariants, and the longer sanitizer campaign required for a release candidate.
[`Compatibility/memory-pressure.md`](Compatibility/memory-pressure.md) defines
the iOS presentation-cache eviction transaction: memory warnings release the
20 MiB Metal atlases and CPU glyph/style render payloads, retain readable
terminal text, request a full Truffle or SSH snapshot, and rebuild lazily only
after that snapshot arrives. The same contract routes Ghostty's logical-content
preserving full scrollback compression through the production FFI and applies
it to hidden SSH tabs on a warning. Hidden terminals beyond the physical-device
tier's four/eight-session cap are then evicted by deterministic LRU; selecting
or reconnecting a cold pane recreates fresh native resources under its stable
workspace identity without an automatic SSH connection. Aggregate byte-budget
enforcement samples whole-process Darwin physical footprint and continues LRU
eviction while above the device tier's soft bound. A signed standard-tier
iPhone gate now drives the production path from 185.1 MiB to 145.2 MiB with one
exact oldest-hidden-session eviction. The implementation and standard-tier
over-soft recovery proof are complete; compact-device and real
system-pressure/jetsam evidence remain release gates.

`GhostteaTruffle` is the first Phase 8 cross-device product boundary. It imports
the Apple-native Swift package from Truffle's published repository, pinned to an
exact revision in [`Compatibility/truffle-swift.lock.json`](Compatibility/truffle-swift.lock.json),
uses the same `ghosttea-terminal` app ID as the desktop daemon, persists only
Truffle's durable device ID, and resolves a fresh generation-checked `Peer`
before every connection. Its typed clients implement the desktop `TSP1`
connection-control preface, nonce handshake, shared-session listing, and a
dedicated demand-driven live attachment over Truffle's full-duplex
`MeshConnection`. Compact control/state channels carry the existing session
epochs, input, resize, selection, snapshot, and patch contracts. Remote logical
state is rendered locally by a separately owned `GhostteaLogicalReplica` C/Swift
handle, and the replica pump ACKs only successfully produced TRF1 frames. The
exact sibling revision and
Ghosttea ports/protocol version are recorded in
[`Compatibility/truffle-swift.lock.json`](Compatibility/truffle-swift.lock.json)
and included in the deterministic iOS BOM. The desktop daemon now binds the
matching compact-stream listener on port 9421, requires Tailscale WhoIs
identity, reconciles it with the current Truffle peer, and serves the shared
handshake/session-list contract without changing its existing
desktop-to-desktop QUIC path. Production TailscaleKit composition and the real
application composition now live in the separate `apple/GhostteaApp` target.
The pinned TailscaleKit binary sets the production package minimum to iOS 18.1.
The app's SSH tab now composes the protected profile repository, device-only
Keychain credentials, host-key and keyboard-interactive prompt boundaries,
network-aware `GhostteaSession`, the shared Metal terminal surface, and the
tested tabs/splits coordinator. Secret-free multi-pane workspace state is saved
atomically and restored demand-paused. The app also composes the shared command
palette and routes hardware-keyboard workspace chords before terminal input.
The automated Release archive now passes store validation and verifies its
bundle, arm64 executable, dSYM, and team signature. A signed iPhone 14 Pro has
discovered the desktop demo, attached read-write to its live Truffle session,
and driven input that appeared in the concurrently attached desktop terminal;
the exact evidence and remaining live matrix are recorded in
[`Compatibility/ios-device-evidence.md`](Compatibility/ios-device-evidence.md).
The automated signed-device matrix now proves two concurrent iOS attachments,
control handoff, exact resize, selection, snapshot resync, detach/reconnect,
and desktop-process restart recovery against the same desktop session. The
embedded-listener descriptor fault is fixed by the reviewed libtailscale patch
recorded in the release lock. The production `WindowGroup` now shares one
application-owned mesh while giving each scene an independent attachment,
replica, renderer, grid, control epoch, and stable view ID; a signed iPhone
regression passes after that ownership split. A deterministic iPad Pro
Simulator gate also creates two real `WindowGroup` scenes, verifies the shared
runtime and distinct identities, closes one, and observes one survivor.
Physical iPad Stage Manager terminal qualification and the periodic
self-recovering Tailscale LocalAPI watch timeout remain release gates.
App Store distribution export and signed provenance publication remain
release-account steps; their local evidence contract is implemented.

`GhostteaConnectionProfiles` defines the versioned, non-secret recipe used to
recreate an SSH connection. A profile may persist ordinary connection metadata,
terminal dimensions, and a shell/tmux/Zellij attach choice, but authentication
contains only typed opaque Keychain references. Its actor-backed JSON store
validates versions and duplicate IDs, writes atomically, and applies complete
file protection on iOS. Keyboard-interactive responses remain runtime-only and
must be supplied afresh when a profile is resolved.
`GhostteaSSHConnectionProfileRepository` composes that store with the Keychain
vault. New secrets receive fresh opaque IDs before profile JSON changes; a JSON
failure rolls the new items back, while successful replacement or deletion
retires old items and returns any cleanup debt for explicit retry.
`GhostteaConnectionProfilesUI` provides the reusable SwiftUI list and editor.
Its metadata draft cannot contain secret fields, and its transient editor
clears password, private-key, and passphrase strings before a successfully
validated one-shot save request leaves the view.

`GhostteaSession` owns generation-checked connection and read tasks above the
transport-neutral reconnect policy. Inbound data is pulled in bounded chunks,
so a slow terminal or awaited host event naturally withholds further SSH window
demand. Terminal replies and user input share one bounded, strictly sequenced
writer. Core effects reach the host in their original order, while route
changes, background suspension, explicit disconnect, clean exit, and late task
completion remain generation-safe. PTY resize is sent before the matching core
resize and full frame. The first replay tests cover clean drain/exit, native
terminal replies, ordered input, resize propagation, and explicit reconnect.

`GhostteaWorkspace` is the platform-neutral Phase 7 pane-tree and tab-collection
contract. Its version-1 documents store only stable layout IDs and opaque
session IDs—never credentials, host data, commands, cwd/title, or live
connection state. The pure reducers implement split, focus, resize, equalize,
zoom, pane close, tab creation/selection/reordering, and deterministic tab
close semantics. Pane actions route through the collection atomically so a
last-pane close closes its tab when possible and only the sole remaining tab
requests window closure. Swift and TypeScript consume the same JSON vectors.
Restoration filters both trees and tabs against sessions that are actually live
and repairs stale active, zoom, and selected-tab references.
`GhostteaWorkspaceRestorationDocument` adds an exact session-to-profile-ID
manifest without changing that rule: a binding is permission to attempt a new
allocation, never evidence of a surviving connection. The host restores stable
workspace identities only after their profiles have produced fresh terminal and
transport resources; failed allocations collapse through the ordinary
restoration reducer.
Its atomic JSON store applies complete file protection on iOS. The generic
restorer attempts allocations sequentially in workspace order, collapses
ordinary per-session failures, and rolls back every completed allocation if the
task is cancelled. This makes authentication prompts deterministic and avoids
an all-or-nothing launch when one saved server is unavailable.

`GhostteaWorkspaceUI` adapts that same model without changing it. Regular iPad
and external-display size classes show the selected tab's recursive split tree;
compact iPhone size classes mount only the active pane and provide a pane
switcher. Zoom presents one pane in either mode. The caller supplies pane views
and handles emitted reducer actions, keeping terminal/session ownership outside
the SwiftUI layout product.

`GhostteaWorkspaceKeyChord` resolves the same Ghostty-style application
shortcuts as the desktop package and assigns stable `ghosttea.workspace.*`
command IDs. `GhostteaWorkspaceCommand.route(in:)` turns mutations into outer
reducer actions while leaving new-tab, split-session, and remote-picker work as
explicit host requests. Product input code should try this resolver before
terminal key encoding and forward only unmatched chords to the terminal core.
`GhostteaWorkspaceShortcutState` additionally preserves press ownership across
down, repeat, and up events so a claimed application shortcut dispatches once
and cannot leak its release into the terminal.

`GhostteaWorkspacePaletteSnapshot` provides deterministic, tokenized filtering,
deduplication, ranking, and wraparound selection over typed saved-connection and
workspace-command invocations. `GhostteaWorkspacePaletteView` presents the same
search-first interaction as the desktop remote-session palette: touch rows plus
hardware Up/Down, Return, Escape, and Command-Shift-O dismissal. It receives
ordinary profile display metadata and an opaque profile ID; credentials and
session allocation remain host-owned.

`GhostteaWorkspaceSessionCoordinator` is the transport-neutral multi-session
host boundary. It allocates a real session before committing a new tab or
split, rolls invalid allocations back through the supplied terminator, removes
only session IDs emitted by close transitions, and drains all remaining
sessions in workspace order on window close. Its registry must exactly match
the document at initialization, so persisted identities never become claims
that a session is live.

`GhostteaSSHWorkspace` is the concrete bridge injected into that coordinator.
One factory shares only immutable SSH configuration and the native text
runtime; every allocation receives a unique opaque workspace ID, native
terminal handle, `GhostteaTerminal`, `GhostteaSession`, ordered event identity,
and disconnect lifecycle. Allocation can remain demand-paused for restoration,
while ordinary new-tab and split requests start a fresh transport before the
coordinator commits their layout identity.
Restoration may request a persisted session ID and a per-session profile while
still receiving a fresh native terminal handle and SSH transport. Duplicate or
empty restored identities are rejected within a factory lifetime.
The SSH restore convenience resolves each available saved profile, recreates
its resource demand-paused by default, and returns the exact registry required
to initialize `GhostteaWorkspaceSessionCoordinator`.

`GhostteaSSHConfiguration` and `GhostteaSSHTransport` are the production SSH
entry points; the older candidate names remain for compatibility fixtures and
the device harness. `GhostteaSSHSessionFactory` installs SSH-specific, redacted
failure handling and separates transient network failures from authentication,
host-key, credential, and remote-command failures that require user action.
Passwords, private keys, and passphrases resolve from the Keychain only when
authentication begins. The known-host path helper creates an app-private
Application Support directory with complete file protection on iOS, while the
native store retains atomic OpenSSH-format updates. Shell, named tmux, and
named Zellij attach profiles request a PTY and quote session names as single
shell arguments.

The iOS harness now binds that production session directly to the shared core
and Metal terminal surface. Session state, TRF1 frames, hardware/software/mouse
input, scrollback, selection, route changes, and app suspension all cross the
same `GhostteaSession` actor used by product code. Its automatic shell gate
connects to the disposable fixture, emits styled output, exits cleanly, and
validates the marker through native terminal accessibility text before passing.
The dedicated device runner installs a signed build, starts the fixture, waits
for the app's process result, and removes its temporary Keychain credential
before exit. A second automatic gate attaches a named tmux session, observes
its initial pane through native accessibility text, propagates a PTY resize,
injects an exit acknowledgement, and requires a typed zero exit.
The Vim gate launches the fixture's minimal Vim build, obtains both the initial
and resized dimensions from `stty` inside Vim, edits the buffer through the
normal terminal input path, validates each marker through native accessibility
rows, and requires Vim to exit normally.
The Zellij gate attaches or creates a named session using a checksum-pinned
official no-web binary in the disposable fixture. It validates the initial
pane, propagates an outer PTY resize, sends input through the ordered session
writer, observes every marker through native accessibility rows, and requires
Zellij and its pane to exit cleanly.
The monitor-TUI gate runs pinned htop and btop builds in one production SSH
session. It validates each application's main and overlay views through native
accessibility rows, drives their normal keyboard paths, resizes the PTY in both
directions, and requires both applications and the shell to exit normally.
The agent-TUI gate runs the real, pinned Claude Code CLI against a disposable
Anthropic-compatible gateway inside the SSH fixture. It validates a streamed
answer, interrupts a deliberately held stream, opens the shortcuts overlay,
resizes the PTY, exits through `/exit`, and requires the final remote size and
typed zero exit through the same production terminal path. The test uses a
fixture-only token and never requires a developer credential or external model
request.

## Build and test

From the repository root on Apple Silicon macOS:

```sh
GHOSTTY_DEVELOPER_DIR=/Applications/Xcode_26.3.app/Contents/Developer \
  npm run bootstrap:ghostty-vt:apple
GHOSTTY_DEVELOPER_DIR=/Applications/Xcode_26.3.app/Contents/Developer \
  npm run build:ghostty-vt:apple
npm run bootstrap:ssh:apple
npm run build:ssh:apple
npm run build:apple-native
npm run check:ssh:apple
npm run test:ghostty-vt:apple
npm run test:swiftpm:consumer:local
npm run test:font-parity:apple-runtime
npm run test:ghosttea-core:ffi
npm run test:ghosttea-core:apple-runtime
npm run test:ghosttea-frame:apple-runtime
npm run test:ssh:fixture
npm run test:ssh:fixture:candidate
npm run test:ssh:fixture:swift
npm run test:ios:production-session
npm run test:ios:production-tmux
npm run test:ios:production-vim
npm run test:ios:production-zellij
npm run test:ios:production-monitor-tuis
npm run test:ios:production-claude
npm run bench:ghostty-vt:apple:matrix
```

Xcode 26 installs its Metal compiler as an optional component. If `xcrun metal`
reports a missing toolchain, install the pinned Xcode component once:

```sh
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer \
  xcodebuild -downloadComponent MetalToolchain
```

The Ghostty build uses a repository-pinned Zig archive and Ghostty commit. The
SSH candidate build uses pinned OpenSSL and libssh2 commits. Both produce and
validate macOS, iOS device, and iOS simulator slices.
`build-ghosttea-apple-native.mjs` compiles the core and font-fixture Rust ABIs as
dependencies of one final `ghosttea-apple-ffi` static library, then combines
that single Rust linkage unit with SSH. This guarantees one Rust runtime while
retaining separate `GhosttyVt`, `LibSSH2Candidate`,
`GhostteaFontFixtureNative`, and `GhostteaCoreNative` Clang modules. The full
Swift test suite and an external consumer linking every public product gate the
result on macOS; the integration proof also cross-compiles relevant targets for
the arm64 iOS simulator and device SDKs.

`GhostteaFontProof` loads the five SHA-256-locked font resources from its Swift
package bundle and runs the Rust shaping/rasterization fixture through the C ABI.
The runtime script compares its normalized geometry and glyph bitmap hashes with
the desktop golden on macOS and an iPhone simulator. Pass `--device` directly to
`scripts/test-font-parity-apple-runtime.mjs` to include a connected, unlocked,
signed physical iPhone run.

`GhostteaCore` loads those same package resources and owns runtime and terminal
handles through Swift reference types and a terminal actor. Each update owns a
single aligned native arena whose descriptors retain the core's exact effect
order; callers may copy payloads or borrow them for the duration of a closure.
`npm run test:ghosttea-core:ffi` checks the public header, malformed arguments,
panic poisoning, exact direct-Rust parity, repeated ownership lifecycles, strict
Clippy, and an AddressSanitizer build. The Apple runtime runner checks the same
reply, logical snapshot, accessibility text, and TRF1 frame through Swift on
macOS and iOS. Add `--device` to the underlying runner for physical-device
evidence.

Phase 4's decoder-first `GhostteaTerminal` slice validates TRF1 completely
before Metal sees any size, count, text, or pixel data. The
internal decoder preserves unknown section kinds for compatible extensions,
uses bounded zero-copy frame slices, and decodes every section currently
emitted by `ghosttea-core`. Its Apple runtime gate executes a production frame
on macOS and an arm64 iPhone Simulator; pass `--device` to the underlying
runner to include a signed physical iPhone.

`GhostteaTerminal` also owns retained frame state ahead of GPU resources.
The state machine matches desktop full/incremental sequence classification,
keeps glyph and style catalogs plus row revisions, rejects stale frames, and
enters an explicit full-refresh state after gaps or malformed input. State
replacement is atomic: Metal will never observe a partially decoded frame.

The first Metal resource slice owns one device and command queue plus bounded
2,048-square alpha (`r8Unorm`) and premultiplied-color (`rgba8Unorm`) glyph
atlases. Deterministic shelf placement caches glyph IDs, performs no second
upload for an unchanged visible set, and resets only when the complete visible
working set fits an empty atlas. A set that cannot fit fails before texture
mutation. The fixed resource footprint is 20 MiB; tests cover real production
glyphs, placement, reset, exhaustion, and malformed pixel storage on macOS, and
the automated iPhone Simulator harness executes the real texture upload path.

The first render-pass slice converts retained rows and styles into the same
ordered geometry used by the desktop demo: style backgrounds, view-owned
selection, alpha glyphs, premultiplied color glyphs, decorations, then cursor.
It preserves the desktop cell/origin constants and premultiplied blending,
rejects invalid geometry, renders to an offscreen `rgba8Unorm` target, and reads
pixels back for deterministic same-device verification. Styled ANSI text and a
color emoji exercise every pipeline on macOS and iPhone Simulator. Runtime MSL
compilation was the initial bring-up mechanism and has since been replaced by
the packaged library described below. Offscreen readback remains for the proof;
drawable screenshot goldens remain.

On iOS, `GhostteaTerminalMetalView` is the first public presentation surface.
It is an event-driven `MTKView`: continuous drawing is paused, accepted frames,
drawable-size changes, selection/focus changes, and cursor blink
transitions request individual draws. Full/incremental/stale classification
stays inside the view's retained state, with a callback when the core must send
a full refresh. Drawable submission does not wait on the main run loop. App
backgrounding discards the reconstructible renderer and its 20 MiB atlases
while keeping logical terminal state. Memory warnings additionally discard
CPU glyph/style render payloads, retain row text and accessibility state, and
hold drawing until the host supplies a full snapshot. Truffle and direct-SSH
production surfaces both wire that refresh callback; GPU resources rebuild
lazily after recovery. The harness embeds the surface as a visible preview
after its renderer fixture runs.

`GhostteaTerminalLayout` converts point-space bounds into a clamped terminal
grid using the desktop demo's 7.83-by-19 cell metrics and two-point padding.
`GhostteaTerminalMetalView` combines UIKit safe-area insets with explicit host
content insets, uses that same value for both Metal's content origin and grid
calculation, and emits a deduplicated `onGridSizeChange` callback on layout,
safe-area, and drawable-size changes. The controller can route that callback to
the production core and SSH PTY without putting transport I/O in the view.

`GhostteaResizeCoordinator` owns that controller-side transaction. It
coalesces layout bursts, resizes the PTY before the core model, advances the
layout epoch, and publishes only a full frame for the newest requested size. A
core failure attempts to roll the PTY back to the last committed grid. The
Metal view can bind its deduplicated grid callback directly to this coordinator
while frame application remains an explicit commit handler owned by the host.

The surface owns the desktop-compatible cursor blink state machine. It uses a
600 ms one-shot task, resets visible on cursor activity or restored
focus/visibility, and schedules only for a visible blinking cursor in a focused,
visible surface. Background/GPU suspension and scene occlusion cancel the task;
`setTerminalVisible(_:)` lets a multi-scene host report per-scene visibility,
and `noteCursorActivity()` restarts the interval after local input. Each toggle
requests one Metal draw rather than enabling a display link.

`GhostteaSceneAttachmentRegistry` supplies the local-session presentation boundary:
one generation-checked attachment token per session, explicit transfer to a
new scene, stale-detach rejection, and per-scene visibility changes. Scene
disconnection drops only presentation ownership; it never destroys the
app-owned session. `GhostteaSceneLifecycleState` separately computes the
aggregate app phase so one background window cannot suspend work still visible
in another active scene. Remote Truffle sessions use the desktop core's native
multi-view capability instead: each production scene owns a separately rendered
attachment with a `GhostteaSceneTerminalIdentity`, while the mesh remains
application-owned.

The first native-input slice keeps UIKit above the terminal encoding boundary.
`GhostteaHardwareKeyEvent` maps Apple HID usages to desktop-compatible DOM codes
and carries printable text, unshifted layout identity, modifiers, and
down/repeat/up actions. `GhostteaTerminalInputEncoder` sends terminal keys to
the shared Ghostty-backed `GhostteaCore.encodeKey`, while handling the same
small application-binding layer as desktop and exposing configurable Option
behavior. The Metal view can become first responder on tap and reports hardware
presses through `onHardwareKeyEvent`; returning `false` preserves UIKit's normal
responder chain, and responder loss releases handled held keys.

The next native-input slice makes that same Metal view a deliberately small
`UITextInput` document. The document contains only the active marked-text
composition; terminal history remains native-model state and is never mirrored
into UIKit. Committed Unicode is emitted once through `onSoftwareInputEvent`,
while Return, backward delete, and paste reuse the Ghostty-backed key and paste
encoders. Newlines are normalized into ordered Return events, including CRLF,
and terminal bracketed-paste mode therefore applies equally to software paste
and Command-V.

Marked text is drawn as a transient overlay at the retained terminal cursor,
with UIKit candidate and caret geometry anchored to the same position. UTF-16
selection is retained for UIKit, but deletion and character-range queries honor
composed character sequences so emoji and combining text are not split. Smart
quotes, smart dashes, autocorrection, spell checking, and autocapitalization
are disabled because terminal input must preserve user intent. The harness
preview exposes both hardware and software input callbacks and displays their
encoded bytes after its production TRF1 proof.

The terminal's configurable `inputAccessoryView` provides the default
`` Esc Tab Ctrl Alt ← ↓ ↑ → Home End PgUp PgDn | ~ ` `` row in a horizontally
scrollable native control. Ctrl and Alt are visible one-shot latches: the next
supported software-keyboard character, Return, Delete, or accessory key becomes
a normalized `GhostteaHardwareKeyEvent`, then the latch clears. Accessory
symbols carry their physical HID identity and intrinsic Shift modifier. This
keeps terminal modes and the Option-key policy in the shared input encoder;
the accessory view never constructs an escape sequence.

The pointer foundation retains TRF1's mouse-tracking flag and exposes a typed
press/release/motion model above `GhostteaCore.encodeMouse`. View coordinates
are normalized with the same screen, rounded cell, and content-padding geometry
as desktop, including iOS safe-area/content insets. Routing is explicit:
tracking applications own unmodified pointer input, while non-tracking sessions
and the Shift/force-local override belong to view-owned selection. The shared
Ghostty encoder remains the only component that emits mouse protocol bytes.
Gesture recognizers, wheel accumulation, and selection extraction build on this
boundary in the next slice.

The interaction slice installs indirect-pointer pan and hover recognizers plus
direct-touch pan and long-press selection recognizers. Active mouse-tracking
sessions receive normalized left press/motion/release and hover events; Shift
or `forceLocalSelection` keeps the same pointer drag view-local. Trackpad and
one-finger scrolling use desktop's 2× precise-device multiplier, retain sub-row
remainder for the gesture, and cap remote wheel packets at 12 per update.
Non-tracking rows return to the host, where regular screens move scrollback and
alternate-screen applications receive their configured scroll-key input.

Local selections are stored in absolute scrollback coordinates, clipped back
to the current viewport for Metal rendering, and retained across scroll frames.
The host receives change and commit callbacks; committed extraction goes to
`GhostteaTerminal.selectionText` so wrapped rows, wide cells, and graphemes stay
native-model decisions. Zero-length pointer clicks clear selection; a touch
long-press is itself an explicit selection gesture, so it retains and copies
its cell even without a drag. Word/line expansion, which is absent from the
desktop demo, is not added as an iOS-only behavior. Physical pointer and touch
ergonomics remain release evidence.

Selection now also matches the desktop demo at viewport edges and in its edit
menu. While a local drag remains above or below the surface, a cancellable
40 ms task requests one native scroll row and advances the absolute focus when
the returned TRF1 scrollbar frame arrives. Responder loss, backgrounding, and
gesture completion stop the task. A secondary indirect-pointer click presents
UIKit's Copy, Select All, and Paste menu. Copy and completed non-empty drags ask
the host to extract native selection text; Select All highlights the entire
absolute row range and invokes the native `selectAll` extraction path. The
diagnostic harness writes only those user-invoked results to `UIPasteboard`.

The accessibility surface consumes TRF1's dedicated native accessibility rows,
not glyph geometry or an editable UIKit mirror. Each visible terminal row is a
stable `UIAccessibilityElement` with its absolute scrollback row, screen frame,
and frequently-updating static-text traits. The container supports VoiceOver
page scrolling through the host's native scroll callback, Escape-to-unfocus,
and Copy, Select All, and Paste custom actions. The public accessibility
snapshot keeps this row model inspectable without exposing renderer internals.
Automated simulator coverage proves the element tree and actions; physical
VoiceOver navigation and announcement pacing remain release evidence.

Renderer shaders live as Metal source in the package and are compiled ahead of
time by the local `GhostteaMetalCompilerPlugin`. The plugin declares its AIR and
target-specific `GhostteaTerminal.metallib` outputs as package resources; the
renderer loads that library by URL and has no runtime-source compilation
fallback. This keeps simulator, physical-device, and macOS libraries separate
while making a missing build toolchain or packaged function a build/test
failure.

The initial visual-conformance gate uses the same styled Unicode/emoji TRF1
fixture at 787 by 574 pixels. Same-device runs retain an exact FNV-1a pixel
hash. Cross-device runs compare a 96-by-64 horizontal and vertical perceptual
edge map, mean RGBA channels, and non-background pixel count with explicit
tolerances stored beside the golden. `GhostteaVisualGoldenRecorder` reproduces
the 2.6 KB JSON fixture from the production model and Metal renderer. The
macOS and iPhone Simulator outputs are currently byte-identical; a physical
iPhone and the desktop WebGPU renderer remain required visual-parity evidence.
Regenerate the golden intentionally from the repository root with:

```sh
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer \
  xcrun swift run --package-path apple/GhostteaKit \
  GhostteaVisualGoldenRecorder \
  apple/GhostteaKit/Sources/GhostteaTerminal/Resources/terminal-visual-golden.json
```

The conformance test loads a JSON fixture, feeds it as one buffer, one byte at
a time, and patterned chunks, then compares state, visible text, and ordered
terminal replies. The memory matrix measures macOS physical footprint for one,
four, and eight raw VT sessions before and after upstream scrollback
compression. The iOS harness adds compact/standard whole-process budgets and a
foreground/background compression gate. Standard-tier physical-device evidence
is recorded; compact-device, renderer, active-transport, jetsam, and energy
measurements remain.

`GhostteaPerformance` provides the opt-in coarse pipeline signposts used for
release profiling. Set `GHOSTTEA_PERFORMANCE_RECORDING=1` only for a scored
launch; recording is otherwise disabled. Its constant-time bounded recorder
exports numeric duration/byte summaries and has no arbitrary-string API. The
physical-device protocol, latency gates, energy comparison, and evidence rules
are defined in
[`Compatibility/performance-and-energy.md`](Compatibility/performance-and-energy.md).

No package source should import `GhosttyVt` outside the `GhosttyVtProof` target. This keeps the unstable upstream API from leaking into future app code.

Likewise, only `CGhostteaSSH` and the isolated `GhostteaSSHProbe` may import
`LibSSH2Candidate`. The public `GhostteaSSH` implementation sees only opaque C
shim handles and implements `TerminalTransport`; app code enters it through the
production facade while compatibility fixtures retain the original candidate
names. The current evidence and known chained-MFA return-state ambiguity are recorded in
[`Compatibility/ssh-candidate-decision.md`](Compatibility/ssh-candidate-decision.md).
The adapter uses one deadline across cancellable Apple DNS-SD resolution and
TCP connect, plus an independent SSH-handshake deadline. Its local
banner-blackhole fixture proves that a stalled handshake observes both its
deadline and Swift task cancellation; the iPhone resolves the Mac's Bonjour
hostname through the same connector.
The candidate connection also exposes diagnostic flow-control metrics. The
live flood gate requires its delivered-byte counters to remain unchanged while
terminal demand is paused. It applies the same invariant to raw encrypted
socket receives, then verifies exact delivery while reporting the libssh2
receive window and socket-wait count.
Interactive reads serialize each libssh2 call, but they release that operation
gate before polling the raw socket for readiness. This permits a user write to
proceed while the channel's read side is idle without calling libssh2
concurrently. The live fixture starts an idle read before writing its marker and
requires that full-duplex exchange to complete within two seconds.
Strict known-host verification is the default. An opt-in async responder may
make an explicit accept-once decision for unknown or changed keys after showing
the host, port, algorithm, and SHA-256 fingerprint. It may instead atomically
insert or replace the OpenSSH entry while preserving file permissions; the
future app integration owns the confirmation UI.
