# GhostteaKit SwiftPM and Apple native publishing

GhostteaKit is consumed from the repository root:

```swift
.package(url: "https://github.com/vibecook-dev/ghosttea.git", from: "0.6.2")
.product(name: "GhostteaTerminal", package: "ghosttea")
```

SwiftPM derives releases from semantic-version Git tags and evaluates only the
root `Package.swift`. The root manifest therefore publishes the package, while
`apple/GhostteaKit/Package.swift` remains the local-development mirror.

## One Rust system library

`GhostteaAppleNative.xcframework` contains exactly one Rust `staticlib` per
platform. This is a linkage invariant, not a packaging preference.

A Rust `staticlib` contains its upstream dependencies and Rust standard library.
Combining two independently produced Rust static libraries afterward embeds two
Rust runtimes and can fail with duplicate runtime symbols. The package previously
did exactly that for `ghosttea-ffi` and `ghosttea-font-fixture-ffi`; a consumer
linking `GhostteaCore` and `GhostteaFontProof` together failed on
`_rust_eh_personality`.

The supported structure is:

```text
ghosttea-ffi ───────────────┐
                            ├─ rlib dependencies
ghosttea-font-fixture-ffi ──┘
              │
              ▼
ghosttea-apple-ffi          one Rust staticlib
              │
              ├─ bundled pinned Ghostty VT archive
              └─ merged with pinned libssh2/OpenSSL archive
              │
              ▼
GhostteaAppleNative.xcframework
```

Only `ghosttea-apple-ffi` may declare `crate-type = ["staticlib"]` for this
artifact. Its Rust dependencies must remain available as `rlib`s so rustc, rather
than an archive tool, unifies their shared dependencies and runtime.

`scripts/build-ghosttea-apple-native.mjs` enforces the structure for the macOS
arm64, iOS arm64, and iOS arm64-simulator slices. It requires each core and font
fixture C export exactly once and refuses duplicate archive members.

The build disables `pkg-config` discovery for HarfBuzz and verifies that its
required C definitions are embedded in every Rust slice. Release bytes must not
depend on libraries that happen to be installed on a CI runner or developer
machine.

## Two manifests, one intended difference

|                       | Root `Package.swift`             | `apple/GhostteaKit/Package.swift`          |
| --------------------- | -------------------------------- | ------------------------------------------ |
| Native binary target  | `.binaryTarget(url:checksum:)`   | `.binaryTarget(path:)`                     |
| Intended use          | External consumers               | Local app and native candidate development |
| Artifact verification | SwiftPM SHA-256 before unpacking | Fresh local CI/developer build             |

`npm run check:apple-native-artifact` dumps and compares both package graphs.
Products, targets, and dependencies must remain identical; only binary-target
sourcing may differ.

The five runtime fonts are committed package resources and checked against
`native/fonts.lock.json`. A clean SwiftPM checkout must not depend on generated
or Git LFS content.

## Local candidate qualification

Use the toolchain recorded in
`Compatibility/ios-toolchain.lock.json` on Apple Silicon macOS. Ghostty's
pinned Zig 0.15.2 build additionally requires the side-by-side Xcode recorded
in `native/ghostty.lock.json`; Xcode 26.4 and later changed the macOS system
stubs in a way Zig 0.15.2 cannot link. Keep the main release toolchain on Xcode
26.6 and point only the two Ghostty commands at Xcode 26.3:

```sh
npm ci --ignore-scripts
npm run check:ios-release-toolchain

GHOSTTY_DEVELOPER_DIR=/Applications/Xcode_26.3.app/Contents/Developer \
  npm run bootstrap:ghostty-vt:apple
GHOSTTY_DEVELOPER_DIR=/Applications/Xcode_26.3.app/Contents/Developer \
  npm run build:ghostty-vt:apple
npm run bootstrap:ssh:apple
npm run build:ssh:apple
npm run build:apple-native

DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer \
  swift test --disable-sandbox --package-path apple/GhostteaKit

npm run test:swiftpm:consumer:local
npm run package:ghosttea-apple-native
npm run verify:ghosttea-apple-native-package
```

