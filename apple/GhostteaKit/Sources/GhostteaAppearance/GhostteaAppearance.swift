import Foundation
import GhostteaCore

public struct GhostteaColorTheme: Codable, Equatable, Identifiable, Sendable {
  public var id: String { name }
  public let name: String
  public let background: String
  public let foreground: String
  public let cursor: String
  public let cursorText: String
  public let selection: String
  public let selectionForeground: String
  public let palette: [String]
}

public enum GhostteaThemeCatalog {
  private struct Catalog: Decodable {
    let source: String
    let revision: String
    let themes: [GhostteaColorTheme]
  }

  private static let catalog: Catalog = {
    guard
      let url = Bundle.module.url(forResource: "theme-catalog.generated", withExtension: "json"),
      let data = try? Data(contentsOf: url),
      let catalog = try? JSONDecoder().decode(Catalog.self, from: data)
    else {
      preconditionFailure("bundled Ghostty color-theme catalog is unavailable")
    }
    precondition(catalog.themes.count == 602, "bundled Ghostty color-theme catalog is incomplete")
    return catalog
  }()

  public static var source: String { catalog.source }
  public static var revision: String { catalog.revision }
  public static var themes: [GhostteaColorTheme] { catalog.themes }
}

public struct GhostteaShaderOption: Identifiable, Equatable, Sendable {
  public let id: String
  public let name: String
  public let description: String
  public let license: String
  public let animated: Bool

  public static let available: [Self] = [
    Self(
      id: GhostteaShaderEffect.betterCRT.rawValue,
      name: "Better CRT (legacy)",
      description: "Curved display and scanlines.",
      license: "CC BY-NC-SA 3.0 upstream",
      animated: false),
    Self(
      id: GhostteaShaderEffect.crt.rawValue,
      name: "CRT",
      description: "Lottes-style scanline, shadow-mask, warp, and tone treatment.",
      license: "Unlicense / public domain",
      animated: false),
    Self(
      id: GhostteaShaderEffect.vhs.rawValue,
      name: "VHS",
      description: "Tape wobble, chroma bleed, tracking noise, grain, and vignette.",
      license: "MIT",
      animated: true),
    Self(
      id: GhostteaShaderEffect.sparksFromFire.rawValue,
      name: "Sparks from Fire",
      description: "Animated ember overlay over darker terminal regions.",
      license: "CC BY 3.0",
      animated: true),
  ]

  public static let unavailableUpstreamNames = [
    "animated-gradient-shader", "bloom", "cineShader-Lava", "cubes", "cursor_blaze",
    "cursor_lightning", "dither", "drunkard", "fireworks-rockets", "fireworks", "galaxy",
    "gears-and-belts", "glitchy", "glow-rgbsplit-twitchy", "gradient-background",
    "in-game-crt-cursor", "in-game-crt", "inside-the-matrix", "just-snow",
    "matrix-hallway", "mnoise", "negative", "retro-terminal", "sin-interference",
    "smear_cursor_blocks", "smoke-and-ghost", "spotlight", "starfield-colors", "starfield",
    "tft", "underwater", "water",
  ]
}

public struct GhostteaAppearanceSelection: Equatable, Sendable {
  public var theme: GhostteaColorTheme?
  public var backgroundOpacity: Double
  public var backgroundOpacityCells: Bool
  public var shaderEffects: [String]
  public var shaderAnimation: Bool
  /// `ghosttea-light-adaptation`: restyle dark-painted apps under light themes.
  public var lightAdaptation: GhostteaLightAdaptation
  /// Ghostty `minimum-contrast` ratio (1 is off).
  public var minimumContrast: Double

  /// Ratios offered by Settings; 4.5:1 is the WCAG AA level for body text.
  public static let minimumContrastChoices: [Double] = [1, 3, 4.5, 7]

