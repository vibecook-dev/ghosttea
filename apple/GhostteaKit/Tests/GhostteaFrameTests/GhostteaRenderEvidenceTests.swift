import CoreGraphics
import Foundation
import GhostteaCore
import GhostteaFonts
import ImageIO
import Testing

@testable import GhostteaFrame
@testable import GhostteaTerminal

// Rendered Apple evidence for a change that moves glyph pixels: the font-parity fixture's rows (the
// cases in native/ghosttea/crates/ghosttea-text/src/fixture.rs), the visual golden's text, box
// drawing, and a base carrying 64 combining marks, fed through the production terminal and drawn by
// GhostteaMetalRenderer offscreen. It runs only when GHOSTTEA_RENDER_EVIDENCE_DIR names a directory,
// which the iOS release hardening workflow sets when dispatched with `render_evidence`. Dispatch it
// on the base ref and on the candidate, and compare the two PNGs side by side.
private let evidenceDirectory = ProcessInfo.processInfo.environment["GHOSTTEA_RENDER_EVIDENCE_DIR"]

private let evidenceRows = [
  "Ghosttea => ffi != 0123456789",
  "\u{1b}[1mbold terminal\u{1b}[0m",
  "\u{1b}[3mitalic terminal\u{1b}[0m",
  "\u{1b}[1;3mbold italic\u{1b}[0m",
  "e\u{301} 界",
  "terminal 😀",
  "⏸ ⏸\u{FE0E} ⏸\u{FE0F} 😀",
  "⏸ ✻ ⚠ ← ·",
  "Metal proof ✓ 界 \u{1b}[31;44;4;9mstyled\u{1b}[0m 🙂",
  "┌─┬─┐ │ │ ├─┼─┤ └─┴─┘ ░▒▓█",
  "a" + String(repeating: "\u{301}", count: 64),
]

@Test(.enabled(if: evidenceDirectory?.isEmpty == false))
func rendersTheFixtureRowsAsEvidence() async throws {
  let directory = URL(filePath: try #require(evidenceDirectory), directoryHint: .isDirectory)
  try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)

  let terminal = try GhostteaTerminal(
    runtime: try GhostteaRuntime(),
    configuration: .init(sessionHandle: 110, columns: 100, rows: 30)
  )
  let bytes = Data(("\u{1b}[?25l" + evidenceRows.joined(separator: "\r\n") + "\r\n").utf8)
  let update = try await terminal.feed(bytes, render: .full)
  let data = try #require(update.effects.first { $0.kind == .frameReady }?.payload)
  let frame = try decodeTRF1Frame(data)
  var state = RetainedTRF1State()
  guard case .applied = try state.apply(data) else {
    throw TRF1DecodingError("evidence frame did not produce retained state")
  }

  let runtime = try GhostteaMetalRuntime()
  let renderer = try GhostteaMetalRenderer(runtime: runtime)
  let width = Int(
    ceil(GhostteaMetalRenderer.originX * 2 + Float(frame.columns) * renderer.cellWidth))
  let height = Int(
    ceil(GhostteaMetalRenderer.originY * 2 + Float(frame.rows) * renderer.lineHeight))
  let (result, pixels) = try renderer.renderWithPixels(state: state, width: width, height: height)
  #expect(pixels.count == width * height * 4)

  try writePNG(pixels, width: width, height: height, to: directory.appending(path: "render.png"))
  let manifest: [String: Any] = [
    "rows": evidenceRows,
    "width": width,
    "height": height,
    "pixelHash": String(format: "%016llx", result.pixelHash),
    "nonBackgroundPixelCount": result.nonBackgroundPixelCount,
    "device": runtime.device.name,
    "commit": ProcessInfo.processInfo.environment["GITHUB_SHA"] ?? "local",
  ]
  try JSONSerialization.data(withJSONObject: manifest, options: [.prettyPrinted, .sortedKeys])
    .write(to: directory.appending(path: "render.json"))
}

