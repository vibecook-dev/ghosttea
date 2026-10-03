import Foundation
import GhostteaCore
import Testing

@testable import GhostteaFrame
@testable import GhostteaTerminal

private func writeUInt16(_ value: UInt16, to data: inout Data, at offset: Int) {
  data[offset] = UInt8(truncatingIfNeeded: value)
  data[offset + 1] = UInt8(truncatingIfNeeded: value >> 8)
}

private func writeUInt32(_ value: UInt32, to data: inout Data, at offset: Int) {
  for byte in 0..<4 {
    data[offset + byte] = UInt8(truncatingIfNeeded: value >> UInt32(byte * 8))
  }
}

private func writeUInt64(_ value: UInt64, to data: inout Data, at offset: Int) {
  for byte in 0..<8 {
    data[offset + byte] = UInt8(truncatingIfNeeded: value >> UInt64(byte * 8))
  }
}

private func readUInt16(_ data: Data, at offset: Int) -> UInt16 {
  UInt16(data[offset]) | UInt16(data[offset + 1]) << 8
}

private func readUInt32(_ data: Data, at offset: Int) -> UInt32 {
  UInt32(data[offset])
    | UInt32(data[offset + 1]) << 8
    | UInt32(data[offset + 2]) << 16
    | UInt32(data[offset + 3]) << 24
}

private func readUInt64(_ data: Data, at offset: Int) -> UInt64 {
  var value: UInt64 = 0
  for byte in 0..<8 {
    value |= UInt64(data[offset + byte]) << UInt64(byte * 8)
  }
  return value
}

private func sectionPayloadOffset(_ data: Data, kind: TRF1SectionKind) -> Int? {
  for index in 0..<Int(readUInt16(data, at: 60)) {
    let base = TRF1.frameHeaderBytes + index * TRF1.sectionHeaderBytes
    if readUInt16(data, at: base) == kind.rawValue {
      return Int(readUInt32(data, at: base + 4))
    }
  }
  return nil
}

private func framePayload(_ update: GhostteaUpdate) throws -> Data {
  try #require(update.effects.first { $0.kind == .frameReady }?.payload)
}

private func accessibilityFixture(_ text: String = "hello") -> Data {
  let textBytes = Data(text.utf8)
  let payloadLength = 2 + 6 + textBytes.count
  var data = Data(
    repeating: 0, count: TRF1.frameHeaderBytes + TRF1.sectionHeaderBytes + payloadLength)
  writeUInt32(TRF1.magic, to: &data, at: 0)
  writeUInt16(TRF1.protocolVersion, to: &data, at: 4)
  writeUInt64(7, to: &data, at: 8)
  writeUInt64(3, to: &data, at: 40)
  writeUInt16(80, to: &data, at: 56)
  writeUInt16(24, to: &data, at: 58)
  writeUInt16(1, to: &data, at: 60)
  writeUInt16(TRF1SectionKind.accessibilityText.rawValue, to: &data, at: 64)
  writeUInt32(80, to: &data, at: 68)
  writeUInt32(UInt32(payloadLength), to: &data, at: 72)
  writeUInt32(1, to: &data, at: 76)
  writeUInt16(1, to: &data, at: 80)
  writeUInt16(0, to: &data, at: 82)
  writeUInt32(UInt32(textBytes.count), to: &data, at: 84)
  data.replaceSubrange(88..<(88 + textBytes.count), with: textBytes)
  return data
}

private struct TRF1FuzzGenerator {
  var state: UInt64 = 0x5452_4631_4655_5A5A

  mutating func next() -> UInt64 {
    state ^= state << 13
    state ^= state >> 7
    state ^= state << 17
    return state
  }

  mutating func data(maximumCount: Int) -> Data {
    let count = Int(next() % UInt64(maximumCount + 1))
    return Data((0..<count).map { _ in UInt8(truncatingIfNeeded: next()) })
  }
}

