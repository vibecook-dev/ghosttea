import Foundation
import GhostteaCore
import Metal
import Testing

@testable import GhostteaFrame
@testable import GhostteaTerminal

// Ports `packages/ghosttea-react/src/renderers/light-adaptation.test.ts`: the
// same inputs and tolerances hold the Metal and WebGPU remaps in step.

private func rgb(_ red: UInt8, _ green: UInt8, _ blue: UInt8) -> GhostteaLightRGB {
  GhostteaLightRGB(red, green, blue)
}

private func rgba(_ color: GhostteaLightRGB, alpha: Float = 1) -> GhostteaMetalColor {
  color.metalColor.withAlpha(alpha)
}

private func bytes(_ color: GhostteaMetalColor) -> [Int] {
  [color.red, color.green, color.blue].map { Int(($0 * 255).rounded()) }
}

private func expectNear(
  _ actual: GhostteaMetalColor,
  _ expected: GhostteaLightRGB,
  tolerance: Int = 6,
  sourceLocation: SourceLocation = #_sourceLocation
) {
  let expectedBytes = [Int(expected.red), Int(expected.green), Int(expected.blue)]
  for (value, target) in zip(bytes(actual), expectedBytes) {
    #expect(
      abs(value - target) <= tolerance, "\(bytes(actual)) vs \(expectedBytes)",
      sourceLocation: sourceLocation)
  }
}

// GrokNight's base and GrokDay's paper, with a neutral ink so no tint shifts.
private var grok: GhostteaLightRemap {
  GhostteaLightRemap(
    base: rgb(0x14, 0x14, 0x14),
    paper: rgba(rgb(0xee, 0xee, 0xee)),
    ink: rgba(rgb(0x26, 0x26, 0x26)))
}

@Test func lightAdaptationMapsTheBaseSurfaceOntoThePaper() {
  expectNear(grok.surface(rgb(0x14, 0x14, 0x14)), rgb(0xee, 0xee, 0xee), tolerance: 1)
}

@Test func lightAdaptationKeepsTheGrayHierarchy() {
  expectNear(
    grok.ink(rgb(0xe1, 0xe1, 0xe1), sourceBackground: grok.base), rgb(0x26, 0x26, 0x26),
    tolerance: 10)
  expectNear(
    grok.ink(rgb(0x73, 0x73, 0x73), sourceBackground: grok.base), rgb(0x74, 0x74, 0x74),
    tolerance: 16)
  expectNear(
    grok.ink(rgb(0x33, 0x33, 0x33), sourceBackground: grok.base), rgb(0xcd, 0xcd, 0xcd),
    tolerance: 8)
}

@Test func lightAdaptationKeepsAnAccentHue() {
  let accent = grok.ink(rgb(0xe0, 0xaf, 0x68), sourceBackground: grok.base)
  let channels = bytes(accent)
  #expect(channels[0] > channels[1])
  #expect(channels[1] > channels[2])
  expectNear(accent, rgb(0xa2, 0x76, 0x12), tolerance: 14)
}

@Test func lightAdaptationKeepsAVisibleTintOnDarkDiffRows() {
  let claude = GhostteaLightRemap(
    base: rgb(0x1e, 0x1e, 0x2e),
    paper: rgba(rgb(0xef, 0xf1, 0xf5)),
    ink: rgba(rgb(0x4c, 0x4f, 0x69)))
  let channels = bytes(claude.surface(rgb(0x3d, 0x01, 0x00)))
  #expect(channels[0] > 240)
  #expect(channels[0] - min(channels[1], channels[2]) > 20)
}

@Test func lightAdaptationKeepsLegibleThemeANSIColors() {
  let red = rgb(0xd2, 0x0f, 0x39)  // Catppuccin Latte red, designed for light paper
  let latte = GhostteaLightRemap(
    base: rgb(0x1e, 0x1e, 0x2e),
    paper: rgba(rgb(0xef, 0xf1, 0xf5)),
    ink: rgba(rgb(0x4c, 0x4f, 0x69)))
  #expect(
    bytes(latte.ink(red, sourceBackground: latte.base, paletteIndex: 1)) == [0xd2, 0x0f, 0x39])
  // The same RGB as truecolor is an application color and is remapped.
  #expect(bytes(latte.ink(red, sourceBackground: latte.base)) != [0xd2, 0x0f, 0x39])
  // Neutral entries describe a role, not a hue: "white" text still darkens.
  let white = bytes(latte.ink(rgb(0xbc, 0xc0, 0xcc), sourceBackground: latte.base, paletteIndex: 7))
  #expect(white[0] < 0x80)
}

