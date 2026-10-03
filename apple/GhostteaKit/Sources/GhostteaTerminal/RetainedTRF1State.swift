import Foundation
import GhostteaFrame
import GhostteaPerformance

struct RetainedTRF1Row: Equatable, Sendable {
  var text = ""
  var accessibilityText = ""
  var revision: UInt64 = 0
  var glyphs: [TRF1GlyphInstance] = []
  var styles: [TRF1StyleRun] = []
}

enum RetainedTRF1ApplyResult: Equatable, Sendable {
  case applied(
    fullSnapshot: Bool, changedRows: [UInt16], completedResync: Bool, clipboardWrites: [String])
  case stale
  case needsFullRefresh
}

private enum RetainedTRF1Classification {
  case accept
  case stale
  case resync
}

private enum RetainedTRF1Preparation {
  case stale
  case resync
  case transaction(RetainedTRF1Transaction)
}

private enum RetainedTRF1SelectionUpdate {
  case unchanged
  case replace(TRF1SelectionState?)
}

private struct RetainedTRF1Transaction {
  let frame: TRF1Frame
  let fullSnapshot: Bool
  let resetCatalogs: Bool
  let completedResync: Bool
  let replacements: [TRF1RowReplacement]
  let accessibilityByRow: [UInt16: String]
  let accessibilityOnlyRows: [UInt16]
  let glyphs: [TRF1GlyphDefinition]
  let styles: [TRF1StyleDefinition]
  let cursor: TRF1CursorState
  let scrollbar: TRF1ScrollbarState?
  let selection: RetainedTRF1SelectionUpdate
  let clipboardWrites: [String]
  let changedRows: [UInt16]
}

struct RetainedTRF1State: Equatable, Sendable {
  private(set) var sessionHandle: UInt64 = 0
  private(set) var sessionEpoch: UInt64 = 0
  private(set) var layoutEpoch: UInt64 = 0
  private(set) var sequence: UInt64 = 0
  private(set) var terminalRevision: UInt64 = 0
  private(set) var columns: UInt16 = 0
  private(set) var rows: [RetainedTRF1Row] = []
  private(set) var glyphDefinitions: [UInt32: TRF1GlyphDefinition] = [:]
  private(set) var styleDefinitions: [UInt32: TRF1StyleDefinition] = [:]
  private(set) var cursor: TRF1CursorState?
  private(set) var scrollbar: TRF1ScrollbarState?
  private(set) var selection: TRF1SelectionState?
  private(set) var mouseTracking = false
  private(set) var awaitingResync = false

  var residentGlyphPixelBytes: Int {
    glyphDefinitions.values.reduce(into: 0) { total, definition in
      total =
        total > Int.max - definition.pixels.count
        ? Int.max
        : total + definition.pixels.count
    }
  }

  @discardableResult
  mutating func evictReconstructibleRenderState() -> Int {
    let released = residentGlyphPixelBytes
    glyphDefinitions.removeAll(keepingCapacity: false)
    styleDefinitions.removeAll(keepingCapacity: false)
    for index in rows.indices {
      rows[index].glyphs.removeAll(keepingCapacity: false)
      rows[index].styles.removeAll(keepingCapacity: false)
    }
    if sessionHandle != 0 { awaitingResync = true }
    return released
  }

  mutating func apply(
    _ data: Data,
    inPlaceCommitEnabled: Bool = true
  ) throws -> RetainedTRF1ApplyResult {
    do {
      let recorder = GhostteaPerformanceRecorder.shared
      let frame = try recorder.measure(.trf1FrameDecode, byteCount: data.count) {
        try decodeTRF1Frame(data)
      }
      let preparation = try recorder.measure(.retainedStatePrepare) {
        try prepare(frame)
      }
      switch preparation {
      case .stale:
        return .stale
      case .resync:
        awaitingResync = true
        return .needsFullRefresh
      case .transaction(let transaction):
        recorder.measure(.retainedStateCommit) {
          if inPlaceCommitEnabled {
            commit(transaction)
          } else {
            var next = self
            next.commit(transaction)
            self = next
          }
        }
        return .applied(
          fullSnapshot: transaction.fullSnapshot,
          changedRows: transaction.changedRows,
          completedResync: transaction.completedResync,
          clipboardWrites: transaction.clipboardWrites
        )
      }
    } catch {
      awaitingResync = true
      throw error
    }
  }

