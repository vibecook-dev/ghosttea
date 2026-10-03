// Light adaptation: render a dark-painted application (one that fills the
// screen with its own truecolor backgrounds) as a light design under a light
// theme. Colors are remapped per style before blending, so glyph coverage,
// color emoji, and the shader stack are untouched.
//
// This is a port of `packages/ghosttea-react/src/renderers/light-adaptation.ts`
// and must stay numerically in step with it; the tests share expected values.
//
//  surfaces  mirror around the paper in Lr (OKLab lightness with Ottosson's
//            toe, which tracks CIE L*): a panel 0.05 above the app's base
//            lands 0.05 below the theme background; the base's tint becomes
//            the paper's. Tinted rows step down until a visible tint fits.
//  neutral   ink keeps its Lr distance from its own cell background, mirrored,
//            so primary/secondary/border grays keep their order.
//  accents   land in a mid-tone band: APCA Lc = clamp(0.5·|Lc| + 28, 45, 70)
//            against the new background, chroma raised toward 0.12.
//
// Theme-owned colors (default fg/bg) are left to the theme, and so are
// chromatic ANSI colors (palette 1–6, 9–14): the light theme designed them for
// light paper, so they pass through unless the remapped surface beneath makes
// them less legible than on the theme background. Neutral ANSI colors (0, 7,
// 8, 15) carry a role — "bright text", "dim panel" — rather than a hue, so
// they remap like truecolor.

import Foundation
import GhostteaFrame

struct GhostteaLightRGB: Hashable, Sendable {
  let red: UInt8
  let green: UInt8
  let blue: UInt8

  init(_ red: UInt8, _ green: UInt8, _ blue: UInt8) {
    self.red = red
    self.green = green
    self.blue = blue
  }

  init(_ color: TRF1RGB) {
    self.init(color.red, color.green, color.blue)
  }

  init(_ color: GhostteaMetalColor) {
    func byte(_ value: Float) -> UInt8 { UInt8((Double(value).clamped() * 255).rounded()) }
    self.init(byte(color.red), byte(color.green), byte(color.blue))
  }

  var metalColor: GhostteaMetalColor {
    GhostteaMetalColor(
      red: Float(red) / 255, green: Float(green) / 255, blue: Float(blue) / 255, alpha: 1)
  }

  var hex: String { String((Int(red) << 16) | (Int(green) << 8) | Int(blue), radix: 16) }
}

private typealias Lab = (L: Double, a: Double, b: Double)

extension Double {
  fileprivate func clamped(_ lo: Double = 0, _ hi: Double = 1) -> Double {
    Swift.min(hi, Swift.max(lo, self))
  }
}

private func toLinear(_ v: Double) -> Double {
  v <= 0.04045 ? v / 12.92 : pow((v + 0.055) / 1.055, 2.4)
}

private func toGamma(_ v: Double) -> Double {
  v <= 0.0031308 ? v * 12.92 : 1.055 * pow(v, 1 / 2.4) - 0.055
}

private func oklab(_ color: GhostteaLightRGB) -> Lab {
  let r = toLinear(Double(color.red) / 255)
  let g = toLinear(Double(color.green) / 255)
  let b = toLinear(Double(color.blue) / 255)
  let l = cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  let m = cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  let s = cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  return (
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
  )
}

private func oklabToLinear(_ lab: Lab) -> (Double, Double, Double) {
  let l1 = lab.L + 0.3963377774 * lab.a + 0.2158037573 * lab.b
  let m1 = lab.L - 0.1055613458 * lab.a - 0.0638541728 * lab.b
  let s1 = lab.L - 0.0894841775 * lab.a - 1.291485548 * lab.b
  let l = l1 * l1 * l1
  let m = m1 * m1 * m1
  let s = s1 * s1 * s1
  return (
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s
  )
}

private func inGamut(_ linear: (Double, Double, Double)) -> Bool {
  [linear.0, linear.1, linear.2].allSatisfy { $0 >= -1e-4 && $0 <= 1 + 1e-4 }
}

private func fromLch(_ L: Double, _ C: Double, _ h: Double) -> Lab {
  (L, C * cos(h), C * sin(h))
}

private func toRgb(_ lab: Lab) -> GhostteaLightRGB {
  let linear = oklabToLinear(lab)
  func byte(_ v: Double) -> UInt8 { UInt8((toGamma(v.clamped()).clamped() * 255).rounded()) }
  return GhostteaLightRGB(byte(linear.0), byte(linear.1), byte(linear.2))
}