// Exercise live resize damage against a fresh full snapshot, including the
// adjacent block rows used by TUI logos. A static visual golden cannot catch
// a stale row left behind when the phone keyboard changes the viewport.
@Test func resizedLogoAndTextMatchAFreshFrameInEveryAppearance() async throws {
  let terminal = try GhostteaTerminal(
    runtime: try GhostteaRuntime(),
    configuration: .init(sessionHandle: 111, columns: 80, rows: 24))
  let metal = try GhostteaMetalRuntime()
  let cached = try GhostteaMetalRenderer(runtime: metal)
  var state = RetainedTRF1State()
  let sizes: [(UInt16, UInt16)] = [(80, 24), (46, 18), (46, 7), (90, 30), (46, 18)]
  var records: [[String: Any]] = []
  for (index, size) in sizes.enumerated() {
    let resized = try await terminal.resize(
      columns: size.0, rows: size.1, layoutEpoch: UInt64(index + 1))
    for effect in resized.effects where effect.kind == .frameReady { _ = try state.apply(effect.payload) }
    let lines = [
      "\u{1b}[38;5;208m████████  ▄▄▄▄  ▐▛███▜▌\u{1b}[0m",
      "\u{1b}[38;5;208m████████  ████  ▝▜███▛▘\u{1b}[0m",
      "\u{1b}[38;5;208m████████  ▀▀▀▀    ▘▘ ▝▝\u{1b}[0m",
      "resize \(size.0)x\(size.1) — frame \(index)",
      "normal text / \u{1b}[1mbold\u{1b}[0m / e\u{301} 界",
      "┌───────────────┐ │ box drawing │",
    ]
    let update = try await terminal.feed(
      Data(("\u{1b}[?25l\u{1b}[2J\u{1b}[H" + lines.joined(separator: "\r\n")).utf8), render: .damage)
    for effect in update.effects where effect.kind == .frameReady { _ = try state.apply(effect.payload) }
    let full = try await terminal.refresh(.full)
    var fresh = RetainedTRF1State()
    for effect in full.effects where effect.kind == .frameReady { _ = try fresh.apply(effect.payload) }
    let width = Int(ceil(GhostteaMetalRenderer.originX * 2 + Float(size.0) * cached.cellWidth))
    let height = Int(ceil(GhostteaMetalRenderer.originY * 2 + Float(size.1) * cached.lineHeight))
    for appearance in ["dark", "light", "transparent"] {
      var theme = GhostteaMetalTheme()
      if appearance == "light" {
        theme.background = .init(red: 0.94, green: 0.94, blue: 0.94, alpha: 1)
        theme.foreground = .init(red: 0.15, green: 0.15, blue: 0.15, alpha: 1)
        theme.lightAdaptation = true
      } else if appearance == "transparent" {
        theme.background = .init(red: 0.08, green: 0.08, blue: 0.08, alpha: 0.4)
      }
      let (_, pixels) = try cached.renderWithPixels(state: state, width: width, height: height, theme: theme)
      let reference = try GhostteaMetalRenderer(runtime: metal)
      let (_, expected) = try reference.renderWithPixels(state: fresh, width: width, height: height, theme: theme)
      #expect(pixels == expected, "resize \(index), \(appearance): retained pixels differ from a full scene")
      if let evidenceDirectory, !evidenceDirectory.isEmpty {
        let directory = URL(filePath: evidenceDirectory, directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let name = "resize-\(index)-\(appearance).png"
        try writePNG(pixels, width: width, height: height, to: directory.appending(path: name))
        records.append(["file": name, "columns": size.0, "rows": size.1,
                        "width": width, "height": height, "freshPixelsEqual": pixels == expected])
      }
    }
    // The renderer receiving the full snapshot must converge as well.
    for effect in full.effects where effect.kind == .frameReady { _ = try state.apply(effect.payload) }
  }
  if let evidenceDirectory, !evidenceDirectory.isEmpty {
    try JSONSerialization.data(withJSONObject: records, options: [.prettyPrinted, .sortedKeys])
      .write(to: URL(filePath: evidenceDirectory).appending(path: "resize-matrix.json"))
  }
}

private func writePNG(_ pixels: [UInt8], width: Int, height: Int, to url: URL) throws {
  let provider = try #require(CGDataProvider(data: Data(pixels) as CFData))
  let image = try #require(
    CGImage(
      width: width,
      height: height,
      bitsPerComponent: 8,
      bitsPerPixel: 32,
      bytesPerRow: width * 4,
      space: CGColorSpace(name: CGColorSpace.sRGB)!,
      bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue),
      provider: provider,
      decode: nil,
      shouldInterpolate: false,
      intent: .defaultIntent
    ))
  let destination = try #require(
    CGImageDestinationCreateWithURL(url as CFURL, "public.png" as CFString, 1, nil))
  CGImageDestinationAddImage(destination, image, nil)
  #expect(CGImageDestinationFinalize(destination))
}

