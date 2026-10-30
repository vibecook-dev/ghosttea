# Ghostty 1.4 migration for Vibefield

Status: migration candidate implemented and qualification recorded with open gates.
No release promotion.

## Baselines and scope

- Ghosttea: `3eee581c14b05850c90bea09536d4bc6b856223b`, released as 0.13.7.
- Vibefield: `e259f1fe31d9b3a01dca70dc33a5dad99841f6f3`.
- Existing Ghostty: `f8041e849b36efbbb9736b6ecf0ccfcb01d94e69`, with G15/G21 and MSVC runtime patches.
- Candidate Ghostty: 1.4.0, `83fb95624b0439ee660c2679b43b38c8b63769cd`.
- Migration branch: `codex/libghostty-1.4-vibefield`.

The earlier library qualification used Ghosttea 0.12.0. Its evidence is useful for
the VT port, but does not qualify Vibefield's current 0.13.7 consumers. This work
starts from the exact released consumer baseline and preserves subsequent fixes.

Vibefield's terminal host cells own Ghosttea's terminal model and frame production.
Godview presents those sessions through its terminal pool and panes. The Swift app
uses FieldRoutedTerminal and FieldFreeway over Truffle and consumes rendered TRF1
frames through FieldTerminal and the Ghosttea renderer. Ghosttea's own Truffle
demo is additional coverage; it does not substitute for Vibefield's current route.

Vibefield deliberately pins Truffle Rust/sidecars to 0.7.24 and Swift to 0.7.23.
Preserve that split and validate the resolved dependency graphs. A VT migration
must not silently change transport versions or activate a second Rust node type.

## Required evidence

