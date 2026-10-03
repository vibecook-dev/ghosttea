import { describe, expect, it } from "vitest";
import type { RendererConfig } from "@vibecook/ghosttea-protocol";
import { terminalEffectsFromConfig, terminalThemeFromConfig } from "./config";
import { DEFAULT_EFFECTS, terminalEffectsNeedAnimation } from "./renderers/types";

const renderer: RendererConfig = {
  foreground: [255, 128, 0],
  background: [16, 32, 64],
  cursor: [1, 2, 3],
  selectionBackground: [4, 5, 6],
  selectionForeground: [7, 8, 9],
  fontSize: 13,
  fontFamilies: [],
  paddingX: [2, 2],
  paddingY: [2, 2],
  postProcess: "better-crt",
  customShaderPaths: [],
};

describe("shared configuration presentation", () => {
  it("normalizes byte colors and carries the selected post-process effect", () => {
    expect(terminalThemeFromConfig({ renderer })).toEqual({
      foreground: [1, 128 / 255, 0, 1],
      background: [16 / 255, 32 / 255, 64 / 255, 1],
      cursor: [1 / 255, 2 / 255, 3 / 255, 1],
      cursorText: [16 / 255, 32 / 255, 64 / 255, 1],
      selection: [4 / 255, 5 / 255, 6 / 255, 1],
      selectionForeground: [7 / 255, 8 / 255, 9 / 255, 1],
      backgroundOpacityCells: false,
      lightAdaptation: "auto",
      minimumContrast: 1,
    });
    expect(
      terminalThemeFromConfig({ renderer: { ...renderer, lightAdaptation: "off", minimumContrast: 4.5 } }),
    ).toMatchObject({ lightAdaptation: "off", minimumContrast: 4.5 });
    expect(terminalEffectsFromConfig({ renderer })).toEqual({
      postProcess: "better-crt",
      shaderEffects: ["ghosttea:better-crt"],
      animate: false,
    });
  });

  it("keeps post-processing disabled without an imported opt-in", () => {
    expect(DEFAULT_EFFECTS).toEqual({ postProcess: "none", shaderEffects: [], animate: false });
  });

  it("requests animation frames only when an animated effect is selected", () => {
    expect(
      terminalEffectsNeedAnimation({
        postProcess: "none",
        shaderEffects: ["ghosttea:crt", "ghosttea:better-crt"],
        animate: true,
      }),
    ).toBe(false);
    expect(
      terminalEffectsNeedAnimation({
        postProcess: "none",
        shaderEffects: ["ghosttea:crt", "ghosttea:vhs"],
        animate: true,
      }),
    ).toBe(true);
    expect(
      terminalEffectsNeedAnimation({
        postProcess: "none",
        shaderEffects: ["ghosttea:sparks-from-fire"],
        animate: false,
      }),
    ).toBe(false);
  });
});
