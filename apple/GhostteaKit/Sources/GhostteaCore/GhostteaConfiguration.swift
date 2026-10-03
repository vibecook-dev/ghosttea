import Foundation
import GhostteaCoreNative

public enum GhostteaConfigDiagnosticSeverity: String, Codable, Sendable {
  case info
  case warning
  case error
}

public enum GhostteaConfigSupport: String, Codable, Sendable {
  case applied
  case parsed
  case unsupported
}

public enum GhostteaConfigSourceKind: String, Codable, Sendable {
  case ghosttyDefault = "ghostty-default"
  case included
  case ghostteaOverlay = "ghosttea-overlay"
}

public enum GhostteaRendererPostProcess: String, Codable, Sendable {
  case none
  case betterCRT = "better-crt"
}

/// Whether a light theme may restyle applications that paint their own dark
/// backgrounds (`ghosttea-light-adaptation`).
public enum GhostteaLightAdaptation: String, Codable, Sendable {
  case auto
  case off
}

public enum GhostteaShaderEffect: String, CaseIterable, Codable, Sendable {
  case betterCRT = "ghosttea:better-crt"
  case crt = "ghosttea:crt"
  case vhs = "ghosttea:vhs"
  case sparksFromFire = "ghosttea:sparks-from-fire"
}

public struct GhostteaPaletteConfigEntry: Codable, Equatable, Sendable {
  public let index: UInt8
  public let color: [UInt8]

  public init(index: UInt8, color: [UInt8]) {
    self.index = index
    self.color = color
  }
}

public struct GhostteaConfigCompatibility: Codable, Equatable, Sendable {
  public let ghosttyVersion: String
  public let ghosttyCommit: String
  public let knownKeyCount: Int
}

public struct GhostteaConfigSource: Codable, Equatable, Sendable {
  public let path: String
  public let kind: GhostteaConfigSourceKind
}

public struct GhostteaConfigDiagnostic: Codable, Equatable, Sendable {
  public let severity: GhostteaConfigDiagnosticSeverity
  public let code: String
  public let message: String
  public let source: String?
  public let line: Int?
  public let key: String?
}

public struct GhostteaConfiguredKey: Codable, Equatable, Sendable {
  public let key: String
  public let support: GhostteaConfigSupport
  public let occurrences: Int
}

public struct GhostteaResolvedTerminalConfig: Codable, Equatable, Sendable {
  public let scrollbackBytes: UInt64
  public let foreground: [UInt8]
  public let background: [UInt8]
  public let cursor: [UInt8]
  public let palette: [GhostteaPaletteConfigEntry]

  private enum CodingKeys: String, CodingKey {
    case scrollbackBytes, foreground, background, cursor, palette
  }

  public init(from decoder: Decoder) throws {
    let values = try decoder.container(keyedBy: CodingKeys.self)
    scrollbackBytes = try values.decode(UInt64.self, forKey: .scrollbackBytes)
    foreground = try values.decode([UInt8].self, forKey: .foreground)
    background = try values.decode([UInt8].self, forKey: .background)
    cursor = try values.decode([UInt8].self, forKey: .cursor)
    palette = try values.decodeIfPresent([GhostteaPaletteConfigEntry].self, forKey: .palette) ?? []
  }

  public var colorTriples:
    (
      foreground: (UInt8, UInt8, UInt8),
      background: (UInt8, UInt8, UInt8),
      cursor: (UInt8, UInt8, UInt8)
    )?
  {
    guard foreground.count == 3, background.count == 3, cursor.count == 3 else { return nil }
    return (
      (foreground[0], foreground[1], foreground[2]),
      (background[0], background[1], background[2]),
      (cursor[0], cursor[1], cursor[2])
    )
  }
}

