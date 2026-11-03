import Foundation
import GhostteaCore
import Testing

@testable import GhostteaFrame
@testable import GhostteaTerminal

@Test func claudeBlockRowsHaveNoGapsAtPhoneFontSizesAndDisplayScales() async throws {
  let terminal = try GhostteaTerminal(
    runtime: GhostteaRuntime(), configuration: .init(sessionHandle: 801, columns: 8, rows: 4))
  let update = try await terminal.feed(
    Data("\u{1b}[?25l\u{1b}[38;5;208m██\r\n██".utf8), render: .full)
  var state = RetainedTRF1State()
  for effect in update.effects where effect.kind == .frameReady {
    _ = try state.apply(effect.payload)
  }
  let metal = try GhostteaMetalRuntime()
  for pointSize: Float in [9, 13, 16, 20] {
    for scale: Float in [1, 2, 3] {
      for instanced in [false, true] {
        let cellWidth: Float = 7.83 * pointSize / 13
        let lineHeight: Float = 19 * pointSize / 13
        let renderer = try GhostteaMetalRenderer(
          runtime: metal, cellWidth: cellWidth, lineHeight: lineHeight,
          sourceCellWidth: 7.83, sourceLineHeight: 19,
          instancedSubmissionEnabled: instanced)
        for appearance in ["dark", "light", "transparent", "selected"] {
          var theme = GhostteaMetalTheme()
          if appearance == "light" {
            theme.background = .init(red: 0.96, green: 0.96, blue: 0.94, alpha: 1)
          } else if appearance == "transparent" {
            theme.background = .init(red: 0.1, green: 0.1, blue: 0.1, alpha: 0.65)
          }
          let selection: GhostteaMetalSelection? =
            appearance == "selected"
            ? .init(anchor: .init(column: 0, row: 0), focus: .init(column: 1, row: 1)) : nil
          let width = 400
          let height = 260
          let (_, pixels) = try renderer.renderWithPixels(
            state: state, width: width, height: height, scale: scale,
            theme: theme, selection: selection)
          func pixel(_ x: Int, _ y: Int) -> ArraySlice<UInt8> {
            let offset = (y * width + x) * 4
            return pixels[offset..<offset + 4]
          }
          let left = Int((GhostteaMetalRenderer.originX * scale).rounded())
          let right = Int(((GhostteaMetalRenderer.originX + 2 * cellWidth) * scale).rounded())
          let top = Int((GhostteaMetalRenderer.originY * scale).rounded())
          let bottom = Int(((GhostteaMetalRenderer.originY + 2 * lineHeight) * scale).rounded())
          let expected = Array(pixel(left + 2, top + 2))
          let firstMismatch = (top..<bottom).lazy.flatMap { y in
            (left..<right).lazy.map { x in (x, y) }
          }.first { Array(pixel($0.0, $0.1)) != expected }
          #expect(
            firstMismatch == nil,
            "cell gap at \(String(describing: firstMismatch)), \(pointSize)pt, scale \(scale), \(appearance), instanced \(instanced)"
          )
        }
      }
    }
  }
}

@Test func claudeBlockQuadrantsKeepTheirShapeAndFaintOpacity() async throws {
  let terminal = try GhostteaTerminal(
    runtime: GhostteaRuntime(), configuration: .init(sessionHandle: 802, columns: 8, rows: 4))
  let update = try await terminal.feed(
    Data("\u{1b}[?25l\u{1b}[38;5;208;2m▛▜▝▘".utf8), render: .full)
  var state = RetainedTRF1State()
  for effect in update.effects where effect.kind == .frameReady {
    _ = try state.apply(effect.payload)
  }
  let renderer = try GhostteaMetalRenderer(
    runtime: GhostteaMetalRuntime(), cellWidth: 8, lineHeight: 20)
  let (_, pixels) = try renderer.renderWithPixels(state: state, width: 80, height: 50, scale: 2)
  func pixel(_ x: Int, _ y: Int) -> [UInt8] {
    Array(pixels[(y * 80 + x) * 4..<(y * 80 + x) * 4 + 4])
  }
  let ink = pixel(6, 6)
  let background = pixel(75, 45)
  #expect(ink != background)
  // ▛ upper-left/right and lower-left; ▜ upper-left/right and lower-right;
  // ▝ upper-right; ▘ upper-left. Every occupied pixel has the same faint alpha,
  // including the shared quadrant edges, where double painting darkens a join.
  for (column, occupied) in [
    [true, true, true, false], [true, true, false, true],
    [false, true, false, false], [true, false, false, false],
  ].enumerated() {
    var mismatch = false
    for y in 0..<40 {
      for x in 0..<16 {
        let quadrant = (x >= 8 ? 1 : 0) + (y >= 20 ? 2 : 0)
        mismatch =
          mismatch || pixel(4 + column * 16 + x, 4 + y) != (occupied[quadrant] ? ink : background)
      }
    }
    #expect(!mismatch, "incorrect quadrant or alpha at column \(column)")
  }
}

@Test func claudeBlockCursorUsesCursorTextColor() async throws {
  let terminal = try GhostteaTerminal(
    runtime: GhostteaRuntime(), configuration: .init(sessionHandle: 803, columns: 8, rows: 4))
  let update = try await terminal.feed(
    Data("\u{1b}[38;5;208m█\u{1b}[H\u{1b}[2 q\u{1b}[?25h".utf8), render: .full)
  var state = RetainedTRF1State()
  for effect in update.effects where effect.kind == .frameReady {
    _ = try state.apply(effect.payload)
  }
  #expect(state.cursor?.style == .block)
  #expect(state.cursor?.visible == true)
  var theme = GhostteaMetalTheme()
  theme.cursorText = .init(red: 0, green: 1, blue: 1, alpha: 1)
  let renderer = try GhostteaMetalRenderer(
    runtime: GhostteaMetalRuntime(), cellWidth: 8, lineHeight: 20)
  let (_, pixels) = try renderer.renderWithPixels(
    state: state, width: 80, height: 50, scale: 2, theme: theme)
  var mismatch = false
  for y in 4..<44 {
    for x in 4..<20 {
      mismatch =
        mismatch || Array(pixels[(y * 80 + x) * 4..<(y * 80 + x) * 4 + 4]) != [0, 255, 255, 255]
    }
  }
  #expect(!mismatch)
}

@Test func claudeBlockMappingPreservesAmbiguousHostWidthsAndComplexClusters() {
  #expect(GhostteaMetalBlockElements.cells(in: "A█", nativeCellEnd: 2)[1] != nil)
  #expect(GhostteaMetalBlockElements.cells(in: "A█", nativeCellEnd: 4).isEmpty)
  #expect(GhostteaMetalBlockElements.cells(in: "👩‍💻█", nativeCellEnd: 3).isEmpty)
  #expect(GhostteaMetalBlockElements.cells(in: "█\u{301}", nativeCellEnd: 1).isEmpty)
  #expect(GhostteaMetalBlockElements.cells(in: "█\u{fe0e}", nativeCellEnd: 1).isEmpty)
  for character: Character in ["░", "▒", "▓"] {
    #expect(GhostteaMetalBlockElements.rectangles(for: character) == nil)
  }
}