/// Keep L and hue; reduce chroma until the color fits sRGB.
private func gamutMap(_ lightness: Double, _ C: Double, _ h: Double) -> GhostteaLightRGB {
  let L = lightness.clamped()
  if inGamut(oklabToLinear(fromLch(L, C, h))) { return toRgb(fromLch(L, C, h)) }
  var lo = 0.0
  var hi = C
  for _ in 0..<20 {
    let mid = (lo + hi) / 2
    if inGamut(oklabToLinear(fromLch(L, mid, h))) { lo = mid } else { hi = mid }
  }
  return toRgb(fromLch(L, lo, h))
}

private func maxChroma(_ L: Double, _ h: Double) -> Double {
  var lo = 0.0
  var hi = 0.4
  for _ in 0..<16 {
    let mid = (lo + hi) / 2
    if inGamut(oklabToLinear(fromLch(L, mid, h))) { lo = mid } else { hi = mid }
  }
  return lo
}

private let k1 = 0.206
private let k2 = 0.03
private let k3 = (1 + k1) / (1 + k2)

private func toe(_ L: Double) -> Double {
  0.5 * (k3 * L - k1 + ((k3 * L - k1) * (k3 * L - k1) + 4 * k2 * k3 * L).squareRoot())
}

private func toeInverse(_ Lr: Double) -> Double {
  (Lr * Lr + k1 * Lr) / (k3 * (Lr + k2))
}

// APCA 0.0.98G-4g. Positive Lc = dark text on a light background.
private func apcaY(_ color: GhostteaLightRGB) -> Double {
  let y =
    0.2126729 * pow(Double(color.red) / 255, 2.4)
    + 0.7151522 * pow(Double(color.green) / 255, 2.4)
    + 0.072175 * pow(Double(color.blue) / 255, 2.4)
  return y < 0.022 ? y + pow(0.022 - y, 1.414) : y
}

private func apca(_ text: GhostteaLightRGB, _ background: GhostteaLightRGB) -> Double {
  let yt = apcaY(text)
  let yb = apcaY(background)
  if abs(yb - yt) < 0.0005 { return 0 }
  if yb > yt {
    let sapc = (pow(yb, 0.56) - pow(yt, 0.57)) * 1.14
    return sapc < 0.1 ? 0 : (sapc - 0.027) * 100
  }
  let sapc = (pow(yb, 0.65) - pow(yt, 0.62)) * 1.14
  return sapc > -0.1 ? 0 : (sapc + 0.027) * 100
}

private func smoothstep(_ e0: Double, _ e1: Double, _ x: Double) -> Double {
  let t = ((x - e0) / (e1 - e0)).clamped()
  return t * t * (3 - 2 * t)
}

private func luminance(_ color: GhostteaLightRGB) -> Double {
  0.2126 * toLinear(Double(color.red) / 255)
    + 0.7152 * toLinear(Double(color.green) / 255)
    + 0.0722 * toLinear(Double(color.blue) / 255)
}

private func contrastRatio(_ a: GhostteaLightRGB, _ b: GhostteaLightRGB) -> Double {
  let first = luminance(a)
  let second = luminance(b)
  return (max(first, second) + 0.05) / (min(first, second) + 0.05)
}

/// Results of `ensureContrast`, shared across renderers like the TypeScript
/// module-level map. `nil` values mean the text already meets the ratio.
private final class GhostteaContrastCache: @unchecked Sendable {
  struct Key: Hashable {
    let text: GhostteaLightRGB
    let background: GhostteaLightRGB
    let ratio: Float
  }

  static let shared = GhostteaContrastCache()

  private let lock = NSLock()
  private var entries: [Key: GhostteaLightRGB?] = [:]

  func value(for key: Key, compute: () -> GhostteaLightRGB?) -> GhostteaLightRGB? {
    if let cached = lock.withLock({ entries[key] }) { return cached }
    let result = compute()
    lock.withLock {
      if entries.count > 4096 { entries.removeAll(keepingCapacity: true) }
      entries[key] = .some(result)
    }
    return result
  }
}

enum GhostteaLightColor {
  /// Engage when this share of cells carries an explicit dark background…
  static let engageShare = 0.6
  /// …and stay engaged until it drops below this, so scrolling content does not flicker.
  static let releaseShare = 0.35

  /// Light when dark text out-contrasts light text: WCAG luminance above ~0.179. Matches the VT shim.
  static func isLightBackground(_ color: GhostteaLightRGB) -> Bool {
    let y = luminance(color)
    return (y + 0.05) / 0.05 > 1.05 / (y + 0.05)
  }

