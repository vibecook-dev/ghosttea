import Foundation
import Testing

@testable import GhostteaCore

@Test func ghosttyConfigurationLoadsThroughTheSharedNativeSchema() throws {
  let directory = FileManager.default.temporaryDirectory
    .appendingPathComponent("ghosttea-config-\(UUID().uuidString)", isDirectory: true)
  try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
  defer { try? FileManager.default.removeItem(at: directory) }
  let configURL = directory.appendingPathComponent("config.ghostty")
  try """
  background = 102030
  foreground = fefefe
  scrollback-limit = 123456
  custom-shader = ghosttea:better-crt
  custom-shader = private.glsl
  keybind = super+shift+x=new_tab
  """.write(to: configURL, atomically: true, encoding: .utf8)

  let snapshot = try GhostteaConfiguration.load(
    overlayURL: configURL,
    loadGhosttyFiles: false
  )

  #expect(snapshot.schemaVersion == 1)
  #expect(snapshot.compatibility.ghosttyVersion == "1.3.1")
  #expect(snapshot.terminal.background == [0x10, 0x20, 0x30])
  #expect(snapshot.terminal.scrollbackBytes == 123_456)
  #expect(snapshot.renderer.postProcess == .betterCRT)
  #expect(
    snapshot.workspace.keybindings == [
      GhostteaConfigKeybinding(trigger: "super+shift+x", action: "new_tab")
    ])
  #expect(!snapshot.hasErrors)

  let presentation = snapshot.terminalPresentation
  let presentationJSON = String(
    decoding: try JSONEncoder().encode(presentation),
    as: UTF8.self
  )
  #expect(presentation.isValid)
  #expect(presentation.background == [0x10, 0x20, 0x30])
  #expect(presentation.customShaderCount == 1)
  #expect(!presentationJSON.contains(configURL.path))
  #expect(!presentationJSON.contains("private.glsl"))
  #expect(!presentationJSON.contains("customShaderPaths"))
  #expect(!presentationJSON.contains("keybindings"))
}

@Test func terminalConfigurationUsesGhosttyScrollbackDefault() {
  let config = GhostteaTerminalConfiguration(sessionHandle: 42)
  #expect(config.scrollbackBytes == 10_000_000)
}

@Test func presentationMetricsFallBackWhenScalingWouldOverflow() {
  let presentation = GhostteaTerminalPresentationConfig(
    schemaVersion: 1,
    revision: "huge-font",
    foreground: [255, 255, 255],
    background: [0, 0, 0],
    cursor: [255, 255, 255],
    selectionBackground: [255, 255, 255],
    selectionForeground: [0, 0, 0],
    fontSize: Float.greatestFiniteMagnitude,
    fontFamilies: [],
    paddingX: [2, 2],
    paddingY: [2, 2],
    postProcess: .none,
    customShaderCount: 0
  )
  let base = GhostteaTextMetrics()
  let metrics = GhostteaTextMetrics(presentation: presentation, base: base)
  #expect(metrics.fontSizePixels == base.fontSizePixels)
  #expect(metrics.cellWidthPixels == base.cellWidthPixels)
  #expect(metrics.lineHeightPixels == base.lineHeightPixels)
}

@Test func presentationDecodingDefaultsNewAppearanceFieldsForOlderPeers() throws {
  let current = GhostteaTerminalPresentationConfig(
    schemaVersion: 1,
    revision: "legacy-peer",
    foreground: [1, 2, 3],
    background: [4, 5, 6],
    cursor: [7, 8, 9],
    cursorText: [10, 11, 12],
    selectionBackground: [13, 14, 15],
    selectionForeground: [16, 17, 18],
    palette: [GhostteaPaletteConfigEntry(index: 2, color: [19, 20, 21])],
    backgroundOpacity: 0.5,
    backgroundOpacityCells: true,
    minimumContrast: 4.5,
    lightAdaptation: .off,
    fontSize: 13,
    fontFamilies: [],
    paddingX: [2, 2],
    paddingY: [2, 2],
    postProcess: .none,
    shaderEffects: [GhostteaShaderEffect.vhs.rawValue],
    customShaderAnimation: true,
    customShaderCount: 0)
  var object = try #require(
    JSONSerialization.jsonObject(with: JSONEncoder().encode(current)) as? [String: Any])
  for key in [
    "cursorText", "palette", "backgroundOpacity", "backgroundOpacityCells", "shaderEffects",
    "customShaderAnimation", "minimumContrast", "lightAdaptation",
  ] {
    object[key] = nil
  }

  let decoded = try JSONDecoder().decode(
    GhostteaTerminalPresentationConfig.self,
    from: JSONSerialization.data(withJSONObject: object))
  #expect(decoded.cursorText == decoded.background)
  #expect(decoded.palette.isEmpty)
  #expect(decoded.backgroundOpacity == 1)
  #expect(!decoded.backgroundOpacityCells)
  #expect(decoded.shaderEffects.isEmpty)
  #expect(!decoded.customShaderAnimation)
  #expect(decoded.minimumContrast == 1)
  #expect(decoded.lightAdaptation == .auto)
  #expect(decoded.isValid)
}

