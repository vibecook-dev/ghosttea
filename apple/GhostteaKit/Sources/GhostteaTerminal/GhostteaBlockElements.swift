import Foundation

/// Cell graphics shared in meaning with WebGPU's `blockElementRectangles`.
/// Font ink does not fill terminal line spacing (Menlo leaves 5.5pt at the
/// default size), so solid blocks must use cell fractions instead of bitmaps.
enum GhostteaMetalBlockElements {
  /// Fractions are left, top, right, bottom. Shade characters keep their font
  /// pattern; clusters carrying combining marks or selectors keep their glyphs.
  static func rectangles(for character: Character) -> [SIMD4<Float>]? {
    guard character.unicodeScalars.count == 1,
      let code = character.unicodeScalars.first?.value
    else { return nil }
    switch code {
    case 0x2580: return [SIMD4(0, 0, 1, 0.5)]
    case 0x2581...0x2587: return [SIMD4(0, 1 - Float(code - 0x2580) / 8, 1, 1)]
    case 0x2588: return [SIMD4(0, 0, 1, 1)]
    case 0x2589...0x258F: return [SIMD4(0, 0, Float(0x2590 - code) / 8, 1)]
    case 0x2590: return [SIMD4(0.5, 0, 1, 1)]
    case 0x2594: return [SIMD4(0, 0, 1, 0.125)]
    case 0x2595: return [SIMD4(0.875, 0, 1, 1)]
    case 0x2596...0x259F:
      let masks = [4, 8, 1, 13, 9, 7, 11, 2, 6, 14]
      let mask = masks[Int(code - 0x2596)]
      let quadrants: [SIMD4<Float>] = [
        SIMD4(0, 0, 0.5, 0.5), SIMD4(0.5, 0, 1, 0.5),
        SIMD4(0, 0.5, 0.5, 1), SIMD4(0.5, 0.5, 1, 1),
      ]
      return (0..<4).filter { mask & (1 << $0) != 0 }.map { quadrants[$0] }
    default: return nil
    }
  }

  static func cells(in text: String, nativeCellEnd: @autoclosure () -> Int) -> [Int: [SIMD4<Float>]]
  {
    guard text.unicodeScalars.contains(where: { (0x2580...0x259F).contains($0.value) })
    else { return [:] }
    // TRF1 supplies glyph positions, but no complete text-to-cell map. Keep the
    // host glyph when local Unicode widths disagree, rather than replacing an
    // unrelated cell after a ZWJ or a host-wide emoji with a rectangle.
    let measured = text.reversed().drop(while: { $0.isWhitespace })
      .reduce(0) { $0 + GhostteaMetalGraphicCells.cellWidth($1) }
    guard !text.unicodeScalars.contains(where: { $0.value == 0x200D }), measured == nativeCellEnd()
    else { return [:] }
    var output: [Int: [SIMD4<Float>]] = [:]
    var column = 0
    for character in text {
      if let rectangles = rectangles(for: character) { output[column] = rectangles }
      column += GhostteaMetalGraphicCells.cellWidth(character)
    }
    return output
  }
}