private func exerciseEveryTRF1Decoder(_ data: Data) {
  guard let frame = try? decodeTRF1Frame(data) else { return }
  for section in frame.sections {
    switch section.kind {
    case .glyphDefinitions:
      _ = try? decodeTRF1GlyphDefinitions(section)
    case .styleDefinitions:
      _ = try? decodeTRF1StyleDefinitions(section)
    case .stylePalette:
      _ = try? decodeTRF1StylePalette(section)
    case .rowReplacements:
      _ = try? decodeTRF1RowReplacements(section)
    case .cursorState:
      _ = try? decodeTRF1CursorState(section)
    case .scrollbarState:
      _ = try? decodeTRF1ScrollbarState(section)
    case .selectionSpans:
      _ = try? decodeTRF1SelectionState(section)
    case .accessibilityText:
      _ = try? decodeTRF1AccessibilityRows(section)
    case .clipboardWrite:
      _ = try? decodeTRF1ClipboardWrite(section)
    default:
      break
    }
  }
}

@Test func decodesTheDesktopAccessibilityFixtureShape() throws {
  let frame = try decodeTRF1Frame(accessibilityFixture())
  #expect(frame.sessionHandle == 7)
  #expect(frame.frameSequence == 3)
  #expect(frame.columns == 80)
  #expect(frame.rows == 24)
  #expect(
    try decodeTRF1AccessibilityRows(frame.sections[0]) == [TRF1TextRow(row: 0, text: "hello")])
}

@Test func decodesAProductionCoreFrameAndEveryEmittedSection() async throws {
  let runtime = try GhostteaRuntime()
  let terminal = try GhostteaTerminal(
    runtime: runtime,
    configuration: .init(sessionHandle: 73, sessionEpoch: 4, layoutEpoch: 9, columns: 100, rows: 30)
  )
  let update = try await terminal.feed(Data("phase4 ✓ 界\r\n".utf8), render: .full)
  let bytes = try #require(update.effects.first { $0.kind == .frameReady }?.payload)
  let frame = try decodeTRF1Frame(bytes)
  #expect(frame.flags.contains(.fullSnapshot))
  #expect(frame.sessionHandle == 73)
  #expect(frame.sessionEpoch == 4)
  #expect(frame.layoutEpoch == 9)
  #expect(frame.columns == 100)
  #expect(frame.rows == 30)

  let glyphSection = try #require(frame.sections.first { $0.kind == .glyphDefinitions })
  let styleSection = try #require(frame.sections.first { $0.kind == .styleDefinitions })
  let rowSection = try #require(frame.sections.first { $0.kind == .rowReplacements })
  let cursorSection = try #require(frame.sections.first { $0.kind == .cursorState })
  let accessibilitySection = try #require(frame.sections.first { $0.kind == .accessibilityText })
  let scrollbarSection = try #require(frame.sections.first { $0.kind == .scrollbarState })
  let selectionSection = try #require(frame.sections.first { $0.kind == .selectionSpans })

  #expect(try !decodeTRF1GlyphDefinitions(glyphSection).isEmpty)
  #expect(try !decodeTRF1StyleDefinitions(styleSection).isEmpty)
  #expect(try decodeTRF1RowReplacements(rowSection).contains { $0.text.contains("phase4 ✓ 界") })
  #expect(try decodeTRF1CursorState(cursorSection).y == 1)
  #expect(
    try decodeTRF1AccessibilityRows(accessibilitySection).contains {
      $0.text.contains("phase4 ✓ 界")
    })
  let scrollbar = try decodeTRF1ScrollbarState(scrollbarSection)
  #expect(scrollbar.length == 30)
  #expect(scrollbar.length <= scrollbar.total)
  #expect(try decodeTRF1SelectionState(selectionSection) == nil)
}

