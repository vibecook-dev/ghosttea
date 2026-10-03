import type { RendererConfig } from "@vibecook/ghosttea-protocol";

export interface ManagedAppearanceUpdate {
  theme?: {
    name: string;
    background: string;
    foreground: string;
    cursor: string;
    cursorText: string;
    selection: string;
    selectionForeground: string;
    palette: string[];
  };
  backgroundOpacity: number;
  backgroundOpacityCells: boolean;
  shaderEffects: string[];
  shaderAnimation: boolean;
  /** Omitted by older renderers; the block then leaves the setting to other layers. */
  lightAdaptation?: "auto" | "off";
  /** WCAG ratio from 1 (off) through 21; omitted by older renderers. */
  minimumContrast?: number;
}

export const APPEARANCE_BLOCK_START = "# >>> Ghosttea appearance (managed; edit through Settings)";
export const APPEARANCE_BLOCK_END = "# <<< Ghosttea appearance";

const BUNDLED_SHADER_IDS = new Set([
  "ghosttea:better-crt",
  "ghosttea:crt",
  "ghosttea:vhs",
  "ghosttea:sparks-from-fire",
]);

export function validateAppearanceUpdate(payload: unknown): ManagedAppearanceUpdate {
  if (!payload || typeof payload !== "object") throw new Error("Invalid appearance settings payload");
  const update = payload as Record<string, unknown>;
  let validatedTheme: ManagedAppearanceUpdate["theme"];
  if (update.theme !== undefined) {
    if (!update.theme || typeof update.theme !== "object") throw new Error("Invalid color theme");
    const theme = update.theme as Record<string, unknown>;
    const color = (key: string): string => {
      const value = theme[key];
      if (typeof value !== "string" || !/^#[0-9a-f]{6}$/iu.test(value)) {
        throw new Error(`Theme ${key} is not a six-digit color`);
      }
      return value.toLowerCase();
    };
    if (
      typeof theme.name !== "string" ||
      !theme.name.trim() ||
      /[\r\n]/u.test(theme.name) ||
      theme.name.includes(APPEARANCE_BLOCK_START) ||
      theme.name.includes(APPEARANCE_BLOCK_END)
    ) {
      throw new Error("Theme name is invalid");
    }
    if (!Array.isArray(theme.palette) || theme.palette.length !== 16) {
      throw new Error("Theme palette must contain exactly 16 colors");
    }
    const palette = theme.palette.map((value, index) => {
      if (typeof value !== "string" || !/^#[0-9a-f]{6}$/iu.test(value)) {
        throw new Error(`Theme palette entry ${index} is invalid`);
      }
      return value.toLowerCase();
    });
    validatedTheme = {
      name: theme.name,
      background: color("background"),
      foreground: color("foreground"),
      cursor: color("cursor"),
      cursorText: color("cursorText"),
      selection: color("selection"),
      selectionForeground: color("selectionForeground"),
      palette,
    };
  }
  if (
    typeof update.backgroundOpacity !== "number" ||
    !Number.isFinite(update.backgroundOpacity) ||
    update.backgroundOpacity < 0 ||
    update.backgroundOpacity > 1
  ) {
    throw new Error("Background opacity must be between zero and one");
  }
  if (typeof update.backgroundOpacityCells !== "boolean" || typeof update.shaderAnimation !== "boolean") {
    throw new Error("Invalid appearance toggle");
  }
  if (update.lightAdaptation !== undefined && update.lightAdaptation !== "auto" && update.lightAdaptation !== "off") {
    throw new Error("Light adaptation must be auto or off");
  }
  if (
    update.minimumContrast !== undefined &&
    (typeof update.minimumContrast !== "number" ||
      !Number.isFinite(update.minimumContrast) ||
      update.minimumContrast < 1 ||
      update.minimumContrast > 21)
  ) {
    throw new Error("Minimum contrast must be between 1 and 21");
  }
  if (
    !Array.isArray(update.shaderEffects) ||
    !update.shaderEffects.every((id) => typeof id === "string" && BUNDLED_SHADER_IDS.has(id))
  ) {
    throw new Error("Shader stack contains an unknown effect");
  }
  return {
    ...(validatedTheme ? { theme: validatedTheme } : {}),
    backgroundOpacity: update.backgroundOpacity,
    backgroundOpacityCells: update.backgroundOpacityCells,
    shaderEffects: [...new Set(update.shaderEffects as string[])],
    shaderAnimation: update.shaderAnimation,
    ...(update.lightAdaptation !== undefined ? { lightAdaptation: update.lightAdaptation } : {}),
    ...(update.minimumContrast !== undefined ? { minimumContrast: contrastValue(update.minimumContrast) } : {}),
  };
}

/** Two decimals are enough for a contrast ratio and keep the config readable. */
function contrastValue(ratio: number): number {
  return Number(ratio.toFixed(2));
}

export function appearanceBlock(update: ManagedAppearanceUpdate): string {
  return [
    APPEARANCE_BLOCK_START,
    ...(update.theme
      ? [
          `# Theme: ${update.theme.name}`,
          "# Catalog: mbadolato/iTerm2-Color-Schemes (collection MIT; individual themes retain author terms)",
          `background = ${update.theme.background}`,
          `foreground = ${update.theme.foreground}`,
          `cursor-color = ${update.theme.cursor}`,
          `cursor-text = ${update.theme.cursorText}`,
          `selection-background = ${update.theme.selection}`,
          `selection-foreground = ${update.theme.selectionForeground}`,
          ...update.theme.palette.map((color, index) => `palette = ${index}=${color}`),
        ]
      : ["# Theme: current custom colors preserved"]),
    `background-opacity = ${update.backgroundOpacity.toFixed(2)}`,
    `background-opacity-cells = ${update.backgroundOpacityCells}`,
    "custom-shader =",
    ...update.shaderEffects.map((id) => `custom-shader = ${id}`),
    `custom-shader-animation = ${update.shaderAnimation}`,
    ...(update.lightAdaptation !== undefined ? [`ghosttea-light-adaptation = ${update.lightAdaptation}`] : []),
    ...(update.minimumContrast !== undefined ? [`minimum-contrast = ${contrastValue(update.minimumContrast)}`] : []),
    APPEARANCE_BLOCK_END,
  ].join("\n");
}