public struct GhostteaResolvedRendererConfig: Codable, Equatable, Sendable {
  public let foreground: [UInt8]
  public let background: [UInt8]
  public let cursor: [UInt8]
  public let cursorText: [UInt8]
  public let selectionBackground: [UInt8]
  public let selectionForeground: [UInt8]
  public let palette: [GhostteaPaletteConfigEntry]
  public let backgroundOpacity: Float
  public let backgroundOpacityCells: Bool
  /// WCAG contrast ratio text keeps against its cell background (1 = off).
  public let minimumContrast: Float
  public let lightAdaptation: GhostteaLightAdaptation
  public let fontSize: Float
  public let fontFamilies: [String]
  public let paddingX: [Float]
  public let paddingY: [Float]
  public let postProcess: GhostteaRendererPostProcess
  public let shaderEffects: [String]
  public let customShaderAnimation: Bool
  public let customShaderPaths: [String]

  private enum CodingKeys: String, CodingKey {
    case foreground, background, cursor, cursorText, selectionBackground, selectionForeground
    case palette, backgroundOpacity, backgroundOpacityCells
    case minimumContrast, lightAdaptation
    case fontSize, fontFamilies, paddingX, paddingY, postProcess
    case shaderEffects, customShaderAnimation, customShaderPaths
  }

  public init(from decoder: Decoder) throws {
    let values = try decoder.container(keyedBy: CodingKeys.self)
    foreground = try values.decode([UInt8].self, forKey: .foreground)
    background = try values.decode([UInt8].self, forKey: .background)
    cursor = try values.decode([UInt8].self, forKey: .cursor)
    cursorText = try values.decodeIfPresent([UInt8].self, forKey: .cursorText) ?? background
    selectionBackground = try values.decode([UInt8].self, forKey: .selectionBackground)
    selectionForeground = try values.decode([UInt8].self, forKey: .selectionForeground)
    palette = try values.decodeIfPresent([GhostteaPaletteConfigEntry].self, forKey: .palette) ?? []
    backgroundOpacity = try values.decodeIfPresent(Float.self, forKey: .backgroundOpacity) ?? 1
    backgroundOpacityCells =
      try values.decodeIfPresent(Bool.self, forKey: .backgroundOpacityCells) ?? false
    minimumContrast = try values.decodeIfPresent(Float.self, forKey: .minimumContrast) ?? 1
    lightAdaptation =
      try values.decodeIfPresent(GhostteaLightAdaptation.self, forKey: .lightAdaptation) ?? .auto
    fontSize = try values.decode(Float.self, forKey: .fontSize)
    fontFamilies = try values.decode([String].self, forKey: .fontFamilies)
    paddingX = try values.decode([Float].self, forKey: .paddingX)
    paddingY = try values.decode([Float].self, forKey: .paddingY)
    postProcess = try values.decode(GhostteaRendererPostProcess.self, forKey: .postProcess)
    shaderEffects = try values.decodeIfPresent([String].self, forKey: .shaderEffects) ?? []
    customShaderAnimation =
      try values.decodeIfPresent(Bool.self, forKey: .customShaderAnimation) ?? false
    customShaderPaths = try values.decode([String].self, forKey: .customShaderPaths)
  }
}

/// Renderer-owned settings safe to synchronize with a remote terminal view.
///
/// Host file paths, diagnostics, keybindings, and retention policy are
/// deliberately excluded from this projection.
public struct GhostteaTerminalPresentationConfig: Codable, Equatable, Sendable {
  public let schemaVersion: UInt32
  public let revision: String
  public let foreground: [UInt8]
  public let background: [UInt8]
  public let cursor: [UInt8]
  public let cursorText: [UInt8]
  public let selectionBackground: [UInt8]
  public let selectionForeground: [UInt8]
  public let palette: [GhostteaPaletteConfigEntry]
  public let backgroundOpacity: Float
  public let backgroundOpacityCells: Bool
  /// WCAG contrast ratio text keeps against its cell background (1 = off).
  public let minimumContrast: Float
  public let lightAdaptation: GhostteaLightAdaptation
  public let fontSize: Float
  public let fontFamilies: [String]
  public let paddingX: [Float]
  public let paddingY: [Float]
  public let postProcess: GhostteaRendererPostProcess
  public let shaderEffects: [String]
  public let customShaderAnimation: Bool
  /// Number of host-local shader paths omitted from this projection.
  public let customShaderCount: UInt32

