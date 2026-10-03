import Foundation
import GhostteaCore
import Testing

@testable import GhostteaAppearance

@Test func bundledThemeCatalogIsPinnedAndComplete() {
  #expect(GhostteaThemeCatalog.themes.count == 602)
  #expect(GhostteaThemeCatalog.revision == "875a82f0fdc773ae45099ce683a11c56bb0f8b3d")
  #expect(GhostteaThemeCatalog.themes.first?.name == "0x96f")
  #expect(GhostteaThemeCatalog.themes.allSatisfy { $0.palette.count == 16 })
  #expect(Set(GhostteaThemeCatalog.themes.map(\.name)).count == 602)
  #expect(
    GhostteaThemeCatalog.themes.allSatisfy { theme in
      ([
        theme.background, theme.foreground, theme.cursor, theme.cursorText, theme.selection,
        theme.selectionForeground,
      ] + theme.palette).allSatisfy {
        $0.range(of: "^#[0-9a-f]{6}$", options: .regularExpression) != nil
      }
    })
  #expect(GhostteaShaderOption.available.count == 4)
  #expect(GhostteaShaderOption.unavailableUpstreamNames.count == 32)
  #expect(
    Set(
      GhostteaShaderOption.available.map(\.name)
        + GhostteaShaderOption.unavailableUpstreamNames
    ).count == 36)
}

@Test func appearancePatchStaysLastAndPreservesRawText() throws {
  let original = "# user comment\r\nfont-size = 15\r\n"
  let selection = GhostteaAppearanceSelection(
    theme: GhostteaThemeCatalog.themes[1],
    backgroundOpacity: 0.73,
    backgroundOpacityCells: true,
    shaderEffects: ["ghosttea:crt", "ghosttea:vhs"],
    shaderAnimation: true
  )
  let patched = try GhostteaConfigurationDraft.patchAppearance(
    in: original,
    selection: selection
  )
  #expect(patched.hasPrefix(original + "\r\n"))
  #expect(patched.contains("background-opacity = 0.73\r\n"))
  #expect(
    patched.components(separatedBy: "background-opacity-cells = true").count - 1 == 1)
  #expect(
    patched.range(of: "custom-shader = ghosttea:crt")!.lowerBound
      < patched.range(of: "custom-shader = ghosttea:vhs")!.lowerBound)
  #expect(!patched.replacingOccurrences(of: "\r\n", with: "").contains("\n"))
}

@Test func appearanceBlockWritesReadabilitySettingsLikeTheDesktop() throws {
  let defaults = try GhostteaConfigurationDraft.appearanceBlock(GhostteaAppearanceSelection())
  #expect(defaults.contains("\nghosttea-light-adaptation = auto\n"))
  #expect(defaults.contains("\nminimum-contrast = 1\n"))
  #expect(
    defaults.hasSuffix(
      "minimum-contrast = 1\n" + GhostteaConfigurationDraft.appearanceBlockEnd))

  for (ratio, written) in [(3.0, "3"), (4.5, "4.5"), (7.0, "7"), (2.25, "2.25")] {
    let block = try GhostteaConfigurationDraft.appearanceBlock(
      GhostteaAppearanceSelection(lightAdaptation: .off, minimumContrast: ratio))
    #expect(block.contains("\nghosttea-light-adaptation = off\n"))
    #expect(block.contains("\nminimum-contrast = \(written)\n"))
  }
  #expect(GhostteaAppearanceSelection.minimumContrastChoices == [1, 3, 4.5, 7])

  for invalid in [0.5, 22, .nan, .infinity] {
    #expect(throws: GhostteaConfigDraftError.invalidTheme) {
      try GhostteaConfigurationDraft.appearanceBlock(
        GhostteaAppearanceSelection(minimumContrast: invalid))
    }
  }
}

