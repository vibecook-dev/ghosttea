# Ghostty 1.4 migration: regression history, causes, and resolutions

Original investigation recorded through **2026-10-31, America/Los_Angeles**, on
`codex/libghostty-1.4-vibefield`. The **November 2 publication addendum** below
records the subsequent fixes, device installations and release preparation on
`release/0.14.0`. Sections 1–9 retain their original checkpoint dates.

The migration exposed several independent problems in VibeField's Godview panes,
Swift terminal, Truffle connection path, and verification-build packaging. Some
were new engine integration problems; several already existed before the port.
All affect acceptance of the migration regardless of where they originated.

**Product acceptance remains open.** The earlier
[migration qualification report](./ghostty-1.4-migration.md) records valid results
for its exact builds, but subsequent signed-in manual testing found failures that
those checks missed. This document is the later record; earlier “passed” entries
must not be read as acceptance of the final product or the latest fixes.

At the October 31 documentation checkpoint, the source port and earlier fixes
were committed through `fc0740eb08c9393cbc5aa689286188bf6b1641fd`. Later fixes were
still local changes, and the final block-rendering/resource-bundle build had not
yet been installed. Those statements are historical: the November 2 addendum
records the later installed app and committed fixes. Neither the earlier tests
nor the later UI checks replace qualification of the final published artifacts.

## 1. Versions and ownership

| Component or checkpoint | Exact identity |
| --- | --- |
| Released Ghosttea baseline | 0.13.7, `3eee581c14b05850c90bea09536d4bc6b856223b` |
| Previous Ghostty VT pin | `f8041e849b36efbbb9736b6ecf0ccfcb01d94e69` |
| Candidate Ghostty VT | 1.4.0, `83fb95624b0439ee660c2679b43b38c8b63769cd` |
| Initial source/build port | Ghosttea `e92396a` |
| Committed Ghosttea qualification checkpoint | `fc0740eb08c9393cbc5aa689286188bf6b1641fd` |
| Earlier VibeField qualification base | `e259f1fe31d9b3a01dca70dc33a5dad99841f6f3` |
| October 30 manual VibeField base | `ac5dd87d34879c7f02dccc9838ddbd4434d23f25` |
| VibeField migration applied to that worktree without committing | `363fdf08c9e4859f52a2671c06aa6327171376d5` |
| Truffle versions intentionally retained | Desktop Rust/sidecar 0.7.24; Swift 0.7.23 |

Ghostty provides the VT model. Ghosttea owns shaping, frame production, WebGPU and
Metal rendering, and parts of the routed client. VibeField owns product panes,
focus/geometry policy, Swift attachment, and host integration. Truffle carries
discovery and network traffic. Updating the VT pin does not automatically import
Ghostty's application UI, renderer, fonts, or settings behavior into these layers.

The manual worktrees use local dependency overlays. Their published manifests
still say Ghosttea 0.13.7, and the directory named `ghosttea-0.11.2` is historical;
neither identifies the linked native engine. Likewise, app version `0.1`/build `1`
does not distinguish these builds. Source revisions, local diffs, native archive
hashes, dependency resolution, and installed binary identity are the evidence.

## 2. History of the phone's rendering path

### July–August: desktop cell graphics and a separately shaped phone replica

