# libghostty-vt 1.0 migration

Status, **2026-11-10**: the source port on `feat/ghostty-vt-1.0` is built and
tested on one host, an Apple Silicon Mac, natively. It is not qualified.
Nothing is built by CI, published, tagged or pinned by a consumer, and the
Windows archives, the Apple slices and the Swift proof wrapper are unbuilt. The
evidence table below says, row by row, what has run and what has not. Passing
one row does not qualify another.

## Baselines and scope

- Ghosttea: `4ee8a7cf7cecff2a40e387c40bdf054f7103e477` (0.14.0 plus #102).
- Existing Ghostty: 1.4.0, `83fb95624b0439ee660c2679b43b38c8b63769cd`, with
  the G15/G21 and MSVC runtime patches.
- Candidate Ghostty: libghostty-vt 1.0.0, tag `vt-1.0.0`, tag object
  `6b38d55f04e66ebecc472d8be19946edcc6d2e9d`, commit
  `0fa3d577a5614150ff8e2c152de5fb9d5c6d2dec`, with three patches. The tag is
  signed with RSA key `A04D91F3AA0062627A79C9AD523D5DC389D273BC`. The
  signature was not verified: the key was not at hand and none was imported.
- Zig stays 0.17.0. Every file under Ghostty's `src/font/res`, the fonts and
  their licence texts, is byte-identical at both commits, so
  `native/fonts.lock.json` moves its commit and keeps its hashes. Upstream's
  `src/build/libsystem_override.sh` is byte-identical too, so the pinned
  normalizer copy stands.
- The configuration and UX baseline stays at Ghostty 1.3.1. It is a separate
  pin with its own review.

1.0.0 is upstream's first versioned libghostty-vt. It is 266 commits past
1.4.0, 105 on the first-parent line. It freezes the C ABI under semantic
versioning: within 1.x a release only adds, and upstream's CI compares every
change to committed ABI goldens. The freeze itself is a deliberate break from
1.4.0, so this move adapts every caller once.

No published advisory is open against 1.4.0. This migration is not a security
response.

## Why the tag carries three upstream fixes

`native/patches/ghostty-vt-upstream-fixes.patch` is five upstream commits,
cherry-picked unchanged onto the tag. They landed on upstream main within two
days of the tag and are in no release yet.

| Upstream | Commits | What it fixes |
| --- | --- | --- |
| [#15134](https://github.com/ghostty-org/ghostty/pull/15134) | `1b8b3f55b`, `5ed7747e8` | Tracked pins left on a destroyed page when a column-growing resize without reflow stops its backfill early. The same code is in 1.4.0. Also a slowdown the 1.0 work introduced in `enumFromC`, which every enum-keyed C call runs. |
| [#15127](https://github.com/ghostty-org/ghostty/pull/15127) | `b543fbed1`, `3e29fcd62` | A failed render-state update marked rows clean before they were rebuilt, so the next update could read partly built rows. The same code is in 1.4.0. |
| [#15141](https://github.com/ghostty-org/ghostty/pull/15141) | `321a32a42` | One resize that grows the rows and shrinks the columns pushed the rows it pulled from scrollback back into it. The same code is in 1.4.0, and the differential probe shows it there: with 60 short lines on an 80 by 24 screen, a resize to 60 by 30 leaves the cursor on row 23 with six blank rows under it. With the fix the cursor is on row 29 and the six rows stay in view. |

The enum slowdown is the reason not to ship the bare tag: Ghosttea's snapshot
reads cells through enum-keyed getters. The patch is dropped when the pin
reaches a release that contains these commits.

## What the port required

### The Ghostty side

`native/patches/ghostty-vt-g15-g21.patch` keeps the same nine functions and
the same recovery behaviour. It is a zero-context diff, so none of the 1.4
patch could be re-applied: every hunk was placed by hand against the 1.0
sources. It now follows upstream's 1.0 rules for the C API
(`src/terminal/c/AGENTS.md`):

- `ghostty_formatter_terminal_state_new` takes no options, as
  `ghostty_formatter_terminal_new` no longer does. Options are set with
  `ghostty_formatter_set`. A state formatter refuses a selection with
  `GHOSTTY_INVALID_VALUE` and reads it back as `GHOSTTY_NO_VALUE`; the 1.4
  patch ignored it silently.
- The screen argument of the per-screen functions is validated in every build
  mode. The 1.4 patch validated it only in safe builds, so an out-of-range
  value in the released library was undefined behaviour. The shim never
  passes one: it refuses a screen above 1 before the call.
- `GhosttyHyperlinkIdentity`, `GhosttyTerminalSavedCursor` and
  `GhosttyTerminalScreenState` declare their base layout and are written
  through upstream's sized-struct helpers. A `size` below the base layout is
  still `GHOSTTY_INVALID_VALUE`.
- Size outputs are named `out_written`, `out_uri_written` and
  `out_id_written`. Positions and meanings are unchanged.
- `GhosttyTerminalScreenState.cursor_visual_style` is `GhosttyCursorStyle`,
  upstream's one cursor style enum, with the values the 1.4 enum had. The
  styles in both structs are upstream's frozen 16-byte `GhosttyStyle`.
- Every new type is in the type registry, so upstream's header parity test
  covers it, and the nine functions are in the symbol golden.
- Upstream's three per-target type goldens are left as upstream's. Its ABI
  check passes on the patched library and reports the ten new types as
  additions. The goldens are large generated files that upstream rewrites
  whenever it adds to the ABI, and hunks in them would have to be placed by
  hand again at every upgrade. The cost is that the check does not guard the
  layout of the ten types themselves.
- `ghostty_terminal_screen_get` writes its fields with its own loop. Upstream's
  `lib.sizedWrite` validates the struct again at compile time for every field
  it writes, and at the 22 fields of `GhosttyTerminalScreenState` that exceeds
  Zig's default limit of 1000 compile-time branches. Upstream's largest sized
  struct has 14 fields. The helper is untouched; the limit is worth reporting
  upstream.
- The formatter keeps its ordering: mode 40 and DECCOLM, then tab stops, then
  the other modes, with a pending SS2 or SS3 written last. Upstream's 1.0
  restore of a pending wrap at the right margin is used as it is.
- The cross-page hyperlink fix stands. Upstream 1.0 still reopens an implicit
  OSC 8 link with a new identity when the cursor changes pages.

`native/patches/ghostty-vt-msvc-runtime.patch` is the same option on the same
three compile groups, placed by hand in the five build files.

### The Ghosttea side

Two callers use the Ghostty C API: the shim and
`apple/GhostteaKit/Sources/GhosttyVtProof/GhosttyVtProofSession.swift`. The
Rust-facing shim ABI (`ghostty_shim.h`) is unchanged, so no Rust, TypeScript
or other Swift source moves.

| 1.4.0 | 1.0.0 | Where |
| --- | --- | --- |
| `ghostty_{key,mouse}_encoder_setopt[_from_terminal]` | `ghostty_{key,mouse}_encoder_set[_from_terminal]`, returning a result | shim, proof |
| `ghostty_key_event_set_utf8(event, ptr, len)` | takes a `GhosttyString`; the event borrows the text | shim, proof |
| `char*` output buffers in the five encoders | `uint8_t*` | shim, proof |
| `ghostty_terminal_selection_format_buf` and its options struct | removed; a formatter with `GHOSTTY_FORMATTER_OPT_SELECTION` | shim |
| `GhosttyFormatterTerminalOptions`, `…Extra`, `…ScreenExtra` | removed; `ghostty_formatter_set` and a `GhosttyFormatterExtras` bitmask | shim, proof |
| `GhosttyStyle` with a `size` and one `bool` per attribute | a frozen 16-byte struct with a `flags` bitmask | shim |
| `GhosttyGridRef`, `GhosttySelection` with a `size` | frozen, zero-initialised | shim |
| `GhosttyClipboardWrite.size` | removed; the request is frozen | shim |
| `GhosttyRenderStateCursorVisualStyle` | `GhosttyCursorStyle`, same values | shim |
| `GHOSTTY_RENDER_STATE_OPTION_DIRTY`, `…_ROW_OPTION_DIRTY` | `…_OPT_DIRTY`, `…_ROW_OPT_DIRTY` | shim |
| `GHOSTTY_SCROLL_VIEWPORT_*` | `GHOSTTY_TERMINAL_SCROLL_VIEWPORT_*`; the call returns a result | shim |
| `GHOSTTY_MODE_COLOR_SCHEME_REPORT`, `GHOSTTY_MODE_ALT_SCROLL` | `GHOSTTY_MODE_REPORT_COLOR_SCHEME`, `GHOSTTY_MODE_MOUSE_ALTERNATE_SCROLL` | shim |

Thirteen key enums gained `_INVALID = 0`, which moved every key up by one.
Both callers compile against the headers of the library they link, so the
values follow. Nothing outside them names a Ghostty constant.

Three changes go beyond a rename:

- The two recovery streams shared a duplicated options list. They now share
  one formatter helper that names the twelve extras one by one, so an extra a
  later libghostty adds cannot join the stream unreviewed.
- The key event's text is cleared after each encode. The event outlives the
  call and only borrows the text, which can be a buffer on that call's stack.
- The proof wrapper set the key text inside a closure and encoded outside it,
  after the borrowed pointer had ended. Both now happen inside it.

## Behaviour inherited from upstream

Read from upstream's headers and commit messages. The differential probe
confirms two of them, as marked; the others rest on reading.

- Glyph Protocol APC handling is off unless an embedder opts in: the C
  terminal constructor now disables it (`src/terminal/c/terminal.zig`). In
  1.4.0 every APC protocol started enabled (`src/terminal/apc.zig`), so the
  library answered Glyph Protocol queries although neither Ghosttea renderer
  draws registered glyphs. Ghosttea does not opt in.
- DECIC, DECDC, DECBI and DECFI are implemented (upstream `44a4911e9`). 1.4.0
  ignored them. Confirmed by the probe: the four sequences edit the columns of
  both rows on 1.0 and leave them untouched on 1.4.0.
- A recovery fragment restores a wrap that is pending at the right margin
  (upstream `f761046d6`). It does so by writing the cell under the cursor
  again, in the state-only stream too. Confirmed by the probe: replaying the
  1.4.0 fragment lost the pending wrap, replaying the 1.0 fragment keeps it.
- Text printed after a wrap inside left and right margins respects the right
  margin when the cursor started right of it (upstream `faa346b06`). The probe
  does not show it: its case ends on the same screen at both pins.
- A NULL handle or output pointer returns `GHOSTTY_INVALID_VALUE` instead of
  crashing, and an unknown key returns `GHOSTTY_UNSUPPORTED`.
- Render-state keys with nothing to report return `GHOSTTY_NO_VALUE`. The shim
  already treats anything but success as "no value".
- 1.0 states its rule for debug information: a fast build of the library
  keeps it unless `-Dstrip` is passed. The recipe passes no `-Dstrip` at
  either pin, and the macOS normalizer strips the archive as before. The size
  of the Windows archives against the 1.4 ones is to be read from the
  candidate run.

## Required evidence

| Area | Required check | Status |
| --- | --- | --- |
| Source | Three patches cut from one chain on the tag; a clean tree at the tag takes them in order with `git apply --unidiff-zero --whitespace=error-all` and equals the chain's tip | Passed at the final cut on 2026-11-10. The patched tree is `d0985e7f3c97d75a63f50936a333b2acc6b85215`, the tree every row below built. |
| Library | The patched library builds for macOS ARM64 at the locked flags | Passed on 2026-11-10, built natively on macOS: `libghostty-vt.a`, 12,935,360 bytes. Its shared build exports the 218 functions of the symbol list and nothing else. The release recipe cross-builds this target in a Linux container, and that path has not run. |
| Upstream tests | `zig build test-lib-vt`, including the header parity test and the ported and new tests of this patch | Passed on 2026-11-10 as a debug build on this Mac: 7,208 of 7,264 passed, 56 were skipped and none failed. The tool does not name the skipped tests. The two header parity tests and the 13 tests of this patch are among the passes, and `vt.h` compiles without a warning as C11, C23 and C++17. |
| ABI | `zig build test-lib-vt-abi` against upstream's goldens | Passed on 2026-11-10 for aarch64-macos: "10 addition(s) not in the goldens" and no problem. The two other golden targets were not checked. |
| Shim | The four C units compile against the candidate headers with warnings on | Passed on 2026-11-10 with no warning (Apple clang, `-std=c11`). |
| Core | `cargo test -p ghosttea-vt` and `cargo test -p ghosttea-core`, which holds the phase 1 chunking baseline, against the candidate | Passed on 2026-11-10 with Rust 1.97.1: 50 of 50 and 57 of 57. The phase 1 frame is byte-identical to its fixture. `ghosttea-vt-sys` has no test of its own. |
| Differential | The October probe's twelve cases and seven new ones, baseline against candidate, in four chunkings | Run on 2026-11-10 against the released 1.4.0 archive. Of 57 sections, 49 are identical and no chunking changed a result at either pin. Three cases differ, each for one upstream change named above: `dec_column_edits` in all three sections, `margin_wrap_wide` in its recovery streams and its replay, and `grow_rows_shrink_cols_short` in all three. `grow_rows_shrink_cols`, the first case written for #15141, does not trigger it, because its lines wrap. |
| Artifacts | macOS ARM64 and both Windows MSVC runtime variants as immutable CI candidates with provenance | Not run. Needs the branch on the remote. |
| Apple | All framework slices, the Swift proof wrapper and the complete Swift suite | Not run. The proof wrapper is unbuilt. |
| Fonts | Font parity with the candidate | Not run. The font bytes are unchanged. |
| Performance | Same-product measurements on a quiet host | Not run. This host is under a load hold. |
| Product | Godview and the phone through a linked candidate, before any tag | Not run. |
| Release | `npm run check:ghostty-upgrade` with the artifact manifest, both BOMs and the resource lock at the new source digest | Not run. Red by construction until the candidate artifacts exist, as in the 1.4 sequence. |

## What the local rows do not show

- The library was built natively on macOS, where upstream's build combines the
  archive with Apple's `libtool`. The release recipe builds the macOS archive
  in a Linux container, a different path through upstream's 1.0 build files.
  Neither that build nor the two Windows builds has run, so the MSVC runtime
  patch is unbuilt.
- Upstream's suite ran as a debug build, on one CPU and one operating system.
  The optimized library was built and linked into the Rust suites; upstream's
  suite did not run against it.
- 56 of upstream's tests were skipped on this host and the tool does not name
  them.
- Two `ghosttea-core` tests in `frame.rs` load the system fonts, so they need a
  host with a usable font.
- The library reports its version as `1.0.0-dev+<commit>` unless the source
  tree sits on the `vt-1.0.0` tag with the tag present, or the build passes
  `-Dlib-version-string`. The recipe fetches the pin by commit at depth 1,
  without tags, so the candidate archives will carry the development form.
  Zig's cached build configuration can also keep the commit of an earlier
  build: the library of the local Library row reports a commit one older than
  the one it was built from. Whether the recipe should state a version is open.

The 1.4 port passed its native tests and then failed in the signed-in product
on Godview input and phone resize. See
[the regression history](./ghostty-1.4-regression-history.md). The Product row
is therefore a gate before a tag, not after one.
