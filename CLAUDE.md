# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

ghosttea is a terminal runtime built on Ghostty's `libghostty-vt`. A Rust daemon (`ghosttead`) owns PTYs and terminal state. It streams pre-shaped display lists, called TRF1 frames, to two renderers:

- WebGPU, in Electron + React on Apple Silicon macOS and x64 Windows.
- Native Metal, on iOS 18.1+.

Seven Rust crates, ten `@vibecook/*` npm packages and the SwiftPM package share one version. SwiftPM takes its version from the `vX.Y.Z` git tag.

## Commands

**Prerequisites**

- Node 22+ (CI uses 24).
- Rust 1.88+, the workspace minimum. There is no rust-toolchain file.
- Apple work also needs:
  - Xcode 26.6.
  - Xcode 26.3 installed side by side at `/Applications/Xcode_26.3.app`. It is used only for the Ghostty/Zig 0.15.2 build; override the path with `GHOSTTY_DEVELOPER_DIR`.
  - Rust 1.97.1 with the `aarch64-apple-ios` and `aarch64-apple-ios-sim` targets.

**Get started**

```bash
npm install
npm run fetch:ghostty-vt
npm run dev   # build:sdk, then the Electron demo (apps/desktop, workspace "ghosttea-demo")
```

- **Running the daemon:** the demo uses `GHOSTTEAD_BIN` if it is set, and otherwise runs the daemon through `cargo run --release`. Set `GHOSTTEA_DEV_PROFILE=debug` for a debug build. The supervisor waits only 120 s for `ghosttead ready`, so on a cold machine build it first with `cargo build --release -p ghosttead`.
- **The CI suite:** `npm run ci:desktop` is exactly what the required CI checks run (`verify` on macOS, `windows` on Windows). It runs four stages in order:
  1. `check:desktop`: prettier and `cargo fmt --check`, eslint with zero warnings, the workspace-name and build-script guards, `build:sdk`, `tsc --noEmit` in every workspace, and `cargo check` plus `clippy -D warnings`. Cargo steps use `--locked`.
  2. `test:desktop`: vitest in every workspace, `cargo test --workspace --locked`, the FFI parity/ASan probe, the release-script tests, the integration smokes and the bench tests.
  3. `package:check:built`: packs every package and crate, then builds consumers from those archives.
  4. `test:lifecycle:soak`.
- **Before running locally:** run `npm run bootstrap:ghostty-vt` once before `ci:desktop` or `test:desktop`. `test:ghosttea-core:ffi` syncs fonts from `native/vendor/ghostty` at the locked commit and fails without it. CI on macOS uses the `:apple` variant, which needs Xcode 26.3.
- **Format and lint:** `npm run format` writes prettier and `cargo fmt`. `npm run lint` runs eslint with `--max-warnings 0`. Prettier (width 120, LF line endings enforced by `.gitattributes`) covers only the paths named in the `format` script, not `docs/`, `draft/`, `apple/` or `native/`.
- **Full checks:** `npm run check` runs the lint and type checks plus the iOS release-metadata gates: BOM, resources, App Store, beta matrix and SwiftPM manifests.

**Running a single test**

- **Rust:** `cargo test -p <crate> --locked <filter>`.
- **TypeScript:** packages import each other's built `dist`, so run `npm run build:sdk` first. Then either:
  - `npm test -w @vibecook/ghosttea-react`, or
  - from the package directory, `npx vitest run src/runtime.test.ts -t "<name>"`.
- **Node scripts:** `tests/*.test.mjs` and `bench/**/*.test.mjs` run with `node --test <file>`.
- **Daemon integration:** `npm run test:integration` spawns the daemon and exercises it over its real sockets. `npm run test:lifecycle:soak` runs the soak.
- **Swift:**
  - `swift test --disable-sandbox` at the repo root uses the published native artifact.
  - `swift test --disable-sandbox --package-path apple/GhostteaKit` needs a local artifact. Build it with `npm run bootstrap:ghostty-vt:apple && npm run build:ghostty-vt:apple && npm run bootstrap:ssh:apple && npm run build:ssh:apple && npm run build:apple-native`.
- **Tailnet tests:** Truffle tests and benches skip unless `TRUFFLE_TEST_AUTHKEY` is set (see `.env.example`). The `docs/TESTING.md` it mentions does not exist.

## Architecture

**Desktop frame path**

```
PTY
→ ghosttead session
→ libghostty-vt state
→ damaged rows shaped natively (ghosttea-text: fontdb + harfbuzz + swash)
→ TRF1 frame
→ frame socket
→ Electron utility process (ghosttea-electron bridge)
→ renderer MessagePort
→ the window's single WebGPU worker
```

Electron main never forwards frames, PTY bytes never reach the renderer, and React never draws cells.

**Local planes:** the daemon serves two, each authenticated by the same bearer token sent as the first packet:

