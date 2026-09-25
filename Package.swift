// swift-tools-version: 6.1
// GhostteaKit — the Apple-side terminal package.
//
// This manifest lives at the repository root because SwiftPM resolves a URL
// dependency only against a root manifest: `.package(url:)` cannot point at a
// subdirectory, and the sources live under `apple/GhostteaKit/`. Every target
// names its path explicitly so nothing else in this Rust/TypeScript monorepo is
// scanned.
//
// `apple/GhostteaKit/Package.swift` is deliberately kept alongside this one and
// is NOT a compatibility shim to be deleted. The two manifests differ in exactly
// one place — how the native artifact is sourced — and both are load-bearing:
//
//   this manifest                    apple/GhostteaKit/Package.swift
//   .binaryTarget(url:checksum:)     .binaryTarget(path: "Artifacts/…")
//   consumers, over the network      Apple development, against a fresh build
//
// Local work must not have to publish an artifact before it can compile one, and
// `apple/GhostteaApp` references the package by relative path for that reason.
// Everything else is a mirror; `npm run check:apple-native-artifact` compares the
// two dumped package graphs and fails on any other divergence.
//
// ## Dependency identity is `ghosttea`, not `GhostteaKit`
//
// SwiftPM derives identity from the last path component of the URL, so consumers
// write the repository name, not this manifest's `name:`
//
//     .package(url: "https://github.com/vibecook-dev/ghosttea.git", from: "0.6.1")
//     .product(name: "GhostteaTerminal", package: "ghosttea")
//
// ## The native artifact is content-addressed
//
// `.binaryTarget(url:checksum:)` requires a checksum that is already valid at the
// commit SwiftPM resolves, but release assets are built *after* their release
// commit — so an artifact keyed to a ghosttea version could never carry a valid
// checksum at its own tag. It is published once under a tag naming its content
// digest and referenced by a stable URL, so every later ghosttea tag points at
// bytes that already exist. Only a change to the native sources moves it.
//
// Keep these two values equal to `url` and `checksum` in
// `apple/GhostteaKit/Compatibility/apple-native-artifact.lock.json`;
// `npm run check:apple-native-artifact` compares them and fails closed on drift.

import PackageDescription

let appleNativeURL =
    "https://github.com/vibecook-dev/ghosttea/releases/download/ghosttea-apple-native-a5fa7ef2afc2/GhostteaAppleNative.xcframework.zip"
let appleNativeChecksum = "47549097453eb441c7e1b6e08dfedae28160012cca46ced89495c0b78183f8a0"

// Truffle is consumed from its published repository, pinned to an exact version
// rather than a bare revision.
//
// That is load-bearing for this manifest's whole purpose. SwiftPM forbids a
// version-resolved package from depending on a revision-pinned one, so while
// this pin was a `revision:`, every `from:`/`exact:` consumer of ghosttea —
// including the usage example above — failed to resolve with:
//
//     package 'ghosttea' is required using a stable-version but 'ghosttea'
//     depends on an unstable-version package 'truffle'
//
// Only `revision:` consumers worked. Path dependencies are exempt from the
// rule, which is why `apple/GhostteaApp` never surfaced it, and resolving this
// repository *as the root package* does not surface it either — the rule
// applies to a package being consumed by version, not to the root.
//
// `exact:` rather than `from:` keeps the lockstep discipline the revision pin
// had: exactly one Truffle across both planes, moved deliberately. Truffle's
// remote carries a plain `v0.7.12` tag on the same commit its release-please
// `truffle-v0.7.12` tag names, so this resolves that exact build through a
// stable requirement.
//
// Keep this equal to `package.version` in
// `apple/GhostteaKit/Compatibility/truffle-swift.lock.json`, whose
// `package.revision` records the commit that version resolves to; the App Store
// readiness check compares the resolved pin against both and fails closed.
let truffleRepository = "https://github.com/vibecook-dev/truffle.git"
let truffleVersion: Version = "0.7.12"

let sources = "apple/GhostteaKit/Sources"
let tests = "apple/GhostteaKit/Tests"
let plugins = "apple/GhostteaKit/Plugins"