@Test func decodesTrackedSelectionEndpointsAndExplicitClear() throws {
  var bytes = Data(repeating: 0, count: 12)
  writeUInt16(2, to: &bytes, at: 0)
  writeUInt32(41, to: &bytes, at: 2)
  writeUInt16(8, to: &bytes, at: 6)
  writeUInt32(43, to: &bytes, at: 8)
  let selected = try decodeTRF1SelectionState(
    TRF1Section(kind: .selectionSpans, flags: 0, itemCount: 1, bytes: bytes)
  )
  #expect(
    selected
      == TRF1SelectionState(
        anchor: TRF1SelectionPoint(column: 2, row: 41),
        focus: TRF1SelectionPoint(column: 8, row: 43)
      )
  )
  #expect(
    try decodeTRF1SelectionState(
      TRF1Section(kind: .selectionSpans, flags: 0, itemCount: 0, bytes: Data())
    ) == nil
  )
  #expect(throws: TRF1DecodingError.self) {
    try decodeTRF1SelectionState(
      TRF1Section(kind: .selectionSpans, flags: 0, itemCount: 1, bytes: Data())
    )
  }
}

@Test func retainedSelectionFollowsAlternateScreenGridScroll() async throws {
  let runtime = try GhostteaRuntime()
  let terminal = try GhostteaTerminal(
    runtime: runtime,
    configuration: .init(sessionHandle: 812, sessionEpoch: 1, columns: 12, rows: 3)
  )
  let full = try framePayload(
    await terminal.feed(Data("\u{1b}[?1049hfirst\r\nsecond\r\nthird".utf8), render: .full)
  )
  _ = try await terminal.selectionText(
    startColumn: 0, startRow: 1, endColumn: 5, endRow: 1)
  let scrolled = try framePayload(
    await terminal.feed(Data("\u{1b}[1S".utf8), render: .damage)
  )

  var state = RetainedTRF1State()
  _ = try state.apply(full)
  _ = try state.apply(scrolled)
  #expect(state.selection?.anchor.row == 0)
  #expect(state.selection?.focus.row == 0)
}

@Test func rejectsMalformedFrameEnvelopeBeforeSectionAllocation() {
  var wrongVersion = accessibilityFixture()
  writeUInt16(TRF1.protocolVersion + 1, to: &wrongVersion, at: 4)
  #expect(throws: TRF1DecodingError.self) {
    try decodeTRF1Frame(wrongVersion)
  }

  var invalidSection = accessibilityFixture()
  writeUInt32(UInt32.max - 15, to: &invalidSection, at: 68)
  #expect(throws: TRF1DecodingError.self) {
    try decodeTRF1Frame(invalidSection)
  }

  #expect(throws: TRF1DecodingError.self) {
    try decodeTRF1Frame(Data(repeating: 0, count: TRF1.maximumFrameBytes + 1))
  }
}

@Test func deterministicTRF1DecoderFuzzSmoke() {
  var generator = TRF1FuzzGenerator()
  let seed = accessibilityFixture("fuzz ✓")

  for iteration in 0..<4_096 {
    var candidate: Data
    if iteration.isMultiple(of: 2) {
      candidate = seed
      let mutations = 1 + Int(generator.next() % 8)
      for _ in 0..<mutations {
        let offset = Int(generator.next() % UInt64(candidate.count))
        candidate[offset] = UInt8(truncatingIfNeeded: generator.next())
      }
      if iteration.isMultiple(of: 16) {
        candidate.removeLast(Int(generator.next() % UInt64(candidate.count + 1)))
      }
    } else {
      candidate = generator.data(maximumCount: 4_096)
      if candidate.count >= TRF1.frameHeaderBytes && iteration.isMultiple(of: 3) {
        writeUInt32(TRF1.magic, to: &candidate, at: 0)
        writeUInt16(TRF1.protocolVersion, to: &candidate, at: 4)
      }
    }
    exerciseEveryTRF1Decoder(candidate)

    let section = TRF1Section(
      kind: TRF1SectionKind(rawValue: UInt16(truncatingIfNeeded: generator.next())),
      flags: UInt16(truncatingIfNeeded: generator.next()),
      itemCount: UInt32(truncatingIfNeeded: generator.next()),
      bytes: generator.data(maximumCount: 2_048)
    )
    _ = try? decodeTRF1GlyphDefinitions(section)
    _ = try? decodeTRF1StyleDefinitions(section)
    _ = try? decodeTRF1RowReplacements(section)
    _ = try? decodeTRF1CursorState(section)
    _ = try? decodeTRF1ScrollbarState(section)
    _ = try? decodeTRF1SelectionState(section)
    _ = try? decodeTRF1AccessibilityRows(section)
    _ = try? decodeTRF1ClipboardWrite(section)
  }
}