export function patchAppearanceBlock(contents: string, block: string): string {
  const newline = contents.includes("\r\n") ? "\r\n" : "\n";
  const normalizedBlock = block.replaceAll("\n", newline);
  const start = contents.indexOf(APPEARANCE_BLOCK_START);
  const end = contents.indexOf(APPEARANCE_BLOCK_END);
  const duplicateStart =
    start >= 0 && contents.indexOf(APPEARANCE_BLOCK_START, start + APPEARANCE_BLOCK_START.length) >= 0;
  const duplicateEnd = end >= 0 && contents.indexOf(APPEARANCE_BLOCK_END, end + APPEARANCE_BLOCK_END.length) >= 0;
  if (start < 0 !== end < 0 || (start >= 0 && end < start) || duplicateStart || duplicateEnd) {
    throw new Error("The managed appearance block in config.ghostty is malformed");
  }
  let blockEnd = end + APPEARANCE_BLOCK_END.length;
  if (start >= 0 && contents.slice(blockEnd, blockEnd + 2) === "\r\n") blockEnd += 2;
  else if (start >= 0 && (contents[blockEnd] === "\n" || contents[blockEnd] === "\r")) blockEnd += 1;
  const withoutExistingBlock = start >= 0 ? `${contents.slice(0, start)}${contents.slice(blockEnd)}` : contents;
  // Keep the managed layer last so ordinary settings later in the overlay do
  // not silently shadow a successful Settings save.
  return `${appendWithBlankLine(withoutExistingBlock, newline)}${normalizedBlock}${newline}`;
}

function appendWithBlankLine(contents: string, newline: "\n" | "\r\n"): string {
  if (!contents) return "";
  let cursor = contents.length;
  let trailingNewlines = 0;
  while (cursor > 0) {
    if (cursor >= 2 && contents.slice(cursor - 2, cursor) === "\r\n") cursor -= 2;
    else if (contents[cursor - 1] === "\n" || contents[cursor - 1] === "\r") cursor -= 1;
    else break;
    trailingNewlines += 1;
  }
  return `${contents}${newline.repeat(Math.max(0, 2 - trailingNewlines))}`;
}

function colorBytes(color: string): [number, number, number] {
  return [1, 3, 5].map((offset) => Number.parseInt(color.slice(offset, offset + 2), 16)) as [number, number, number];
}

function sameValues(left: readonly unknown[], right: readonly unknown[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/** Return requested values that another config layer shadowed. */
export function appearanceUpdateMismatches(renderer: RendererConfig, update: ManagedAppearanceUpdate): string[] {
  const mismatches: string[] = [];
  const checkColor = (name: string, actual: readonly number[], expected: string): void => {
    if (!sameValues(actual, colorBytes(expected))) mismatches.push(name);
  };
  if (update.theme) {
    checkColor("background", renderer.background, update.theme.background);
    checkColor("foreground", renderer.foreground, update.theme.foreground);
    checkColor("cursor-color", renderer.cursor, update.theme.cursor);
    checkColor("cursor-text", renderer.cursorText ?? renderer.background, update.theme.cursorText);
    checkColor("selection-background", renderer.selectionBackground, update.theme.selection);
    checkColor("selection-foreground", renderer.selectionForeground, update.theme.selectionForeground);
    const palette = new Map((renderer.palette ?? []).map((entry) => [entry.index, entry.color]));
    for (let index = 0; index < update.theme.palette.length; index += 1) {
      if (!sameValues(palette.get(index) ?? [], colorBytes(update.theme.palette[index]!))) {
        mismatches.push(`palette ${index}`);
      }
    }
  }
  const expectedOpacity = Number(update.backgroundOpacity.toFixed(2));
  if (Math.abs((renderer.backgroundOpacity ?? 1) - expectedOpacity) > 0.0001) {
    mismatches.push("background-opacity");
  }
  if ((renderer.backgroundOpacityCells ?? false) !== update.backgroundOpacityCells) {
    mismatches.push("background-opacity-cells");
  }
  const shaderEffects =
    renderer.shaderEffects && renderer.shaderEffects.length > 0
      ? renderer.shaderEffects
      : renderer.postProcess === "better-crt"
        ? ["ghosttea:better-crt"]
        : [];
  if (!sameValues(shaderEffects, update.shaderEffects)) mismatches.push("custom-shader");
  if ((renderer.customShaderAnimation ?? false) !== update.shaderAnimation) {
    mismatches.push("custom-shader-animation");
  }
  if (update.lightAdaptation !== undefined && (renderer.lightAdaptation ?? "auto") !== update.lightAdaptation) {
    mismatches.push("ghosttea-light-adaptation");
  }
  if (
    update.minimumContrast !== undefined &&
    Math.abs((renderer.minimumContrast ?? 1) - contrastValue(update.minimumContrast)) > 0.0001
  ) {
    mismatches.push("minimum-contrast");
  }
  return mismatches;
}
