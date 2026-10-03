import { describe, expect, it } from "vitest";
import type { ConfigSnapshot } from "@vibecook/ghosttea-protocol";
import { appearanceDraftFromConfig, sameAppearanceDraft } from "./AppearanceSettings.js";

const config = {
  revision: "config-1",
  renderer: {
    foreground: [240, 241, 242],
    background: [16, 17, 18],
    cursor: [171, 205, 239],
    selectionBackground: [32, 33, 34],
    selectionForeground: [224, 225, 226],
    backgroundOpacity: 0.73,
    backgroundOpacityCells: true,
    postProcess: "none",
    shaderEffects: ["ghosttea:crt", "not-bundled"],
    customShaderAnimation: true,
  },
} as ConfigSnapshot;

describe("Appearance settings draft", () => {
  it("projects only values that the Appearance page owns", () => {
    expect(appearanceDraftFromConfig(config)).toMatchObject({
      opacity: 0.73,
      opacityCells: true,
      effects: ["ghosttea:crt"],
      animation: true,
      lightAdaptation: "auto",
      minimumContrast: 1,
    });
    expect(
      appearanceDraftFromConfig({
        ...config,
        renderer: { ...config.renderer, lightAdaptation: "off", minimumContrast: 4.5 },
      }),
    ).toMatchObject({ lightAdaptation: "off", minimumContrast: 4.5 });
  });

  it("detects a stale sibling draft without relying on object identity", () => {
    const baseline = appearanceDraftFromConfig(config);
    expect(sameAppearanceDraft(baseline, { ...baseline, effects: [...baseline.effects] })).toBe(true);
    expect(sameAppearanceDraft(baseline, { ...baseline, opacity: 0.5 })).toBe(false);
    expect(sameAppearanceDraft(baseline, { ...baseline, effects: [] })).toBe(false);
    expect(sameAppearanceDraft(baseline, { ...baseline, lightAdaptation: "off" })).toBe(false);
    expect(sameAppearanceDraft(baseline, { ...baseline, minimumContrast: 3 })).toBe(false);
  });
});