@Test func rejectsInvalidUTF8CountsPixelsAndReservedFields() throws {
  var invalidUTF8 = accessibilityFixture()
  invalidUTF8[88] = 0xff
  let textFrame = try decodeTRF1Frame(invalidUTF8)
  #expect(throws: TRF1DecodingError.self) {
    try decodeTRF1AccessibilityRows(textFrame.sections[0])
  }

  var glyphBytes = Data(repeating: 0, count: 4 + 20 + 4)
  writeUInt32(1, to: &glyphBytes, at: 0)
  writeUInt32(12, to: &glyphBytes, at: 4)
  writeUInt16(2, to: &glyphBytes, at: 8)
  writeUInt16(2, to: &glyphBytes, at: 10)
  writeUInt32(3, to: &glyphBytes, at: 20)
  let glyphSection = TRF1Section(kind: .glyphDefinitions, flags: 0, itemCount: 1, bytes: glyphBytes)
  #expect(throws: TRF1DecodingError.self) {
    try decodeTRF1GlyphDefinitions(glyphSection)
  }

  var hostileCount = Data(repeating: 0, count: 4)
  writeUInt32(UInt32.max, to: &hostileCount, at: 0)
  #expect(throws: TRF1DecodingError.self) {
    try decodeTRF1GlyphDefinitions(
      TRF1Section(kind: .glyphDefinitions, flags: 0, itemCount: UInt32.max, bytes: hostileCount)
    )
  }

  var styleBytes = Data(repeating: 0, count: 20)
  writeUInt32(1, to: &styleBytes, at: 0)
  styleBytes[18] = 1
  let styleSection = TRF1Section(kind: .styleDefinitions, flags: 0, itemCount: 1, bytes: styleBytes)
  #expect(throws: TRF1DecodingError.self) {
    try decodeTRF1StyleDefinitions(styleSection)
  }

  let cursorSection = TRF1Section(
    kind: .cursorState,
    flags: 0,
    itemCount: 1,
    bytes: Data([0, 0, 0, 0, 1, 4, 0, 0])
  )
  #expect(throws: TRF1DecodingError.self) {
    try decodeTRF1CursorState(cursorSection)
  }
}

@Test func decodesClipboardAndRejectsUnboundedScrollbarState() throws {
  let text = Data("copied ✓".utf8)
  var clipboard = Data(repeating: 0, count: 4 + text.count)
  writeUInt32(UInt32(text.count), to: &clipboard, at: 0)
  clipboard.replaceSubrange(4..<(4 + text.count), with: text)
  #expect(
    try decodeTRF1ClipboardWrite(
      TRF1Section(kind: .clipboardWrite, flags: 0, itemCount: 1, bytes: clipboard)
    ) == "copied ✓"
  )

  var scrollbar = Data(repeating: 0, count: 24)
  writeUInt64(10, to: &scrollbar, at: 0)
  writeUInt64(9, to: &scrollbar, at: 8)
  writeUInt64(2, to: &scrollbar, at: 16)
  #expect(throws: TRF1DecodingError.self) {
    try decodeTRF1ScrollbarState(
      TRF1Section(kind: .scrollbarState, flags: 0, itemCount: 1, bytes: scrollbar)
    )
  }
}