  private func prepare(_ frame: TRF1Frame) throws -> RetainedTRF1Preparation {
    if sessionHandle != 0 && frame.sessionHandle != sessionHandle {
      throw TRF1DecodingError("frame belongs to a different terminal session")
    }
    let fullFrame = frame.flags.contains(.fullSnapshot)
    switch classify(frame: frame, full: fullFrame) {
    case .stale:
      return .stale
    case .resync:
      return .resync
    case .accept:
      break
    }

    var sections: [TRF1SectionKind: TRF1Section] = [:]
    var clipboardSections: [TRF1Section] = []
    sections.reserveCapacity(frame.sections.count)
    for section in frame.sections {
      if section.kind == .clipboardWrite {
        clipboardSections.append(section)
      } else if sections[section.kind] == nil {
        sections[section.kind] = section
      }
    }
    guard let rowSection = sections[.rowReplacements] else {
      throw TRF1DecodingError("missing row replacement section")
    }
    guard let cursorSection = sections[.cursorState] else {
      throw TRF1DecodingError("missing cursor section")
    }
    let fullRows = rowSection.flags & TRF1FrameFlags.fullSnapshot.rawValue != 0
    guard fullRows == fullFrame else {
      throw TRF1DecodingError("frame and row snapshot flags disagree")
    }

    let decodedReplacements = try decodeTRF1RowReplacements(rowSection)
    let accessibilityRows =
      try sections[.accessibilityText].map(
        decodeTRF1AccessibilityRows) ?? []
    let nextCursor = try decodeTRF1CursorState(cursorSection)
    let glyphs = try sections[.glyphDefinitions].map(decodeTRF1GlyphDefinitions) ?? []
    let styles =
      try sections[.styleDefinitions].map {
        try decodeTRF1StyleDefinitions($0, palette: sections[.stylePalette])
      } ?? []
    let nextScrollbar = try sections[.scrollbarState].map(decodeTRF1ScrollbarState)
    let nextSelection = try sections[.selectionSpans].map(decodeTRF1SelectionState)
    let clipboardWrites = try clipboardSections.map(decodeTRF1ClipboardWrite)

    let changedSession = sessionEpoch != 0 && frame.sessionEpoch != sessionEpoch
    let completingResync = awaitingResync
    if !fullRows && rows.count != Int(frame.rows) {
      throw TRF1DecodingError("incremental frame changed viewport row count")
    }

    var accessibilityByRow: [UInt16: String] = [:]
    accessibilityByRow.reserveCapacity(accessibilityRows.count)
    for row in accessibilityRows {
      guard Int(row.row) < Int(frame.rows) else {
        throw TRF1DecodingError("accessibility row exceeds viewport")
      }
      guard accessibilityByRow.updateValue(row.text, forKey: row.row) == nil else {
        throw TRF1DecodingError("duplicate accessibility row")
      }
    }

    var acceptedReplacements: [TRF1RowReplacement] = []
    acceptedReplacements.reserveCapacity(decodedReplacements.count)
    var changedRows: [UInt16] = []
    changedRows.reserveCapacity(decodedReplacements.count)
    var revisions =
      fullRows
      ? Array(repeating: UInt64(0), count: Int(frame.rows))
      : rows.map(\.revision)
    for replacement in decodedReplacements {
      guard Int(replacement.row) < revisions.count else {
        throw TRF1DecodingError("row replacement exceeds viewport")
      }
      if replacement.revision < revisions[Int(replacement.row)] {
        continue
      }
      revisions[Int(replacement.row)] = replacement.revision
      acceptedReplacements.append(replacement)
      changedRows.append(replacement.row)
    }
    let changedRowSet = Set(changedRows)
    let accessibilityOnlyRows = accessibilityByRow.keys.filter { !changedRowSet.contains($0) }

    return .transaction(
      RetainedTRF1Transaction(
        frame: frame,
        fullSnapshot: fullFrame,
        resetCatalogs: changedSession || completingResync,
        completedResync: completingResync,
        replacements: acceptedReplacements,
        accessibilityByRow: accessibilityByRow,
        accessibilityOnlyRows: accessibilityOnlyRows,
        glyphs: glyphs,
        styles: styles,
        cursor: nextCursor,
        scrollbar: nextScrollbar,
        selection: sections[.selectionSpans] == nil ? .unchanged : .replace(nextSelection ?? nil),
        clipboardWrites: clipboardWrites,
        changedRows: changedRows
      )
    )
  }

  private mutating func commit(_ transaction: RetainedTRF1Transaction) {
    let frame = transaction.frame
    if transaction.resetCatalogs {
      rows.removeAll(keepingCapacity: false)
      glyphDefinitions.removeAll(keepingCapacity: false)
      styleDefinitions.removeAll(keepingCapacity: false)
    }
    for definition in transaction.glyphs {
      glyphDefinitions[definition.id] = definition
    }
    for definition in transaction.styles {
      styleDefinitions[definition.id] = definition
    }
    if transaction.fullSnapshot {
      rows = Array(repeating: RetainedTRF1Row(), count: Int(frame.rows))
    }
    for replacement in transaction.replacements {
      rows[Int(replacement.row)] = RetainedTRF1Row(
        text: replacement.text,
        accessibilityText: transaction.accessibilityByRow[replacement.row] ?? replacement.text,
        revision: replacement.revision,
        glyphs: replacement.glyphs,
        styles: replacement.styles
      )
    }
    for row in transaction.accessibilityOnlyRows {
      rows[Int(row)].accessibilityText = transaction.accessibilityByRow[row]!
    }

    sessionHandle = frame.sessionHandle
    sessionEpoch = frame.sessionEpoch
    layoutEpoch = frame.layoutEpoch
    sequence = frame.frameSequence
    terminalRevision = frame.terminalRevision
    columns = frame.columns
    cursor = transaction.cursor
    mouseTracking = frame.flags.contains(.mouseTracking)
    if let scrollbar = transaction.scrollbar {
      self.scrollbar = scrollbar
    }
    if case .replace(let selection) = transaction.selection {
      self.selection = selection
    }
    awaitingResync = false
  }

  private func classify(frame: TRF1Frame, full: Bool) -> RetainedTRF1Classification {
    let sameSession = sessionEpoch == 0 || frame.sessionEpoch == sessionEpoch
    if sameSession
      && (frame.layoutEpoch < layoutEpoch
        || (frame.layoutEpoch == layoutEpoch && frame.frameSequence <= sequence))
    {
      return .stale
    }
    if awaitingResync && !full {
      return .resync
    }
    let changedSession = !sameSession
    let missingInitialSnapshot = sessionEpoch == 0 && !full
    let sequenceGap: Bool
    if sessionEpoch == frame.sessionEpoch && sequence != 0 {
      sequenceGap = sequence == UInt64.max || frame.frameSequence != sequence + 1
    } else {
      sequenceGap = false
    }
    return !full && (changedSession || missingInitialSnapshot || sequenceGap) ? .resync : .accept
  }
}
