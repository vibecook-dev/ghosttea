import Foundation

public enum TRF1 {
  public static let magic: UInt32 = 0x3146_5254
  public static let protocolVersion: UInt16 = 1
  public static let frameHeaderBytes = 64
  public static let sectionHeaderBytes = 16
  public static let maximumFrameBytes = 16 * 1024 * 1024
}

public struct TRF1FrameFlags: OptionSet, Sendable {
  public let rawValue: UInt16

  public init(rawValue: UInt16) {
    self.rawValue = rawValue
  }

  public static let fullSnapshot = Self(rawValue: 1 << 0)
  public static let mouseTracking = Self(rawValue: 1 << 1)
}

public struct TRF1SectionKind: RawRepresentable, Hashable, Sendable {
  public let rawValue: UInt16

  public init(rawValue: UInt16) {
    self.rawValue = rawValue
  }

  public static let glyphDefinitions = Self(rawValue: 1)
  public static let styleDefinitions = Self(rawValue: 2)
  public static let rowReplacements = Self(rawValue: 3)
  public static let cursorState = Self(rawValue: 4)
  public static let selectionSpans = Self(rawValue: 5)
  public static let imageDefinitions = Self(rawValue: 6)
  public static let imagePlacements = Self(rawValue: 7)
  public static let scrollbarState = Self(rawValue: 8)
  public static let viewportMetadata = Self(rawValue: 9)
  public static let accessibilityText = Self(rawValue: 10)
  public static let clipboardWrite = Self(rawValue: 11)
  public static let stylePalette = Self(rawValue: 13)
}

public struct TRF1Section: Sendable {
  public let kind: TRF1SectionKind
  public let flags: UInt16
  public let itemCount: UInt32
  public let bytes: Data
}

public struct TRF1Frame: Sendable {
  public let protocolVersion: UInt16
  public let flags: TRF1FrameFlags
  public let sessionHandle: UInt64
  public let viewHandle: UInt64
  public let sessionEpoch: UInt64
  public let layoutEpoch: UInt64
  public let frameSequence: UInt64
  public let terminalRevision: UInt64
  public let columns: UInt16
  public let rows: UInt16
  public let sections: [TRF1Section]
}

public struct TRF1TextRow: Equatable, Sendable {
  public let row: UInt16
  public let text: String
}

public struct TRF1GlyphInstance: Equatable, Sendable {
  public let glyphID: UInt32
  public let styleID: UInt32
  public let x: Float
  public let y: Float
  public let width: Float
  public let height: Float
  public let cellStart: UInt16
  public let cellSpan: UInt16
}

public struct TRF1StyleRun: Equatable, Sendable {
  public let styleID: UInt32
  public let cellStart: UInt16
  public let cellSpan: UInt16
}

public struct TRF1RowReplacement: Equatable, Sendable {
  public let row: UInt16
  public let revision: UInt64
  public let text: String
  public let glyphs: [TRF1GlyphInstance]
  public let styles: [TRF1StyleRun]
}

public enum TRF1GlyphFormat: UInt8, Sendable {
  case alpha8 = 0
  case rgba8Premultiplied = 1
}

public struct TRF1GlyphDefinition: Equatable, Sendable {
  public let id: UInt32
  public let width: UInt16
  public let height: UInt16
  public let bearingX: Int16
  public let bearingY: Int16
  public let format: TRF1GlyphFormat
  public let pixels: Data
}

public struct TRF1RGB: Equatable, Sendable {
  public let red: UInt8
  public let green: UInt8
  public let blue: UInt8
}

public struct TRF1StyleDefinition: Equatable, Sendable {
  public let id: UInt32
  public let bold: Bool
  public let italic: Bool
  public let faint: Bool
  public let inverse: Bool
  public let invisible: Bool
  public let strikethrough: Bool
  public let underline: Bool
  public let foreground: TRF1RGB?
  public let background: TRF1RGB?
  /// Palette index `foreground` was resolved from, when it came from the palette.
  public let foregroundPalette: UInt8?
  /// Palette index `background` was resolved from, when it came from the palette.
  public let backgroundPalette: UInt8?