| Area | Required check | Status |
| --- | --- | --- |
| Source | Rebase both local patch contracts; checksum-verified Zig 0.17; deterministic bootstrap diff | Passed: both patches ported, nine extension exports retained; prepared-source diff reproduced twice. |
| Artifacts | macOS ARM64 and both Windows MSVC runtime variants; immutable CI candidates and provenance | Passed in corrected run 40972570187: macOS and both Windows CRT consumers, signed provenance, all 40 inventoried files per bundle, header/library checksums, SBOM consistency and three CRT witnesses per Windows variant. All three candidates are pinned atomically. Run 40969422970 remains rejected for its macOS duplicate `memset`. |
| Apple | All framework slices, complete combined Rust/Swift artifact, reviewed toolchain | Final combined candidate package verified: `ghosttea-apple-native-1611ad6b0820`, source digest `56dc58d73c6d319af6759ef6f1e465e011ae58b32ec5e7b50295a1c2d4f49ac8`. All 18 public Swift products link against it. The exact signed iPhone package now passes all 833 production terminal tests with no failures or skips, and its native font golden passes on device. Both staged iOS archives match the package and both baseline/candidate app signatures verify. No artifact published. |
| Core | Full Rust tests, C ABI, allocation/lifetime checks, parser chunking and ordered replies | Passed against the corrected CI macOS archive: candidate 424 Rust tests / 3 ignored and 623 JS tests; baseline 414 Rust / 3 ignored. ABI 197 types / 1,916 assertions; four strict C shims. C FFI parity and AddressSanitizer gate passed without duplicate-symbol warnings. |
| Fonts | Unicode policy, explicit missing-glyph handling, desktop and iOS rendered comparisons | Eight bundled files verified; two Noto fonts updated. Unicode 18 cell-width regression reproduced and fixed. Reviewed pixel comparison: all eight cases retain identical layout; two emoji cases have intentional font-pixel changes. New engine with old fonts reproduces the old golden exactly. Native iPhone font goldens passed in all four old/new client-host combinations. Joined-emoji artwork now stays at its natural cell width while following text retains the host grid; Godview and iPhone images show the corrected artwork/grid. The complete Metal/frame suite passes 80 tests. Its one font-dependent golden hash changed; restoring only the old fonts reproduced the old pixel hash exactly, with layout, edge map, mean channels, occupied pixels and tolerances unchanged. |
| Godview | Pane creation/split/close, focus/input, resize, scrollback, selection/copy, freeze/resume, mirrors and restored panes | Passed: final full field-app suite (2,807 tests, no skips). Final exact-CI-artifact pane lab copies Unicode and 160-row scrollback, switches alternate screens, verifies hidden output, splits/closes panes, preserves used sessions, checks fullscreen/canvas sizing and reattaches eight times. Screenshot reviewed; clean process exit, PTYs 93 before/after and zero surviving owned processes. |
| Real desktop | Isolated-profile Godview and terminal-direct smoke with candidate host binary | All 13 landing gates passed against the frozen graph and exact CI archive, including Godview, routed/direct terminals, Studio, graphics fallback, plugin recovery and bundled-package checks. All 14 emitted process censuses were empty. The routed-terminal shutdown passed at its unchanged 30-second watchdog; the earlier failed attempt remains recorded. Windows evidence covers native CI consumers, not a physical Windows GPU/product-UI run. |
| Host routing | Seat/geometry authority, activation/generation fences, drawn acknowledgements, credits and transfer bounds | Passed: baseline 493 originally; candidate 498 tests passed, with 15 existing ignored cases including a doctest. Passing coverage includes read-only copy, identity/lease fences and oversized replies. Shared Freeway fix is included in both comparison hosts. |
| Swift | FieldTerminal, FieldInput, FieldRoutedTerminal, FieldFreeway and relevant FieldMesh tests; real simulator rendering | Simulator: 1,306 passed / 2 skipped on both. iPhone baseline: 826 passed after correcting a demonstrated test-only acknowledgment race. The final rebuilt candidate now passes all 833 production tests, including seven new selection tests, with zero failures and zero skips. The tested app, debug library, xctestrun and native archives match their recorded final-package hashes. |
| Remote | Concurrent desktop/Swift mirrors; slow viewers, disconnect/reconnect, foreground resync, stale frames and control handoff | Passed on the exact final package: all four old/new client-host pairings, eight tests, zero failures or skips. The probe exercises two independent Truffle nodes and production Metal surfaces, real PTY input, accepted/rendered frames, resize and seat handoff, park/resume, fresh-link reconnect and live Unicode copy. All isolated apps were uninstalled and both hosts exited cleanly. Earlier phone tailnet-join failures remain recorded; their cause was not established. |
| Compatibility | Baseline/candidate host-client combinations without wire-version drift | Passed: all four final-package combinations. Wire versions unchanged. New client/new host copies exact Unicode and live PTY text through both production attachments; new client/old host returns explicit unsupported copy status while mirroring and reconnect continue. Old clients remain usable with both hosts. The comparison baseline includes the documented shared Freeway correction. |
| Workspace | Complete verification with the exact locked dependency graph | Static/build checks and 26 of 27 JavaScript test projects passed. The remaining agent-cleanup assertion reported 1,999 ms against a 2,000 ms bound; source is unchanged from baseline. Full `pnpm verify` remains red, with matched timing controls recorded separately. |
| Performance | Same-product pane workloads and frame latency; no acceptance based solely on old microbenchmarks | All 16 paired scenario processes completed without errors or unpresentable arms; approximately 120 Hz, frame p95 around 9.1–9.3 ms. Latency is explicitly unqualified: the user chose to continue under the heavily loaded host instead of arranging a quiet repeat. Injection-to-PTY measurements are not input-to-photon latency, and these results are not a performance sign-off. |
| Release | Source/font/artifact/BOM consistency, device evidence and atomic upgrade/rollback | Candidate source, font parity, BOM, resources, Swift manifests, App Store and beta metadata checks passed, as did final-package production and remote iPhone checks. Desktop landing-gate results and remaining release limits are recorded below. No coordinated artifact/version promotion. Config/UX retain their separately recorded 1.3.1 baseline. |

Use isolated application profiles and sessions. Do not operate on existing user
terminals or rewrite goldens to hide differences. Record intentional upstream
corrections separately from regressions. Missing platform evidence remains an open
gate; passing library tests cannot establish that every product behavior works.

## Regressions found during qualification

**Unicode grid alignment (fixed in the candidate).** Ghostty 1.4 uses Unicode 18,
while the Rust width/segmentation tables do not classify all newly assigned
characters the same way. U+1F6D9 followed by `X` reproduced a misplaced second
glyph. Terminal shaping now consumes the host's authoritative cell boundaries,
columns, widths and styles; cache identity also includes that geometry. Tests
cover all nine newly classified emoji, missing artwork, grid gaps, malformed
metadata, and old/new-host widths in logical replicas. The new emoji still have
no artwork in the pinned fonts; the missing-glyph representation preserves the
correct cell span. TRF1 and the routed protocol versions are unchanged.

**Physical-device focus test race (test-only fix).** The original baseline failed
`theCellASessionOpensOrComesBackOnIsSaidFocused` on iPhone. Its helper sent a frames
acknowledgment but returned before the socket reader processed it; immediate
reopen correctly took the fresh-attach path instead of the fast path the test
expected. Waiting explicitly for both legs to acknowledge made all five repeats
(35 suite test executions) pass, followed by all 826 device tests. No production
resume behavior was changed. Original failing results are retained.

