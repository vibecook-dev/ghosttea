import Foundation

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

private func accessibilityFixture(_ text: String) -> Data {
  let textBytes = Data(text.utf8)
  let payloadLength = 2 + 6 + textBytes.count
  var data = Data(
    repeating: 0,
    count: TRF1.frameHeaderBytes + TRF1.sectionHeaderBytes + payloadLength)
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
  writeUInt32(UInt32(textBytes.count), to: &data, at: 84)
  data.replaceSubrange(88..<(88 + textBytes.count), with: textBytes)
  return data
}

private struct Generator {
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

private func exerciseEveryDecoder(_ data: Data) {
  guard let frame = try? decodeTRF1Frame(data) else { return }
  for section in frame.sections {
    switch section.kind {
    case .glyphDefinitions: _ = try? decodeTRF1GlyphDefinitions(section)
    case .styleDefinitions: _ = try? decodeTRF1StyleDefinitions(section)
    case .stylePalette: _ = try? decodeTRF1StylePalette(section)
    case .rowReplacements: _ = try? decodeTRF1RowReplacements(section)
    case .cursorState: _ = try? decodeTRF1CursorState(section)
    case .scrollbarState: _ = try? decodeTRF1ScrollbarState(section)
    case .accessibilityText: _ = try? decodeTRF1AccessibilityRows(section)
    case .clipboardWrite: _ = try? decodeTRF1ClipboardWrite(section)
    default: break
    }
  }
}

private var generator = Generator()
private let seed = accessibilityFixture("fuzz ✓")
private let iterationCount =
  ProcessInfo.processInfo.environment["GHOSTTEA_FUZZ_ITERATIONS"].flatMap(Int.init) ?? 4_096
for iteration in 0..<iterationCount {
  if ProcessInfo.processInfo.environment["GHOSTTEA_FUZZ_PROGRESS"] == "1"
    && iteration.isMultiple(of: 256)
  {
    FileHandle.standardError.write(Data("TRF1 fuzz progress \(iteration)\n".utf8))
  }
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
  exerciseEveryDecoder(candidate)

  let section = TRF1Section(
    kind: TRF1SectionKind(rawValue: UInt16(truncatingIfNeeded: generator.next())),
    flags: UInt16(truncatingIfNeeded: generator.next()),
    itemCount: UInt32(truncatingIfNeeded: generator.next()),
    bytes: generator.data(maximumCount: 2_048))
  _ = try? decodeTRF1GlyphDefinitions(section)
  _ = try? decodeTRF1StyleDefinitions(section)
  _ = try? decodeTRF1StylePalette(section)
  _ = try? decodeTRF1RowReplacements(section)
  _ = try? decodeTRF1CursorState(section)
  _ = try? decodeTRF1ScrollbarState(section)
  _ = try? decodeTRF1AccessibilityRows(section)
  _ = try? decodeTRF1ClipboardWrite(section)
}