// A remote frame is shaped at the host's metrics. Changing the viewer's font
// size must scale its glyphs along with cell backgrounds, cursor and row pitch.
@Test func remoteFontResizeMatchesUniformlyScaledHostPixels() async throws {
  let terminal = try GhostteaTerminal(
    runtime: try GhostteaRuntime(),
    configuration: .init(sessionHandle: 112, columns: 40, rows: 8))
  let update = try await terminal.feed(
    Data("AB e\u{301} 中 😀\r\n\u{1b}[31;44m██\u{1b}[0m".utf8), render: .full)
  var state = RetainedTRF1State()
  for effect in update.effects where effect.kind == .frameReady { _ = try state.apply(effect.payload) }
  let metal = try GhostteaMetalRuntime()
  let reference = try GhostteaMetalRenderer(runtime: metal)
  let resized = try GhostteaMetalRenderer(
    runtime: metal, cellWidth: GhostteaTerminalLayout.cellWidth * 2,
    lineHeight: GhostteaTerminalLayout.lineHeight * 2,
    sourceCellWidth: GhostteaTerminalLayout.cellWidth,
    sourceLineHeight: GhostteaTerminalLayout.lineHeight)
  let (_, expected) = try reference.renderWithPixels(state: state, width: 680, height: 340, scale: 2)
  let (_, actual) = try resized.renderWithPixels(
    state: state, width: 680, height: 340, contentInsets: .init(top: 2, left: 2))
  let identical = actual == expected
  if let evidenceDirectory, !evidenceDirectory.isEmpty {
    let directory = URL(filePath: evidenceDirectory, directoryHint: .isDirectory)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    try writePNG(actual, width: 680, height: 340, to: directory.appending(path: "remote-font-actual.png"))
    try writePNG(expected, width: 680, height: 340, to: directory.appending(path: "remote-font-expected.png"))
  }
  #expect(identical, "remote glyphs must grow together with their cells")
  let (_, cached) = try resized.renderWithPixels(
    state: state, width: 680, height: 340, contentInsets: .init(top: 2, left: 2))
  #expect(cached == actual)
}

#if os(macOS)
// Compare the actual host font as well as the bundled-font fixture. Menlo's
// full-block ink does not fill this host's 19pt line box.
@Test(.enabled(if: evidenceDirectory?.isEmpty == false))
func rendersHostMenloBlocksAsEvidence() async throws {
  let bytes = try Data(contentsOf: URL(filePath: "/System/Library/Fonts/Menlo.ttc"))
  let fonts = try GhostteaBundledFonts.load().map { font in
    switch font.role {
    case .regular, .bold, .italic, .boldItalic:
      GhostteaBundledFont(role: font.role, data: bytes, faceIndex: font.role.rawValue)
    default: font
    }
  }
  let terminal = try GhostteaTerminal(
    runtime: try GhostteaRuntime(fonts: fonts, metrics: .init()),
    configuration: .init(sessionHandle: 113, columns: 46, rows: 18))
  let lines = [
    "\u{1b}[38;5;208m████████  ▄▄▄▄  ▐▛███▜▌",
    "████████  ████  ▝▜███▛▘",
    "████████  ▀▀▀▀    ▘▘ ▝▝\u{1b}[0m",
    "normal text / bold / 中 e\u{301}",
  ]
  let update = try await terminal.feed(
    Data(("\u{1b}[?25l" + lines.joined(separator: "\r\n")).utf8), render: .full)
  var state = RetainedTRF1State()
  for effect in update.effects where effect.kind == .frameReady { _ = try state.apply(effect.payload) }
  let renderer = try GhostteaMetalRenderer(runtime: GhostteaMetalRuntime())
  let (_, pixels) = try renderer.renderWithPixels(state: state, width: 730, height: 690, scale: 2)
  let directory = URL(filePath: try #require(evidenceDirectory), directoryHint: .isDirectory)
  try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
  try writePNG(pixels, width: 730, height: 690, to: directory.appending(path: "host-menlo.png"))
}
#endif
