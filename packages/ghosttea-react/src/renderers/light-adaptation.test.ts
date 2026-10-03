import type { StyleDefinition, StyleRun } from "@vibecook/ghosttea-frame";
import { describe, expect, it } from "vitest";
import {
  createLightAdaptation,
  darkPaintedBase,
  ensureContrast,
  isLightBackground,
  type Rgb,
} from "./light-adaptation.js";
import { DEFAULT_THEME, type RenderView, type Rgba, type TerminalTheme } from "./types.js";

const rgba = ([r, g, b]: Rgb): Rgba => [r / 255, g / 255, b / 255, 1];
const bytes = (color: Rgba): Rgb => [color[0], color[1], color[2]].map((v) => Math.round(v * 255)) as unknown as Rgb;
const near = (actual: Rgba, expected: Rgb, tolerance = 6): void => {
  bytes(actual).forEach((value, index) => expect(Math.abs(value - expected[index]!)).toBeLessThanOrEqual(tolerance));
};

// GrokNight's base and GrokDay's paper, with a neutral ink so no tint shifts.
const grok = createLightAdaptation([0x14, 0x14, 0x14], rgba([0xee, 0xee, 0xee]), rgba([0x26, 0x26, 0x26]));

describe("light adaptation colors", () => {
  it("maps the app's base surface onto the theme paper", () => {
    near(grok.surface([0x14, 0x14, 0x14]), [0xee, 0xee, 0xee], 1);
  });

  it("keeps the gray hierarchy of GrokNight close to GrokDay", () => {
    near(grok.ink([0xe1, 0xe1, 0xe1], grok.base), [0x26, 0x26, 0x26], 10); // primary
    near(grok.ink([0x73, 0x73, 0x73], grok.base), [0x74, 0x74, 0x74], 16); // secondary
    near(grok.ink([0x33, 0x33, 0x33], grok.base), [0xcd, 0xcd, 0xcd], 8); // border
  });

  it("keeps an accent's hue instead of inverting it", () => {
    const [r, g, b] = bytes(grok.ink([0xe0, 0xaf, 0x68], grok.base));
    expect(r).toBeGreaterThan(g);
    expect(g).toBeGreaterThan(b);
    near(grok.ink([0xe0, 0xaf, 0x68], grok.base), [0xa2, 0x76, 0x12], 14);
  });

  it("keeps a visible tint on dark diff rows", () => {
    const claude = createLightAdaptation([0x1e, 0x1e, 0x2e], rgba([0xef, 0xf1, 0xf5]), rgba([0x4c, 0x4f, 0x69]));
    const [r, g, b] = bytes(claude.surface([0x3d, 0x01, 0x00]));
    expect(r).toBeGreaterThan(240);
    expect(r - Math.min(g, b)).toBeGreaterThan(20);
  });

  it("keeps a light theme's own ANSI colors when they stay legible", () => {
    const red: Rgb = [0xd2, 0x0f, 0x39]; // Catppuccin Latte red, designed for light paper
    const latte = createLightAdaptation([0x1e, 0x1e, 0x2e], rgba([0xef, 0xf1, 0xf5]), rgba([0x4c, 0x4f, 0x69]));
    expect(bytes(latte.ink(red, latte.base, 1))).toEqual(red);
    // The same RGB as truecolor is an application color and is remapped.
    expect(bytes(latte.ink(red, latte.base))).not.toEqual(red);
    // Neutral entries describe a role, not a hue: "white" text still darkens.
    const white = bytes(latte.ink([0xbc, 0xc0, 0xcc], latte.base, 7));
    expect(white[0]).toBeLessThan(0x80);
  });

  it("classifies backgrounds the same way the VT shim answers CSI ? 996 n", () => {
    expect(isLightBackground([0xef, 0xf1, 0xf5])).toBe(true);
    expect(isLightBackground([0x1e, 0x1e, 0x2e])).toBe(false);
  });
});

