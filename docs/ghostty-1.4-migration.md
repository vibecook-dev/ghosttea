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
| Apple | All framework slices, complete combined Rust/Swift artifact, reviewed toolchain | Final combined candidate package verified: `ghosttea-apple-native-1611ad6b0820`, source digest `56dc58d73c6d319af6759ef6f1e465e011ae58b32ec5e7b50295a1c2d4f49ac8`. All 18 public Swift products link against it. Clean iPhone QA build passed; both staged iOS archives match the package and both baseline/candidate app signatures verify. No artifact published. |
| Core | Full Rust tests, C ABI, allocation/lifetime checks, parser chunking and ordered replies | Passed against the corrected CI macOS archive: candidate 424 Rust tests / 3 ignored and 623 JS tests; baseline 414 Rust / 3 ignored. ABI 197 types / 1,916 assertions; four strict C shims. C FFI parity and AddressSanitizer gate passed without duplicate-symbol warnings. |
| Fonts | Unicode policy, explicit missing-glyph handling, desktop and iOS rendered comparisons | Eight bundled files verified; two Noto fonts updated. Unicode 18 cell-width regression reproduced and fixed. Reviewed pixel comparison: all eight cases retain identical layout; two emoji cases have intentional font-pixel changes. New engine with old fonts reproduces the old golden exactly. Native iPhone font goldens passed in all four old/new client-host combinations. Joined-emoji artwork now stays at its natural cell width while following text retains the host grid; Godview and iPhone images show the corrected artwork/grid. The complete Metal/frame suite passes 80 tests. Its one font-dependent golden hash changed; restoring only the old fonts reproduced the old pixel hash exactly, with layout, edge map, mean channels, occupied pixels and tolerances unchanged. |
| Godview | Pane creation/split/close, focus/input, resize, scrollback, selection/copy, freeze/resume, mirrors and restored panes | Passed: final full field-app suite (2,807 tests, no skips). Final exact-CI-artifact pane lab copies Unicode and 160-row scrollback, switches alternate screens, verifies hidden output, splits/closes panes, preserves used sessions, checks fullscreen/canvas sizing and reattaches eight times. Screenshot reviewed; clean process exit, PTYs 93 before/after and zero surviving owned processes. |
| Real desktop | Isolated-profile Godview and terminal-direct smoke with candidate host binary | Final exact-CI-artifact Godview and direct-terminal smokes passed with no surviving processes. Terminal-door connection/origin checks passed, but its first shutdown exceeded the 30-second watchdog; unchanged baseline and candidate controls subsequently passed at that same timeout. This intermittent shutdown failure remains recorded. Windows evidence covers native CI consumers, not a physical Windows GPU/product-UI run. |
| Host routing | Seat/geometry authority, activation/generation fences, drawn acknowledgements, credits and transfer bounds | Passed: baseline 493 originally; candidate now 498 / 15 explicitly ignored hardware/network fixtures, including read-only copy, identity/lease fences and oversized replies. Shared Freeway fix is included in both comparison hosts. |
| Swift | FieldTerminal, FieldInput, FieldRoutedTerminal, FieldFreeway and relevant FieldMesh tests; real simulator rendering | Simulator: 1,306 passed / 2 skipped on both. iPhone baseline: 826 passed after correcting a demonstrated test-only acknowledgment race; the prior candidate passed all 833 production tests, including seven new selection tests. The final rebuilt artifact has a clean, signed QA app ready, but its on-device rerun is explicitly pending by user choice after the iPhone became unavailable. Prior device results do not claim execution of this final package. |
| Remote | Concurrent desktop/Swift mirrors; slow viewers, disconnect/reconnect, foreground resync, stale frames and control handoff | Both real route probes and all four iPhone client-host pairings passed after the shared Freeway correction. Tests require two independent nodes and Metal surfaces to accept AND render PTY updates, with input, resize, park/resume and fresh-link redial. New-client/old-host copy fallback also passed. New-client/new-host and old-client/new-host reruns both passed and exited cleanly. Both supported views returned the expected Unicode/live PTY selection; the runner removed the isolated apps. |
| Compatibility | Baseline/candidate host-client combinations without wire-version drift | Wire versions unchanged. Four mixed-version combinations passed. Copy is an optional negotiated `selection-text` capability; older hosts return explicit unsupported status without disrupting the route. All three pairings affected by copy changes passed; the unchanged old-client/old-host control is retained from the four-way matrix. |
| Performance | Same-product pane workloads and frame latency; no acceptance based solely on old microbenchmarks | All 16 paired scenario processes completed without errors or unpresentable arms; approximately 120 Hz, frame p95 around 9.1–9.3 ms. Latency is explicitly unqualified: the user chose to continue under the heavily loaded host instead of arranging a quiet repeat. Injection-to-PTY measurements are not input-to-photon latency, and these results are not a performance sign-off. |
| Release | Source/font/artifact/BOM consistency, device evidence and atomic upgrade/rollback | Candidate source, font parity, BOM, resources, Swift manifests, App Store and beta metadata checks passed. Final device confirmation, full landing gates and coordinated artifact/version promotion remain open. Config/UX retain their separately recorded 1.3.1 baseline. |

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

**Workspace gate under load.** The earlier Vibefield `pnpm verify` invocation
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

**Final desktop shutdown evidence.** The final Godview and direct-terminal smoke
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

## Promotion and rollback

No release has been published. The candidate's development source pin is separate
from Vibefield's exact released npm, Cargo and Swift versions. Before landing,
complete the required full landing gates and resolve or explicitly account for
the recorded workspace timeouts and intermittent terminal-door shutdown failure.
Corrected native packages and their consumers
have passed. The final rebuilt-package iPhone run is pending by the user's choice
after device availability was lost. Latency also remains explicitly unqualified;
do not convert the noisy measurements into a performance guarantee.
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