@Test func presentationRoundTripsReadabilitySettingsWithTheDesktopSpelling() throws {
  let presentation = GhostteaTerminalPresentationConfig(
    schemaVersion: 1,
    revision: "readability",
    foreground: [1, 2, 3],
    background: [4, 5, 6],
    cursor: [7, 8, 9],
    selectionBackground: [13, 14, 15],
    selectionForeground: [16, 17, 18],
    minimumContrast: 4.5,
    lightAdaptation: .off,
    fontSize: 13,
    fontFamilies: [],
    paddingX: [2, 2],
    paddingY: [2, 2],
    postProcess: .none,
    customShaderCount: 0)
  let object = try #require(
    JSONSerialization.jsonObject(with: JSONEncoder().encode(presentation)) as? [String: Any])
  #expect(object["minimumContrast"] as? Double == 4.5)
  #expect(object["lightAdaptation"] as? String == "off")
  let decoded = try JSONDecoder().decode(
    GhostteaTerminalPresentationConfig.self,
    from: JSONSerialization.data(withJSONObject: object))
  #expect(decoded == presentation)
  #expect(
    throws: DecodingError.self,
    "Unknown modes are rejected like the Rust enum"
  ) {
    var invalid = object
    invalid["lightAdaptation"] = "sometimes"
    _ = try JSONDecoder().decode(
      GhostteaTerminalPresentationConfig.self,
      from: JSONSerialization.data(withJSONObject: invalid))
  }
}

@Test func configurationStoreValidatesSavesAndRejectsStaleRevisions() throws {
  let directory = FileManager.default.temporaryDirectory
    .appendingPathComponent("ghosttea-config-store-\(UUID().uuidString)", isDirectory: true)
  try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
  defer { try? FileManager.default.removeItem(at: directory) }
  let configURL = directory.appendingPathComponent("config.ghostty")
  let store = try GhostteaConfigurationStore(overlayURL: configURL, loadGhosttyFiles: false)
  let original = try store.document()
  #expect(!original.exists)

  let candidate = """
    foreground = 112233
    background = 445566
    cursor-color = 778899
    cursor-text = aabbcc
    palette = 2=abcdef
    background-opacity = 0.42
    background-opacity-cells = true
    custom-shader = ghosttea:vhs
    custom-shader-animation = true
    """
  let validation = try store.validate(contents: candidate)
  #expect(!configURL.fileExists)
  #expect(validation.documentRevision != original.revision)
  #expect(validation.config.renderer.cursorText == [0xaa, 0xbb, 0xcc])
  #expect(
    validation.config.renderer.palette == [
      GhostteaPaletteConfigEntry(index: 2, color: [0xab, 0xcd, 0xef])
    ])
  #expect(validation.config.renderer.backgroundOpacity == 0.42)
  #expect(validation.config.renderer.backgroundOpacityCells)
  #expect(validation.config.renderer.shaderEffects == [GhostteaShaderEffect.vhs.rawValue])
  #expect(validation.config.renderer.customShaderAnimation)

  let saved: GhostteaConfigDocumentUpdate
  switch try store.replace(expectedRevision: original.revision, contents: candidate) {
  case .saved(let update):
    saved = update
  case .conflict:
    Issue.record("a new overlay unexpectedly conflicted")
    return
  }
  #expect(saved.document.exists)
  #expect(saved.document.contents == candidate)
  #expect(try String(contentsOf: configURL, encoding: .utf8) == candidate)

  try "font-size = 19\n".write(to: configURL, atomically: true, encoding: .utf8)
  switch try store.replace(
    expectedRevision: saved.document.revision,
    contents: "font-size = 20\n"
  ) {
  case .saved:
    Issue.record("a stale document revision overwrote an external edit")
  case .conflict(let current):
    #expect(current.contents == "font-size = 19\n")
  }
}

