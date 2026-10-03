import { describe, expect, it } from "vitest";
import type { RendererConfig } from "@vibecook/ghosttea-protocol";
import {
  APPEARANCE_BLOCK_END,
  APPEARANCE_BLOCK_START,
  appearanceBlock,
  appearanceUpdateMismatches,
  patchAppearanceBlock,
  validateAppearanceUpdate,
  type ManagedAppearanceUpdate,
} from "./appearance-config";

const update: ManagedAppearanceUpdate = {
  theme: {
    name: "Test Theme",
    background: "#101112",
    foreground: "#f0f1f2",
    cursor: "#abcdef",
    cursorText: "#010203",
    selection: "#202122",
    selectionForeground: "#e0e1e2",
    palette: Array.from({ length: 16 }, (_, index) => `#${index.toString(16).repeat(6)}`),
  },
  backgroundOpacity: 0.73,
  backgroundOpacityCells: true,
  shaderEffects: ["ghosttea:crt", "ghosttea:vhs"],
  shaderAnimation: true,
};

describe("managed appearance config", () => {
  it("validates colors and keeps a unique ordered shader stack", () => {
    const validated = validateAppearanceUpdate({
      ...update,
      theme: { ...update.theme!, background: "#AABBCC" },
      shaderEffects: ["ghosttea:vhs", "ghosttea:crt", "ghosttea:vhs"],
    });
    expect(validated.theme!.background).toBe("#aabbcc");
    expect(validated.shaderEffects).toEqual(["ghosttea:vhs", "ghosttea:crt"]);
    expect(() => validateAppearanceUpdate({ ...update, shaderEffects: ["/tmp/untrusted.glsl"] })).toThrow(
      "unknown effect",
    );
    expect(() =>
      validateAppearanceUpdate({ ...update, theme: { ...update.theme!, name: "bad\nforeground = red" } }),
    ).toThrow("Theme name is invalid");
  });

  it("preserves custom colors when no catalog theme was selected", () => {
    const { theme, ...customColorUpdate } = update;
    const validated = validateAppearanceUpdate(customColorUpdate);
    const block = appearanceBlock(validated);

    expect(theme).toBeDefined();
    expect(validated.theme).toBeUndefined();
    expect(block).toContain("# Theme: current custom colors preserved");
    expect(block).not.toContain("background =");
    expect(block).not.toContain("palette =");
  });

  it("appends a complete CRLF block without rewriting user settings", () => {
    const original = "# user comment\r\nfont-size = 14\r\n";
    const result = patchAppearanceBlock(original, appearanceBlock(update));
    expect(result.startsWith(original)).toBe(true);
    expect(result).toContain(`${APPEARANCE_BLOCK_START}\r\n# Theme: Test Theme`);
    expect(result).toContain("palette = 15=#ffffff\r\n");
    expect(result).toContain("custom-shader = ghosttea:crt\r\ncustom-shader = ghosttea:vhs\r\n");
    expect(result).not.toMatch(/(^|[^\r])\n/u);
  });

  it("replaces only the existing managed block", () => {
    const first = patchAppearanceBlock("font-size = 14\n", appearanceBlock(update));
    const second = patchAppearanceBlock(
      `${first}# untouched tail\n`,
      appearanceBlock({ ...update, backgroundOpacity: 0.5, shaderEffects: [] }),
    );
    expect(second.match(new RegExp(APPEARANCE_BLOCK_START.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "gu"))).toHaveLength(
      1,
    );
    expect(second).toContain("font-size = 14\n");
    expect(second).toContain("background-opacity = 0.50\n");
    expect(second).toContain("# untouched tail\n");
    expect(second.indexOf("# untouched tail")).toBeLessThan(second.indexOf(APPEARANCE_BLOCK_START));
    expect(second.trimEnd().endsWith(APPEARANCE_BLOCK_END)).toBe(true);
  });

  it("preserves trailing spaces and indentation outside the managed block", () => {
    const original = `# before   \n\n${APPEARANCE_BLOCK_START}\nold = value\n${APPEARANCE_BLOCK_END}\n  # tail   \n`;
    const result = patchAppearanceBlock(original, appearanceBlock(update));

    expect(result).toContain("# before   \n\n  # tail   \n");
    expect(result).toContain("  # tail   \n\n# >>> Ghosttea appearance");
  });

  it("detects requested values shadowed by a later included layer", () => {
    const renderer: RendererConfig = {
      foreground: [0xf0, 0xf1, 0xf2],
      background: [0x10, 0x11, 0x12],
      cursor: [0xab, 0xcd, 0xef],
      cursorText: [1, 2, 3],
      selectionBackground: [0x20, 0x21, 0x22],
      selectionForeground: [0xe0, 0xe1, 0xe2],
      palette: update.theme!.palette.map((color, index) => ({
        index,
        color: [1, 3, 5].map((offset) => Number.parseInt(color.slice(offset, offset + 2), 16)) as [
          number,
          number,
          number,
        ],
      })),
      backgroundOpacity: 0.73,
      backgroundOpacityCells: true,
      fontSize: 13,
      fontFamilies: [],
      paddingX: [2, 2],
      paddingY: [2, 2],
      postProcess: "none",
      shaderEffects: ["ghosttea:crt", "ghosttea:vhs"],
      customShaderAnimation: true,
      customShaderPaths: [],
    };

    expect(appearanceUpdateMismatches(renderer, update)).toEqual([]);
    expect(
      appearanceUpdateMismatches({ ...renderer, background: [9, 9, 9], shaderEffects: ["ghosttea:vhs"] }, update),
    ).toEqual(["background", "custom-shader"]);
  });

  it("writes readability settings only when the renderer sends them", () => {
    const readable = validateAppearanceUpdate({ ...update, lightAdaptation: "off", minimumContrast: 4.567 });
    expect(readable).toMatchObject({ lightAdaptation: "off", minimumContrast: 4.57 });
    const block = appearanceBlock(readable);
    expect(block).toContain("ghosttea-light-adaptation = off\nminimum-contrast = 4.57\n");
    expect(appearanceBlock(validateAppearanceUpdate(update))).not.toMatch(/light-adaptation|minimum-contrast/u);
    expect(() => validateAppearanceUpdate({ ...update, lightAdaptation: "maybe" })).toThrow("auto or off");
    expect(() => validateAppearanceUpdate({ ...update, minimumContrast: 0 })).toThrow("between 1 and 21");

    const renderer = { lightAdaptation: "auto", minimumContrast: 1 } as RendererConfig;
    const customColors: ManagedAppearanceUpdate = {
      backgroundOpacity: 1,
      backgroundOpacityCells: false,
      shaderEffects: [],
      shaderAnimation: false,
      lightAdaptation: "off",
      minimumContrast: 4.57,
    };
    expect(appearanceUpdateMismatches(renderer, customColors)).toEqual(
      expect.arrayContaining(["ghosttea-light-adaptation", "minimum-contrast"]),
    );
  });

  it("refuses ambiguous or incomplete managed markers", () => {
    expect(() => patchAppearanceBlock(`${APPEARANCE_BLOCK_START}\n`, appearanceBlock(update))).toThrow("malformed");
    expect(() =>
      patchAppearanceBlock(
        `${APPEARANCE_BLOCK_START}\n${APPEARANCE_BLOCK_END}\n${APPEARANCE_BLOCK_START}\n${APPEARANCE_BLOCK_END}\n`,
        appearanceBlock(update),
      ),
    ).toThrow("malformed");
  });
});