@Test func retainedStateAppliesFullAndIncrementalFramesAndRejectsStaleFrames() async throws {
  let runtime = try GhostteaRuntime()
  let terminal = try GhostteaTerminal(
    runtime: runtime,
    configuration: .init(sessionHandle: 91, sessionEpoch: 3, layoutEpoch: 7, columns: 80, rows: 12)
  )
  let full = try framePayload(
    await terminal.feed(Data("first\r\n".utf8), render: .full)
  )
  let incremental = try framePayload(
    await terminal.feed(Data("second ✓\r\n".utf8), render: .damage)
  )

  var state = RetainedTRF1State()
  guard
    case .applied(let fullSnapshot, let changedRows, let completedResync, _) = try state.apply(full)
  else {
    Issue.record("initial full frame was not applied")
    return
  }
  #expect(fullSnapshot)
  #expect(changedRows.count == 12)
  #expect(!completedResync)
  #expect(state.rows[0].text.contains("first"))
  #expect(!state.glyphDefinitions.isEmpty)
  #expect(!state.styleDefinitions.isEmpty)

  guard case .applied(let nextWasFull, let nextChangedRows, _, _) = try state.apply(incremental)
  else {
    Issue.record("next incremental frame was not applied")
    return
  }
  #expect(!nextWasFull)
  #expect(!nextChangedRows.isEmpty)
  #expect(state.rows[1].text.contains("second ✓"))
  #expect(state.sequence == readUInt64(incremental, at: 40))
  #expect(try state.apply(incremental) == .stale)
}

@Test func retainedStateInPlaceAndCopyCommitsRemainExactlyEquivalent() async throws {
  let runtime = try GhostteaRuntime()
  let terminal = try GhostteaTerminal(
    runtime: runtime,
    configuration: .init(sessionHandle: 911, sessionEpoch: 3, layoutEpoch: 7, columns: 80, rows: 12)
  )
  let full = try framePayload(await terminal.feed(Data("first\r\n".utf8), render: .full))
  let second = try framePayload(await terminal.feed(Data("second ✓\r\n".utf8), render: .damage))
  let third = try framePayload(await terminal.feed(Data("third 界\r\n".utf8), render: .damage))
  let frames = [full, second, third]
  var inPlace = RetainedTRF1State()
  var copied = RetainedTRF1State()
  for frame in frames {
    let inPlaceResult = try inPlace.apply(frame, inPlaceCommitEnabled: true)
    let copiedResult = try copied.apply(frame, inPlaceCommitEnabled: false)
    #expect(inPlaceResult == copiedResult)
    #expect(inPlace == copied)
  }
}

@Test func retainedStateRequestsAndCompletesFullResynchronization() async throws {
  let runtime = try GhostteaRuntime()
  let terminal = try GhostteaTerminal(
    runtime: runtime,
    configuration: .init(sessionHandle: 92, sessionEpoch: 1, layoutEpoch: 1, columns: 80, rows: 10)
  )
  let full = try framePayload(await terminal.feed(Data("baseline\r\n".utf8), render: .full))
  let incremental = try framePayload(await terminal.feed(Data("delta\r\n".utf8), render: .damage))
  var gapped = incremental
  writeUInt64(readUInt64(incremental, at: 40) + 2, to: &gapped, at: 40)

  var state = RetainedTRF1State()
  _ = try state.apply(full)
  let acceptedSequence = state.sequence
  #expect(try state.apply(gapped) == .needsFullRefresh)
  #expect(state.awaitingResync)
  #expect(state.sequence == acceptedSequence)
  #expect(try state.apply(incremental) == .needsFullRefresh)

  let recovery = try framePayload(await terminal.refresh(.full))
  guard case .applied(let fullSnapshot, _, let completedResync, _) = try state.apply(recovery)
  else {
    Issue.record("full recovery frame was not applied")
    return
  }
  #expect(fullSnapshot)
  #expect(completedResync)
  #expect(!state.awaitingResync)
  #expect(state.sequence == readUInt64(recovery, at: 40))
  #expect(!state.glyphDefinitions.isEmpty)
}