  public init(
    schemaVersion: UInt32,
    revision: String,
    foreground: [UInt8],
    background: [UInt8],
    cursor: [UInt8],
    cursorText: [UInt8]? = nil,
    selectionBackground: [UInt8],
    selectionForeground: [UInt8],
    palette: [GhostteaPaletteConfigEntry] = [],
    backgroundOpacity: Float = 1,
    backgroundOpacityCells: Bool = false,
    minimumContrast: Float = 1,
    lightAdaptation: GhostteaLightAdaptation = .auto,
    fontSize: Float,
    fontFamilies: [String],
    paddingX: [Float],
    paddingY: [Float],
    postProcess: GhostteaRendererPostProcess,
    shaderEffects: [String] = [],
    customShaderAnimation: Bool = false,
    customShaderCount: UInt32
  ) {
    self.schemaVersion = schemaVersion
    self.revision = revision
    self.foreground = foreground
    self.background = background
    self.cursor = cursor
    self.cursorText = cursorText ?? background
    self.selectionBackground = selectionBackground
    self.selectionForeground = selectionForeground
    self.palette = palette
    self.backgroundOpacity = backgroundOpacity
    self.backgroundOpacityCells = backgroundOpacityCells
    self.minimumContrast = minimumContrast
    self.lightAdaptation = lightAdaptation
    self.fontSize = fontSize
    self.fontFamilies = fontFamilies
    self.paddingX = paddingX
    self.paddingY = paddingY
    self.postProcess = postProcess
    self.shaderEffects = shaderEffects
    self.customShaderAnimation = customShaderAnimation
    self.customShaderCount = customShaderCount
  }

  private enum CodingKeys: String, CodingKey {
    case schemaVersion, revision, foreground, background, cursor, cursorText
    case selectionBackground, selectionForeground, palette
    case backgroundOpacity, backgroundOpacityCells
    case minimumContrast, lightAdaptation
    case fontSize, fontFamilies, paddingX, paddingY, postProcess
    case shaderEffects, customShaderAnimation, customShaderCount
  }

  public init(from decoder: Decoder) throws {
    let values = try decoder.container(keyedBy: CodingKeys.self)
    schemaVersion = try values.decode(UInt32.self, forKey: .schemaVersion)
    revision = try values.decode(String.self, forKey: .revision)
    foreground = try values.decode([UInt8].self, forKey: .foreground)
    background = try values.decode([UInt8].self, forKey: .background)
    cursor = try values.decode([UInt8].self, forKey: .cursor)
    cursorText = try values.decodeIfPresent([UInt8].self, forKey: .cursorText) ?? background
    selectionBackground = try values.decode([UInt8].self, forKey: .selectionBackground)
    selectionForeground = try values.decode([UInt8].self, forKey: .selectionForeground)
    palette = try values.decodeIfPresent([GhostteaPaletteConfigEntry].self, forKey: .palette) ?? []
    backgroundOpacity = try values.decodeIfPresent(Float.self, forKey: .backgroundOpacity) ?? 1
    backgroundOpacityCells =
      try values.decodeIfPresent(Bool.self, forKey: .backgroundOpacityCells) ?? false
    minimumContrast = try values.decodeIfPresent(Float.self, forKey: .minimumContrast) ?? 1
    lightAdaptation =
      try values.decodeIfPresent(GhostteaLightAdaptation.self, forKey: .lightAdaptation) ?? .auto
    fontSize = try values.decode(Float.self, forKey: .fontSize)
    fontFamilies = try values.decode([String].self, forKey: .fontFamilies)
    paddingX = try values.decode([Float].self, forKey: .paddingX)
    paddingY = try values.decode([Float].self, forKey: .paddingY)
    postProcess = try values.decode(GhostteaRendererPostProcess.self, forKey: .postProcess)
    shaderEffects = try values.decodeIfPresent([String].self, forKey: .shaderEffects) ?? []
    customShaderAnimation =
      try values.decodeIfPresent(Bool.self, forKey: .customShaderAnimation) ?? false
    customShaderCount = try values.decode(UInt32.self, forKey: .customShaderCount)
  }