  public init(
    theme: GhostteaColorTheme? = nil,
    backgroundOpacity: Double = 1,
    backgroundOpacityCells: Bool = false,
    shaderEffects: [String] = [],
    shaderAnimation: Bool = false,
    lightAdaptation: GhostteaLightAdaptation = .auto,
    minimumContrast: Double = 1
  ) {
    self.theme = theme
    self.backgroundOpacity = backgroundOpacity
    self.backgroundOpacityCells = backgroundOpacityCells
    self.shaderEffects = shaderEffects
    self.shaderAnimation = shaderAnimation
    self.lightAdaptation = lightAdaptation
    self.minimumContrast = minimumContrast
  }

  public init(config: GhostteaConfigSnapshot) {
    theme = GhostteaThemeCatalog.themes.first { $0.matches(config.renderer) }
    backgroundOpacity = Double(config.renderer.backgroundOpacity)
    backgroundOpacityCells = config.renderer.backgroundOpacityCells
    shaderEffects =
      config.renderer.shaderEffects.isEmpty && config.renderer.postProcess == .betterCRT
      ? [GhostteaShaderEffect.betterCRT.rawValue]
      : config.renderer.shaderEffects
    shaderAnimation = config.renderer.customShaderAnimation
    lightAdaptation = config.renderer.lightAdaptation
    minimumContrast = Double(config.renderer.minimumContrast)
  }
}

public enum GhostteaFriendlyConfigSection: String, CaseIterable, Hashable, Sendable {
  case colors
  case opacity
  case scrollback
  case typography
  case padding
  case keybindings
}

public struct GhostteaFriendlyConfigValues: Equatable, Sendable {
  public var foreground: String
  public var background: String
  public var cursor: String
  public var cursorText: String
  public var selectionBackground: String
  public var selectionForeground: String
  public var backgroundOpacity: Double
  public var backgroundOpacityCells: Bool
  public var scrollbackLimit: UInt64
  public var fontFamilies: [String]
  public var fontSize: Double
  public var paddingX: [Double]
  public var paddingY: [Double]
  public var clearKeybindings: Bool
  public var keybindings: [String]

  public init(config: GhostteaConfigSnapshot) {
    foreground = Self.hex(config.renderer.foreground)
    background = Self.hex(config.renderer.background)
    cursor = Self.hex(config.renderer.cursor)
    cursorText = Self.hex(config.renderer.cursorText)
    selectionBackground = Self.hex(config.renderer.selectionBackground)
    selectionForeground = Self.hex(config.renderer.selectionForeground)
    backgroundOpacity = Double(config.renderer.backgroundOpacity)
    backgroundOpacityCells = config.renderer.backgroundOpacityCells
    scrollbackLimit = config.terminal.scrollbackBytes
    fontFamilies = config.renderer.fontFamilies
    fontSize = Double(config.renderer.fontSize)
    paddingX = config.renderer.paddingX.map(Double.init)
    paddingY = config.renderer.paddingY.map(Double.init)
    clearKeybindings = config.workspace.clearKeybindings
    keybindings = config.workspace.keybindings.map { "\($0.trigger)=\($0.action)" }
  }

  fileprivate static func hex(_ bytes: [UInt8]) -> String {
    "#" + bytes.map { String(format: "%02x", $0) }.joined()
  }
}

public enum GhostteaConfigDraftError: Error, LocalizedError, Equatable {
  case malformedManagedBlock(String)
  case invalidTheme
  case importedConfigurationHasErrors(Int)

  public var errorDescription: String? {
    switch self {
    case .malformedManagedBlock(let name):
      "The managed \(name) block in config.ghostty is malformed."
    case .invalidTheme:
      "The selected theme contains an invalid color or palette."
    case .importedConfigurationHasErrors(let count):
      "The selected Ghostty configuration contains \(count) error(s) and was not imported."
    }
  }
}

public enum GhostteaConfigurationDraft {
  public static let appearanceBlockStart =
    "# >>> Ghosttea appearance (managed; edit through Settings)"
  public static let appearanceBlockEnd = "# <<< Ghosttea appearance"
  public static let friendlyBlockStart =
    "# >>> Ghosttea common settings (managed; edit through Settings)"
  public static let friendlyBlockEnd = "# <<< Ghosttea common settings"