@Test func lightAdaptationClassifiesBackgroundsLikeTheVTShim() {
  #expect(GhostteaLightColor.isLightBackground(rgb(0xef, 0xf1, 0xf5)))
  #expect(!GhostteaLightColor.isLightBackground(rgb(0x1e, 0x1e, 0x2e)))
}

private func contrast(_ a: GhostteaMetalColor, _ b: GhostteaMetalColor) -> Double {
  func luminance(_ color: GhostteaMetalColor) -> Double {
    zip([0.2126, 0.7152, 0.0722], [color.red, color.green, color.blue]).reduce(0) { sum, pair in
      let v = Double(pair.1)
      return sum + pair.0 * (v <= 0.04045 ? v / 12.92 : pow((v + 0.055) / 1.055, 2.4))
    }
  }
  let first = luminance(a)
  let second = luminance(b)
  return (max(first, second) + 0.05) / (min(first, second) + 0.05)
}

private let panel = rgba(rgb(0xe6, 0xe6, 0xe6))

@Test func minimumContrastLeavesTextAloneWhenOffOrAlreadyMet() {
  let gray = rgba(rgb(0x9a, 0x9a, 0x9a))
  #expect(GhostteaLightColor.ensureContrast(gray, background: panel, ratio: 1) == gray)
  let ink = rgba(rgb(0x26, 0x26, 0x26))
  #expect(GhostteaLightColor.ensureContrast(ink, background: panel, ratio: 4.5) == ink)
}

@Test func minimumContrastMovesLightnessOnlyAsFarAsNeededAndKeepsHue() {
  let amber = rgba(rgb(0xe0, 0xaf, 0x68), alpha: 0.55)
  let result = GhostteaLightColor.ensureContrast(amber, background: panel, ratio: 4.5)
  #expect(contrast(result, panel) >= 4.5)
  #expect(contrast(result, panel) < 4.7)
  let channels = bytes(result)
  #expect(channels[0] > channels[1])
  #expect(channels[1] > channels[2])
  #expect(result.alpha == 0.55)
}

@Test func minimumContrastReachesBlackOrWhiteWhenNothingLessSuffices() {
  let gray = rgba(rgb(0x80, 0x80, 0x80))
  #expect(bytes(GhostteaLightColor.ensureContrast(gray, background: gray, ratio: 21)) == [0, 0, 0])
  let lifted = GhostteaLightColor.ensureContrast(
    rgba(rgb(0x30, 0x30, 0x30)), background: rgba(rgb(0x20, 0x20, 0x20)), ratio: 7)
  #expect(bytes(lifted)[0] > 0x80)
}

private let paintedStyle = TRF1StyleDefinition(
  id: 7, bold: false, italic: false, faint: false, inverse: false, invisible: false,
  strikethrough: false, underline: false, foreground: nil,
  background: TRF1RGB(red: 0x14, green: 0x14, blue: 0x14))

private func lightTheme(adaptation: Bool = true) -> GhostteaMetalTheme {
  var theme = GhostteaMetalTheme()
  theme.background = rgba(rgb(0xef, 0xf1, 0xf5))
  theme.foreground = rgba(rgb(0x4c, 0x4f, 0x69))
  theme.lightAdaptation = adaptation
  return theme
}

private func paintedBase(
  _ theme: GhostteaMetalTheme, paintedRows: Int, engaged: Bool
) -> GhostteaLightRGB? {
  let painted = [TRF1StyleRun(styleID: 7, cellStart: 0, cellSpan: 10)]
  return GhostteaLightColor.darkPaintedBase(
    styleRows: (0..<10).map { $0 < paintedRows ? painted : [] },
    rowCount: 10,
    columns: 10,
    styleDefinitions: [7: paintedStyle],
    theme: theme,
    engaged: engaged)
}