  public var isValid: Bool {
    schemaVersion == 1
      && !revision.isEmpty
      && [foreground, background, cursor, selectionBackground, selectionForeground]
        .allSatisfy { $0.count == 3 }
      && cursorText.count == 3
      && palette.count <= 256
      && palette.allSatisfy { $0.color.count == 3 }
      && backgroundOpacity.isFinite && (0...1).contains(backgroundOpacity)
      && fontSize.isFinite && fontSize > 0
      && paddingX.count == 2 && paddingY.count == 2
      && paddingX.allSatisfy { $0.isFinite && $0 >= 0 }
      && paddingY.allSatisfy { $0.isFinite && $0 >= 0 }
  }
}

public struct GhostteaConfigKeybinding: Codable, Equatable, Sendable {
  public let trigger: String
  public let action: String
}

public struct GhostteaResolvedWorkspaceConfig: Codable, Equatable, Sendable {
  public let keybindings: [GhostteaConfigKeybinding]
  public let clearKeybindings: Bool
}

/// Versioned projection produced by the same Rust configuration engine used by
/// ghosttead and the Electron renderer.
public struct GhostteaConfigSnapshot: Codable, Equatable, Sendable {
  public let schemaVersion: UInt32
  public let revision: String
  public let compatibility: GhostteaConfigCompatibility
  public let sources: [GhostteaConfigSource]
  public let diagnostics: [GhostteaConfigDiagnostic]
  public let configuredKeys: [GhostteaConfiguredKey]
  public let terminal: GhostteaResolvedTerminalConfig
  public let renderer: GhostteaResolvedRendererConfig
  public let workspace: GhostteaResolvedWorkspaceConfig

  public var hasErrors: Bool {
    diagnostics.contains { $0.severity == .error }
  }

  public var terminalPresentation: GhostteaTerminalPresentationConfig {
    GhostteaTerminalPresentationConfig(
      schemaVersion: schemaVersion,
      revision: revision,
      foreground: renderer.foreground,
      background: renderer.background,
      cursor: renderer.cursor,
      cursorText: renderer.cursorText,
      selectionBackground: renderer.selectionBackground,
      selectionForeground: renderer.selectionForeground,
      palette: renderer.palette,
      backgroundOpacity: renderer.backgroundOpacity,
      backgroundOpacityCells: renderer.backgroundOpacityCells,
      minimumContrast: renderer.minimumContrast,
      lightAdaptation: renderer.lightAdaptation,
      fontSize: renderer.fontSize,
      fontFamilies: renderer.fontFamilies,
      paddingX: renderer.paddingX,
      paddingY: renderer.paddingY,
      postProcess: renderer.postProcess,
      shaderEffects: renderer.shaderEffects,
      customShaderAnimation: renderer.customShaderAnimation,
      customShaderCount: UInt32(clamping: renderer.customShaderPaths.count)
    )
  }
}

public enum GhostteaConfiguration {
  /// Loads Ghostty's standard files and then an optional app-owned overlay.
  /// Set `loadGhosttyFiles` false for sandboxed documents or deterministic
  /// tests that should read only the supplied URL.
  public static func load(
    overlayURL: URL? = nil,
    loadGhosttyFiles: Bool = true
  ) throws -> GhostteaConfigSnapshot {
    let path = overlayURL?.path ?? ""
    var output = ghosttea_owned_bytes_t(data: nil, len: 0, capacity: 0)
    let status = withUTF8(path) { pathView in
      ghosttea_config_load_json(pathView, loadGhosttyFiles, &output)
    }
    try check(status)
    defer { ghosttea_owned_bytes_free(output) }
    let data = output.data.map { Data(bytes: $0, count: output.len) } ?? Data()
    return try JSONDecoder().decode(GhostteaConfigSnapshot.self, from: data)
  }
}

public struct GhostteaConfigDocument: Codable, Equatable, Sendable {
  public let schemaVersion: UInt32
  public let revision: String
  public let path: String
  public let exists: Bool
  public let contents: String

  public init(
    schemaVersion: UInt32,
    revision: String,
    path: String,
    exists: Bool,
    contents: String
  ) {
    self.schemaVersion = schemaVersion
    self.revision = revision
    self.path = path
    self.exists = exists
    self.contents = contents
  }
}

public struct GhostteaConfigDocumentValidation: Codable, Equatable, Sendable {
  public let documentRevision: String
  public let config: GhostteaConfigSnapshot

