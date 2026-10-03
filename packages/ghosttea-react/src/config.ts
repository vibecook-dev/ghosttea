import type { ConfigSnapshot, RendererConfig } from "@vibecook/ghosttea-protocol";
import type { TerminalEffects, TerminalShaderEffect, TerminalTheme } from "./renderers/types.js";

function rgba(color: readonly [number, number, number], alpha = 1): [number, number, number, number] {
  return [color[0] / 255, color[1] / 255, color[2] / 255, alpha];
}

const SHADER_EFFECTS = new Set<TerminalShaderEffect>([
  "ghosttea:better-crt",
  "ghosttea:crt",
  "ghosttea:vhs",
  "ghosttea:sparks-from-fire",
]);

export function terminalThemeFromConfig(config: Pick<ConfigSnapshot, "renderer">): TerminalTheme {
  const renderer = config.renderer;
  const backgroundOpacity = renderer.backgroundOpacity ?? 1;
  return {
    background: rgba(renderer.background, backgroundOpacity),
    foreground: rgba(renderer.foreground),
    cursor: rgba(renderer.cursor),
    cursorText: rgba(renderer.cursorText ?? renderer.background),
    selection: rgba(renderer.selectionBackground),
    selectionForeground: rgba(renderer.selectionForeground),
    backgroundOpacityCells: renderer.backgroundOpacityCells ?? false,
    lightAdaptation: "auto",
  };
}

export function terminalEffectsFromConfig(config: Pick<ConfigSnapshot, "renderer">): TerminalEffects {
  const configured = config.renderer.shaderEffects?.filter((id): id is TerminalShaderEffect =>
    SHADER_EFFECTS.has(id as TerminalShaderEffect),
  );
  const shaderEffects =
    configured && configured.length > 0
      ? configured
      : config.renderer.postProcess === "better-crt"
        ? (["ghosttea:better-crt"] as const)
        : [];
  return {
    postProcess: config.renderer.postProcess,
    shaderEffects,
    animate: config.renderer.customShaderAnimation ?? false,
  };
}

/** Public alias useful to hosts that cache only the renderer projection. */
export function rendererTheme(renderer: RendererConfig): TerminalTheme {
  return terminalThemeFromConfig({ renderer });
}