  public static func preferredNewline(in contents: String) -> String {
    let bytes = contents.utf8
    guard let newline = bytes.firstIndex(of: 0x0A) else { return "\n" }
    return newline > bytes.startIndex && bytes[bytes.index(before: newline)] == 0x0D
      ? "\r\n" : "\n"
  }

  /// Applies a textarea edit while preserving CRLF tokens in every untouched
  /// portion of the exact raw document.
  public static func applyTextEdit(previous: String, edited: String) -> String {
    let before = normalizedNewlines(previous)
    let after = normalizedNewlines(edited)
    guard before != after else { return previous }
    let beforeCharacters = Array(before)
    let afterCharacters = Array(after)
    var prefix = 0
    while prefix < min(beforeCharacters.count, afterCharacters.count),
      beforeCharacters[prefix] == afterCharacters[prefix]
    {
      prefix += 1
    }
    var suffix = 0
    while suffix < beforeCharacters.count - prefix,
      suffix < afterCharacters.count - prefix,
      beforeCharacters[beforeCharacters.count - suffix - 1]
        == afterCharacters[afterCharacters.count - suffix - 1]
    {
      suffix += 1
    }
    let originalStart = originalIndex(in: previous, normalizedOffset: prefix)
    let originalEnd = originalIndex(
      in: previous,
      normalizedOffset: beforeCharacters.count - suffix)
    let replacement = String(afterCharacters[prefix..<(afterCharacters.count - suffix)])
      .replacingOccurrences(of: "\n", with: preferredNewline(in: previous))
    return String(previous[..<originalStart]) + replacement + String(previous[originalEnd...])
  }

  public static func appendDocument(_ appended: String, to contents: String) -> String {
    guard !contents.isEmpty else { return appended }
    guard !appended.isEmpty else { return contents }
    let newline = preferredNewline(in: contents)
    return appendWithBlankLine(contents, newline: newline) + appended
  }

  public static func appearanceBlock(_ selection: GhostteaAppearanceSelection) throws -> String {
    guard selection.backgroundOpacity.isFinite,
      (0...1).contains(selection.backgroundOpacity),
      selection.minimumContrast.isFinite,
      (1...21).contains(selection.minimumContrast),
      selection.shaderEffects.allSatisfy({ id in
        GhostteaShaderOption.available.contains { $0.id == id }
      })
    else { throw GhostteaConfigDraftError.invalidTheme }
    var lines = [appearanceBlockStart]
    if let theme = selection.theme {
      guard theme.isValid else { throw GhostteaConfigDraftError.invalidTheme }
      lines += [
        "# Theme: \(theme.name)",
        "# Catalog: mbadolato/iTerm2-Color-Schemes (collection MIT; individual themes retain author terms)",
        "background = \(theme.background)",
        "foreground = \(theme.foreground)",
        "cursor-color = \(theme.cursor)",
        "cursor-text = \(theme.cursorText)",
        "selection-background = \(theme.selection)",
        "selection-foreground = \(theme.selectionForeground)",
      ]
      lines += theme.palette.enumerated().map { "palette = \($0.offset)=\($0.element)" }
    } else {
      lines.append("# Theme: current custom colors preserved")
    }
    lines += [
      "background-opacity = \(configDecimal(selection.backgroundOpacity))",
      "background-opacity-cells = \(selection.backgroundOpacityCells)",
      "custom-shader =",
    ]
    lines += Array(NSOrderedSet(array: selection.shaderEffects)).compactMap { value in
      (value as? String).map { "custom-shader = \($0)" }
    }
    lines += [
      "custom-shader-animation = \(selection.shaderAnimation)",
      "ghosttea-light-adaptation = \(selection.lightAdaptation.rawValue)",
      "minimum-contrast = \(contrastRatio(selection.minimumContrast))",
      appearanceBlockEnd,
    ]
    return lines.joined(separator: "\n")
  }