  /// Ghostty's `minimum-contrast`: text below the WCAG ratio against its
  /// background moves toward whichever of black or white contrasts more.
  /// Ghostty snaps straight to that extreme; this keeps hue and chroma and
  /// moves OKLab lightness only as far as the ratio needs, reaching black or
  /// white only when nothing less suffices.
  static func ensureContrast(
    _ text: GhostteaMetalColor,
    background: GhostteaMetalColor,
    ratio: Float
  ) -> GhostteaMetalColor {
    guard ratio > 1 else { return text }
    let fg = GhostteaLightRGB(text)
    let bg = GhostteaLightRGB(background)
    let target = Double(ratio)
    let result = GhostteaContrastCache.shared.value(
      for: .init(text: fg, background: bg, ratio: ratio)
    ) { () -> GhostteaLightRGB? in
      if contrastRatio(fg, bg) >= target { return nil }
      let white = GhostteaLightRGB(255, 255, 255)
      let black = GhostteaLightRGB(0, 0, 0)
      let towardWhite = contrastRatio(white, bg) > contrastRatio(black, bg)
      let lab = oklab(fg)
      let C = hypot(lab.a, lab.b)
      let h = atan2(lab.b, lab.a)
      var near = lab.L
      var far: Double = towardWhite ? 1 : 0
      var best = towardWhite ? white : black
      if contrastRatio(best, bg) >= target {
        for _ in 0..<20 {
          let mid = (near + far) / 2
          let candidate = gamutMap(mid, C, h)
          if contrastRatio(candidate, bg) >= target {
            far = mid
            best = candidate
          } else {
            near = mid
          }
        }
      }
      return best
    }
    guard let result else { return text }
    return GhostteaMetalColor(
      red: Float(result.red) / 255,
      green: Float(result.green) / 255,
      blue: Float(result.blue) / 255,
      alpha: text.alpha
    )
  }

  /// The surface a dark-painted application uses as its base, or nil when the
  /// pane should render as-is: adaptation is off, the theme is dark, or too few
  /// cells carry an explicit dark background (the app follows the theme).
  static func darkPaintedBase(
    state: RetainedTRF1State,
    theme: GhostteaMetalTheme,
    engaged: Bool
  ) -> GhostteaLightRGB? {
    darkPaintedBase(
      styleRows: state.rows.lazy.map(\.styles),
      rowCount: state.rows.count,
      columns: Int(state.columns),
      styleDefinitions: state.styleDefinitions,
      theme: theme,
      engaged: engaged
    )
  }

  static func darkPaintedBase(
    styleRows: some Sequence<[TRF1StyleRun]>,
    rowCount: Int,
    columns: Int,
    styleDefinitions: [UInt32: TRF1StyleDefinition],
    theme: GhostteaMetalTheme,
    engaged: Bool
  ) -> GhostteaLightRGB? {
    guard theme.lightAdaptation, isLightBackground(GhostteaLightRGB(theme.background)) else {
      return nil
    }
    let total = rowCount * columns
    guard total > 0 else { return nil }
    var areas: [GhostteaLightRGB: Int] = [:]
    var order: [GhostteaLightRGB] = []
    var darkness: [GhostteaLightRGB: Bool] = [:]
    var dark = 0
    for runs in styleRows {
      for run in runs {
        let style = styleDefinitions[run.styleID]
        guard let raw = style?.inverse == true ? style?.foreground : style?.background else {
          continue
        }
        let background = GhostteaLightRGB(raw)
        let isDark: Bool
        if let known = darkness[background] {
          isDark = known
        } else {
          isDark = !isLightBackground(background)
          darkness[background] = isDark
        }
        guard isDark else { continue }
        dark += Int(run.cellSpan)
        if let area = areas[background] {
          areas[background] = area + Int(run.cellSpan)
        } else {
          areas[background] = Int(run.cellSpan)
          order.append(background)
        }
      }
    }
    guard Double(dark) / Double(total) >= (engaged ? releaseShare : engageShare) else {
      return nil
    }
    var best: GhostteaLightRGB?
    var bestArea = -1
    for color in order where areas[color]! > bestArea {
      best = color
      bestArea = areas[color]!
    }
    return best
  }
}

/// The remap for one (application base, theme paper, theme ink) triple. Its
/// caches make repeated lookups of the same color cheap, so a renderer keeps
/// one instance per key rather than rebuilding it per frame.
final class GhostteaLightRemap {
  private static let chromaticANSI: Set<UInt8> = [1, 2, 3, 4, 5, 6, 9, 10, 11, 12, 13, 14]

  private struct InkKey: Hashable {
    let color: GhostteaLightRGB
    let sourceBackground: GhostteaLightRGB
    let themeColor: Bool
  }

  /// Stable identity for cache keys: base, paper, and ink.
  let key: String
  let base: GhostteaLightRGB
  private let paper: GhostteaLightRGB
  private let baseLab: Lab
  private let paperLab: Lab
  private let inkLab: Lab
  private let baseLr: Double
  private let paperLr: Double
  private var surfaces: [GhostteaLightRGB: GhostteaLightRGB] = [:]
  private var inks: [InkKey: GhostteaMetalColor] = [:]