@Test func appearanceSelectionDefaultsReadabilityForConfigsWithoutIt() throws {
  let selection = GhostteaAppearanceSelection(config: try testConfiguration())
  #expect(selection.lightAdaptation == .auto)
  #expect(selection.minimumContrast == 1)
}

@Test func appearancePatchRejectsAmbiguousManagedMarkers() {
  #expect(throws: GhostteaConfigDraftError.self) {
    try GhostteaConfigurationDraft.patchAppearance(
      in: GhostteaConfigurationDraft.appearanceBlockStart + "\n",
      selection: GhostteaAppearanceSelection()
    )
  }
}

@Test func rawTextEditPreservesUntouchedMixedNewlines() {
  let previous = "one\r\ntwo\nthree\r\nfour"
  let edited = "one\ntwo changed\nthree\nfour"
  #expect(
    GhostteaConfigurationDraft.applyTextEdit(previous: previous, edited: edited)
      == "one\r\ntwo changed\nthree\r\nfour")
}

@Test func appendingToCRLFDocumentUsesExactlyOneBlankLine() {
  #expect(
    GhostteaConfigurationDraft.appendDocument("font-size = 14\n", to: "# existing\r\n")
      == "# existing\r\n\r\nfont-size = 14\n")
  #expect(
    GhostteaConfigurationDraft.appendDocument("font-size = 14\n", to: "# existing\r\n\r\n")
      == "# existing\r\n\r\nfont-size = 14\n")
}

@Test func friendlySectionsRoundTripAndMostRecentManagedEditorWins() throws {
  let values = GhostteaFriendlyConfigValues(config: try testConfiguration())
  let original = """
    # >>> Ghosttea common settings (managed; edit through Settings)
    background-opacity = 0.50
    font-size = 13
    # <<< Ghosttea common settings

    # >>> Ghosttea appearance (managed; edit through Settings)
    background-opacity = 0.80
    # <<< Ghosttea appearance
    """

  #expect(GhostteaConfigurationDraft.friendlySections(in: original) == [.opacity, .typography])
  let patched = try GhostteaConfigurationDraft.patchFriendly(
    in: original,
    values: values,
    sections: [.colors])
  #expect(GhostteaConfigurationDraft.friendlySections(in: patched) == [.colors])
  #expect(
    patched.range(of: GhostteaConfigurationDraft.friendlyBlockStart)!.lowerBound
      > patched.range(of: GhostteaConfigurationDraft.appearanceBlockStart)!.lowerBound)
}

@Test func malformedFriendlyMarkersDoNotClaimManagedSections() {
  let malformed = GhostteaConfigurationDraft.friendlyBlockStart + "\nfont-size = 16\n"
  #expect(GhostteaConfigurationDraft.friendlySections(in: malformed).isEmpty)
}

@Test func portableImportRejectsConfigurationsWithErrorDiagnostics() throws {
  let directory = FileManager.default.temporaryDirectory
    .appendingPathComponent("ghosttea-invalid-import-\(UUID().uuidString)", isDirectory: true)
  try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
  defer { try? FileManager.default.removeItem(at: directory) }
  let configURL = directory.appendingPathComponent("config.ghostty")
  try "background = definitely-not-a-color\n".write(
    to: configURL,
    atomically: true,
    encoding: .utf8)
  let configuration = try GhostteaConfiguration.load(
    overlayURL: configURL,
    loadGhosttyFiles: false)
  #expect(configuration.hasErrors)

  #expect(throws: GhostteaConfigDraftError.self) {
    try GhostteaConfigurationDraft.portableConfig(from: configuration)
  }
}

private func testConfiguration() throws -> GhostteaConfigSnapshot {
  let directory = FileManager.default.temporaryDirectory
    .appendingPathComponent("ghosttea-appearance-test-\(UUID().uuidString)", isDirectory: true)
  try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
  defer { try? FileManager.default.removeItem(at: directory) }
  return try GhostteaConfiguration.load(
    overlayURL: directory.appendingPathComponent("config.ghostty"),
    loadGhosttyFiles: false)
}