**Candidate build gates.** Zig 0.17's package directory must be writable when the
source mount is read-only. Its Windows system-library discovery also encounters
a broken Strawberry Perl pkg-config shim on the runner. The candidate workflow
now selects a versioned native executable, retains rejected binaries for diagnosis,
and still rejects missing or conflicting MSVC runtime evidence. Ghostty 1.4's
`-fno-autolink` removes runtime stamps from every production C++ object. Each of
the three compile groups now adds a metadata-only witness using its actual flags
plus `-fautolink`; the compiler's `_MT`/`_DLL` macros determine the stamp. Packaging
requires all three witnesses, and CI links/runs Rust VT, text, core and FFI tests
for both CRT selections. Both Windows archives passed symbol/CRT checks, native Rust consumer tests and
signed provenance again in corrected run 40972570187, which also carries the final Rust
emoji correction.

## Routed copy and transport corrections

**Godview and Swift copy (existing gaps, fixed in this work).** Released Godview
returned an empty string for routed copy, and the Swift home card did not wire
its selection callback. Both now request exact host text over the authenticated
control leg. `selection-text` is negotiated independently of the core wire
version; copy needs read authority, never input or geometry authority. Correlated
request/session/activation/lease identities, bounded queues, five-second timeout,
no replay and cancellation prevent delayed responses from reaching a replacement
pane or overwriting a newer copy. Empty selections preserve the clipboard;
oversized selections return `TOO_LARGE` instead of silently truncating. The UI
uses its existing feedback surface for failures. Protocol fixtures are shared
byte-for-byte across TypeScript, Rust and Swift.

**Truffle proxy trailing slash (existing interoperability defect).** The pinned
proxy forwards the Freeway root as `/f/<secret>/`; the old door accepted only
`/f/<secret>`, returning 404 before authentication. The door now accepts exactly
one trailing slash while preserving the complete secret comparison and identity
gate. Wrong secrets, double slashes, subpaths and missing identity remain refused.
Both comparison hosts include the same fix, so the mixed-version baseline is
explicitly not a pristine released product. Original failure evidence is retained.

**Joined emoji and host cell accounting.** Unicode 18 widened nine newly assigned
emoji relative to the Rust tables. Host metadata now remains authoritative.
Legacy-width hosts may reserve four columns for a joined emoji: the shaper keeps
one combined symbol at a two-cell visual width and anchors subsequent clusters
at their actual host columns. Splitting the emoji into separate glyphs was an
intermediate attempt and is superseded. Tests cover legacy and mode-2027 hosts,
adjacent emoji, replica geometry and cache invalidation.

**Selection and procedural graphics grid (fixed).** Live Godview review found that
browser-derived text width ended a selected row’s backdrop before the host’s
last glyph, making its selected `X` invisible. Both WebGPU backdrop paths now
cover host glyph spans and trailing spaces. Box/block classification falls back
to host glyphs when Unicode widths disagree or ZWJ mapping is ambiguous, so an
unrelated following letter cannot become a block. Metal uses the same conservative
classification rule for graphics colors. New regression tests cover joined emoji,
Unicode 18, CJK, combining text, leading/trailing spaces and adjacent graphics;
reviewed Godview images preserve `👩‍💻ab▀X` and the highlighted final `X`.

**Normalized macOS archive.** Linux cross-builds skip upstream's Darwin-only
`libsystem_override.sh`. Simply stripping that archive leaves both compiler-rt
and Ghostty's override defining `memset`. The candidate now runs the exact
checksum-pinned upstream script during Apple normalization, preserving compiler
intrinsics while localizing compiler-rt's libc/libm symbols. The script is part
of the artifact source inventory and content-addressed recipe. CI now runs Rust
consumers of that normalized archive and rejects linker diagnostics. A matching
checksum or signed provenance alone was insufficient to qualify the earlier run.

**Physical QA host lifecycle.** A competing root Metal drawable loop could block
XCTest teardown even after assertions passed. The isolated harness pauses those
background views while mounting the two real terminal surfaces, restores the
original controller and leaves its Metal views paused until QA process exit.
All four pairings subsequently exited cleanly. This changes only the generated
QA host. Vibefield's reusable runner consumes/deletes the test configuration and
uninstalls the isolated app even after launch failure.