  public static func patchAppearance(
    in contents: String,
    selection: GhostteaAppearanceSelection
  ) throws -> String {
    let newline = preferredNewline(in: contents)
    let block = try appearanceBlock(selection).replacingOccurrences(of: "\n", with: newline)
    let range = try managedBlockRange(
      in: contents,
      startMarker: appearanceBlockStart,
      endMarker: appearanceBlockEnd,
      name: "appearance"
    )
    var remaining = contents
    if let range {
      var upper = range.upperBound
      if remaining[upper...].hasPrefix("\r\n") {
        upper = remaining.index(upper, offsetBy: 2)
      } else if remaining[upper...].hasPrefix("\n") || remaining[upper...].hasPrefix("\r") {
        upper = remaining.index(after: upper)
      }
      remaining.removeSubrange(range.lowerBound..<upper)
    }
    return appendWithBlankLine(remaining, newline: newline) + block + newline
  }

  public static func friendlyBlock(
    _ values: GhostteaFriendlyConfigValues,
    sections: Set<GhostteaFriendlyConfigSection>
  ) -> String {
    var lines = [
      friendlyBlockStart,
      "# Only groups changed in the friendly editor are overridden; raw edits elsewhere are preserved.",
    ]
    if sections.contains(.colors) {
      lines += [
        "foreground = \(safeColor(values.foreground, fallback: "#ffffff"))",
        "background = \(safeColor(values.background, fallback: "#000000"))",
        "cursor-color = \(safeColor(values.cursor, fallback: values.foreground))",
        "cursor-text = \(safeColor(values.cursorText, fallback: values.background))",
        "selection-background = \(safeColor(values.selectionBackground, fallback: values.foreground))",
        "selection-foreground = \(safeColor(values.selectionForeground, fallback: values.background))",
      ]
    }
    if sections.contains(.opacity) {
      lines += [
        "background-opacity = \(configDecimal(min(1, max(0, values.backgroundOpacity))))",
        "background-opacity-cells = \(values.backgroundOpacityCells)",
      ]
    }
    if sections.contains(.scrollback) {
      lines.append("scrollback-limit = \(values.scrollbackLimit)")
    }
    if sections.contains(.typography) {
      lines.append("font-family =")
      lines += cleanLines(values.fontFamilies).map { "font-family = \($0)" }
      lines.append("font-size = \(max(values.fontSize, 0.1))")
    }
    if sections.contains(.padding) {
      let x = validPair(values.paddingX, fallback: [2, 2])
      let y = validPair(values.paddingY, fallback: [2, 2])
      lines += ["window-padding-x = \(x[0]),\(x[1])", "window-padding-y = \(y[0]),\(y[1])"]
    }
    if sections.contains(.keybindings) {
      lines.append(values.clearKeybindings ? "keybind = clear" : "keybind =")
      lines += cleanLines(values.keybindings).map { "keybind = \($0)" }
    }
    lines.append(friendlyBlockEnd)
    return lines.joined(separator: "\n")
  }

  public static func patchFriendly(
    in contents: String,
    values: GhostteaFriendlyConfigValues,
    sections: Set<GhostteaFriendlyConfigSection>
  ) throws -> String {
    let range = try managedBlockRange(
      in: contents,
      startMarker: friendlyBlockStart,
      endMarker: friendlyBlockEnd,
      name: "common settings"
    )
    if sections.isEmpty {
      guard let range else { return contents }
      var result = contents
      result.removeSubrange(range)
      return result
    }
    let newline = preferredNewline(in: contents)
    let block = friendlyBlock(values, sections: sections)
      .replacingOccurrences(of: "\n", with: newline)
    var remaining = contents
    if let range {
      var upper = range.upperBound
      if remaining[upper...].hasPrefix("\r\n") {
        upper = remaining.index(upper, offsetBy: 2)
      } else if remaining[upper...].hasPrefix("\n") || remaining[upper...].hasPrefix("\r") {
        upper = remaining.index(after: upper)
      }
      remaining.removeSubrange(range.lowerBound..<upper)
    }
    // Keep the most recently edited managed layer last. Appearance and the
    // friendly editor intentionally overlap on colors and opacity; moving the
    // edited block prevents an older managed block from silently shadowing it.
    return appendWithBlankLine(remaining, newline: newline) + block + newline
  }