  init(
    base: GhostteaLightRGB, paper paperColor: GhostteaMetalColor, ink inkColor: GhostteaMetalColor
  ) {
    let paper = GhostteaLightRGB(paperColor)
    let ink = GhostteaLightRGB(inkColor)
    self.base = base
    self.paper = paper
    baseLab = oklab(base)
    paperLab = oklab(paper)
    inkLab = oklab(ink)
    baseLr = toe(baseLab.L)
    paperLr = toe(paperLab.L)
    key = [base, paper, ink].map(\.hex).joined(separator: "/")
  }

  /// A color painted as an area: cell backgrounds and block-element art.
  func surface(_ color: GhostteaLightRGB) -> GhostteaMetalColor {
    surfaceRGB(color).metalColor
  }

  /// A glyph color, judged against the background it was designed on.
  /// `paletteIndex` is the ANSI entry the color came from, when known.
  func ink(
    _ color: GhostteaLightRGB,
    sourceBackground: GhostteaLightRGB,
    paletteIndex: UInt8? = nil
  ) -> GhostteaMetalColor {
    let themeColor = paletteIndex.map(Self.chromaticANSI.contains) ?? false
    let cacheKey = InkKey(color: color, sourceBackground: sourceBackground, themeColor: themeColor)
    if let cached = inks[cacheKey] { return cached }
    let mapped = surfaceRGB(sourceBackground)
    if themeColor {
      let legibility = min(45, abs(apca(color, paper)))
      if abs(apca(color, mapped)) >= legibility {
        let rgba = color.metalColor
        inks[cacheKey] = rgba
        return rgba
      }
    }
    let lab = oklab(color)
    let C0 = hypot(lab.a, lab.b)
    // Neutral ink: mirror its Lr distance from the background, and lean
    // toward the theme ink's tint so app grays sit in the chosen theme.
    var a = lab.a
    var b = lab.b
    if C0 < 0.03 {
      let w = (1 - C0 / 0.03) * 0.7
      a = lab.a * (1 - w) + inkLab.a * w
      b = lab.b * (1 - w) + inkLab.b * w
    }
    let C = hypot(a, b)
    let h = atan2(b, a)
    let delta = toe(lab.L) - toe(oklab(sourceBackground).L)
    let sign: Double = delta >= 0 ? -1 : 1
    let Lr = (toe(oklab(mapped).L) + sign * max(abs(delta), 0.06)).clamped()
    var result = gamutMap(toeInverse(Lr), C, h)
    let w = smoothstep(0.03, 0.08, C0)
    if w > 0 {
      let source = apca(color, sourceBackground)
      let lightOnDark = source < 0 || (source == 0 && delta >= 0)
      let magnitude = (abs(source) * 0.5 + 28).clamped(45, 70)
      let boosted = C0 + w * (0.12 - C0).clamped(0, C0 * 0.8)
      let accent = solveLc(
        lightOnDark ? magnitude : -magnitude, boosted, atan2(lab.b, lab.a), mapped)
      if w >= 1 {
        result = accent
      } else {
        let p = oklab(result)
        let q = oklab(accent)
        result = toRgb(
          (p.L * (1 - w) + q.L * w, p.a * (1 - w) + q.a * w, p.b * (1 - w) + q.b * w))
      }
    }
    let rgba = result.metalColor
    inks[cacheKey] = rgba
    return rgba
  }

  private func surfaceRGB(_ color: GhostteaLightRGB) -> GhostteaLightRGB {
    if let cached = surfaces[color] { return cached }
    let lab = oklab(color)
    var Lr = (paperLr - (toe(lab.L) - baseLr)).clamped()
    let ap = lab.a - baseLab.a + paperLab.a
    let bp = lab.b - baseLab.b + paperLab.b
    let C = hypot(ap, bp)
    let h = atan2(bp, ap)
    if C > 0.015 {
      let want = min(C, 0.045)
      let stop = Lr - 0.15
      while Lr > stop && maxChroma(toeInverse(Lr), h) < want { Lr -= 0.005 }
    }
    let result = gamutMap(toeInverse(Lr), C, h)
    surfaces[color] = result
    return result
  }

  private func solveLc(
    _ want: Double, _ C: Double, _ h: Double, _ background: GhostteaLightRGB
  ) -> GhostteaLightRGB {
    let backgroundL = oklab(background).L
    var lo = want > 0 ? 0 : backgroundL
    var hi = want > 0 ? backgroundL : 1
    var best = gamutMap(want > 0 ? 0 : 1, C, h)
    for _ in 0..<18 {
      let mid = (lo + hi) / 2
      let candidate = gamutMap(mid, C, h)
      let lc = apca(candidate, background)
      let enough = want > 0 ? lc >= want : lc <= want
      if enough { best = candidate }
      if (want > 0) == enough { lo = mid } else { hi = mid }
    }
    return best
  }
}