**Cargo output directory (packaging correction).** The machine's Cargo config
places its shared target directory on SamsungRed. A checkout's `target` symlink
does not override that setting. Two scripts wrote to Cargo's configured directory
but then read `root/target`, causing the package gate to read an older crate's
artifact manifest. The package gate now creates its archives in a fresh fixture
directory. The Apple composer asks Cargo for its actual target directory and
uses that same path for compilation and library composition. A real Cargo
regression check covers the default path, a configured path containing spaces
and an environment override. The Apple source digest and workflow inputs also
cover the new resolver.

**Earlier workspace gate under load.** The earlier Vibefield `pnpm verify` invocation
passed its static, type, lint, Rust clippy and bundle stages, then reported five
JavaScript test failures. The four fieldd failures passed on a focused rerun
(81 passed, seven skipped); three were polluted by Node's conflicting
`NO_COLOR`/`FORCE_COLOR` warning, removed from the rerun environment. The remaining
fieldd test and the field-app document test were timing-sensitive. Both baseline
and candidate passed the document first-run/restart controls at their original
five-second timeout; the complete 19-test document suite passed with only its
outer test timeout raised to 30 seconds. Product assertions were unchanged.
The final exact-artifact Rust run passed all 498 tests (15 ignored, including one
documentation test), followed by generated-contract freshness. This is qualified
stage/recheck evidence, not a claim that the original full invocation was green
or a latency sign-off. A disk-full build attempt is retained separately.

A final full repeat after SSD relocation ran Nx projects serially with the color
conflict removed. All static, type, lint, clippy and bundle stages passed. The
complete fieldd suite passed 2,608 tests (11 skipped), and field-app passed all
2,807 with no skips. Six five-second helper-process timeouts remained in the
screenshot and Electron-shell projects, so the full invocation still exited 1.
The affected tests and launcher/helper source files match the baseline exactly.
All 41 tests in those three files then passed on both baseline and candidate,
one file at a time, with the original timeouts and unchanged assertions. Preserve
both results; these rechecks do not turn the full-run exit status into a pass.

**Controlled dependency restoration (2026-10-30).** Early repeat attempts
exposed missing/mismatched React links and the candidate renderer resolving the
released protocol, which lacks the new copy capability. The next full run then
reported three document-compaction assertions, a missing Loro JavaScript snippet
in a logging fixture, and a terminal environment assertion. Investigation found
that pnpm automatically reinstalled the local dev overlay before running commands:
its resolutions had drifted to Loro 1.17.1 and React 19.3.1 while the committed
lock specifies Loro 1.13.8 and React 19.2.7. That run was stopped before any
landing gates; its failures are retained as an invalid dependency comparison.

A clean offline frozen install restored the complete committed graph. Stale
hoists required recreating only the isolated generated dependency directory.
`pnpm_config_verify_deps_before_run=false` prevents pnpm from automatically
undoing that restore; it does not disable the dependency guard or any test.
Host peers and the candidate renderer's internal Ghosttea source links were then
restored. The single-copy guard passes, the installed lock is byte-identical to
the committed lock, and actual baseline/candidate package manifests and versions
match, including Loro's WASM bytes. Production pins and tracked source did not
change. Repeating this candidate setup must preserve the frozen graph and these
source links; a plain auto-install of the dev overlay can reintroduce drift.

The terminal assertion also exposed a build-only flag inherited from this run:
`GHOSTTEA_GHOSTTY_VT_OFFLINE=1`. The unchanged service privacy filter removes
registered secret names and prefixes, not that build flag. It is now absent from
runtime test environments; `GHOSTTY_VT_PREFIX` still selects the exact verified
CI archive. Original assertions and timeouts remain intact. This correction is
to the qualification environment, with no product environment-policy change.

**Full frozen workspace run (2026-10-30).** With the actual locked dependencies
restored, all static, type, lint, formatting, Rust clippy and bundle checks passed.
Of 27 JavaScript test projects, 26 passed: 9,982 tests passed, one failed and
17 were skipped under the existing test conditions. Field-app passed all 2,807 tests with
no skips; Electron-shell passed 1,983 with three existing skips. The previous
screenshot/helper process timeouts did not recur. Fieldd passed 2,607 tests with
11 existing skips and one failure: its agent-cleanup warning recorded `pendingMs`
as 1,999 against a 2,000 ms minimum. The test had already verified that exit was
reported and cleanup remained pending. Its test and implementation are identical
to the baseline. The full invocation remains exit 1; focused controls do not
turn that result green. Test workers were capped at two, with the original
assertions and timeouts; this is not a latency sign-off. Because `verify` stops
at its first failed stage, its Rust and generated-file stages did not run in
that invocation. Running those stages separately against the same frozen graph
and exact CI archive passed: 498 Rust tests, 15 existing ignored cases including
the doctest, zero failures, and current generated files. Their success does not
change the original full-invocation exit status.