describe("minimum contrast", () => {
  const luminance = (color: Rgba): number =>
    [0.2126, 0.7152, 0.0722].reduce((sum, weight, index) => {
      const v = color[index]!;
      return sum + weight * (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    }, 0);
  const ratio = (a: Rgba, b: Rgba): number => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
    return (hi + 0.05) / (lo + 0.05);
  };
  const panel = rgba([0xe6, 0xe6, 0xe6]);

  it("leaves text alone when it is off or already meets the ratio", () => {
    const gray = rgba([0x9a, 0x9a, 0x9a]);
    expect(ensureContrast(gray, panel, 1)).toBe(gray);
    const ink = rgba([0x26, 0x26, 0x26]);
    expect(ensureContrast(ink, panel, 4.5)).toBe(ink);
  });

  it("moves lightness only as far as the ratio needs and keeps the hue", () => {
    const amber: Rgba = [0xe0 / 255, 0xaf / 255, 0x68 / 255, 0.55];
    const result = ensureContrast(amber, panel, 4.5);
    expect(ratio(result, panel)).toBeGreaterThanOrEqual(4.5);
    expect(ratio(result, panel)).toBeLessThan(4.7);
    const [r, g, b] = bytes(result);
    expect(r).toBeGreaterThan(g);
    expect(g).toBeGreaterThan(b);
    expect(result[3]).toBe(0.55);
  });

  it("reaches black or white when nothing less suffices", () => {
    expect(bytes(ensureContrast(rgba([0x80, 0x80, 0x80]), rgba([0x80, 0x80, 0x80]), 21))).toEqual([0, 0, 0]);
    expect(bytes(ensureContrast(rgba([0x30, 0x30, 0x30]), rgba([0x20, 0x20, 0x20]), 7))[0]).toBeGreaterThan(0x80);
  });
});

function view(theme: TerminalTheme, cols: number, rows: number, paintedRows: number): RenderView {
  const style: StyleDefinition = {
    id: 7,
    bold: false,
    italic: false,
    faint: false,
    inverse: false,
    invisible: false,
    strikethrough: false,
    underline: false,
    background: [0x14, 0x14, 0x14],
  };
  const painted: StyleRun[] = [{ styleId: 7, cellStart: 0, cellSpan: cols }];
  return {
    cols,
    rows: Array<string>(rows).fill(""),
    nativeStyleRows: Array.from({ length: rows }, (_, row) => (row < paintedRows ? painted : [])),
    styleDefinitions: new Map([[7, style]]),
    theme,
  } as unknown as RenderView;
}

const light: TerminalTheme = {
  ...DEFAULT_THEME,
  background: rgba([0xef, 0xf1, 0xf5]),
  foreground: rgba([0x4c, 0x4f, 0x69]),
  lightAdaptation: "auto",
};

describe("light adaptation engagement", () => {
  it("engages for a pane the app paints dark under a light theme", () => {
    expect(darkPaintedBase(view(light, 10, 10, 10), false)).toEqual([0x14, 0x14, 0x14]);
  });

  it("stays off for dark themes, opt-outs, and apps that follow the theme", () => {
    expect(darkPaintedBase(view({ ...light, background: rgba([0x1e, 0x1e, 0x2e]) }, 10, 10, 10), false)).toBeNull();
    expect(darkPaintedBase(view({ ...light, lightAdaptation: "off" }, 10, 10, 10), false)).toBeNull();
    expect(darkPaintedBase(view(light, 10, 10, 1), false)).toBeNull();
  });

  it("uses hysteresis so partially painted scrolls do not flicker", () => {
    expect(darkPaintedBase(view(light, 10, 10, 5), false)).toBeNull();
    expect(darkPaintedBase(view(light, 10, 10, 5), true)).toEqual([0x14, 0x14, 0x14]);
    expect(darkPaintedBase(view(light, 10, 10, 3), true)).toBeNull();
  });
});