  public init(
    id: UInt32,
    bold: Bool,
    italic: Bool,
    faint: Bool,
    inverse: Bool,
    invisible: Bool,
    strikethrough: Bool,
    underline: Bool,
    foreground: TRF1RGB?,
    background: TRF1RGB?,
    foregroundPalette: UInt8? = nil,
    backgroundPalette: UInt8? = nil
  ) {
    self.id = id
    self.bold = bold
    self.italic = italic
    self.faint = faint
    self.inverse = inverse
    self.invisible = invisible
    self.strikethrough = strikethrough
    self.underline = underline
    self.foreground = foreground
    self.background = background
    self.foregroundPalette = foregroundPalette
    self.backgroundPalette = backgroundPalette
  }
}

/// Palette provenance for one style definition (TRF1 section 13).
public struct TRF1StylePaletteEntry: Equatable, Sendable {
  public let styleID: UInt32
  public let foreground: UInt8?
  public let background: UInt8?
}

public enum TRF1CursorStyle: UInt8, Sendable {
  case bar = 0
  case block = 1
  case underline = 2
  case hollowBlock = 3
}

public struct TRF1CursorState: Equatable, Sendable {
  public let x: UInt16
  public let y: UInt16
  public let visible: Bool
  public let style: TRF1CursorStyle
  public let blinking: Bool
}

public struct TRF1ScrollbarState: Equatable, Sendable {
  public let total: UInt64
  public let offset: UInt64
  public let length: UInt64
}

public struct TRF1SelectionPoint: Equatable, Sendable {
  public let column: UInt16
  public let row: UInt32

  public init(column: UInt16, row: UInt32) {
    self.column = column
    self.row = row
  }
}

/// Ghostty-owned selection endpoints in absolute retained-grid coordinates.
/// Unlike viewport highlights, these points are tracked through scroll and
/// reflow by Ghostty's grid pins.
public struct TRF1SelectionState: Equatable, Sendable {
  public let anchor: TRF1SelectionPoint
  public let focus: TRF1SelectionPoint

  public init(anchor: TRF1SelectionPoint, focus: TRF1SelectionPoint) {
    self.anchor = anchor
    self.focus = focus
  }
}

public struct TRF1DecodingError: Error, Equatable, CustomStringConvertible, Sendable {
  public let reason: String

  public init(_ reason: String) {
    self.reason = reason
  }

  public var description: String {
    "Invalid terminal frame: \(reason)"
  }
}

private struct TRF1Reader {
  let data: Data

  func require(offset: Int, length: Int, _ reason: String) throws {
    guard offset >= 0, length >= 0, offset <= data.count, length <= data.count - offset else {
      throw TRF1DecodingError(reason)
    }
  }

  func uint8(_ offset: Int, _ reason: String) throws -> UInt8 {
    try require(offset: offset, length: 1, reason)
    return data[data.startIndex + offset]
  }

  func uint16(_ offset: Int, _ reason: String) throws -> UInt16 {
    try require(offset: offset, length: 2, reason)
    return UInt16(data[data.startIndex + offset])
      | UInt16(data[data.startIndex + offset + 1]) << 8
  }

  func int16(_ offset: Int, _ reason: String) throws -> Int16 {
    Int16(bitPattern: try uint16(offset, reason))
  }

  func uint32(_ offset: Int, _ reason: String) throws -> UInt32 {
    try require(offset: offset, length: 4, reason)
    return UInt32(data[data.startIndex + offset])
      | UInt32(data[data.startIndex + offset + 1]) << 8
      | UInt32(data[data.startIndex + offset + 2]) << 16
      | UInt32(data[data.startIndex + offset + 3]) << 24
  }

  func uint64(_ offset: Int, _ reason: String) throws -> UInt64 {
    try require(offset: offset, length: 8, reason)
    var value: UInt64 = 0
    for byte in 0..<8 {
      value |= UInt64(data[data.startIndex + offset + byte]) << UInt64(byte * 8)
    }
    return value
  }

  func float32(_ offset: Int, _ reason: String) throws -> Float {
    Float(bitPattern: try uint32(offset, reason))
  }

  func bytes(_ offset: Int, _ length: Int, _ reason: String) throws -> Data {
    try require(offset: offset, length: length, reason)
    let start = data.startIndex + offset
    return data[start..<(start + length)]
  }
}

private func require(_ condition: @autoclosure () -> Bool, _ reason: String) throws {
  guard condition() else { throw TRF1DecodingError(reason) }
}

private func decodeUTF8(_ data: Data, _ reason: String) throws -> String {
  guard let text = String(data: data, encoding: .utf8) else {
    throw TRF1DecodingError(reason)
  }
  return text
}