- Control: u32 little-endian length-prefixed JSON, protocol 1.16.
- Frames: TRF1.

On macOS and Linux they are Unix sockets. On Windows they are named pipes with a user-only DACL.

**Remote sessions:** these use a separate mesh protocol (`tunnel_protocol.rs`) over Truffle, a Tailscale-based transport.

**Rust (`native/`)**

- `ghosttead`: the daemon binary. It is configured only by environment (`GHOSTTEA_CONTROL_SOCKET`, `GHOSTTEA_FRAME_SOCKET`, `GHOSTTEA_AUTH_TOKEN`).
- `ghosttea` (`native/ghosttea/src`): the embeddable service.
  - `service.rs`: the protocol and command handling.
  - `session.rs`: the PTY session, with reader, frame-batcher and input-actor threads.
  - `frame_hub.rs`: frame fan-out.
  - `mesh.rs` and `tunnel_protocol.rs`: remote sessions.
- `ghosttea-core`: the platform-neutral terminal model, shared with iOS. It holds the TRF1 encoder (`frame.rs`), view authority (who may resize or type), logical replicas, ordered effects, and human/automation input ordering. It must not depend on PTYs, processes, Tokio networking, sockets, Electron, Truffle, UIKit or Swift.
- `ghosttea-vt` and `ghosttea-vt-sys`: the only crates that touch Ghostty headers.
  - vt-sys links a checksum-verified prebuilt libghostty-vt plus a C shim.
  - It looks for the library in this order: `GHOSTTY_VT_PREFIX`, `GHOSTTEA_GHOSTTY_VT_BUNDLE`, `native/build/ghostty`, then a verified download. `GHOSTTEA_GHOSTTY_VT_OFFLINE=1` forbids the download.
  - Ghostty itself is pinned by `native/ghostty.lock.json` and `native/patches/`.
- `ghosttea-config`: Ghostty configuration compatibility, checked against Ghostty v1.3.1's key schema (`native/ghostty-config.lock.json`). It adds one extension key, `ghosttea-light-adaptation`.
- `ghosttea-truffle`: the mesh adapter. It uses QUIC port 9420 between desktops and the compact Apple-client port 9421. Every crate sharing the host's Truffle node must resolve exactly `truffle-core =0.7.19`.
- `ghosttea-ffi` (C ABI v1, `include/ghosttea.h`) and `ghosttea-font-fixture-ffi`: folded into the single static library `ghosttea-apple-ffi` for iOS.

**TypeScript (`packages/`)**

- `ghosttea-protocol`: control protocol types and guards, the renderer command allowlist, and the TPv3 "routed" transport contract used by VibeField, an external consumer.
- `ghosttea-frame`: the TRF1 decoder.
- `ghosttea`: the renderer MessagePort client.
- `ghosttea-client`: the Node control client for automation.
- `ghosttea-electron`: the daemon supervisor, utility-process bridge and preload.
- `ghosttea-react`: the runtime, worker, renderers, `TerminalSurface` and `/workspace`.
- `ghosttea-native-tabs`: the macOS N-API addon.
- `ghosttead`: the daemon resolver, plus its two platform binary packages.

`ghosttea-react/src/runtime.ts` owns the worker and both transports:

- **ports** (the local daemon through the bridge): the UI thread reads only the TRF1 header, then transfers the buffer to the worker.
- **routed** (TPv3): the worker owns the frame socket.

Rules in the renderer:

- Frames are decoded only in `terminal-render.worker.ts`.
- `renderers/webgpu-renderer.ts` holds its WGSL shaders inline.
- `renderers/light-adaptation.ts` must stay numerically identical to `GhostteaLightAdaptation.swift`.

**Apple (`apple/`)**

- **Two manifests:**
  - The root `Package.swift` is what SwiftPM consumers resolve. Its binary target is a URL plus a checksum.
  - `apple/GhostteaKit/Package.swift` is the local mirror. Its binary target is `Artifacts/ghosttea-apple-native.xcframework`, which is gitignored.
  - `npm run check:swiftpm:manifests` keeps the two identical apart from that.
- **Renderer:** the Metal renderer consumes the same TRF1 frames (`GhostteaFrame/TRF1Decoder.swift`). Shared desktop sessions are rendered on the device from logical snapshots (`GhostteaLogicalReplica`).
- **Apps:** `GhostteaApp` is the iOS app. `GhostteaHarness` hosts the device gates that the `scripts/test-ios-*.mjs` scripts drive.

## Invariants