  public init(documentRevision: String, config: GhostteaConfigSnapshot) {
    self.documentRevision = documentRevision
    self.config = config
  }
}

public struct GhostteaConfigReload: Codable, Equatable, Sendable {
  public let config: GhostteaConfigSnapshot
  public let changed: Bool
}

public struct GhostteaConfigDocumentUpdate: Codable, Equatable, Sendable {
  public let document: GhostteaConfigDocument
  public let config: GhostteaConfigSnapshot
  public let effectiveChanged: Bool
}

public enum GhostteaConfigDocumentReplaceResult: Equatable, Sendable {
  case saved(GhostteaConfigDocumentUpdate)
  case conflict(current: GhostteaConfigDocument)
}

/// A retained native configuration owner. Its methods are thread-safe and may
/// be called from a detached task so editor validation never blocks SwiftUI.
public final class GhostteaConfigurationStore: @unchecked Sendable {
  public static let maximumDocumentBytes = 64 * 1024

  private let handle: OpaquePointer

  public init(overlayURL: URL, loadGhosttyFiles: Bool = true) throws {
    var created: OpaquePointer?
    let status = withUTF8(overlayURL.path) { path in
      ghosttea_config_manager_create(path, loadGhosttyFiles, &created)
    }
    try check(status)
    guard let created else {
      throw GhostteaCoreError.malformedUpdate(
        "configuration manager creation returned no handle")
    }
    handle = created
  }

  deinit {
    ghosttea_config_manager_destroy(handle)
  }

  public func snapshot() throws -> GhostteaConfigSnapshot {
    try decodeJSON(GhostteaConfigSnapshot.self) { output in
      ghosttea_config_manager_snapshot_json(handle, &output)
    }
  }

  public func reload() throws -> GhostteaConfigReload {
    try decodeJSON(GhostteaConfigReload.self) { output in
      ghosttea_config_manager_reload_json(handle, &output)
    }
  }

  /// Reloads the effective configuration and captures the exact overlay
  /// document it was resolved from. The overlay may be edited by another
  /// process between native calls, so retry until the document revision is
  /// stable on both sides of the reload.
  public func reloadDocument() throws -> GhostteaConfigDocumentUpdate {
    var effectiveChanged = false
    for _ in 0..<3 {
      let before = try document()
      let reloaded = try reload()
      effectiveChanged = effectiveChanged || reloaded.changed
      let after = try document()
      guard before.revision == after.revision else { continue }
      return GhostteaConfigDocumentUpdate(
        document: after,
        config: reloaded.config,
        effectiveChanged: effectiveChanged
      )
    }
    throw GhostteaCoreError.malformedUpdate(
      "configuration document changed repeatedly while it was being reloaded")
  }

  public func document() throws -> GhostteaConfigDocument {
    try decodeJSON(GhostteaConfigDocument.self) { output in
      ghosttea_config_manager_document_json(handle, &output)
    }
  }

  public func validate(contents: String) throws -> GhostteaConfigDocumentValidation {
    try decodeJSON(GhostteaConfigDocumentValidation.self) { output in
      withUTF8(contents) { contents in
        ghosttea_config_manager_validate_document_json(handle, contents, &output)
      }
    }
  }

  public func replace(
    expectedRevision: String,
    contents: String
  ) throws -> GhostteaConfigDocumentReplaceResult {
    let response = try decodeJSON(ReplaceResponse.self) { output in
      withUTF8(expectedRevision) { revision in
        withUTF8(contents) { contents in
          ghosttea_config_manager_replace_document_json(handle, revision, contents, &output)
        }
      }
    }
    switch response.status {
    case "saved":
      guard let document = response.document, let config = response.config,
        let effectiveChanged = response.effectiveChanged
      else {
        throw GhostteaCoreError.malformedUpdate(
          "configuration replacement omitted its saved result")
      }
      return .saved(
        GhostteaConfigDocumentUpdate(
          document: document,
          config: config,
          effectiveChanged: effectiveChanged
        ))
    case "conflict":
      guard let current = response.current else {
        throw GhostteaCoreError.malformedUpdate(
          "configuration conflict omitted the current document")
      }
      return .conflict(current: current)
    default:
      throw GhostteaCoreError.malformedUpdate(
        "unknown configuration replacement status \(response.status)")
    }
  }

