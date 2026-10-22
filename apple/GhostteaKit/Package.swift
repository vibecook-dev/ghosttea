// swift-tools-version: 6.1

import PackageDescription

// Truffle is consumed from its published repository rather than the sibling
// development checkout, pinned to an exact version rather than a bare revision.
//
// That is not a style preference. SwiftPM forbids a version-resolved package
// from depending on a revision-pinned one, so a `revision:` pin here made
// GhostteaKit itself unconsumable by version:
//
//     package 'ghosttea' is required using a stable-version but 'ghosttea'
//     depends on an unstable-version package 'truffle'
//
// Only `revision:` consumers could resolve, and path dependencies are exempt
// from the rule — which is why `apple/GhostteaApp`, which references this
// package by relative path, never surfaced it.
//
// `exact:` rather than `from:` keeps the lockstep discipline the revision pin
// had: exactly one Truffle across both planes, moved deliberately. Truffle's
// remote carries a plain `v0.7.19` tag on the same commit its release-please
// `truffle-v0.7.19` tag names, so this resolves that exact build through a
// stable requirement.
//
// Keep this equal to `package.version` in
// `Compatibility/truffle-swift.lock.json`, whose `package.revision` records the
// commit that version resolves to; the App Store readiness check compares the
// resolved pin against both and fails closed on drift.
let truffleRepository = "https://github.com/vibecook-dev/truffle.git"
let truffleVersion: Version = "0.7.19"

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
      path: "Artifacts/ghosttea-apple-native.xcframework"
    ),
    .target(
      name: "CGhostteaSSH",
      dependencies: ["GhostteaAppleNative"],
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
      ]
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
      ]
    ),
    .target(
      name: "GhostteaCredentials",
      linkerSettings: [.linkedFramework("Security")]
    ),
    .target(name: "GhostteaDiagnostics"),
    .target(name: "GhostteaPerformance"),
    .target(
      name: "GhostteaConnectionProfiles",
      dependencies: ["GhostteaCredentials", "GhostteaSSH"]
    ),
    .target(
      name: "GhostteaConnectionProfilesUI",
      dependencies: ["GhostteaConnectionProfiles"]
    ),
    .target(
      name: "GhostteaFontProof",
      dependencies: ["GhostteaAppleNative", "GhostteaFonts"],
      exclude: ["Resources"],
      linkerSettings: [
        .linkedFramework("CoreGraphics"),
        .linkedFramework("CoreText"),
        .linkedLibrary("c++"),
      ]
    ),
    .target(
      name: "GhostteaFonts",
      path: "Sources/GhostteaFontProof/Resources",
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
      linkerSettings: [
        .linkedFramework("CoreGraphics"),
        .linkedFramework("CoreText"),
        .linkedLibrary("c++"),
      ]
    ),
    .target(
      name: "GhostteaAppearance",
      dependencies: ["GhostteaCore"],
      resources: [.process("Resources")]
    ),
    .target(name: "GhostteaFrame"),
    .target(
      name: "GhostteaSession",
      dependencies: ["GhostteaCore", "GhostteaPerformance", "GhostteaTransport"]
    ),
    .target(
      name: "GhostteaTerminal",
      dependencies: ["GhostteaCore", "GhostteaFrame", "GhostteaPerformance", "GhostteaTransport"],
      exclude: ["GhostteaTerminal.metal"],
      resources: [.copy("Resources/terminal-visual-golden.json")],
      linkerSettings: [
        .linkedFramework("Metal"),
        .linkedFramework("MetalKit", .when(platforms: [.iOS])),
        .linkedFramework("UIKit", .when(platforms: [.iOS])),
      ],
      plugins: ["GhostteaMetalCompilerPlugin"]
    ),
    .target(name: "GhostteaTransport"),
    .target(
      name: "GhostteaTruffle",
      dependencies: [
        "GhostteaCore",
        "GhostteaPerformance",
        .product(name: "Truffle", package: "truffle"),
        .product(name: "TruffleTailscale", package: "truffle"),
      ]
    ),
    .target(name: "GhostteaWorkspace"),
    .target(
      name: "GhostteaWorkspaceUI",
      dependencies: ["GhostteaWorkspace"]
    ),
    .target(
      name: "GhostteaSSHProbe",
      dependencies: ["GhostteaTransport", "GhostteaAppleNative"]
    ),
    .target(
      name: "GhosttyVtProof",
      dependencies: ["GhostteaAppleNative", "GhostteaWorkspace"]
    ),
    .executableTarget(
      name: "GhostteaSSHLiveProbe",
      dependencies: ["GhostteaSSH", "GhostteaTransport"]
    ),
    .executableTarget(
      name: "GhosttyVtMemoryProbe",
      dependencies: ["GhosttyVtProof"]
    ),
    .executableTarget(
      name: "GhostteaVisualGoldenRecorder",
      dependencies: ["GhostteaCore", "GhostteaTerminal"]
    ),
    .testTarget(
      name: "GhostteaCredentialsTests",
      dependencies: ["GhostteaCredentials"]
    ),
    .testTarget(
      name: "GhostteaDiagnosticsTests",
      dependencies: ["GhostteaDiagnostics"]
    ),
    .testTarget(
      name: "GhostteaPerformanceTests",
      dependencies: ["GhostteaPerformance"]
    ),
    .testTarget(
      name: "GhostteaConnectionProfilesTests",
      dependencies: [
        "GhostteaConnectionProfiles",
        "GhostteaCredentials",
        "GhostteaSSH",
      ]
    ),
    .testTarget(
      name: "GhostteaConnectionProfilesUITests",
      dependencies: ["GhostteaConnectionProfiles", "GhostteaConnectionProfilesUI"]
    ),
    .testTarget(
      name: "GhostteaFontProofTests",
      dependencies: ["GhostteaFontProof"]
    ),
    .testTarget(
      name: "GhostteaCoreTests",
      dependencies: ["GhostteaCore"]
    ),
    .testTarget(
      name: "GhostteaAppearanceTests",
      dependencies: ["GhostteaAppearance"]
    ),
    .testTarget(
      name: "GhostteaFrameTests",
      dependencies: ["GhostteaCore", "GhostteaFrame", "GhostteaTerminal", "GhostteaTransport"]
    ),
    .testTarget(
      name: "GhostteaSSHTests",
      dependencies: [
        "GhostteaCredentials",
        "GhostteaSession",
        "GhostteaSSH",
        "GhostteaTransport",
      ]
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
      ]
    ),
    .testTarget(
      name: "GhostteaSSHProbeTests",
      dependencies: ["GhostteaSSHProbe"]
    ),
    .testTarget(
      name: "GhostteaSessionTests",
      dependencies: ["GhostteaSession", "GhostteaTransport"]
    ),
    .testTarget(
      name: "GhostteaTransportTests",
      dependencies: ["GhostteaTransport"]
    ),
    .testTarget(
      name: "GhostteaTruffleTests",
      dependencies: [
        "GhostteaCore",
        "GhostteaTruffle",
        .product(name: "Truffle", package: "truffle"),
      ],
      resources: [.copy("Fixtures")]
    ),
    .testTarget(
      name: "GhostteaWorkspaceTests",
      dependencies: ["GhostteaWorkspace"],
      resources: [.copy("Fixtures")]
    ),
    .testTarget(
      name: "GhostteaWorkspaceUITests",
      dependencies: ["GhostteaWorkspace", "GhostteaWorkspaceUI"]
    ),
    .testTarget(
      name: "GhosttyVtProofTests",
      dependencies: ["GhosttyVtProof"],
      resources: [.copy("Fixtures")]
    ),
    .plugin(
      name: "GhostteaMetalCompilerPlugin",
      capability: .buildTool()
    ),
  ]
)