@Test func retainedStateEvictsReconstructibleGlyphsAndRequiresAFullFrame() async throws {
  let runtime = try GhostteaRuntime()
  let terminal = try GhostteaTerminal(
    runtime: runtime,
    configuration: .init(sessionHandle: 921, sessionEpoch: 1, columns: 80, rows: 10)
  )
  let full = try framePayload(
    await terminal.feed(Data("memory pressure ✓\r\n".utf8), render: .full))
  let incremental = try framePayload(
    await terminal.feed(Data("incremental\r\n".utf8), render: .damage))
  var state = RetainedTRF1State()
  _ = try state.apply(full)
  let retainedText = state.rows.map(\.text)
  let resident = state.residentGlyphPixelBytes

  #expect(resident > 0)
  #expect(state.evictReconstructibleRenderState() == resident)
  #expect(state.residentGlyphPixelBytes == 0)
  #expect(state.glyphDefinitions.isEmpty)
  #expect(state.styleDefinitions.isEmpty)
  #expect(state.rows.allSatisfy { $0.glyphs.isEmpty && $0.styles.isEmpty })
  #expect(state.rows.map(\.text) == retainedText)
  #expect(state.awaitingResync)
  #expect(try state.apply(incremental) == .needsFullRefresh)

  let recovery = try framePayload(await terminal.refresh(.full))
  guard case .applied(let fullSnapshot, _, let completedResync, _) = try state.apply(recovery)
  else {
    Issue.record("memory-pressure recovery frame was not applied")
    return
  }
  #expect(fullSnapshot)
  #expect(completedResync)
  #expect(!state.awaitingResync)
  #expect(state.residentGlyphPixelBytes > 0)
}

@Test func retainedStateIsAtomicOnMalformedRowsAndSkipsOlderRowRevisions() async throws {
  let runtime = try GhostteaRuntime()
  let terminal = try GhostteaTerminal(
    runtime: runtime,
    configuration: .init(sessionHandle: 93, columns: 80, rows: 8)
  )
  let full = try framePayload(await terminal.feed(Data("stable\r\n".utf8), render: .full))
  let incremental = try framePayload(await terminal.feed(Data("newer\r\n".utf8), render: .damage))
  let payloadOffset = try #require(sectionPayloadOffset(incremental, kind: .rowReplacements))

  var state = RetainedTRF1State()
  _ = try state.apply(full)
  let baselineRows = state.rows
  let baselineGlyphs = state.glyphDefinitions
  let baselineSequence = state.sequence

  var invalidRow = incremental
  writeUInt16(UInt16.max, to: &invalidRow, at: payloadOffset + 2)
  #expect(throws: TRF1DecodingError.self) {
    try state.apply(invalidRow)
  }
  #expect(state.rows == baselineRows)
  #expect(state.glyphDefinitions == baselineGlyphs)
  #expect(state.sequence == baselineSequence)
  #expect(state.awaitingResync)

  var recovered = RetainedTRF1State()
  _ = try recovered.apply(full)
  var olderRevision = incremental
  writeUInt64(0, to: &olderRevision, at: payloadOffset + 4)
  _ = try recovered.apply(olderRevision)
  #expect(recovered.rows[1].text.isEmpty)
  #expect(recovered.sequence == readUInt64(incremental, at: 40))
}

@Test func retainedStateRequiresAnInitialFullSnapshot() async throws {
  let runtime = try GhostteaRuntime()
  let terminal = try GhostteaTerminal(
    runtime: runtime,
    configuration: .init(sessionHandle: 94)
  )
  _ = try framePayload(await terminal.feed(Data("initial".utf8), render: .damage))
  let incremental = try framePayload(
    await terminal.feed(Data(" incremental".utf8), render: .damage))
  var state = RetainedTRF1State()
  #expect(try state.apply(incremental) == .needsFullRefresh)
  #expect(state.awaitingResync)
  #expect(state.sessionHandle == 0)
}