  private struct ReplaceResponse: Decodable {
    let status: String
    let document: GhostteaConfigDocument?
    let config: GhostteaConfigSnapshot?
    let effectiveChanged: Bool?
    let current: GhostteaConfigDocument?
  }

  private func decodeJSON<Value: Decodable>(
    _ type: Value.Type,
    operation: (inout ghosttea_owned_bytes_t) -> ghosttea_status_t
  ) throws -> Value {
    var output = ghosttea_owned_bytes_t(data: nil, len: 0, capacity: 0)
    try check(operation(&output))
    defer { ghosttea_owned_bytes_free(output) }
    let data = output.data.map { Data(bytes: $0, count: output.len) } ?? Data()
    return try JSONDecoder().decode(type, from: data)
  }
}

extension GhostteaTextMetrics {
  /// Scales the bundled-font geometry to the resolved Ghostty font size.
  ///
  /// Ghosttea does not yet load arbitrary `font-family` values on Apple
  /// platforms, but applying the size here keeps shaping, grid calculation,
  /// and Metal presentation on one set of metrics.
  public init(
    config: GhostteaConfigSnapshot,
    base: GhostteaTextMetrics = .init()
  ) {
    self.init(presentation: config.terminalPresentation, base: base)
  }

  public init(
    presentation: GhostteaTerminalPresentationConfig,
    base: GhostteaTextMetrics = .init()
  ) {
    let configuredSize = presentation.fontSize
    guard configuredSize.isFinite, configuredSize > 0,
      base.fontSizePixels.isFinite, base.fontSizePixels > 0
    else {
      self = base
      return
    }
    let scale = configuredSize / base.fontSizePixels
    let cellWidth = base.cellWidthPixels * scale
    let lineHeight = base.lineHeightPixels * scale
    let baseline = base.baselinePixels * scale
    guard scale.isFinite, scale > 0,
      cellWidth.isFinite, cellWidth > 0,
      lineHeight.isFinite, lineHeight > 0,
      baseline.isFinite, baseline >= 0
    else {
      self = base
      return
    }
    self.init(
      fontSizePixels: configuredSize,
      cellWidthPixels: cellWidth,
      lineHeightPixels: lineHeight,
      baselinePixels: baseline,
      rasterScale: base.rasterScale
    )
  }
}

extension GhostteaRuntime {
  /// Creates the shared native runtime with the resolved Ghostty font size.
  public convenience init(config: GhostteaConfigSnapshot) throws {
    try self.init(presentation: config.terminalPresentation)
  }

  public convenience init(presentation: GhostteaTerminalPresentationConfig) throws {
    try self.init(metrics: GhostteaTextMetrics(presentation: presentation))
  }
}

extension GhostteaTerminalConfiguration {
  /// Builds a terminal using the resolved Ghostty scrollback limit.
  public init(
    sessionHandle: UInt64,
    config: GhostteaConfigSnapshot,
    sessionEpoch: UInt64 = 1,
    layoutEpoch: UInt64 = 1,
    columns: UInt16 = 80,
    rows: UInt16 = 24
  ) {
    self.init(
      sessionHandle: sessionHandle,
      sessionEpoch: sessionEpoch,
      layoutEpoch: layoutEpoch,
      scrollbackBytes: config.terminal.scrollbackBytes,
      columns: columns,
      rows: rows
    )
  }
}

extension GhostteaTerminal {
  /// Applies the config colors to the terminal model so subsequently emitted
  /// TRF1 style definitions match desktop behavior.
  public func apply(
    config: GhostteaConfigSnapshot,
    render: GhostteaRenderRequest = .full
  ) throws -> GhostteaUpdate {
    guard let colors = config.terminal.colorTriples else {
      throw GhostteaCoreError.malformedUpdate(
        "configuration colors must each contain exactly three components")
    }
    return try setAppearance(
      foreground: colors.foreground,
      background: colors.background,
      cursor: colors.cursor,
      palette: config.terminal.palette,
      render: render
    )
  }
}
