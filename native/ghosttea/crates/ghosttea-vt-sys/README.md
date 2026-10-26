# ghosttea-vt-sys

Native artifact and linking contract for Ghosttea's pinned Ghostty VT core.
Applications should depend on the safe `ghosttea-vt` crate instead of using
this crate directly.

Repository builds use `native/build/ghostty/<target>/install`, so one checkout
can hold several platforms at once. Consumers can provide an equivalent
verified installation with `GHOSTTY_VT_PREFIX`. Otherwise the crate downloads
the target bundle recorded in `artifacts.json` and verifies the bundle, static
library, and public header with SHA-256 before linking.

Supported overrides:

- `GHOSTTY_VT_PREFIX` selects an unpacked installation.
- `GHOSTTEA_GHOSTTY_VT_BUNDLE` selects a local release bundle.
- `GHOSTTEA_GHOSTTY_VT_BASE_URL` redirects downloads to a mirror.
- `GHOSTTEA_GHOSTTY_VT_OFFLINE=1` forbids network fallback.

Every bundle includes the upstream Ghostty license, build metadata, the exact
reviewed source patches under `SOURCE-PATCHES/`, and an SPDX 2.3 SBOM. Artifact
names use a digest of the upstream commit, ordered patch identities, and full
build recipe. The commit alone is not a complete artifact identity.

## Release targets

| Target                              | Built by                                                 | Static archive              | Reproducible |
| ----------------------------------- | -------------------------------------------------------- | --------------------------- | ------------ |
| `aarch64-apple-darwin`              | Zig in the pinned Linux builder image                    | `lib/libghostty-vt.a`       | no           |
| `x86_64-pc-windows-msvc`            | Zig on a Windows host, for the dynamic C runtime (`/MD`) | `lib/ghostty-vt-static.lib` | no           |
| `x86_64-pc-windows-msvc-crt-static` | Zig on a Windows host, for the static C runtime (`/MT`)  | `lib/ghostty-vt-static.lib` | no           |

Ghostty installs the Windows static archive under a distinct name because
`lib/ghostty-vt.lib`, the DLL import library, sits beside it.

The Windows library comes in one build per C runtime. Every object in an MSVC
link must be compiled for the same runtime; the linker refuses a mix with
LNK2038, and the C++ standard headers stamp each object with the runtime it
was compiled for. A Rust target links the dynamic runtime unless it enables
`crt-static`, and `cc` builds a consumer's own C++ for the same one, so this
crate links the `x86_64-pc-windows-msvc` build by default and the
`x86_64-pc-windows-msvc-crt-static` build under `-C target-feature=+crt-static`.
Packaging reads each library's linker directives and refuses objects stamped
for the other runtime.

Windows cannot use the container cross-build: Microsoft's CRT headers and
import libraries are not redistributable, so Zig must find an installed MSVC
and Windows SDK and therefore builds on a matching host. The container build
pins its job count, dependency seed, target CPU to `baseline`, and in-container
paths. Its Mach-O archive is then stripped by the exact Xcode build recorded in
`native/ghostty.lock.json`, and archive metadata is canonicalized. All three
classes of constraint reduce variance: scheduling and CPU drift can change code
generation across ARM hosts, while an unpinned Apple `strip` changes
otherwise-identical objects across macOS runner generations. Even with every
pin applied, Zig 0.15.2 emitted a different instruction sequence in the root
object across the local and CI ARM hosts, so the archive is not classified as
reproducible. A native Windows build likewise embeds host-toolchain state that
no postprocessing step can canonicalize.

`reproducible` in `artifacts.json` records that difference and decides how a
bundle is trusted:

- a downloaded or supplied bundle is always verified against its locked
  checksums, because it is untrusted input;
- a repository build is verified only when the target is reproducible. It
  already comes from the pinned Ghostty commit, so its checksum is a
  reproducibility check rather than a trust boundary.

One CI workflow-dispatch run produces both authoritative candidates. Their
results and shared `candidateRunId` are reviewed and locked in `artifacts.json`.
The tag run downloads both immutable workflow artifacts by run ID, verifies
their bundle checksums, result metadata, embedded source identities, and SBOMs,
and promotes the same bytes. It must never rebuild an archive for an existing
locked checksum.