**Matched agent-cleanup controls.** A predetermined set of three alternating
baseline/candidate pairs passed all 12 selected test executions (six per build).
Each invocation selects the same two item-87 cases and excludes the other 54;
those exclusions are not additional product test results. Test source and the
agent-cleanup implementation are byte-identical across the comparison. Original
assertions and timeouts were retained. The only setup difference is skipping the
native rebuild in global setup and reusing the already-qualified retained binaries,
whose hashes were checked before and after each run. No candidate-specific
behavior difference was observed in these controls. They do not establish the
cause of the original 1 ms failure or turn the full workspace gate green.

**Full desktop landing run (2026-10-30).** All 13 required landing gates passed
serially in 1,742.53 seconds, against the frozen graph and exact CI native archive:
stills, basic smoke, full canvas, both graphics fallback modes, kind faults,
plugin restart, plugin-author try, Godview, routed terminal door, direct terminal,
Studio and bundled plugins. All 14 emitted final process censuses were empty.
The routed-terminal probe passed its original 30-second shutdown watchdog.
The plugin-author light/dark clock and full-board images were also reviewed;
clock geometry is intact in both, with markedly dimmer existing dark styling.
The bundle gate accepted the valid fixture and refused corrupt content and a
forged index. No assertions or timeouts changed. Historical red invocations
remain evidence of those attempts, independently of this complete passing run.

**Earlier desktop shutdown evidence.** The final Godview and direct-terminal smoke
commands both exited zero. The terminal-door probe accepted document/control and
worker/frames connections from the expected origin, then its teardown exceeded
the existing 30-second watchdog and exited 3. An unchanged baseline control and
candidate recheck both subsequently exited zero, with the original assertions
and watchdog. Their probe, supervisor and teardown source files are identical.
Both controls used the 20-second daemon drain budget and needed forced cleanup
inside the smoke; the launcher's final process census was empty in every run.
The initial failure is retained, its root cause is not established, and the
rechecks do not make the initial three-command gate green. The final host's
Cargo dependency fingerprints trace to the corrected CI archive's exact SHA-256;
it is a later build from the same sources than the host recorded before full
workspace verification.

**Final build identity and cleanup.** The complete Rust test command enables
Tokio's `test-util` feature through dependency feature unification, producing
different test-feature binaries at Cargo's usual executable paths. The originally
qualified runtime binaries remained intact in `debug/deps`. A normal
`cargo build -p field-native --bins` restored all three top-level executable hashes
exactly to the bytes used by the final phone matrix, desktop gates and timing
controls. Their dependency fingerprints still trace to the corrected CI VT archive.
No product source changed. The final owned-process census was empty.

**Final physical-device qualification (2026-10-30).** The exact final signed
candidate passed all 833 production terminal, input, routed, Freeway and mesh
tests, with zero failures and zero skips. On the user's next requested retry,
all four old/new client-host pairings passed their native-font and real-Truffle
checks: eight tests, no failures or skips. App, debug-library, xctestrun and
native-archive hashes were reverified; the candidate is the same package as the
833-test run. No product code, assertions or timeouts changed for the retry.

Each pairing exercised real PTY input, two independent Truffle nodes and
production Metal surfaces, advances in both accepted and rendered frames,
seat/geometry handoff, resize, park/resume, fresh-link redial and fresh output.
The new client copied exact Unicode and live PTY text from both attachments on
the new host; the old host returned explicit unsupported-copy status while its
stream and reconnect remained usable. The old clients passed against both hosts.
The test reaches the production selection API; a physical tap on the Swift home
card's copy menu was not separately exercised.

Both candidate-client screenshots were reviewed at original resolution:
[new host](ghostty-1.4-qualification/iphone-final-new-client-new-host.png) and
[old host](ghostty-1.4-qualification/iphone-final-new-client-old-host.png).
Mirrors match, joined emoji keep their natural artwork width, and the missing
Unicode 18 glyph and following `X` preserve each host's actual cell grid. The
pinned fonts still lack artwork for the newly assigned emoji.