  public static func friendlySections(in contents: String) -> Set<GhostteaFriendlyConfigSection> {
    let managedRange: Range<String.Index>?
    do {
      managedRange = try managedBlockRange(
        in: contents,
        startMarker: friendlyBlockStart,
        endMarker: friendlyBlockEnd,
        name: "common settings"
      )
    } catch {
      return []
    }
    guard let range = managedRange else { return [] }

    var sections: Set<GhostteaFriendlyConfigSection> = []
    for line in contents[range].components(separatedBy: .newlines) {
      let key =
        line.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
        .first?.trimmingCharacters(in: .whitespaces) ?? ""
      switch key {
      case "foreground", "background", "cursor-color", "cursor-text",
        "selection-background", "selection-foreground":
        sections.insert(.colors)
      case "background-opacity", "background-opacity-cells":
        sections.insert(.opacity)
      case "scrollback-limit":
        sections.insert(.scrollback)
      case "font-family", "font-size":
        sections.insert(.typography)
      case "window-padding-x", "window-padding-y":
        sections.insert(.padding)
      case "keybind":
        sections.insert(.keybindings)
      default:
        break
      }
    }
    return sections
  }

  /// Serializes only values Ghosttea can honor. This is used for the explicit
  /// “Import from Ghostty” projection and never pretends to preserve unknown
  /// source text.
  public static func portableConfig(from config: GhostteaConfigSnapshot) throws -> String {
    let errorCount = config.diagnostics.count { $0.severity == .error }
    guard errorCount == 0 else {
      throw GhostteaConfigDraftError.importedConfigurationHasErrors(errorCount)
    }
    let values = GhostteaFriendlyConfigValues(config: config)
    var lines = friendlyBlock(values, sections: Set(GhostteaFriendlyConfigSection.allCases))
      .components(separatedBy: "\n")
      .filter { $0 != friendlyBlockStart && $0 != friendlyBlockEnd && !$0.hasPrefix("# Only") }
    lines.append("custom-shader =")
    lines += config.renderer.shaderEffects.map { "custom-shader = \($0)" }
    lines.append("custom-shader-animation = \(config.renderer.customShaderAnimation)")
    lines.append("minimum-contrast = \(contrastRatio(Double(config.renderer.minimumContrast)))")
    lines += config.renderer.palette.map { entry in
      "palette = \(entry.index)=\(GhostteaFriendlyConfigValues.hex(entry.color))"
    }
    return lines.joined(separator: "\n") + "\n"
  }

  private static func managedBlockRange(
    in contents: String,
    startMarker: String,
    endMarker: String,
    name: String
  ) throws -> Range<String.Index>? {
    let start = contents.range(of: startMarker)
    let end = contents.range(of: endMarker)
    guard (start == nil) == (end == nil) else {
      throw GhostteaConfigDraftError.malformedManagedBlock(name)
    }
    guard let start, let end else { return nil }
    let duplicateStart = contents.range(
      of: startMarker, range: start.upperBound..<contents.endIndex)
    let duplicateEnd = contents.range(of: endMarker, range: end.upperBound..<contents.endIndex)
    guard end.lowerBound >= start.upperBound, duplicateStart == nil, duplicateEnd == nil else {
      throw GhostteaConfigDraftError.malformedManagedBlock(name)
    }
    return start.lowerBound..<end.upperBound
  }