let package = Package(
  name: "GhostteaKit",
  platforms: [
    .iOS("18.1"),
    .macOS(.v14),
  ],
  products: [
    .library(name: "GhostteaCredentials", targets: ["GhostteaCredentials"]),
    .library(name: "GhostteaDiagnostics", targets: ["GhostteaDiagnostics"]),
    .library(name: "GhostteaConnectionProfiles", targets: ["GhostteaConnectionProfiles"]),
    .library(name: "GhostteaConnectionProfilesUI", targets: ["GhostteaConnectionProfilesUI"]),
    .library(name: "GhostteaCore", targets: ["GhostteaCore"]),
    .library(name: "GhostteaAppearance", targets: ["GhostteaAppearance"]),
    .library(name: "GhostteaFontProof", targets: ["GhostteaFontProof"]),
    .library(name: "GhostteaPerformance", targets: ["GhostteaPerformance"]),
    .library(name: "GhostteaTerminal", targets: ["GhostteaTerminal"]),
    .library(name: "GhostteaSSH", targets: ["GhostteaSSH"]),
    .library(name: "GhostteaSSHWorkspace", targets: ["GhostteaSSHWorkspace"]),
    .library(name: "GhostteaSSHProbe", targets: ["GhostteaSSHProbe"]),
    .library(name: "GhostteaSession", targets: ["GhostteaSession"]),
    .library(name: "GhostteaTransport", targets: ["GhostteaTransport"]),
    .library(name: "GhostteaTruffle", targets: ["GhostteaTruffle"]),
    .library(name: "GhostteaWorkspace", targets: ["GhostteaWorkspace"]),
    .library(name: "GhostteaWorkspaceUI", targets: ["GhostteaWorkspaceUI"]),
    .library(name: "GhosttyVtProof", targets: ["GhosttyVtProof"]),
    .executable(name: "GhosttyVtMemoryProbe", targets: ["GhosttyVtMemoryProbe"]),
  ],
  dependencies: [
    .package(url: truffleRepository, exact: truffleVersion)
  ],
  targets: [
    .binaryTarget(
      name: "GhostteaAppleNative",
      url: appleNativeURL,
      checksum: appleNativeChecksum
    ),
    .target(
      name: "CGhostteaSSH",
      dependencies: ["GhostteaAppleNative"],
      path: "\(sources)/CGhostteaSSH",
      publicHeadersPath: "include"
    ),
    .target(
      name: "GhostteaSSH",
      dependencies: [
        "CGhostteaSSH",
        "GhostteaCore",
        "GhostteaCredentials",
        "GhostteaSession",
        "GhostteaTransport",
      ],
      path: "\(sources)/GhostteaSSH"
    ),
    .target(
      name: "GhostteaSSHWorkspace",
      dependencies: [
        "GhostteaConnectionProfiles",
        "GhostteaCore",
        "GhostteaCredentials",
        "GhostteaSession",
        "GhostteaSSH",
        "GhostteaWorkspace",
      ],
      path: "\(sources)/GhostteaSSHWorkspace"
    ),
    .target(
      name: "GhostteaCredentials",
      path: "\(sources)/GhostteaCredentials",
      linkerSettings: [.linkedFramework("Security")]
    ),
    .target(name: "GhostteaDiagnostics", path: "\(sources)/GhostteaDiagnostics"),
    .target(name: "GhostteaPerformance", path: "\(sources)/GhostteaPerformance"),
    .target(
      name: "GhostteaConnectionProfiles",
      dependencies: ["GhostteaCredentials", "GhostteaSSH"],
      path: "\(sources)/GhostteaConnectionProfiles"
    ),
    .target(
      name: "GhostteaConnectionProfilesUI",
      dependencies: ["GhostteaConnectionProfiles"],
      path: "\(sources)/GhostteaConnectionProfilesUI"
    ),
    .target(
      name: "GhostteaFontProof",
      dependencies: ["GhostteaAppleNative", "GhostteaFonts"],
      path: "\(sources)/GhostteaFontProof",
      exclude: ["Resources"],
      linkerSettings: [
        .linkedFramework("CoreGraphics"),
        .linkedFramework("CoreText"),
        .linkedLibrary("c++"),
      ]
    ),
    .target(
      name: "GhostteaFonts",
      path: "\(sources)/GhostteaFontProof/Resources",
      resources: [
        .process("Fonts"),
        .copy("FONT-NOTICES.md"),
        .copy("OFL-1.1.txt"),
        .copy("font-parity.json"),
      ]
    ),
    .target(
      name: "GhostteaCore",
      dependencies: ["GhostteaAppleNative", "GhostteaFonts", "GhostteaPerformance"],
      path: "\(sources)/GhostteaCore",
      linkerSettings: [
        .linkedFramework("CoreGraphics"),
        .linkedFramework("CoreText"),
        .linkedLibrary("c++"),
      ]
    ),
    .target(
      name: "GhostteaAppearance",
      dependencies: ["GhostteaCore"],
      path: "\(sources)/GhostteaAppearance",
      resources: [.process("Resources")]
    ),
    .target(name: "GhostteaFrame", path: "\(sources)/GhostteaFrame"),
    .target(
      name: "GhostteaSession",
      dependencies: ["GhostteaCore", "GhostteaPerformance", "GhostteaTransport"],
      path: "\(sources)/GhostteaSession"
    ),
    .target(
      name: "GhostteaTerminal",
      dependencies: ["GhostteaCore", "GhostteaFrame", "GhostteaPerformance", "GhostteaTransport"],
      path: "\(sources)/GhostteaTerminal",
      exclude: ["GhostteaTerminal.metal"],
      resources: [.copy("Resources/terminal-visual-golden.json")],
      linkerSettings: [
        .linkedFramework("Metal"),
        .linkedFramework("MetalKit", .when(platforms: [.iOS])),
        .linkedFramework("UIKit", .when(platforms: [.iOS])),
      ],
      plugins: ["GhostteaMetalCompilerPlugin"]
    ),
    .target(name: "GhostteaTransport", path: "\(sources)/GhostteaTransport"),
    .target(
      name: "GhostteaTruffle",
      dependencies: [
        "GhostteaCore",
        "GhostteaPerformance",
        .product(name: "Truffle", package: "truffle"),
        .product(name: "TruffleTailscale", package: "truffle"),
      ],
      path: "\(sources)/GhostteaTruffle"
    ),
    .target(name: "GhostteaWorkspace", path: "\(sources)/GhostteaWorkspace"),
    .target(
      name: "GhostteaWorkspaceUI",
      dependencies: ["GhostteaWorkspace"],
      path: "\(sources)/GhostteaWorkspaceUI"
    ),
    .target(
      name: "GhostteaSSHProbe",
      dependencies: ["GhostteaTransport", "GhostteaAppleNative"],
      path: "\(sources)/GhostteaSSHProbe"
    ),
    .target(
      name: "GhosttyVtProof",
      dependencies: ["GhostteaAppleNative", "GhostteaWorkspace"],
      path: "\(sources)/GhosttyVtProof"
    ),
    .executableTarget(
      name: "GhostteaSSHLiveProbe",
      dependencies: ["GhostteaSSH", "GhostteaTransport"],
      path: "\(sources)/GhostteaSSHLiveProbe"
    ),
    .executableTarget(
      name: "GhosttyVtMemoryProbe",
      dependencies: ["GhosttyVtProof"],
      path: "\(sources)/GhosttyVtMemoryProbe"
    ),
    .executableTarget(
      name: "GhostteaVisualGoldenRecorder",
      dependencies: ["GhostteaCore", "GhostteaTerminal"],
      path: "\(sources)/GhostteaVisualGoldenRecorder"
    ),
    .testTarget(
      name: "GhostteaCredentialsTests",
      dependencies: ["GhostteaCredentials"],
      path: "\(tests)/GhostteaCredentialsTests"
    ),
    .testTarget(
      name: "GhostteaDiagnosticsTests",
      dependencies: ["GhostteaDiagnostics"],
      path: "\(tests)/GhostteaDiagnosticsTests"
    ),
    .testTarget(
      name: "GhostteaPerformanceTests",
      dependencies: ["GhostteaPerformance"],
      path: "\(tests)/GhostteaPerformanceTests"
    ),
    .testTarget(
      name: "GhostteaConnectionProfilesTests",
      dependencies: [
        "GhostteaConnectionProfiles",
        "GhostteaCredentials",
        "GhostteaSSH",
      ],
      path: "\(tests)/GhostteaConnectionProfilesTests"
    ),
    .testTarget(
      name: "GhostteaConnectionProfilesUITests",
      dependencies: ["GhostteaConnectionProfiles", "GhostteaConnectionProfilesUI"],
      path: "\(tests)/GhostteaConnectionProfilesUITests"
    ),
    .testTarget(
      name: "GhostteaFontProofTests",
      dependencies: ["GhostteaFontProof"],
      path: "\(tests)/GhostteaFontProofTests"
    ),
    .testTarget(
      name: "GhostteaCoreTests",
      dependencies: ["GhostteaCore"],
      path: "\(tests)/GhostteaCoreTests"
    ),
    .testTarget(
      name: "GhostteaAppearanceTests",
      dependencies: ["GhostteaAppearance"],
      path: "\(tests)/GhostteaAppearanceTests"
    ),
    .testTarget(
      name: "GhostteaFrameTests",
      dependencies: ["GhostteaCore", "GhostteaFrame", "GhostteaTerminal", "GhostteaTransport"],
      path: "\(tests)/GhostteaFrameTests"
    ),
    .testTarget(
      name: "GhostteaSSHTests",
      dependencies: [
        "GhostteaCredentials",
        "GhostteaSession",
        "GhostteaSSH",
        "GhostteaTransport",
      ],
      path: "\(tests)/GhostteaSSHTests"
    ),
    .testTarget(
      name: "GhostteaSSHWorkspaceTests",
      dependencies: [
        "GhostteaConnectionProfiles",
        "GhostteaCore",
        "GhostteaCredentials",
        "GhostteaSession",
        "GhostteaSSH",
        "GhostteaSSHWorkspace",
        "GhostteaTransport",
        "GhostteaWorkspace",
      ],
      path: "\(tests)/GhostteaSSHWorkspaceTests"
    ),
    .testTarget(
      name: "GhostteaSSHProbeTests",
      dependencies: ["GhostteaSSHProbe"],
      path: "\(tests)/GhostteaSSHProbeTests"
    ),
    .testTarget(
      name: "GhostteaSessionTests",
      dependencies: ["GhostteaSession", "GhostteaTransport"],
      path: "\(tests)/GhostteaSessionTests"
    ),
    .testTarget(
      name: "GhostteaTransportTests",
      dependencies: ["GhostteaTransport"],
      path: "\(tests)/GhostteaTransportTests"
    ),
    .testTarget(
      name: "GhostteaTruffleTests",
      dependencies: [
        "GhostteaCore",
        "GhostteaTruffle",
        .product(name: "Truffle", package: "truffle"),
      ],
      path: "\(tests)/GhostteaTruffleTests",
      resources: [.copy("Fixtures")]
    ),
    .testTarget(
      name: "GhostteaWorkspaceTests",
      dependencies: ["GhostteaWorkspace"],
      path: "\(tests)/GhostteaWorkspaceTests",
      resources: [.copy("Fixtures")]
    ),
    .testTarget(
      name: "GhostteaWorkspaceUITests",
      dependencies: ["GhostteaWorkspace", "GhostteaWorkspaceUI"],
      path: "\(tests)/GhostteaWorkspaceUITests"
    ),
    .testTarget(
      name: "GhosttyVtProofTests",
      dependencies: ["GhosttyVtProof"],
      path: "\(tests)/GhosttyVtProofTests",
      resources: [.copy("Fixtures")]
    ),
    .plugin(
      name: "GhostteaMetalCompilerPlugin",
      capability: .buildTool(),
      path: "\(plugins)/GhostteaMetalCompilerPlugin"
    ),
  ]
)