private func requireKind(_ section: TRF1Section, _ kind: TRF1SectionKind, _ reason: String) throws {
  try require(section.kind == kind, reason)
}

public func decodeTRF1Frame(_ data: Data) throws -> TRF1Frame {
  try require(data.count >= TRF1.frameHeaderBytes, "truncated header")
  try require(data.count <= TRF1.maximumFrameBytes, "packet exceeds limit")
  let reader = TRF1Reader(data: data)
  let magic = try reader.uint32(0, "truncated header")
  try require(magic == TRF1.magic, "bad magic")
  let version = try reader.uint16(4, "truncated header")
  try require(version == TRF1.protocolVersion, "unsupported protocol version")
  let sectionCount = Int(try reader.uint16(60, "truncated header"))
  let tableBytes = sectionCount * TRF1.sectionHeaderBytes
  try require(tableBytes <= data.count - TRF1.frameHeaderBytes, "truncated section table")
  let tableEnd = TRF1.frameHeaderBytes + tableBytes
  var sections: [TRF1Section] = []
  sections.reserveCapacity(sectionCount)
  for index in 0..<sectionCount {
    let base = TRF1.frameHeaderBytes + index * TRF1.sectionHeaderBytes
    let offset = Int(try reader.uint32(base + 4, "truncated section table"))
    let length = Int(try reader.uint32(base + 8, "truncated section table"))
    try require(offset >= tableEnd && offset <= data.count && length <= data.count - offset, "section out of bounds")
    sections.append(
      TRF1Section(
        kind: TRF1SectionKind(rawValue: try reader.uint16(base, "truncated section table")),
        flags: try reader.uint16(base + 2, "truncated section table"),
        itemCount: try reader.uint32(base + 12, "truncated section table"),
        bytes: try reader.bytes(offset, length, "section out of bounds")
      )
    )
  }
  return TRF1Frame(
    protocolVersion: version,
    flags: TRF1FrameFlags(rawValue: try reader.uint16(6, "truncated header")),
    sessionHandle: try reader.uint64(8, "truncated header"),
    viewHandle: try reader.uint64(16, "truncated header"),
    sessionEpoch: try reader.uint64(24, "truncated header"),
    layoutEpoch: try reader.uint64(32, "truncated header"),
    frameSequence: try reader.uint64(40, "truncated header"),
    terminalRevision: try reader.uint64(48, "truncated header"),
    columns: try reader.uint16(56, "truncated header"),
    rows: try reader.uint16(58, "truncated header"),
    sections: sections
  )
}

public func decodeTRF1AccessibilityRows(_ section: TRF1Section) throws -> [TRF1TextRow] {
  try requireKind(section, .accessibilityText, "wrong accessibility section kind")
  let reader = TRF1Reader(data: section.bytes)
  try reader.require(offset: 0, length: 2, "truncated text row header")
  let count = try reader.uint16(0, "truncated text row header")
  try require(UInt32(count) == section.itemCount, "text row count mismatch")
  try require(Int(count) <= (section.bytes.count - 2) / 6, "truncated text row")
  var rows: [TRF1TextRow] = []
  rows.reserveCapacity(Int(count))
  var offset = 2
  for _ in 0..<count {
    try reader.require(offset: offset, length: 6, "truncated text row")
    let row = try reader.uint16(offset, "truncated text row")
    let length = Int(try reader.uint32(offset + 2, "truncated text row"))
    offset += 6
    let bytes = try reader.bytes(offset, length, "text row payload out of bounds")
    rows.append(TRF1TextRow(row: row, text: try decodeUTF8(bytes, "invalid text row UTF-8")))
    offset += length
  }
  try require(offset == section.bytes.count, "trailing text row bytes")
  return rows
}