- **Protocol versions:** every new control-protocol surface gets its own minor version. The constants and compile-time asserts live at the top of `service.rs`, mirrored by `PROTOCOL_MINOR` in `packages/ghosttea-protocol/src/index.ts`. Events are gated by each connection's negotiated minor. READMEs that say "protocol 1.11" mean the version that added config documents, not the current one.
- **TRF1:** stays at version 1. New data goes in new sections that older decoders skip; existing section layouts never change. The latest sections are 12 (link targets) and 13 (style palette).
- **stdout:** the `ghosttea` library never writes to stdout, and a test in `service.rs` enforces it. Hosts print readiness themselves.
- **Blocked writes:** a blocked PTY write must not keep a session alive. The input actor holds only a weak session reference.
- **vt-sys build script:** `ghosttea-vt-sys`'s `build.rs` must route every `rerun-if-changed` through its guard, as checked by `scripts/check-build-script-inputs.mjs`.
- **Renderer permissions:** renderers may send only allowlisted commands. `isRendererClientCommandAllowed` defines the list and `rendererCommandRejection` enforces it in the bridge. Config-document commands stay in Electron main, and the auth token never reaches a renderer.
- **TypeScript strictness:** the build uses `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess`, hence the `...(x === undefined ? {} : { x })` spreads. Unused arguments and caught errors must start with `_`.
- **Package directories:** each `packages/` directory is named after the package it publishes, as checked by `npm run check:workspace-names`.
- **Audits:** `cargo audit` treats warnings as errors (`.cargo/audit.toml`), and CI also runs `npm audit --audit-level=high`. A new advisory can therefore turn `main` red with no code change. Fix it with a lockfile-only bump.
- **iOS inventory:** any `Cargo.lock` change requires regenerating the iOS inventory, which records the lock's hash. Run `npm run update:ios-rust-components`, then `node scripts/check-ios-release-bom.mjs --write`, then `npm run update:ios-release-resources` (see `apple/GhostteaKit/Compatibility/release-hardening.md`).
- **iOS artifact digest:** the iOS native artifact's source digest covers the native crates, the native locks, `Cargo.lock` and the Cargo manifests (`nativeSourceInputs` in `scripts/ghosttea-apple-native-artifact.mjs`).
  - Any change to those turns `audit-published` red until a release re-pins the artifact. On non-release PRs that red is expected.
  - Keep that workflow's `pull_request.paths` in sync with the list.

## Releases

See `PUBLISHING.md`. In outline, on a `release/X.Y.Z` branch:

1. Commit `release: X.Y.Z`. It is a pure version bump across the manifests, `Cargo.lock`, `package-lock.json` and the regenerated iOS inventory, plus a dated `CHANGELOG.md` section.
2. Dispatch `ghosttea-apple-native-artifact.yml` with `publish: true` on that branch.
3. Commit `release: pin X.Y.Z Apple native artifact`.
4. Merge the PR, then push a signed `vX.Y.Z` tag on the merge commit. Auto-merge is enabled for the repository (`gh pr merge --auto --merge`), but it waits only for the required `verify` and `windows` checks, so confirm the iOS and Apple artifact runs before tagging.

`publish-release.yml` then re-validates, publishes the crates and npm packages through OIDC trusted publishing, and creates the GitHub release. `smoke-published.yml` installs what shipped.

- **Keep the environment:** the publish jobs must keep `environment: release`, because npm and crates.io trust that environment. Since 2026-10-24 it has no required reviewer, and only `v*` tags and `release/*` branches can deploy to it.
- **Tag rule:** the "release tags" ruleset lets only admins create, move or delete `v*` tags, so an admin's tag push is the release gate. Automation that needs to push `v*` tags must be added as a bypass actor.
- **Never overwrite:** registry versions are immutable and tags never move. To resume a partial release, push a `vX.Y.Z-retry.N` tag.
- **New crates or packages:** run `npm run check:first-publishes` before tagging a release that adds one. Trusted publishing can't create new crates.
- **Older lines:** patches on an older line (for example 0.10.2) are tagged on their own release branch and never merged back.

## Conventions

- **Commit subjects:** lowercase `type(scope): …`, written as a sentence about behavior, often `<change> — <consequence>`. Types are `feat`, `fix`, `test`, `docs`, `ci`, `chore(deps)` and `release`; `react:` and `TP:` prefixes also appear.
- **Commit bodies:** bullet lists that cite commits, PRs, advisory IDs and what was verified.
- **Branches and PRs:** branch prefixes are `feat/`, `fix/`, `chore/`, `ci/`, `deps/`, `test/` and `release/X.Y.Z`. PRs land as merge commits.
- **CI runs:** don't dispatch `desktop-release-gates.yml` or `ios-release-hardening.yml` by hand on a branch that has a PR. The PR already runs them, and the duplicates compete for macOS runners. Open the PR, as a draft if needed, and cite its runs.
- **Open issues:** there is no roadmap file. Open issues are recorded where they live, such as "Known Windows session cost" in `native/ghosttea/README.md`.
- **Design docs:** `draft/` holds the July 2026 design documents. Use them for background, not as the spec; the code has diverged.