The preceding four final-package attempts timed out at the phone's 60-second
Truffle `waitUntilRunning` bound, before peer discovery or terminal attachment.
Both old/new apps failed there and both Mac hosts joined. Those failures remain
in `iphone-final-package.json`; their environmental cause is not established.
The successful retry is recorded separately in
`iphone-final-package-retry-20261030.json`, with no passing claim backfilled into
the failed attempts. All four QA apps were uninstalled, temporary configuration
was consumed/deleted, and both fixtures exited zero. Complete retry result bundles
and logs are archived on SamsungRed with per-file checksum verification; the
approved test key was checked absent from the archive.

The first baseline fixture startup in this resumed pass failed because its retained
executable was launched outside Cargo's original `debug/deps` layout. The embedded
floor locates its terminal and Freeway helpers beside the current executable or
one directory above it. Restoring a hard link to the same fixture bytes at their
original location resolved startup; all three adjacent helpers were verified.
Product code and test assertions were unchanged. The failure and successful
fixture recovery are retained separately from the phone's tailnet-join failures.

**Storage recovery.** The user requested cache cleanup and use of SamsungRed.
Disposable incremental/obsolete builds were removed; 20.98 GiB of isolated Rust,
native and iPhone build caches were then copied to
`/Volumes/SamsungRed/codex-build-cache/vibefield-libghostty-migration-2026-10-29`.
Each copy passed a complete content-checksum comparison before its original was
removed, and the original paths remain symlinks. Source and qualification evidence
remain internal. Xcode's path-bound precompiled caches required a fresh candidate
build after relocation; that build succeeded and its two staged native libraries
match the verified package. Internal free space was about 64 GiB at completion;
that total also reflects other work on the shared machine.
The exact final Apple candidate ZIP is also retained on SamsungRed, with its
50,692,910 bytes and SHA-256 `de397a043efee2cb3f8d0e2cecf320cb345af475c4ea9b6d70b50f13f789dc5d`
reverified after copying. It remains unpublished.

## Promotion and rollback

No release has been published. The candidate's development source pin is separate
from Vibefield's exact released npm, Cargo and Swift versions. All 13 desktop
landing gates passed, as did the separately completed Rust/generated-file stages.
Before landing, resolve the remaining full-workspace
agent-cleanup timing failure. Its matched controls passed with unchanged checks,
but no full `pnpm verify` pass is claimed. Earlier helper-timeout and terminal-door
shutdown failures remain preserved; they did not recur in the final frozen run.
Corrected native packages and their consumers have passed. The exact final
rebuilt iPhone package passed all 833 production tests and all four real-Truffle
client/host combinations. Latency remains explicitly unqualified; do not convert
the noisy measurements into a performance guarantee.
Publish coordinated Ghosttea native/npm/Cargo/Swift artifacts only after release
authorization, then move every Vibefield production pin together and run its
landing gates. Do not commit development overlay locks or nil Swift release lines.
Rollback must restore the complete previous Ghosttea version and all associated
native/font artifacts, while retaining independently validated product fixes.

Three pre-existing SSH production-readiness blockers remain (the pinned libssh2
security baseline, missing upstream fixes and incomplete revalidation). They are
not caused by this VT migration and have not been waived. Configuration and UX
compatibility remain on their separately reviewed 1.3.1 baseline. A passing
terminal suite is not a claim that every TUI, network handoff or suspension case
has been exercised.

## Evidence location

The isolated run and its full logs/result bundles are under
`/private/tmp/vibefield-libghostty-migration-2026-10-29/evidence`. Baseline and
candidate checkouts, native build directories, simulator and iPhone app IDs are
separate from the user's running applications. Compact result summaries belong
in `docs/ghostty-1.4-qualification`; preserve failed attempts as well as passes.

The final frozen desktop runs, six timing-control runs, generated-file checks,
plugin-author images and exact comparison harnesses are retained in the SSD's
`qualification-evidence/desktop-final-20261030/desktop-results.tar.gz`:
69 files, 7,691,046 bytes, SHA-256
`c8f770c7480e130578243bf4260f834eebd65a3b28344bbf508b4a46caaa6d7c`.
Every archive member was checked against its original; the approved test key is
absent. The obsolete generated dependency directory used to diagnose the overlay
drift was removed after qualification; its diagnostic locks and logs remain.
Archive locations and hashes are recorded in
[desktop archive metadata](ghostty-1.4-qualification/desktop-final-20261030-archive.json),
[device retry metadata](ghostty-1.4-qualification/device-retry-20261030-archive.json)
and [final Apple asset metadata](ghostty-1.4-qualification/final-candidate-assets-20261030.json).