public func decodeTRF1RowReplacements(_ section: TRF1Section) throws -> [TRF1RowReplacement] {
  try requireKind(section, .rowReplacements, "wrong row replacement section kind")
  let reader = TRF1Reader(data: section.bytes)
  try reader.require(offset: 0, length: 2, "truncated row replacement header")
  let count = try reader.uint16(0, "truncated row replacement header")
  try require(UInt32(count) == section.itemCount, "row replacement count mismatch")
  try require(Int(count) <= (section.bytes.count - 2) / 18, "truncated row replacement")
  var replacements: [TRF1RowReplacement] = []
  replacements.reserveCapacity(Int(count))
  var offset = 2
  for _ in 0..<count {
    try reader.require(offset: offset, length: 18, "truncated row replacement")
    let row = try reader.uint16(offset, "truncated row replacement")
    let revision = try reader.uint64(offset + 2, "truncated row replacement")
    let textLength = Int(try reader.uint32(offset + 10, "truncated row replacement"))
    let glyphCount = Int(try reader.uint16(offset + 14, "truncated row replacement"))
    let styleCount = Int(try reader.uint16(offset + 16, "truncated row replacement"))
    offset += 18
    let text = try decodeUTF8(
      reader.bytes(offset, textLength, "row replacement payload out of bounds"),
      "invalid row replacement UTF-8"
    )
    offset += textLength
    try require(glyphCount <= (section.bytes.count - offset) / 28, "truncated glyph instance")
    var glyphs: [TRF1GlyphInstance] = []
    glyphs.reserveCapacity(glyphCount)
    for _ in 0..<glyphCount {
      try reader.require(offset: offset, length: 28, "truncated glyph instance")
      glyphs.append(
        TRF1GlyphInstance(
          glyphID: try reader.uint32(offset, "truncated glyph instance"),
          styleID: try reader.uint32(offset + 4, "truncated glyph instance"),
          x: try reader.float32(offset + 8, "truncated glyph instance"),
          y: try reader.float32(offset + 12, "truncated glyph instance"),
          width: try reader.float32(offset + 16, "truncated glyph instance"),
          height: try reader.float32(offset + 20, "truncated glyph instance"),
          cellStart: try reader.uint16(offset + 24, "truncated glyph instance"),
          cellSpan: try reader.uint16(offset + 26, "truncated glyph instance")
        )
      )
      offset += 28
    }
    try require(styleCount <= (section.bytes.count - offset) / 8, "truncated row style run")
    var styles: [TRF1StyleRun] = []
    styles.reserveCapacity(styleCount)
    for _ in 0..<styleCount {
      try reader.require(offset: offset, length: 8, "truncated row style run")
      styles.append(
        TRF1StyleRun(
          styleID: try reader.uint32(offset, "truncated row style run"),
          cellStart: try reader.uint16(offset + 4, "truncated row style run"),
          cellSpan: try reader.uint16(offset + 6, "truncated row style run")
        )
      )
      offset += 8
    }
    replacements.append(TRF1RowReplacement(row: row, revision: revision, text: text, glyphs: glyphs, styles: styles))
  }
  try require(offset == section.bytes.count, "trailing row replacement bytes")
  return replacements
}

public func decodeTRF1GlyphDefinitions(_ section: TRF1Section) throws -> [TRF1GlyphDefinition] {
  try requireKind(section, .glyphDefinitions, "wrong glyph definition section kind")
  let reader = TRF1Reader(data: section.bytes)
  try reader.require(offset: 0, length: 4, "truncated glyph definition header")
  let count = try reader.uint32(0, "truncated glyph definition header")
  try require(count == section.itemCount, "glyph definition count mismatch")
  try require(Int(count) <= (section.bytes.count - 4) / 20, "truncated glyph definition")
  var definitions: [TRF1GlyphDefinition] = []
  definitions.reserveCapacity(Int(count))
  var offset = 4
  for _ in 0..<count {
    try reader.require(offset: offset, length: 20, "truncated glyph definition")
    let width = try reader.uint16(offset + 4, "truncated glyph definition")
    let height = try reader.uint16(offset + 6, "truncated glyph definition")
    guard let format = TRF1GlyphFormat(rawValue: try reader.uint8(offset + 12, "truncated glyph definition")) else {
      throw TRF1DecodingError("invalid glyph format")
    }
    let reservedByte = try reader.uint8(offset + 13, "truncated glyph definition")
    let reservedWord = try reader.uint16(offset + 14, "truncated glyph definition")
    try require(reservedByte == 0 && reservedWord == 0, "nonzero glyph reserved bytes")
    let pixelLength = Int(try reader.uint32(offset + 16, "truncated glyph definition"))
    let bytesPerPixel = format == .alpha8 ? 1 : 4
    let expectedLength = Int(width) * Int(height) * bytesPerPixel
    try require(pixelLength == expectedLength, "glyph pixel length mismatch")
    let id = try reader.uint32(offset, "truncated glyph definition")
    let bearingX = try reader.int16(offset + 8, "truncated glyph definition")
    let bearingY = try reader.int16(offset + 10, "truncated glyph definition")
    offset += 20
    let pixels = try reader.bytes(offset, pixelLength, "glyph pixels out of bounds")
    definitions.append(
      TRF1GlyphDefinition(
        id: id,
        width: width,
        height: height,
        bearingX: bearingX,
        bearingY: bearingY,
        format: format,
        pixels: pixels
      )
    )
    offset += pixelLength
  }
  try require(offset == section.bytes.count, "trailing glyph definition bytes")
  return definitions
}