@Test func lightAdaptationEngagesForADarkPaintedPaneUnderALightTheme() {
  #expect(paintedBase(lightTheme(), paintedRows: 10, engaged: false) == rgb(0x14, 0x14, 0x14))
}

@Test func lightAdaptationStaysOffForDarkThemesOptOutsAndThemeFollowingApps() {
  var dark = lightTheme()
  dark.background = rgba(rgb(0x1e, 0x1e, 0x2e))
  #expect(paintedBase(dark, paintedRows: 10, engaged: false) == nil)
  #expect(paintedBase(lightTheme(adaptation: false), paintedRows: 10, engaged: false) == nil)
  #expect(paintedBase(lightTheme(), paintedRows: 1, engaged: false) == nil)
}

@Test func lightAdaptationUsesHysteresisSoPartialScrollsDoNotFlicker() {
  #expect(paintedBase(lightTheme(), paintedRows: 5, engaged: false) == nil)
  #expect(paintedBase(lightTheme(), paintedRows: 5, engaged: true) == rgb(0x14, 0x14, 0x14))
  #expect(paintedBase(lightTheme(), paintedRows: 3, engaged: true) == nil)
}

@Test func graphicCellsFollowDesktopCellWidths() {
  #expect(GhostteaMetalGraphicCells.cellWidth("界") == 2)
  #expect(GhostteaMetalGraphicCells.cellWidth("🙂") == 2)
  #expect(GhostteaMetalGraphicCells.cellWidth("─") == 1)
  #expect(GhostteaMetalGraphicCells.cellWidth("a") == 1)
}

private func pixel(_ texture: any MTLTexture, x: Int, y: Int) -> [Int] {
  var value = [UInt8](repeating: 0, count: 4)
  value.withUnsafeMutableBytes { bytes in
    texture.getBytes(
      bytes.baseAddress!,
      bytesPerRow: 4,
      from: MTLRegionMake2D(x, y, 1, 1),
      mipmapLevel: 0)
  }
  return value.map(Int.init)
}

@Test func metalRendererRestylesADarkPaintedPaneUnderALightTheme() async throws {
  let runtime = try GhostteaRuntime()
  let terminal = try GhostteaTerminal(
    runtime: runtime,
    configuration: .init(sessionHandle: 211, columns: 40, rows: 6))
  // Paint every cell #141414 the way Grok's default theme does, then write
  // light-gray text over it.
  let paint = "\u{1b}[48;2;20;20;20m\u{1b}[2J\u{1b}[H\u{1b}[38;2;225;225;225mGrok night\r\n"
  let update = try await terminal.feed(Data(paint.utf8), render: .full)
  var state = RetainedTRF1State()
  _ = try state.apply(try #require(update.effects.first { $0.kind == .frameReady }?.payload))
  #expect(
    state.styleDefinitions.values.contains {
      $0.background == TRF1RGB(red: 20, green: 20, blue: 20)
    })

  let metal = try GhostteaMetalRuntime()
  let renderer = try GhostteaMetalRenderer(runtime: metal, alphaAtlasSize: 512, colorAtlasSize: 512)
  let descriptor = MTLTextureDescriptor.texture2DDescriptor(
    pixelFormat: .rgba8Unorm, width: 240, height: 80, mipmapped: false)
  descriptor.storageMode = .shared
  descriptor.usage = [.renderTarget]
  let target = try #require(metal.device.makeTexture(descriptor: descriptor))
  // A blank cell on the third row, clear of the text and the cursor.
  let probe = (
    x: Int(GhostteaMetalRenderer.originX + 20 * renderer.cellWidth),
    y: Int(GhostteaMetalRenderer.originY + 2.5 * renderer.lineHeight)
  )

  var theme = lightTheme(adaptation: false)
  _ = try renderer.render(state: state, target: target, theme: theme)
  let asPainted = pixel(target, x: probe.x, y: probe.y)
  #expect(asPainted[0] < 0x30 && asPainted[1] < 0x30 && asPainted[2] < 0x30, "\(asPainted)")

  // Enabling adaptation on the same renderer must invalidate cached geometry.
  theme.lightAdaptation = true
  _ = try renderer.render(state: state, target: target, theme: theme)
  let adapted = pixel(target, x: probe.x, y: probe.y)
  // The app's base surface lands on the theme paper.
  #expect(
    abs(adapted[0] - 0xef) <= 2 && abs(adapted[1] - 0xf1) <= 2 && abs(adapted[2] - 0xf5) <= 2,
    "\(adapted)")

  theme.lightAdaptation = false
  _ = try renderer.render(state: state, target: target, theme: theme)
  #expect(pixel(target, x: probe.x, y: probe.y) == asPainted)
}