  private static func appendWithBlankLine(_ contents: String, newline: String) -> String {
    guard !contents.isEmpty else { return "" }
    let bytes = contents.utf8
    var cursor = bytes.endIndex
    var trailing = 0
    while cursor > bytes.startIndex {
      let last = bytes.index(before: cursor)
      guard bytes[last] == 0x0A || bytes[last] == 0x0D else { break }
      cursor = last
      if bytes[last] == 0x0A, cursor > bytes.startIndex {
        let previous = bytes.index(before: cursor)
        if bytes[previous] == 0x0D { cursor = previous }
      }
      trailing += 1
    }
    return contents + String(repeating: newline, count: max(0, 2 - trailing))
  }

  private static func normalizedNewlines(_ value: String) -> String {
    value.replacingOccurrences(of: "\r\n", with: "\n")
      .replacingOccurrences(of: "\r", with: "\n")
  }

  private static func originalIndex(
    in value: String,
    normalizedOffset: Int
  ) -> String.Index {
    var index = value.startIndex
    var offset = 0
    while index < value.endIndex, offset < normalizedOffset {
      if value[index] == "\r" {
        let next = value.index(after: index)
        if next < value.endIndex, value[next] == "\n" {
          index = value.index(after: next)
        } else {
          index = next
        }
      } else {
        index = value.index(after: index)
      }
      offset += 1
    }
    return index
  }

  private static func safeColor(_ value: String, fallback: String) -> String {
    isColor(value) ? value.lowercased() : fallback.lowercased()
  }

  private static func configDecimal(_ value: Double) -> String {
    String(format: "%.2f", locale: Locale(identifier: "en_US_POSIX"), value)
  }

  /// Up to two decimals without trailing zeros, matching the desktop's
  /// `minimum-contrast = 4.5` rather than `4.50`.
  private static func contrastRatio(_ value: Double) -> String {
    var text = String(format: "%.2f", locale: Locale(identifier: "en_US_POSIX"), value)
    while text.hasSuffix("0") { text.removeLast() }
    if text.hasSuffix(".") { text.removeLast() }
    return text
  }

  private static func isColor(_ value: String) -> Bool {
    value.range(of: "^#[0-9a-fA-F]{6}$", options: .regularExpression) != nil
  }

  private static func cleanLines(_ values: [String]) -> [String] {
    values.map {
      $0.replacingOccurrences(of: "\r", with: "")
        .replacingOccurrences(of: "\n", with: "").trimmingCharacters(in: .whitespaces)
    }.filter { !$0.isEmpty }
  }

  private static func validPair(_ values: [Double], fallback: [Double]) -> [Double] {
    guard values.count == 2, values.allSatisfy({ $0.isFinite && $0 >= 0 }) else {
      return fallback
    }
    return values
  }
}

extension GhostteaColorTheme {
  fileprivate var isValid: Bool {
    !name.isEmpty && !name.contains("\n") && palette.count == 16
      && ([background, foreground, cursor, cursorText, selection, selectionForeground] + palette)
        .allSatisfy {
          $0.range(of: "^#[0-9a-fA-F]{6}$", options: .regularExpression) != nil
        }
  }

  fileprivate func matches(_ renderer: GhostteaResolvedRendererConfig) -> Bool {
    guard isValid else { return false }
    let fixed = [
      (background, renderer.background), (foreground, renderer.foreground),
      (cursor, renderer.cursor), (cursorText, renderer.cursorText),
      (selection, renderer.selectionBackground),
      (selectionForeground, renderer.selectionForeground),
    ]
    guard fixed.allSatisfy({ hexBytes($0.0) == $0.1 }) else { return false }
    let resolved = Dictionary(uniqueKeysWithValues: renderer.palette.map { ($0.index, $0.color) })
    return palette.enumerated().allSatisfy { index, color in
      resolved[UInt8(index)] == hexBytes(color)
    }
  }
}

private func hexBytes(_ value: String) -> [UInt8] {
  guard value.count == 7 else { return [] }
  let hex = value.dropFirst()
  return stride(from: 0, to: 6, by: 2).compactMap { offset in
    let start = hex.index(hex.startIndex, offsetBy: offset)
    let end = hex.index(start, offsetBy: 2)
    return UInt8(hex[start..<end], radix: 16)
  }
}
