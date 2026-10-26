import CoreGraphics
import Foundation
import GhostteaCore
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