The initial Ghosttea repository commit,
[`ab9bac6`](https://github.com/vibecook-dev/ghosttea/commit/ab9bac6bb725444720f04570903d2c936c6020ea)
(July 14), already drew solid Unicode block characters as fractions of terminal
cells in WebGPU. Full blocks, halves, eighths, and quadrants therefore did not
depend on a font's ink reaching the edge of its line box.

The first Metal renderer,
[`72c84f2`](https://github.com/vibecook-dev/ghosttea/commit/72c84f2dd2b2a633d13128a070d2e0dfc68502ec)
(July 17), drew those characters using their font bitmaps and glyph offsets. It
did not contain the equivalent cell-rectangle path. Its recorded author and
committer are James Yong, with no agent/coauthor trailer. Review of 28 released
Metal revisions found no removal of an earlier phone block-geometry fix.
October's graphics-color classification work (`4342f2a`) did not add that geometry.

VibeField's August 5 phone attachment (`15dfa4af9` and `72929d81a`) consumed logical
TSP1 rows, built a local `GhostteaRuntime`, and shaped/encoded them on the phone.
It loaded the bundled JetBrains Mono Nerd Font and used device presentation
authority. The default fixture used 13 pt text, 19 pt row pitch, and a 14 pt
baseline. This font path made the same missing geometry treatment less visible
than the later host-font path; it is not proof that every earlier build was seamless.

### September: why the phone started consuming the host's frames

VibeField commit
[`b6d4b9f85`](https://github.com/vibefield/vibefield/commit/b6d4b9f858a605af62edf01fc599a85060b8a246),
“TM-5: the phone attaches over the routed client, and the cell's own frame reaches
the glass,” was authored and committed on September 13 in Pacific time. Git records
James Yong as author/committer and **Claude Fable 5.1 as coauthor**. Those are the
recorded credits, not proof of who wrote an individual line.

That change removed the phone's local logical-row replica and encoding step.
`RoutedTerminalFrameSink` instead passed the cell's TRF1 frames directly to Metal.
The host cell constructed its text engine through `TextEngine::discover`; the
tested Mac resolves that to Menlo. **The Ghosttea pin was 0.10.1 on both sides of
this change.** This was a change to the rendering inputs and ownership, not a
Ghosttea version upgrade.

The maintained VibeField design record, `draft/thinking-terminal-mesh-cells.md`
(Option T and decisions TM-D1–TM-D7), explains the reasons:

- The old phone path depended on an in-process terminal service. It did not work
  alongside the isolated cell architecture and the new Godview deck's routing.
- The phone would use the same routed protocol as desktop viewers, with expiring,
  revocable, per-client/session grants instead of a separate bearer-key path.
- Truffle's sidecar proxy could forward directly to a cell without putting the
  main service into the terminal byte path or adding another transport hop.
- The cell would shape and encode once. Each viewer would decode binary damage
  frames, with credits and catch-up, eliminating the phone's row replica and
  repeated encoding of whole logical rows.

The record dates the choice of Option T to September 14. It is a maintained
design record, not an immutable transcript of the TM-5 commit. TM-5's immediate
hardware witness was pending; later records include a real phone connection
qualification. It would be inaccurate to say this architecture was never tested
on a device.

The architecture had a concrete purpose, but the transition needed a rendering
parity check using both the former bundled font and the actual host font. Frame
delivery, identity, and reconnect tests did not establish that visual parity.

### Appearance and resize policy also changed, at different times

TM-5 removed local runtime reconfiguration: glyphs and explicit RGB colors now
came from the host. Follow-up `13120801a` corrected Settings/README claims that
the phone independently reshaped and restyled remote content. Local presentation
controls must be distinguished from host-authored glyphs and explicit colors.

Initially the phone received input/read rights without geometry rights, so its
viewport setter only recorded a size. **That policy was superseded on September
30:** the latest focused pane, including a phone pane, takes geometry, input, and
read control through the lease. The October focus work implemented that policy.
The original no-resize decision therefore does not explain away the current
resize failure or change the acceptance requirement.

## 3. Problems resolved during the initial 1.4 port

These problems were addressed during the qualification recorded at `fc0740e`.
The Ghosttea changes are committed at that checkpoint; the associated VibeField
integration, including its Freeway door correction, still needs coordinated
landing. The earlier report holds the detailed build and test records.

| Problem and cause | Resolution and qualification |
| --- | --- |
| Source/build interfaces changed with Ghostty 1.4 and Zig 0.17. | Ported the ABI/build recipe from Zig 0.15.2, preserving the G15/G21 and MSVC contracts and all nine extension exports. Prepared-source reproduction and C ABI checks passed. |
| Unicode 18 classified nine new emoji as wide while Rust/browser tables still treated them differently. Following text, caches, and selection backdrops could use the wrong columns. | Shaping and cache identity follow host cell boundaries. WebGPU selection covers host glyph spans and trailing spaces. Ambiguous graphics mapping falls back to host glyphs. Missing emoji artwork remains a font limitation, with correct cell spans. |
| Legacy hosts can reserve four columns for a joined emoji; stretching its artwork to that span distorted it. | Keep joined artwork at its natural two-cell visual width while anchoring following text to actual host columns. An intermediate attempt to split the joined emoji was superseded. |
| Godview routed copy returned an empty string; the Swift home card had no wired selection callback. This was an existing product gap included at the user's request. | Added negotiated `selection-text` requests to the authenticated host, requiring read authority only. Request/activation/lease correlation, bounds, timeout, cancellation, and no replay prevent stale clipboard writes. Empty selections preserve the clipboard; oversized replies fail explicitly. Old hosts report unsupported copy. |
| The Truffle proxy forwarded `/f/<secret>/`, while the Freeway door accepted only the form without a trailing slash. | Accept exactly one trailing slash with the same complete secret and identity checks. Wrong secrets, extra slashes, and subpaths remain refused. Both comparison hosts include this fix: that baseline is not a pristine released product. |
| Linux cross-builds skipped Darwin's runtime-symbol normalization, leaving duplicate `memset` definitions in the macOS archive. | Run the checksum-pinned upstream `libsystem_override.sh`, then link and execute actual consumers. CI run 40969422970 remains rejected; corrected run 40972570187 passed macOS and both Windows CRT consumers with provenance/inventory checks. |
| Zig's package cache was unwritable in a read-only source mount; Windows found a broken pkg-config shim; `-fno-autolink` removed CRT stamps. | Put packages in writable build output, select native pkg-config, and add three metadata-only CRT witnesses using each compile group's actual flags/macros. Both Windows runtime variants passed consumer tests. |
| Cargo wrote to the SSD-configured target directory, but packaging read `root/target` and found an older artifact manifest. | Resolve Cargo's actual target directory and compose from it; create package-gate outputs in a fresh directory. Checks cover default, space-containing configured paths, and environment overrides. |

Eight bundled font files were verified, with two Noto updates. Intentional emoji
pixel changes were reviewed: the new engine with only the old fonts restored
reproduced the old golden exactly. Layout and unchanged rendering invariants were
retained; replacing a golden alone was not used as evidence of correctness.

## 4. October 30: signed-in manual testing reopened acceptance

The isolated apps were installed alongside the normal app at the user's request.
After login, the phone first reported “desktop not serving.” Once connected, the
user reported no typing in Godview, phone display gaps, and broken resize controls,
and asked that transparency, light mode, and themes be checked. Both apps were
stopped before investigation. The following defects were reproduced independently;
not every original user action could be reconstructed from logs.

### Desktop discovery used the wrong DNS name

The separate desktop installation received a canonical Tailscale DNS name with a
collision suffix, while its raw hostname remained unchanged. Truffle's backend
knew the canonical `dnsName`, but the Swift public peer snapshot dropped it.
VibeField consequently constructed and dialed the unsuffixed address even though
the desktop services were healthy.

The local Truffle fix carries optional `dnsName` through discovery, metadata
updates, provisional-peer merging, and equality. VibeField uses it after case and
trailing-root-dot normalization, retaining the old fallback when absent. Account
checks and ATS settings were unchanged. The rebuilt app reached the actual
desktop, its ready product feed, and terminal service. That established discovery
and connection, not working terminal input or rendering. Truffle's 108 Swift
tests and FieldMesh's 293 tests passed, including collision-name coverage.

### Godview could exhaust recovery and remain unable to type

Recorded control legs repeatedly closed with `4004 LEG_TIMEOUT`. After five
retries, returning to or focusing the pane did not restart recovery. The local
Ghosttea routed-control/runtime fix allows a fresh bounded attempt on focus or
visibility restoration; protocol errors and definitive refusals remain final.

A real Godview lab reproduced timeout, retry exhaustion, hide/show, recovery of
the input lease, and execution of a typed command. Background timer throttling is
consistent with the heartbeat failures, but the exact scheduling cause of the
original manual failure is not proven.

### Parked and resuming views exposed input too early

The phone logs contained **78 `no-view` input drops** while its host view was
detached. Client and host now close the input gate while parked, and a late
“allowed” lease update cannot reopen it. This fixes the permission error; the
exact product lifecycle action that left the user's pane detached is still unknown.

After Internet access recovered, a real Truffle retry exposed another race: the
first post-resume command was refused as `pending`. A buffered frame and cached
allowed status had reopened the client gate before the host resumed the view.
Both Swift and Godview now require the current live-demand acknowledgement and a
newer cell status. Demand sequences are unique across sessions sharing a
connection, so another session's acknowledgement cannot satisfy the barrier.
Tests fail before and pass after the change. Dropped keystrokes are never replayed.

### Coalesced reattachment omitted the full scene

If `none` then `live` demand arrived before the pump ran, its notifications could
coalesce. Looking only at current live demand missed the detach/reattach, and a
new view received a delta referring to an older scene. The native pump now tracks
the engine's attachment epoch and sends a full catch-up on change while
preserving the activation sequence. A deterministic test reproduced the failure.

### Rejected phone scenes had no effective repair path

A physical-phone run completed mirroring, copy, resize, park/resume, and reconnect,
then stalled during idle refresh. The renderer could reject a scene without
successfully obtaining a complete replacement.

The local integration adds optional `scene-repair` negotiation and a frames-leg
`RequestScene`. The pump supplies a full catch-up without detaching the view or
giving up geometry ownership. Current-leg, session, lease, read-right, expiry,
demand, and revocation checks fence the request. Swift coalesces requests and
fails after three rejected full scenes. Shared fixtures, native socket tests,
physical-phone tests, and two complete Truffle runs pass. Core wire versions are
unchanged; this capability still requires coordinated host/client integration.

### Remote font changes scaled the grid but not the glyphs

The phone increased cell width and row height while keeping host-shaped glyph
coordinates and ink at their original size. This produced spacing/alignment
errors independently of the default-font block seams discussed below.

Remote scenes now declare source cell metrics. Metal scales glyph positions,
ink, color glyphs, and cursor overlays to the viewer grid. Local-runtime behavior
is retained. A failing-before rendered regression now matches uniform glyph
scaling byte for byte. Underline thickness intentionally follows display scale,
so it is checked separately from the uniformly scaled glyph image.

Mounted SwiftUI/Metal checks also verify that keyboard movement withholds
intermediate sizes, reports the final smaller grid, restores the grid on
expansion, and updates rows/columns on font changes without replacing the scene.

### Appearance checks were broadened, with limits retained

Tests cover alpha composition, light adaptation, palette provenance, minimum
contrast, and cached/direct rendering parity. Physical-phone captures show a
pink backing through 40% background opacity, light theme, 18 pt scaled glyphs,
and 13 pt dark appearance. Copy-selection highlighting was cleared before the
final appearance captures.

These checks verify specific rendering behavior. They do not restore the old
device-owned shaping architecture or prove that every theme preference can
override host-authored explicit RGB colors. Live settings behavior and ownership
still belong in the signed-in acceptance round. Menlo's standard-size block gaps
were visible in both released and 1.4 frames and required a separate fix.

## 5. October 31: released-build comparison and missing icons

At the user's request, a comparison used released Ghosttea rather than Ghostty
1.4. The user then questioned the age of the Swift app, reported missing icons,
and identified the artifact specifically as black horizontal gaps in Claude's
TUI mascot. Both comparison apps were subsequently closed.

### The source-age audit was a snapshot, not proof of current-main freshness

The manual apps used VibeField `ac5dd87d3`. At the audit, main was
`2f71beb2ef6ca657fe5dad7412ea109d85d8d640`, 462 commits ahead overall. Four
production Swift commits affected five files for person/home identity and Stop
decoding; terminal, input, swarm, and design sources were unchanged in that
comparison. `TerminalSettingsSheet.swift` had the identical blob
`3037962678e28ec592502f9314bac341c2f90efa` at the two checkpoints; its layout history
went back to August, with later copy/attribution changes.

Thus the old-looking settings did not prove that a months-old Swift checkout had
been selected. It also did not make `ac5dd87d3` current: main continued to advance,
including settings work. A fresh integration must record a new main SHA and
rebuild it before claiming to include “all latest updates.”

### Missing icons were introduced by the manual build configuration

The verification build globally overrode Xcode's `PRODUCT_BUNDLE_IDENTIFIER` to
install alongside the normal app. That override also reached **all nine SwiftPM
resource bundles**, giving them the app's identifier. UIKit resolved FieldHome
asset names against the wrong bundle. This was our verification-build packaging
error, not evidence of a Ghostty regression or missing icon source files.

In a 46-case asset/appearance probe, five FieldHome icons failed in both light and
dark mode: ten failures. Changing only resource-bundle identifiers made all 46
pass, with compiled `Assets.car` bytes unchanged. The fix introduces app-only
`VIBEFIELD_APP_BUNDLE_IDENTIFIER` and `VIBEFIELD_APP_DISPLAY_NAME` settings,
referenced by the app target; comparison scripts override those settings instead.

Both comparison configurations were rebuilt. The rebuilt resources pass 46/46
checks, all nine resource identifiers are unique and differ from the app ID, and
strict signing verification passes. These corrected builds were not installed
during this pass; on-phone icon confirmation remains pending.

## 6. Claude mascot gaps: confirmed cause, likely trigger, final fix

### What the controlled comparison proves

The pre-fix Metal renderer used font ink bounds to draw solid blocks. At 13 pt,
Menlo's full-block ink is 13.5 pt high in a 19 pt row, leaving 5.5 pt of background
between stacked rows. Desktop WebGPU already bypassed these margins with
cell-aligned geometry. That renderer difference explains the measured seams.

| Font used for the controlled input | Full-block ink height | Exact background gap | Versions checked |
| --- | --- | --- | --- |
| Bundled JetBrains Mono Nerd Font | 17.5 pt | 1.5 pt | Ghosttea 0.10.1 and 0.13.7 |
| Host-discovered Menlo | 13.5 pt | 5.5 pt | Ghosttea 0.10.1 and 0.13.7 |

Measurements use 13 pt text, 19 pt row pitch, and 2× rendering, sampling through
repeated full blocks. Antialiased pixels count as ink; only exact background
pixels count as the gap. This supersedes an earlier threshold-based 2.0 pt estimate
for the bundled font. Corresponding old/new frame cross-replays were
pixel-identical. The 0.13.7-versus-1.4 Menlo control also reproduced the same gaps.

The September TM-5 shift from bundled phone shaping to host-shaped frames is
therefore the **strongest candidate for making the old Metal omission much more
visible**. It is not an established first-bad installed build. No known last-good
phone binary/session has been recovered, and the bundled-font control itself has
a smaller gap. We cannot claim that Claude removed a previously working block
fix, that every pre-TM-5 run was seamless, or that Ghostty 1.4 introduced this bug.

### Why existing checks missed it

The existing Metal golden exercised ordinary text, Unicode, styling, and emoji.
It did not contain a multirow block mascot or assert continuity across row
boundaries. Transport checks showed delivery and recovery; source/pin checks
showed which build ran. Neither tested the missing visual invariant. A new
host-font path exposed a renderer parity gap without changing the Ghosttea pin.

### The final implementation

The local candidate adds `GhostteaBlockElements.swift` and changes
`GhostteaMetalRenderer.swift` to draw unambiguous, single-cell alpha8 solid block
elements as cell-relative rectangles. It covers U+2580–U+2590 and U+2594–U+259F:
full/partial blocks and quadrants. Shared boundaries snap to device pixels;
selection foreground, cursor text, faint alpha, and colors are retained.
Shade characters U+2591–U+2593 remain font-rendered.

Complex clusters, combining sequences, variation selectors, ZWJ content, and
width mismatches conservatively retain the font path. ZWJ detection uses
`unicodeScalars`, including in the graphics-color classifier: searching composed
`Character` values could miss a joiner inside a combined emoji and map a later
letter to a block's column.

An earlier native-raster prototype was evaluated and reverted: it reduced the
large gaps but left filtering seams. Archived prototype images are not the final
implementation. The final block fix changes Swift/Metal rendering, with **no
native production, TRF1-format, or Truffle-protocol change for this fix**.

### Evidence for the fix, and the remaining boundary

- All 96 pixel-matrix cases failed before and pass after: four font sizes
  (9/13/16/20 pt), three display scales (1×/2×/3×), two submission paths, and four
  appearances (dark/light/transparent/selected). Additional assertions cover
  quadrants, faint/cursor behavior, and conservative Unicode fallback.
- The frame/rendering suite passed 85 tests, with two optional image exports
  skipped; Swift Testing reports 87 total. These are tests and matrix cases,
  not 183 independent tests.
- The 72 final replay images have seam-free mascot bodies using the **same
  published 0.13.7 frame bytes** as their before images. All 24 same-size ordinary
  text comparison regions are pixel-identical.
- The Ghostty 1.4 iPhone candidate builds and passes strict signing checks,
  including the final Unicode guard and resource-identity correction.

The evidence supports applying the fix to the 1.4 build as well as released-frame
input. The rendered QA uses the shared production Metal renderer on macOS. The
latest corrected app has not yet been installed or exercised over real Truffle
on the phone; compile/sign success is not a substitute for that run.

## 7. Verification history and environmental failures

Counts below belong to separate checkpoints and suites. Do not add them together
or treat earlier physical-device results as qualification of later source edits.

| Checkpoint | Observed result | Limit |
| --- | --- | --- |
| Committed initial qualification through `fc0740e` | Candidate: 424 Rust tests, 3 ignored; 623 JS tests; ABI 197 types/1,916 assertions; FFI and ASan passed. Final signed iPhone package: 833 production tests. Four old/new host/client pairings: eight real remote tests. All 13 desktop landing gates passed. | Predates the signed-in manual regressions. Physical Windows GPU/product UI not covered. |
| October 30 discovery fix | 108 Truffle Swift tests and 293 FieldMesh tests; actual product connection reached ready state. | Connection success does not qualify terminal behavior. |
| Latest October 30 lifecycle/repair fixes | 527 physical-phone tests (183 routed, 177 terminal, 167 input); 449 Ghosttea React tests; native 310 unit and 26 socket tests, with one existing benchmark ignored; 1,306 contract tests and 185 mirrored iOS fixtures. | Exact builds recorded in the retry identity; predates the final block/icon fixes. |
| October 30 live behavior | Two complete physical-phone Truffle runs: real PTY input, independent mirrors, Unicode copy, geometry handoff/resize, park/resume, redial, idle repair, live Metal. Godview normal and forced-exhaustion labs executed typed commands and passed copy, alternate screen, hidden output, split/zoom, and reattach checks. | Isolated production-path probes, not a replacement for the user's signed-in round. |
| Resize and appearance controls | All 15 0.13.7/1.4 PNG pairs identical across five grids and three appearances; each resize also matched a fresh full frame. Remote-scaling renderer suite: 82 tests passed. | Offscreen macOS checks; block seams were present in both versions before the final fix. |
| October 31 block and bundle fixes | 96 block matrix cases, 85 passing frame tests plus two optional skips, 72 final replay images, 24 unchanged text regions, 46/46 rebuilt icon checks; iPhone build/sign passed. | No physical-phone installation or new live-transport run after these final fixes. |

Other failures were preserved and classified rather than hidden by rerunning:

- A baseline device test raced its own socket acknowledgement. Waiting for both
  legs fixed the test without changing production resume behavior. This is
  distinct from the later, real resume input-barrier bug.
- A competing root Metal drawable loop blocked isolated XCTest teardown. The
  QA host paused its background views; mounted SwiftUI layout checks required a
  scene-connected window. A desktop harness initially mistook textarea grant
  state for actual readiness; it now uses Godview's real input-allowed marker,
  inert state, and focus before injecting keys. Failed harness runs remain saved.
- One real-network attempt failed with `NSURLErrorDomain -1009` before terminal
  attachment. On retry, connectivity recovered and exposed the genuine resume
  race. A cleanup-time TailscaleKit exception initially obscured a timeout;
  subsequent probes preserve the original error before cleanup.
- Automatic pnpm overlay installation drifted Loro/React away from the committed
  lockfile. Frozen installation and repaired isolated generated links restored
  the graph; preventing automatic reinstallation did not disable dependency
  guards. A build-only offline variable was also removed from the runtime test
  environment. The drifted run is not a valid baseline/candidate comparison.
- Disk-full attempts led to the user-requested, checksum-verified cache move to
  the portable SSD. Path-bound Xcode caches were rebuilt. The Cargo output-path
  defect above was corrected rather than relying on an old `target` symlink.
- Full workspace verification remains red. The final run passed static/build
  stages and 26/27 JavaScript projects (9,982 passed, one failed, 17 skipped);
  an unchanged cleanup assertion observed 1,999 ms against a 2,000 ms bound.
  Focused baseline/candidate controls passing do not change that full-run result.
- Latency remains explicitly unqualified, as the user chose to continue under
  heavy system load. Sixteen paired workload processes completed at roughly
  120 Hz with frame p95 around 9.1–9.3 ms, but those measurements do not establish
  input-to-photon latency or a performance sign-off.

## 8. What remains before migration acceptance

1. Review and commit the local fixes in their owning repositories, preserving the
   intentional transport versions and coordinated capability/fixture changes.
   This document commits none of that implementation. Saved patch snapshots are
   checkpoints and may predate the final block and packaging edits.
2. Integrate against a newly recorded latest VibeField main revision. Preserve the
   app-only bundle settings and verify native hashes, resource IDs, and resolved
   dependencies. Do not label the existing `ac5dd87d3` build as current main.
3. Install that final candidate alongside the regular phone app and run the user's
   signed-in desktop/phone round: actual Claude mascot, immediate typing after
   focus/resume, split panes, selection/copy, scrollback, keyboard movement,
   font changes, geometry ownership, themes/light mode/opacity, backgrounding,
   reconnect, and simultaneous Truffle mirroring.
4. Retain the unknowns: the exact original parked-view trigger and the last-good/
   first-bad installed build for the mascot have not been established. A known
   earlier binary/session would allow a stronger historical comparison.
5. Resolve or explicitly disposition the full workspace timing gate, physical
   Windows product/GPU coverage, new-emoji artwork gaps, and the unqualified
   latency measurement before assigning the corresponding release guarantees.

The desktop and phone apps are closed at the user's request. No launch,
installation, release promotion, or source-fix push is implied by this record.

## 9. Evidence index

The committed [migration report](./ghostty-1.4-migration.md) and
[qualification evidence](./ghostty-1.4-qualification/) cover the initial port.
Later evidence remains in local QA archives, **not files added by this commit**.
Paths below are relative to the original `electron-ghostty` workspace:

- `G14` = `artifacts/ghostty-1.4-manual-20261030/evidence/`
- `REL` = `artifacts/ghosttea-release-manual-20261031/evidence/`

| Evidence | Contents |
| --- | --- |
| `G14/ios-dns-fix-build-identity.json`, `ios-dns-fix-live-observation.json` | Canonical discovery correction and installed-app observation. |
| `G14/regression-retry-build-identity.json` | Source/binary identity for the 527-test, real-Truffle and Godview recovery checkpoint. |
| `G14/desktop-resume-pane-ready/pane-regression.json`, `desktop-resume-recovery-final/pane-regression.json` | Real pane operations, first-ready input, forced heartbeat/retry exhaustion and recovery. |
| `G14/iphone-resume-gate-after-summary.json`, `iphone-remote-resume-fixed-summary.json`, `iphone-remote-appearance-final-summary.json` | Physical suites and complete remote runs, with appearance captures alongside them. |
| `G14/regression-coalesced-reattach-before.log`, `regression-scene-repair-native.log`, `regression-remote-font-before.log`, `regression-remote-font-final.log` | Reattachment reproduction, repair checks, and before/after scaling evidence. |
| `G14/regression-resize-ab.json`, `regression-render-build-identities.json` | Released/candidate resize controls and native archive identities. |
| `REL/swift-history-audit.json` | Exact VibeField comparison revisions, affected Swift files, and Settings blob identity. |
| `REL/icon-resource-collision-result.json` | Ten failing icon cases, identifier-only control, and rebuilt-resource verification. |
| `REL/terminal-history/audit.json`, `terminal-history/claude-regression-origin.json` | Font/frame controls, historical source excerpts, Git attribution, 28 Metal revisions, measured gaps, and limits of the attribution. |
| `G14/claude-blocks/audit.json`, `metal-regression-before.log`, `metal-regression-after.log`, `resource-identity.json` | Final block-fix scope, pixel tests, exact source hashes, build/sign status, and bundle identities. The last three paths are also under `claude-blocks/`. |

The exact final block-fix source hashes recorded by that audit are:

| File | SHA-256 |
| --- | --- |
| `apple/GhostteaKit/Sources/GhostteaTerminal/GhostteaBlockElements.swift` | `04988531f69b8773ca85b448850718a6c0a0c79049d747bebe956e82e5acb66b` |
| `apple/GhostteaKit/Sources/GhostteaTerminal/GhostteaMetalRenderer.swift` | `49058e2f84fc18edec3eebde85e081b57fc6feebb1cffe59b14a6a92a50e2f85` |
| `apple/GhostteaKit/Tests/GhostteaFrameTests/GhostteaBlockElementTests.swift` | `771a6e411132c76d76951ba3bc5235dc20f2ff350e47c146f8e50aab7314fc3d` |

These hashes identify the local implementation reviewed here; they do not mean
those files are included in this documentation commit. The screenshot gallery
and archived prototype material are supporting review aids. The retained final
images, source identities, and test logs determine which result a claim refers to.

## 10. November 2: committed fixes and release preparation

The migration was rebased onto the latest published Ghosttea main, 0.13.8. The
release branch is `release/0.14.0`; the synchronized npm/Cargo version and generated
iOS inventory are 0.14.0. This preserves the newer conditional terminal-release
and acknowledged attachment-disposal behavior rather than publishing an older
fork of main.

The fixes that sections 6–8 described as uncommitted are now tracked:

- Ghosttea `59c002f` contains remote source-frame text metrics and the cell-geometry
  treatment of solid blocks and quadrants. `ce80daa` contains routed foreground
  recovery and the input barrier after resumed demand.
- Vibefield `e65d31e88` adds authenticated selection copy; `3d7081ea0` adds scene
  repair and input gating; `165045ba4` connects mirrored glyph scaling to the
  terminal font settings; `75ef64d2e` dials the canonical mesh DNS name.
- Vibefield `0c4590d7a` and `836d8e700` refine the terminal overlays, gesture/focus
  ownership and keypad. `c2c72be4e` fixes both icon paths. `b8771d46a` retains the
  desktop and physical-device qualification tools.

These consumer commits are reviewable in
[Vibefield PR #12](https://github.com/vibefield/vibefield/pull/12). The original
manual-testing worktree remains separate; its machine-specific dependency and QA
configuration are not the publication branch's dependency pins.

### Clean publication build exposed the remaining Truffle dependency

The first clean iOS build against the published dependency graph failed to
compile `FieldStoreDoors+Mesh.swift`: published `Truffle.Peer` has no `dnsName`.
The manual builds had used the local Truffle patch described in section 4. The
Vibefield source fix alone therefore cannot close the discovery issue in a
released app.

The Truffle patch is now committed as `2d91013` on latest main in
[Truffle PR #247](https://github.com/vibecook-dev/truffle/pull/247). All 116 root
Swift package tests passed, including canonical-name updates/clearing, local
snapshots, stable references and provisional-peer merging. The patch shipped in
[Truffle 0.7.26](https://github.com/vibecook-dev/truffle/releases/tag/truffle-v0.7.26)
through [release PR #248](https://github.com/vibecook-dev/truffle/pull/248).
[Release run 41563588677](https://github.com/vibecook-dev/truffle/actions/runs/41563588677)
passed its complete publication sequence; the final SwiftPM `v0.7.26` tag names
`101889f676d32989e2c32295c3b608ccd5972c02`. All 13 npm packages and three crates
were independently checked at that version. Both Ghosttea Swift manifests,
their resolved/provenance locks and the iOS inventory move to this release.
Vibefield's Swift pin must match when its Ghosttea 0.14.0 pin lands.

The Swift sources at the release tag are identical to the reviewed candidate.
The TailscaleKit binary, license/privacy hashes and Ghosttea native source digest
are unchanged. The intervening Truffle Swift update also reads peers' application
tags, retaining the tested hostname fallback for older peers. Desktop Truffle
Rust and sidecar versions remain 0.7.24; the DNS fix does not change the existing
login and transport checks. The original failed clean build is retained at
`G14/publication-20261102/keypad-profiles-swift.log`.

With the verified Truffle 0.7.26 pin, all **307 Ghosttea Swift tests** passed
against the published native archive, including the Claude block-gap,
resize/appearance and routed attachment regressions. A fresh downstream package
linked all **18 public Swift library products**. The served-byte audit and
generated iOS BOM/resource checks passed; the three pre-existing release
blockers remain recorded. These results qualify the updated Ghosttea package,
not a final published-dependency Vibefield device run.

### Subsequent phone UI issues

The corrected VibeField G14 app was built, installed alongside the regular app,
launched on the physical iPhone, and used for the subsequent user-directed UI
refinements. This supersedes the October 31 statement that no corrected app had
been installed. It does not claim a new complete four-pairing Truffle matrix on
the final 0.14.0 registry release.

The terminal now keeps the keyboard hidden during scrolling, extends behind a
fading header, and uses floating paste/keyboard controls with a context indicator.
Remote-driver takeover folds the keyboard; the device name fits the available
width and the takeover message is centered in the available terminal area.

The replacement keypad has Navigate, Shortcuts and Fn pages. Switching between
native and custom keyboards preserves the measured composer geometry. Switching
between drafting and direct terminal input keeps the outgoing responder mounted
until the incoming responder owns focus. Removing it, or disabling its UIKit
interaction too early, caused the observed keyboard dismissal/reappearance.
Deferred stale focus requests are rejected, and the redundant prompt Enter key
was removed.

Two separate icon defects required separate fixes:

- The swarm's PNG was already byte-identical to the desktop atlas. A CGContext
  transform flipped its rows during Metal upload, so valid tile coordinates read
  the wrong icons. Removing that transform makes the actual R8 texture match
  desktop pixels; the new test reproduces the old failure.
- The terminal header uses SVG assets, not that atlas. Xcode misread compact
  numeric/arc arguments in the Codex path. Separating commands and arguments
  preserves all 59 geometry operations and the desktop reference pixels while
  fixing the compiled asset at 11, 24 and 96 pt in light and dark appearances.

### Evidence and remaining limits

The later checks are distinct checkpoints, not counts to sum:

| Checkpoint | Result | Boundary |
| --- | --- | --- |
| Keypad layout | 185 simulator checks passed, including portrait/landscape UI; physical-phone fixture checks preserved composer position, terminal rows and takeover folding. | Local rendering/input checks, not a new live Truffle matrix. |
| Direct-terminal mode switch | 186 checks passed; zero keyboard-hide notifications when switching both directions with native and custom keyboards. | Selected page, unsent draft and composer frame were checked in the simulator. |
| Duplicate Enter removal | 184 checks passed; no mode-switch keyboard dismissal. | The corresponding G14 app was built, installed and launched. |
| Swarm atlas | 38 checks passed; all 20 icons reviewed in both appearances. | Test reads the uploaded Metal texture, not just the PNG source. |
| Header SVG | UI check passed; all three sizes reviewed in both appearances; reference geometry and 240 px pixels unchanged. | Product app built, installed and launched. |
| November 2 release preparation | All Ghosttea workspace type checks and 631 JavaScript tests passed; 428 Rust tests passed with three existing ignored cases against the promoted VT archive; Vibefield's committed product sources passed 1,509 contract and 32 routed-host tests. Rust formatting and 205 iOS fixture copies / 67 contract constants passed. | The Vibefield tests used the local Ghosttea candidate. Published dependency pins and the complete release/consumer gates remain separate. |

The local evidence directories are `G14/keypad-implementation`,
`G14/keypad-mode-switch`, `G14/live-enter-removal`, `G14/swarm-icons` and
`G14/header-icon`, each suffixed `-20261102`, under the evidence root indexed in
section 9. Their result JSON records the tested source hashes. Large xcresult
bundles, device data and test credentials are not release source assets.

One recorded keypad limit remains: if the custom keypad is open during the first
rotation into an orientation with no measured native keyboard height, the first
ABC switch may recalibrate once (40 pt on the tested iOS 26.5 simulator). Subsequent
switches use the measured height. Physical hardware-keyboard input was checked by
routing tests, not an attached keyboard.

Latency remains unqualified at the user's direction. Physical Windows GPU/product
behavior, real Wi-Fi/cellular handoff and long suspension remain unclaimed. The
pre-existing SSH production-readiness blockers and the historical full-Vibefield
agent-cleanup timing failure are not waived by these UI checks. Product release
CI must verify the final native pin, and Vibefield must qualify the published
0.14.0 dependency graph before its integration PR becomes merge-ready.
