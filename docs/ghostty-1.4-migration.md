# Ghostty 1.4 migration for Vibefield

Status: implementation and product qualification in progress. No release promotion.

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
| Artifacts | macOS ARM64 and both Windows MSVC runtime variants; immutable CI candidates and provenance | Open: run 40961534587 built macOS and dynamic Windows; the Windows archive lacked runtime stamps because upstream disables autolink. Compiler witnesses and both-runtime Rust consumer tests await a new candidate run. |
| Apple | All framework slices, complete combined Rust/Swift artifact, reviewed toolchain | Built: VT, SSH and combined native XCFrameworks; all 18 public Swift products link. Final input-digest refresh pending. |
| Core | Full Rust tests, C ABI, allocation/lifetime checks, parser chunking and ordered replies | Passed: candidate 422 Rust tests / 3 ignored; baseline 414 / 3. ABI 197 types / 1,916 assertions; four strict C shims. C FFI parity and AddressSanitizer gate passed. |
| Fonts | Unicode policy, explicit missing-glyph handling, desktop and iOS rendered comparisons | Eight bundled files verified; two Noto fonts updated. Unicode 18 cell-width regression reproduced and fixed. Reviewed pixel comparison: all eight cases retain identical layout; two emoji cases have intentional font-pixel changes. New engine with old fonts reproduces the old golden exactly. Device font proof pending. |
| Godview | Pane creation/split/close, focus/input, resize, scrollback, selection/copy, freeze/resume, mirrors and restored panes | Passed: 1,032 candidate tests; GPU pane lab split/close, used-session retention, fullscreen and canvas sizing on both versions. Remaining interactive behaviors open. |
| Real desktop | Isolated-profile Godview and terminal-direct smoke with candidate host binary | Passed on both exact consumer baselines: isolated Godview/direct terminal smoke and WebGPU pane regression; captured images inspected. |
| Host routing | Seat/geometry authority, activation/generation fences, drawn acknowledgements, credits and transfer bounds | Passed: all 493 Vibefield native tests on both versions; 14 explicitly ignored network/hardware tests per run. |
| Swift | FieldTerminal, FieldInput, FieldRoutedTerminal, FieldFreeway and relevant FieldMesh tests; real simulator rendering | Simulator: 1,306 passed / 2 skipped on both. iPhone baseline: 826 passed after correcting a demonstrated test-only acknowledgment race; candidate: the same 826 production tests passed; the separate opt-in remote fixture test skipped in the full suite and is tested separately. |
| Remote | Concurrent desktop/Swift mirrors; slow viewers, disconnect/reconnect, foreground resync, stale frames and control handoff | Both real Truffle route probes passed. First production Freeway + iPhone attempt reached Truffle but failed the WebSocket upgrade with HTTP 404. Investigating the proxy/door boundary; not accepted. |
| Compatibility | Baseline/candidate host-client combinations without wire-version drift | Wire versions unchanged; logical replica tests cover old/new host Unicode widths and geometry-only cache changes. Live mixed-version matrix pending. |
| Performance | Same-product pane workloads and frame latency; no acceptance based solely on old microbenchmarks | Functional GPU pane checks passed; cold single-run timings are diagnostic only. All 16 paired scenario processes completed successfully; detailed metrics and timeout/error records are under review. |
| Release | Source/font/artifact/BOM consistency, device evidence and atomic upgrade/rollback | Not promoted. Config/UX retain their separately recorded 1.3.1 baseline; native/font/BOM final consistency and artifact promotion remain gates. |

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
for both CRT selections. The actual Windows archives remain unverified until
that workflow completes.

## Evidence location

The isolated run and its full logs/result bundles are under
`/private/tmp/vibefield-libghostty-migration-2026-10-29/evidence`. Baseline and
candidate checkouts, native build directories, simulator and iPhone app IDs are
separate from the user's running applications. Compact result summaries belong
in `docs/ghostty-1.4-qualification`; preserve failed attempts as well as passes.
