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
| Source | Rebase both local patch contracts; checksum-verified Zig 0.17; deterministic bootstrap diff | Pending |
| Artifacts | macOS ARM64 and both Windows MSVC runtime variants; immutable CI candidates and provenance | Pending |
| Apple | All framework slices, complete combined Rust/Swift artifact, reviewed toolchain | Pending |
| Core | Full Rust tests, C ABI, allocation/lifetime checks, parser chunking and ordered replies | Pending |
| Fonts | Unicode policy, explicit missing-glyph handling, desktop and iOS rendered comparisons | Pending |
| Godview | Pane creation/split/close, focus/input, resize, scrollback, selection/copy, freeze/resume, mirrors and restored panes | Pending |
| Real desktop | Isolated-profile Godview and terminal-direct smoke with candidate host binary | Pending |
| Host routing | Seat/geometry authority, activation/generation fences, drawn acknowledgements, credits and transfer bounds | Pending |
| Swift | FieldTerminal, FieldInput, FieldRoutedTerminal, FieldFreeway and relevant FieldMesh tests; real simulator rendering | Pending |
| Remote | Concurrent desktop/Swift mirrors; slow viewers, disconnect/reconnect, foreground resync, stale frames and control handoff | Pending |
| Compatibility | Baseline/candidate host-client combinations without wire-version drift | Pending |
| Performance | Same-product pane workloads and frame latency; no acceptance based solely on old microbenchmarks | Pending |
| Release | Source/font/artifact/BOM consistency, device evidence and atomic upgrade/rollback | Pending |

Use isolated application profiles and sessions. Do not operate on existing user
terminals or rewrite goldens to hide differences. Record intentional upstream
corrections separately from regressions. Missing platform evidence remains an open
gate; passing library tests cannot establish that every product behavior works.