@Test func metalRendererAppliesMinimumContrastToTextOnly() async throws {
  let runtime = try GhostteaRuntime()
  let terminal = try GhostteaTerminal(
    runtime: runtime,
    configuration: .init(sessionHandle: 212, columns: 40, rows: 4))
  // Pale gray text and a block element in the same pale gray on a light theme.
  let text = "\u{1b}[38;2;200;200;200mpale text \u{2588}\u{2588}\r\n"
  let update = try await terminal.feed(Data(text.utf8), render: .full)
  var state = RetainedTRF1State()
  _ = try state.apply(try #require(update.effects.first { $0.kind == .frameReady }?.payload))

  let metal = try GhostteaMetalRuntime()
  let renderer = try GhostteaMetalRenderer(runtime: metal, alphaAtlasSize: 512, colorAtlasSize: 512)
  let descriptor = MTLTextureDescriptor.texture2DDescriptor(
    pixelFormat: .rgba8Unorm, width: 240, height: 40, mipmapped: false)
  descriptor.storageMode = .shared
  descriptor.usage = [.renderTarget]
  let target = try #require(metal.device.makeTexture(descriptor: descriptor))
  let block = (
    x: Int(GhostteaMetalRenderer.originX + 10.5 * renderer.cellWidth),
    y: Int(GhostteaMetalRenderer.originY + 0.5 * renderer.lineHeight)
  )

  var theme = lightTheme(adaptation: false)
  let plain = try renderer.render(state: state, width: 240, height: 40, theme: theme)
  _ = try renderer.render(state: state, target: target, theme: theme)
  let plainBlock = pixel(target, x: block.x, y: block.y)
  #expect(abs(plainBlock[0] - 200) <= 2, "\(plainBlock)")

  theme.minimumContrast = 4.5
  let contrasted = try renderer.render(state: state, width: 240, height: 40, theme: theme)
  // Darker text lowers the mean; the cached geometry from the first render is not reused.
  #expect(contrasted.pixelHash != plain.pixelHash)
  #expect(contrasted.visualFingerprint.meanRed < plain.visualFingerprint.meanRed)
  // Block elements are graphics and keep the raw foreground, as in Ghostty.
  _ = try renderer.render(state: state, target: target, theme: theme)
  #expect(pixel(target, x: block.x, y: block.y) == plainBlock)

  theme.minimumContrast = 1
  #expect(
    try renderer.render(state: state, width: 240, height: 40, theme: theme).pixelHash
      == plain.pixelHash)
}

@Test func productionFramesCarryPaletteProvenanceBesideTheRGB() async throws {
  let terminal = try GhostteaTerminal(
    runtime: try GhostteaRuntime(),
    configuration: .init(sessionHandle: 212, columns: 20, rows: 2))
  // ANSI red and the same RGB as truecolor must reach the renderer as two
  // styles, and only the palette one may pass through light adaptation.
  let probe = try await terminal.feed(Data("\u{1b}[31mA".utf8), render: .full)
  var probeState = RetainedTRF1State()
  _ = try probeState.apply(
    try #require(probe.effects.first { $0.kind == .frameReady }?.payload))
  let red = try #require(probeState.styleDefinitions.values.first { $0.foregroundPalette == 1 })
  let rgb = try #require(red.foreground)
  let truecolor = "\u{1b}[38;2;\(rgb.red);\(rgb.green);\(rgb.blue)mB"
  let update = try await terminal.feed(Data(truecolor.utf8), render: .full)
  var state = RetainedTRF1State()
  _ = try state.apply(try #require(update.effects.first { $0.kind == .frameReady }?.payload))
  let sameRGB = state.styleDefinitions.values.filter { $0.foreground == rgb }
  #expect(sameRGB.count == 2)
  #expect(Set(sameRGB.map(\.foregroundPalette)) == [1, nil])
}