/// Decodes style definitions. Pass the frame's optional style palette section
/// to attach palette provenance; the RGB colors are complete without it.
public func decodeTRF1StyleDefinitions(
  _ section: TRF1Section,
  palette paletteSection: TRF1Section? = nil
) throws -> [TRF1StyleDefinition] {
  try requireKind(section, .styleDefinitions, "wrong style definition section kind")
  let reader = TRF1Reader(data: section.bytes)
  try reader.require(offset: 0, length: 4, "truncated style definition header")
  let count = try reader.uint32(0, "truncated style definition header")
  try require(count == section.itemCount, "style definition count mismatch")
  try require(Int(count) <= (section.bytes.count - 4) / 16, "invalid style definition length")
  try require(section.bytes.count == 4 + Int(count) * 16, "invalid style definition length")
  var styles: [TRF1StyleDefinition] = []
  styles.reserveCapacity(Int(count))
  for index in 0..<Int(count) {
    let offset = 4 + index * 16
    let flags = try reader.uint16(offset + 4, "truncated style definition")
    let foregroundKind = try reader.uint8(offset + 6, "truncated style definition")
    let backgroundKind = try reader.uint8(offset + 7, "truncated style definition")
    try require(flags & ~0x7f == 0, "invalid style flags")
    try require(foregroundKind <= 1 && backgroundKind <= 1, "invalid style color kind")
    let reserved = try reader.uint16(offset + 14, "truncated style definition")
    try require(reserved == 0, "nonzero style reserved bytes")
    let foreground = foregroundKind == 1
      ? TRF1RGB(
        red: try reader.uint8(offset + 8, "truncated style definition"),
        green: try reader.uint8(offset + 9, "truncated style definition"),
        blue: try reader.uint8(offset + 10, "truncated style definition")
      )
      : nil
    let background = backgroundKind == 1
      ? TRF1RGB(
        red: try reader.uint8(offset + 11, "truncated style definition"),
        green: try reader.uint8(offset + 12, "truncated style definition"),
        blue: try reader.uint8(offset + 13, "truncated style definition")
      )
      : nil
    styles.append(
      TRF1StyleDefinition(
        id: try reader.uint32(offset, "truncated style definition"),
        bold: flags & 1 != 0,
        italic: flags & 2 != 0,
        faint: flags & 4 != 0,
        inverse: flags & 8 != 0,
        invisible: flags & 16 != 0,
        strikethrough: flags & 32 != 0,
        underline: flags & 64 != 0,
        foreground: foreground,
        background: background
      )
    )
  }
  guard let paletteSection else { return styles }
  var palette: [UInt32: TRF1StylePaletteEntry] = [:]
  for entry in try decodeTRF1StylePalette(paletteSection) {
    palette[entry.styleID] = entry
  }
  return styles.map { style in
    guard let entry = palette[style.id] else { return style }
    return TRF1StyleDefinition(
      id: style.id,
      bold: style.bold,
      italic: style.italic,
      faint: style.faint,
      inverse: style.inverse,
      invisible: style.invisible,
      strikethrough: style.strikethrough,
      underline: style.underline,
      foreground: style.foreground,
      background: style.background,
      foregroundPalette: style.foreground == nil ? nil : entry.foreground,
      backgroundPalette: style.background == nil ? nil : entry.background
    )
  }
}

