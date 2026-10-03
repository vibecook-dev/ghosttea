// Light adaptation: render a dark-painted application (one that fills the
// screen with its own truecolor backgrounds) as a light design under a light
// theme. Colors are remapped per style before blending, so glyph coverage,
// color emoji, and the shader stack are untouched.
//
// The rules come from comparing candidate remaps with three applications' own
// light designs (GrokDay, Codex, OpenCode):
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

import type { StyleDefinition } from "@vibecook/ghosttea-frame";
import type { RenderView, Rgba } from "./types.js";

export type Rgb = readonly [number, number, number];
type Lab = [number, number, number];

const clamp = (value: number, lo = 0, hi = 1): number => Math.min(hi, Math.max(lo, value));
const toLinear = (v: number): number => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const toGamma = (v: number): number => (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055);

function oklab([r8, g8, b8]: Rgb): Lab {
  const r = toLinear(r8 / 255);
  const g = toLinear(g8 / 255);
  const b = toLinear(b8 / 255);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function oklabToLinear([L, a, b]: Lab): Lab {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

const inGamut = (linear: Lab): boolean => linear.every((v) => v >= -1e-4 && v <= 1 + 1e-4);
const fromLch = (L: number, C: number, h: number): Lab => [L, C * Math.cos(h), C * Math.sin(h)];
const toRgb = (lab: Lab): Rgb =>
  oklabToLinear(lab).map((v) => Math.round(clamp(toGamma(clamp(v))) * 255)) as unknown as Rgb;

/** Keep L and hue; reduce chroma until the color fits sRGB. */
function gamutMap(L: number, C: number, h: number): Rgb {
  L = clamp(L);
  if (inGamut(oklabToLinear(fromLch(L, C, h)))) return toRgb(fromLch(L, C, h));
  let lo = 0;
  let hi = C;
  for (let i = 0; i < 20; i += 1) {
    const mid = (lo + hi) / 2;
    if (inGamut(oklabToLinear(fromLch(L, mid, h)))) lo = mid;
    else hi = mid;
  }
  return toRgb(fromLch(L, lo, h));
}

function maxChroma(L: number, h: number): number {
  let lo = 0;
  let hi = 0.4;
  for (let i = 0; i < 16; i += 1) {
    const mid = (lo + hi) / 2;
    if (inGamut(oklabToLinear(fromLch(L, mid, h)))) lo = mid;
    else hi = mid;
  }
  return lo;
}

const K1 = 0.206;
const K2 = 0.03;
const K3 = (1 + K1) / (1 + K2);
const toe = (L: number): number => 0.5 * (K3 * L - K1 + Math.sqrt((K3 * L - K1) ** 2 + 4 * K2 * K3 * L));
const toeInv = (Lr: number): number => (Lr * Lr + K1 * Lr) / (K3 * (Lr + K2));

// APCA 0.0.98G-4g. Positive Lc = dark text on a light background.
function apcaY([r, g, b]: Rgb): number {
  const y = 0.2126729 * (r / 255) ** 2.4 + 0.7151522 * (g / 255) ** 2.4 + 0.072175 * (b / 255) ** 2.4;
  return y < 0.022 ? y + (0.022 - y) ** 1.414 : y;
}
function apca(text: Rgb, background: Rgb): number {
  const yt = apcaY(text);
  const yb = apcaY(background);
  if (Math.abs(yb - yt) < 0.0005) return 0;
  if (yb > yt) {
    const sapc = (yb ** 0.56 - yt ** 0.57) * 1.14;
    return sapc < 0.1 ? 0 : (sapc - 0.027) * 100;
  }
  const sapc = (yb ** 0.65 - yt ** 0.62) * 1.14;
  return sapc > -0.1 ? 0 : (sapc + 0.027) * 100;
}

const smoothstep = (e0: number, e1: number, x: number): number => {
  const t = clamp((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};

const toRgba = ([r, g, b]: Rgb): Rgba => [r / 255, g / 255, b / 255, 1];
const fromRgba = (color: Rgba): Rgb => [
  Math.round(clamp(color[0]) * 255),
  Math.round(clamp(color[1]) * 255),
  Math.round(clamp(color[2]) * 255),
];
const keyOf = ([r, g, b]: Rgb): number => (r << 16) | (g << 8) | b;

const luminance = ([r, g, b]: Rgb): number =>
  0.2126 * toLinear(r / 255) + 0.7152 * toLinear(g / 255) + 0.0722 * toLinear(b / 255);
const contrastRatio = (a: Rgb, b: Rgb): number => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};

/** Light when dark text out-contrasts light text: WCAG luminance above ~0.179. Matches the VT shim. */
export function isLightBackground(color: Rgb): boolean {
  const y = luminance(color);
  return (y + 0.05) / 0.05 > 1.05 / (y + 0.05);
}

/** null: the text already meets the ratio. */
const contrasted = new Map<string, Rgb | null>();

/**
 * Ghostty's `minimum-contrast`: text below the WCAG ratio against its
 * background moves toward whichever of black or white contrasts more. Ghostty
 * snaps straight to that extreme; this keeps hue and chroma and moves OKLab
 * lightness only as far as the ratio needs, reaching black or white only when
 * nothing less suffices.
 */
export function ensureContrast(text: Rgba, background: Rgba, ratio: number): Rgba {
  if (!(ratio > 1)) return text;
  const fg = fromRgba(text);
  const bg = fromRgba(background);
  const cacheKey = `${keyOf(fg)}/${keyOf(bg)}/${ratio}`;
  let result = contrasted.get(cacheKey);
  if (result === undefined) {
    if (contrastRatio(fg, bg) >= ratio) result = null;
    else {
      const towardWhite = contrastRatio([255, 255, 255], bg) > contrastRatio([0, 0, 0], bg);
      const [L, a, b] = oklab(fg);
      const C = Math.hypot(a, b);
      const h = Math.atan2(b, a);
      let near = L;
      let far = towardWhite ? 1 : 0;
      let best: Rgb = towardWhite ? [255, 255, 255] : [0, 0, 0];
      if (contrastRatio(best, bg) >= ratio) {
        for (let i = 0; i < 20; i += 1) {
          const mid = (near + far) / 2;
          const candidate = gamutMap(mid, C, h);
          if (contrastRatio(candidate, bg) >= ratio) {
            far = mid;
            best = candidate;
          } else near = mid;
        }
      }
      result = best;
    }
    if (contrasted.size > 4096) contrasted.clear();
    contrasted.set(cacheKey, result);
  }
  if (result === null) return text;
  return [result[0] / 255, result[1] / 255, result[2] / 255, text[3]];
}

export interface LightAdaptation {
  /** Stable identity for cache keys: base, paper, and ink. */
  readonly key: string;
  readonly base: Rgb;
  /** A color painted as an area: cell backgrounds and block-element art. */
  surface(color: Rgb): Rgba;
  /**
   * A glyph color, judged against the background it was designed on.
   * `paletteIndex` is the ANSI entry the color came from, when known.
   */
  ink(color: Rgb, sourceBackground: Rgb, paletteIndex?: number): Rgba;
}

export function createLightAdaptation(base: Rgb, paperColor: Rgba, inkColor: Rgba): LightAdaptation {
  const paper = fromRgba(paperColor);
  const inkRgb = fromRgba(inkColor);
  const baseLab = oklab(base);
  const paperLab = oklab(paper);
  const inkLab = oklab(inkRgb);
  const baseLr = toe(baseLab[0]);
  const paperLr = toe(paperLab[0]);

  const surfaces = new Map<number, Rgb>();
  const surfaceRgb = (color: Rgb): Rgb => {
    const cached = surfaces.get(keyOf(color));
    if (cached) return cached;
    const [L, a, b] = oklab(color);
    let Lr = clamp(paperLr - (toe(L) - baseLr));
    const ap = a - baseLab[1] + paperLab[1];
    const bp = b - baseLab[2] + paperLab[2];
    const C = Math.hypot(ap, bp);
    const h = Math.atan2(bp, ap);
    if (C > 0.015) {
      const want = Math.min(C, 0.045);
      const stop = Lr - 0.15;
      while (Lr > stop && maxChroma(toeInv(Lr), h) < want) Lr -= 0.005;
    }
    const result = gamutMap(toeInv(Lr), C, h);
    surfaces.set(keyOf(color), result);
    return result;
  };

  const solveLc = (want: number, C: number, h: number, background: Rgb): Rgb => {
    const backgroundL = oklab(background)[0];
    let lo = want > 0 ? 0 : backgroundL;
    let hi = want > 0 ? backgroundL : 1;
    let best = gamutMap(want > 0 ? 0 : 1, C, h);
    for (let i = 0; i < 18; i += 1) {
      const mid = (lo + hi) / 2;
      const candidate = gamutMap(mid, C, h);
      const lc = apca(candidate, background);
      const enough = want > 0 ? lc >= want : lc <= want;
      if (enough) best = candidate;
      if (want > 0 === enough) lo = mid;
      else hi = mid;
    }
    return best;
  };

  const inks = new Map<string, Rgba>();
  const ink = (color: Rgb, sourceBackground: Rgb, paletteIndex?: number): Rgba => {
    const themeColor = paletteIndex !== undefined && CHROMATIC_ANSI.has(paletteIndex);
    const cacheKey = `${keyOf(color)}/${keyOf(sourceBackground)}${themeColor ? "/p" : ""}`;
    const cached = inks.get(cacheKey);
    if (cached) return cached;
    const mapped = surfaceRgb(sourceBackground);
    if (themeColor) {
      const legibility = Math.min(45, Math.abs(apca(color, paper)));
      if (Math.abs(apca(color, mapped)) >= legibility) {
        const rgba = toRgba(color);
        inks.set(cacheKey, rgba);
        return rgba;
      }
    }
    const [L, a0, b0] = oklab(color);
    const C0 = Math.hypot(a0, b0);
    // Neutral ink: mirror its Lr distance from the background, and lean
    // toward the theme ink's tint so app grays sit in the chosen theme.
    let a = a0;
    let b = b0;
    if (C0 < 0.03) {
      const w = (1 - C0 / 0.03) * 0.7;
      a = a0 * (1 - w) + inkLab[1] * w;
      b = b0 * (1 - w) + inkLab[2] * w;
    }
    const C = Math.hypot(a, b);
    const h = Math.atan2(b, a);
    const delta = toe(L) - toe(oklab(sourceBackground)[0]);
    const sign = delta >= 0 ? -1 : 1;
    const Lr = clamp(toe(oklab(mapped)[0]) + sign * Math.max(Math.abs(delta), 0.06));
    let result = gamutMap(toeInv(Lr), C, h);
    const w = smoothstep(0.03, 0.08, C0);
    if (w > 0) {
      const source = apca(color, sourceBackground);
      const lightOnDark = source < 0 || (source === 0 && delta >= 0);
      const magnitude = clamp(Math.abs(source) * 0.5 + 28, 45, 70);
      const boosted = C0 + w * clamp(0.12 - C0, 0, C0 * 0.8);
      const accent = solveLc(lightOnDark ? magnitude : -magnitude, boosted, Math.atan2(b0, a0), mapped);
      if (w >= 1) result = accent;
      else {
        const p = oklab(result);
        const q = oklab(accent);
        result = toRgb([p[0] * (1 - w) + q[0] * w, p[1] * (1 - w) + q[1] * w, p[2] * (1 - w) + q[2] * w]);
      }
    }
    const rgba = toRgba(result);
    inks.set(cacheKey, rgba);
    return rgba;
  };

  return {
    key: [base, paper, inkRgb].map((color) => keyOf(color).toString(16)).join("/"),
    base,
    surface: (color) => toRgba(surfaceRgb(color)),
    ink,
  };
}

const CHROMATIC_ANSI = new Set([1, 2, 3, 4, 5, 6, 9, 10, 11, 12, 13, 14]);

/** Engage when this share of cells carries an explicit dark background… */
export const ENGAGE_SHARE = 0.6;
/** …and stay engaged until it drops below this, so scrolling content does not flicker. */
export const RELEASE_SHARE = 0.35;

/**
 * The surface a dark-painted application uses as its base, or null when the
 * pane should render as-is: adaptation is off, the theme is dark, or too few
 * cells carry an explicit dark background (the app follows the theme).
 */
export function darkPaintedBase(view: RenderView, engaged: boolean): Rgb | null {
  if ((view.theme.lightAdaptation ?? "off") === "off") return null;
  if (!isLightBackground(fromRgba(view.theme.background))) return null;
  const rows = Math.max(view.rows.length, view.nativeStyleRows.length);
  const total = rows * view.cols;
  if (total === 0) return null;
  const areas = new Map<number, number>();
  let dark = 0;
  const darkness = new Map<number, boolean>();
  for (const runs of view.nativeStyleRows) {
    for (const run of runs) {
      const style: StyleDefinition | undefined = view.styleDefinitions.get(run.styleId);
      const background = style?.inverse ? style.foreground : style?.background;
      if (!background) continue;
      const key = keyOf(background);
      let isDark = darkness.get(key);
      if (isDark === undefined) {
        isDark = !isLightBackground(background);
        darkness.set(key, isDark);
      }
      if (!isDark) continue;
      dark += run.cellSpan;
      areas.set(key, (areas.get(key) ?? 0) + run.cellSpan);
    }
  }
  if (dark / total < (engaged ? RELEASE_SHARE : ENGAGE_SHARE)) return null;
  let bestKey = 0;
  let bestArea = -1;
  for (const [key, area] of areas) {
    if (area > bestArea) {
      bestKey = key;
      bestArea = area;
    }
  }
  return [(bestKey >> 16) & 0xff, (bestKey >> 8) & 0xff, bestKey & 0xff];
}