@Test func retainedStateAcceptsFullSessionEpochReplacementAndResetsCatalogs() async throws {
  let runtime = try GhostteaRuntime()
  let firstTerminal = try GhostteaTerminal(
    runtime: runtime,
    configuration: .init(sessionHandle: 95, sessionEpoch: 1, columns: 80, rows: 6)
  )
  let replacementTerminal = try GhostteaTerminal(
    runtime: runtime,
    configuration: .init(sessionHandle: 95, sessionEpoch: 2, columns: 80, rows: 6)
  )
  let first = try framePayload(await firstTerminal.feed(Data("abcdefgh\r\n".utf8), render: .full))
  let replacement = try framePayload(
    await replacementTerminal.feed(Data("x\r\n".utf8), render: .full))
  let decodedReplacement = try decodeTRF1Frame(replacement)
  let replacementGlyphs = try decodeTRF1GlyphDefinitions(
    #require(decodedReplacement.sections.first { $0.kind == .glyphDefinitions })
  )

  var state = RetainedTRF1State()
  _ = try state.apply(first)
  #expect(state.glyphDefinitions.count > replacementGlyphs.count)
  guard case .applied(let full, _, _, _) = try state.apply(replacement) else {
    Issue.record("replacement session full frame was not applied")
    return
  }
  #expect(full)
  #expect(state.sessionEpoch == 2)
  #expect(Set(state.glyphDefinitions.keys) == Set(replacementGlyphs.map(\.id)))
  #expect(state.rows[0].text == "x")
}

private func styleSection(
  _ styles: [(id: UInt32, foreground: Bool, background: Bool)]
) -> TRF1Section {
  var bytes = Data(repeating: 0, count: 4 + styles.count * 16)
  writeUInt32(UInt32(styles.count), to: &bytes, at: 0)
  for (index, style) in styles.enumerated() {
    let offset = 4 + index * 16
    writeUInt32(style.id, to: &bytes, at: offset)
    bytes[offset + 6] = style.foreground ? 1 : 0
    bytes[offset + 7] = style.background ? 1 : 0
    bytes[offset + 8] = 0xcc
    bytes[offset + 11] = 0x81
  }
  return TRF1Section(
    kind: .styleDefinitions, flags: 0, itemCount: UInt32(styles.count), bytes: bytes)
}

private func paletteSection(
  _ entries: [(id: UInt32, flags: UInt8, foreground: UInt8, background: UInt8)],
  itemCount: UInt32? = nil
) -> TRF1Section {
  var bytes = Data(repeating: 0, count: 4 + entries.count * 8)
  writeUInt32(UInt32(entries.count), to: &bytes, at: 0)
  for (index, entry) in entries.enumerated() {
    let offset = 4 + index * 8
    writeUInt32(entry.id, to: &bytes, at: offset)
    bytes[offset + 4] = entry.flags
    bytes[offset + 5] = entry.foreground
    bytes[offset + 6] = entry.background
  }
  return TRF1Section(
    kind: .stylePalette, flags: 0, itemCount: itemCount ?? UInt32(entries.count), bytes: bytes)
}

@Test func decodesStylePaletteProvenanceOnlyForExplicitColors() throws {
  let styles = styleSection([(1, true, false), (2, true, true), (3, false, false)])
  let palette = paletteSection([(1, 0b11, 9, 4), (2, 0b10, 0, 12)])
  #expect(
    try decodeTRF1StylePalette(palette) == [
      TRF1StylePaletteEntry(styleID: 1, foreground: 9, background: 4),
      TRF1StylePaletteEntry(styleID: 2, foreground: nil, background: 12),
    ])

  let decoded = try decodeTRF1StyleDefinitions(styles, palette: palette)
  // Style 1 has no explicit background, so its background index is dropped.
  #expect(decoded[0].foregroundPalette == 9)
  #expect(decoded[0].backgroundPalette == nil)
  #expect(decoded[1].foregroundPalette == nil)
  #expect(decoded[1].backgroundPalette == 12)
  #expect(decoded[2].foregroundPalette == nil && decoded[2].backgroundPalette == nil)
  // RGB stays authoritative: decoding without the section differs only in provenance.
  let plain = try decodeTRF1StyleDefinitions(styles)
  #expect(plain.map(\.foreground) == decoded.map(\.foreground))
  #expect(plain.allSatisfy { $0.foregroundPalette == nil && $0.backgroundPalette == nil })
}