public func decodeTRF1StylePalette(_ section: TRF1Section) throws -> [TRF1StylePaletteEntry] {
  try requireKind(section, .stylePalette, "wrong style palette section kind")
  let reader = TRF1Reader(data: section.bytes)
  try reader.require(offset: 0, length: 4, "truncated style palette header")
  let count = try reader.uint32(0, "truncated style palette header")
  try require(count == section.itemCount, "style palette count mismatch")
  try require(Int(count) <= (section.bytes.count - 4) / 8, "invalid style palette length")
  try require(section.bytes.count == 4 + Int(count) * 8, "invalid style palette length")
  var entries: [TRF1StylePaletteEntry] = []
  entries.reserveCapacity(Int(count))
  for index in 0..<Int(count) {
    let offset = 4 + index * 8
    let flags = try reader.uint8(offset + 4, "truncated style palette entry")
    try require(flags & ~0x3 == 0, "invalid style palette flags")
    let foreground = try reader.uint8(offset + 5, "truncated style palette entry")
    let background = try reader.uint8(offset + 6, "truncated style palette entry")
    entries.append(
      TRF1StylePaletteEntry(
        styleID: try reader.uint32(offset, "truncated style palette entry"),
        foreground: flags & 1 != 0 ? foreground : nil,
        background: flags & 2 != 0 ? background : nil
      )
    )
  }
  return entries
}

public func decodeTRF1CursorState(_ section: TRF1Section) throws -> TRF1CursorState {
  try requireKind(section, .cursorState, "wrong cursor section kind")
  try require(section.itemCount == 1, "cursor item count mismatch")
  try require(section.bytes.count == 8, "invalid cursor payload length")
  let reader = TRF1Reader(data: section.bytes)
  let visible = try reader.uint8(4, "truncated cursor state")
  let rawStyle = try reader.uint8(5, "truncated cursor state")
  let blinking = try reader.uint8(6, "truncated cursor state")
  try require(visible <= 1, "invalid cursor visibility")
  guard let style = TRF1CursorStyle(rawValue: rawStyle) else {
    throw TRF1DecodingError("invalid cursor style")
  }
  try require(blinking <= 1, "invalid cursor blinking state")
  let reserved = try reader.uint8(7, "truncated cursor state")
  try require(reserved == 0, "nonzero cursor reserved byte")
  return TRF1CursorState(
    x: try reader.uint16(0, "truncated cursor state"),
    y: try reader.uint16(2, "truncated cursor state"),
    visible: visible == 1,
    style: style,
    blinking: blinking == 1
  )
}

public func decodeTRF1ScrollbarState(_ section: TRF1Section) throws -> TRF1ScrollbarState {
  try requireKind(section, .scrollbarState, "wrong scrollbar section kind")
  try require(section.itemCount == 1, "scrollbar item count mismatch")
  try require(section.bytes.count == 24, "invalid scrollbar payload size")
  let reader = TRF1Reader(data: section.bytes)
  let total = try reader.uint64(0, "truncated scrollbar state")
  let offset = try reader.uint64(8, "truncated scrollbar state")
  let length = try reader.uint64(16, "truncated scrollbar state")
  try require(length <= total, "scrollbar viewport exceeds total rows")
  try require(offset <= total - length, "scrollbar offset exceeds scrollable range")
  return TRF1ScrollbarState(total: total, offset: offset, length: length)
}

public func decodeTRF1SelectionState(_ section: TRF1Section) throws -> TRF1SelectionState? {
  try requireKind(section, .selectionSpans, "wrong selection section kind")
  if section.itemCount == 0 {
    try require(section.bytes.isEmpty, "empty selection carries payload bytes")
    return nil
  }
  try require(section.itemCount == 1, "selection item count mismatch")
  try require(section.bytes.count == 12, "invalid selection payload size")
  let reader = TRF1Reader(data: section.bytes)
  return TRF1SelectionState(
    anchor: TRF1SelectionPoint(
      column: try reader.uint16(0, "truncated selection state"),
      row: try reader.uint32(2, "truncated selection state")
    ),
    focus: TRF1SelectionPoint(
      column: try reader.uint16(6, "truncated selection state"),
      row: try reader.uint32(8, "truncated selection state")
    )
  )
}

public func decodeTRF1ClipboardWrite(_ section: TRF1Section) throws -> String {
  try requireKind(section, .clipboardWrite, "wrong clipboard section kind")
  try require(section.itemCount == 1, "clipboard item count mismatch")
  try require(section.bytes.count >= 4, "truncated clipboard payload")
  let reader = TRF1Reader(data: section.bytes)
  let length = Int(try reader.uint32(0, "truncated clipboard payload"))
  try require(length == section.bytes.count - 4, "clipboard length mismatch")
  return try decodeUTF8(reader.bytes(4, length, "clipboard payload out of bounds"), "invalid clipboard UTF-8")
}