@Test func configurationStoreReloadsAStableDocumentAndEffectiveSnapshotTogether() throws {
  let directory = FileManager.default.temporaryDirectory
    .appendingPathComponent("ghosttea-config-reload-\(UUID().uuidString)", isDirectory: true)
  try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
  defer { try? FileManager.default.removeItem(at: directory) }
  let configURL = directory.appendingPathComponent("config.ghostty")
  let store = try GhostteaConfigurationStore(overlayURL: configURL, loadGhosttyFiles: false)
  let initial = try store.snapshot()

  let external = "foreground = 123456\nfont-size = 18\n"
  try external.write(to: configURL, atomically: true, encoding: .utf8)
  let loaded = try store.reloadDocument()
  #expect(loaded.document.exists)
  #expect(loaded.document.contents == external)
  #expect(loaded.config.revision != initial.revision)
  #expect(try store.snapshot() == loaded.config)
  #expect(loaded.config.renderer.foreground == [0x12, 0x34, 0x56])
  #expect(loaded.config.renderer.fontSize == 18)

  try FileManager.default.removeItem(at: configURL)
  let removed = try store.reloadDocument()
  #expect(!removed.document.exists)
  #expect(removed.document.contents.isEmpty)
  #expect(try store.snapshot() == removed.config)
  #expect(removed.config.renderer.foreground == [0xff, 0xff, 0xff])
}

@Test func configurationBuildsRuntimeMetricsAndAppliesTerminalColors() async throws {
  let directory = FileManager.default.temporaryDirectory
    .appendingPathComponent("ghosttea-runtime-config-\(UUID().uuidString)", isDirectory: true)
  try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
  defer { try? FileManager.default.removeItem(at: directory) }
  let configURL = directory.appendingPathComponent("config.ghostty")
  try """
  font-size = 26
  foreground = 112233
  background = 445566
  cursor-color = 778899
  scrollback-limit = 654321
  """.write(to: configURL, atomically: true, encoding: .utf8)

  let snapshot = try GhostteaConfiguration.load(
    overlayURL: configURL,
    loadGhosttyFiles: false
  )
  let metrics = GhostteaTextMetrics(config: snapshot)
  #expect(metrics.fontSizePixels == 26)
  #expect(abs(metrics.cellWidthPixels - 15.66) < 0.001)
  #expect(metrics.lineHeightPixels == 38)
  #expect(metrics.baselinePixels == 28)
  #expect(metrics.rasterScale == 2)

  let terminalConfiguration = GhostteaTerminalConfiguration(
    sessionHandle: 43,
    config: snapshot
  )
  #expect(terminalConfiguration.scrollbackBytes == 654_321)
  let terminal = try GhostteaTerminal(
    runtime: GhostteaRuntime(config: snapshot),
    configuration: terminalConfiguration
  )
  _ = try await terminal.apply(config: snapshot, render: .none)
  let update = try await terminal.feed(
    Data("\u{1b}]10;?\u{1b}\\\u{1b}]11;?\u{1b}\\\u{1b}]12;?\u{1b}\\".utf8),
    render: .none
  )
  let response = update.effects
    .filter { $0.kind == .writeToTransport }
    .reduce(into: Data()) { $0.append($1.payload) }
  let responseText = String(decoding: response, as: UTF8.self)
  #expect(responseText.contains("]10;rgb:1111/2222/3333"))
  #expect(responseText.contains("]11;rgb:4444/5555/6666"))
  #expect(responseText.contains("]12;rgb:7777/8888/9999"))
}

extension URL {
  fileprivate var fileExists: Bool { FileManager.default.fileExists(atPath: path) }
}