@Test func rejectsMalformedStylePaletteSections() {
  for flags: UInt8 in [0b100, 0x80] {
    #expect(throws: TRF1DecodingError("invalid style palette flags")) {
      try decodeTRF1StylePalette(paletteSection([(1, flags, 1, 1)]))
    }
  }
  #expect(throws: TRF1DecodingError("style palette count mismatch")) {
    try decodeTRF1StylePalette(paletteSection([(1, 1, 1, 0)], itemCount: 2))
  }
  var truncated = paletteSection([(1, 1, 1, 0)]).bytes
  truncated.removeLast()
  #expect(throws: TRF1DecodingError.self) {
    try decodeTRF1StylePalette(
      TRF1Section(kind: .stylePalette, flags: 0, itemCount: 1, bytes: truncated))
  }
  #expect(throws: TRF1DecodingError("wrong style palette section kind")) {
    try decodeTRF1StylePalette(
      TRF1Section(kind: .styleDefinitions, flags: 0, itemCount: 0, bytes: Data(count: 4)))
  }
  // A malformed palette fails the style decode that consumes it.
  #expect(throws: TRF1DecodingError("invalid style palette flags")) {
    try decodeTRF1StyleDefinitions(
      styleSection([(1, true, false)]), palette: paletteSection([(1, 0b1000, 1, 0)]))
  }
}

/// The shared golden frame produced by the Rust core and decoded by the
/// TypeScript package, so the Swift decoder is held to the same bytes.
private func ansiBaselineFrame() throws -> Data {
  let fixture = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent()
    .appendingPathComponent("../../../../native/ghosttea/fixtures/phase1/ansi-baseline.json")
    .standardizedFileURL
  let object = try JSONSerialization.jsonObject(with: Data(contentsOf: fixture))
  let hex = try #require((object as? [String: Any])?["expectedFrameHex"] as? String)
  var bytes = Data(capacity: hex.utf8.count / 2)
  var index = hex.startIndex
  while index < hex.endIndex {
    let next = hex.index(index, offsetBy: 2)
    bytes.append(try #require(UInt8(hex[index..<next], radix: 16)))
    index = next
  }
  return bytes
}

@Test func goldenFrameCarriesStylePaletteProvenanceIntoRetainedState() throws {
  let bytes = try ansiBaselineFrame()
  let frame = try decodeTRF1Frame(bytes)
  let styleSection = try #require(frame.sections.first { $0.kind == .styleDefinitions })
  let paletteSection = try #require(frame.sections.first { $0.kind == .stylePalette })
  let styles = try decodeTRF1StyleDefinitions(styleSection, palette: paletteSection)
  let red = try #require(
    styles.first { $0.foreground == TRF1RGB(red: 0xcc, green: 0x66, blue: 0x66) })
  let blue = try #require(
    styles.first { $0.background == TRF1RGB(red: 0x81, green: 0xa2, blue: 0xbe) })
  #expect(red.foregroundPalette == 1)
  #expect(red.backgroundPalette == nil)
  #expect(blue.backgroundPalette == 4)
  #expect(blue.foregroundPalette == nil)

  // Retained state merges the palette, and still skips sections it does not render.
  var state = RetainedTRF1State()
  _ = try state.apply(bytes)
  #expect(state.styleDefinitions[red.id]?.foregroundPalette == 1)
  #expect(state.styleDefinitions[blue.id]?.backgroundPalette == 4)
}