CI selects the `macos-26` ARM runner and
`/Applications/Xcode_26.6.app/Contents/Developer` explicitly for Rust, Swift,
packaging, and tests. It selects
`/Applications/Xcode_26.3.app/Contents/Developer` only for the Ghostty/Zig
input. Both versions and SDK builds are verified against their committed
locks. Do not replace either path with the runner's moving
`/Applications/Xcode.app` default; the checks are intended to fail on drift.
The split is the reviewed workaround for
[Zig issue 31658](https://codeberg.org/ziglang/zig/issues/31658), fixed
upstream after Zig 0.15.2 by
[PR 31673](https://codeberg.org/ziglang/zig/pulls/31673).

The external-consumer test imports and links every public library product into
one executable. It is required in addition to unit tests because cross-product
static-link behavior is a consumer property.

## Content addressing

The release tag is `ghosttea-apple-native-<contentDigest12>`, not a Ghosttea
version. SwiftPM requires a remote binary target's checksum to be committed at
the semantic-version tag it resolves. Therefore the binary must exist before a
Ghosttea version tag can reference it.

The package result records:

- `checksum`: SHA-256 of the zip, enforced by SwiftPM.
- `contentDigest`: digest of archive paths, modes, and file bytes.
- `slices`: SHA-256 of every platform archive.
- `sourceDigest`: digest of all native source, lock, build-script, Cargo, and
  toolchain inputs.
- `tag` and `url`: derived from the content digest.

`npm run verify:ghosttea-apple-native-package` independently unpacks the
candidate and derives these values again before publication. On macOS it also
requires SwiftPM's own `swift package compute-checksum` result to match the
independent SHA-256 calculation.

The archive writer is deterministic for a given XCFramework tree. Native Apple
build outputs are not assumed byte-reproducible, so CI-produced bytes are the
authoritative release subject. Reproducibility is not required for provenance:
the attestation binds the exact released bytes to their workflow, repository,
commit, and build environment.

## Authoritative CI publication

`.github/workflows/ghosttea-apple-native-artifact.yml` owns publication.

1. Open or update the native-source pull request. The iOS hardening workflow
   builds and qualifies a local candidate without requiring an artifact that
   cannot exist until the source is approved.
2. Dispatch the artifact workflow on the exact reviewed source ref. A
   publication request must use the protected `release/*` branch convention;
   the workflow rejects any other ref before starting the expensive build.
3. Leave `publish` false to produce a qualified Actions artifact only.
4. Set `publish` true to request promotion through the protected `release`
   environment.
5. CI builds Ghostty, OpenSSL, libssh2, both Rust FFI surfaces, and the final
   XCFramework from their reviewed locks.
6. CI runs the complete Swift test suite and the all-products consumer.
7. CI packages and independently verifies the archive.
8. The build job attests the qualified archive before uploading it. The publish
   job downloads that exact Actions artifact, verifies its source commit and
   clean-tree metadata, and verifies the attestation before publishing.
9. It creates an append-only content-addressed release without `--clobber`,
   downloads the served assets again, and re-verifies them.

The `release` environment allows only `v*` tags and `release/*` branches. It
has required no reviewer since 2026-10-24. The human release gate is the signed
`v*` tag, which the "release tags" ruleset limits to admins. Do not widen the
environment's refs or publish from a mutable developer workstation.

GitHub only enables `workflow_dispatch` after the workflow file exists on the
default branch. The first rollout of this pipeline is therefore intentionally
two-stage:

1. merge the workflow, single-runtime builder, and candidate gates without
   changing the published pin;
2. configure the protected environment to allow `main`, dispatch the workflow
   on `main`, and publish the qualified artifact; then
3. update the lock and root manifest in a second pull request.

After that bootstrap, a normal native change can stay in one pull request:
publish from the approved head branch, update the pin in that pull request, and
let the pull-request artifact audit verify the served bytes before merge. The
environment must explicitly allow that protected branch pattern; GitHub matches
environment rules against the dispatch ref.

On a `release/*` branch none of that is manual. Every push to one runs the
workflow, and its `release-needs` job compares the tree's native source digest
with the pin. When they differ, as after the release's version bump, the same
run builds, publishes and pins the artifact (see "Updating the SwiftPM pin").
The pin commit, a CHANGELOG edit, or a branch that already carries its pin
needs nothing and stops there.

The artifact audit's pull-request paths cover every `nativeSourceInputs` entry,
including the workspace `Cargo.toml` and `Cargo.lock`. A release-only Cargo
version bump therefore moves `sourceDigest` and intentionally leaves the audit
red until a candidate from that exact commit is promoted and its immutable pin
is committed. `check:swiftpm:manifests` verifies this path coverage so adding a
new provenance input cannot silently bypass the audit.

GitHub artifact attestations are the provenance record:
<https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations>.

## Updating the SwiftPM pin

On a `release/*` branch the workflow's `pin` job writes this commit. It:

1. runs `scripts/pin-ghosttea-apple-native.mjs` on the candidate it just
   published, which refuses a candidate not built from the branch's tree;
2. audits the result with the two commands below;
3. pushes `release: pin X.Y.Z Apple native artifact`;
4. dispatches `desktop-release-gates.yml` and `ios-release-hardening.yml` for
   the new head, because a push made with `GITHUB_TOKEN` starts no workflows.

If the branch moved while the run built, it leaves the pin to the run for the
newer push. The script edits values in place, so its commit changes the same
lines a hand-written pin does: `tests/apple-native-pin.test.mjs` replays the
0.13.1 to 0.13.2 pin byte for byte.

To pin by hand, after a dispatch from another branch or a failed `pin` job, run
the same script with the downloaded `GhostteaAppleNative.xcframework.zip.json`,
`--run-url`, `--attestation-url`, `--source-commit` and `--branch`, or do what
it does:

After CI publishes the artifact, copy the following fields from the workflow's
`GhostteaAppleNative.xcframework.zip.json` into
`Compatibility/apple-native-artifact.lock.json`:

- `tag`
- `url`
- `checksum`
- `size`
- `contentDigest`
- `sourceDigest`
- `entries`
- `slices`

Update `appleNativeURL` and `appleNativeChecksum` in the root `Package.swift` in
the same pull request. Record the workflow run and attestation URL in the lock's
provenance metadata.

The pull request must then pass:

```sh
npm run check:apple-native-artifact:release
npm run test:swiftpm:consumer
```

The release audit intentionally ignores any gitignored local XCFramework and
re-derives identity from the served archive; use
`check:apple-native-artifact` without `--release` when validating a local
candidate. This prevents an older developer build from contaminating a remote
publication decision while preserving local stale-build detection.

The iOS hardening workflow rebuilds and qualifies a local candidate, so it checks
the source build independently. A separate pull-request job, triggered by the
root manifest, artifact lock, and every native provenance input, checks the
served artifact. This split avoids a circular build dependency: a source pull
request can create a candidate while its served-artifact audit is expected to
remain red; after protected promotion and the pin update, the same audit verifies
the immutable URL before merge.

For the same reason, the repository-wide `npm run check` uses
`check:swiftpm:manifests`. The stricter `check:apple-native-artifact` and
`check:apple-native-artifact:release` commands remain explicit publication and
release gates; candidate development must not pretend unmerged source already
has published bytes.

Never replace an existing release asset or move its tag. Every published
Ghosttea version pins an archive checksum; historical consumers must continue to
receive those exact bytes.

## Product release gate

Before npm or crates.io publication, the `vX.Y.Z` workflow:

1. verifies the published Apple artifact and source digest;
2. runs the full root Swift test suite;
3. creates a clean external package that resolves
   `https://github.com/vibecook-dev/ghosttea.git` at exact `X.Y.Z`; and
4. links every public library product in that consumer.

Because pushing the semantic-version tag publishes the Swift package
immediately, the same checks must also be required on the commit before the tag
is created. The tag workflow is defense in depth, not the first qualification
point.
