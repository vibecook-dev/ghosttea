import { describe, expect, it } from "vitest";
import { pathToFileURL } from "node:url";
import type { ConfigSnapshot } from "@vibecook/ghosttea-protocol";
import {
  MAX_CONFIG_EDITOR_BYTES,
  assertConfigDocumentIncludesAuthorized,
  blockingConfigDiagnostics,
  configDocumentIncludes,
  serializeSupportedGhosttyConfig,
  trustedConfigEditorRendererUrl,
  validateConfigContents,
  validateConfigSaveRequest,
} from "./config-editor";

describe("desktop config editor boundary", () => {
  it("rejects non-text, oversized documents, and malformed revisions", () => {
    expect(() => validateConfigContents(null)).toThrow("UTF-8 text");
    expect(() => validateConfigContents("x".repeat(MAX_CONFIG_EDITOR_BYTES + 1))).toThrow("maximum");
    expect(() => validateConfigSaveRequest({ expectedRevision: "", contents: "" })).toThrow("revision");
    expect(validateConfigSaveRequest({ expectedRevision: "document-1", contents: "font-size = 14\n" })).toEqual({
      expectedRevision: "document-1",
      contents: "font-size = 14\n",
    });
  });

  it("serializes the supported effective projection without source paths", () => {
    const config = {
      sources: [{ path: "/Users/private/.config/ghostty/config", kind: "ghostty-default" }],
      terminal: { scrollbackBytes: 42_000 },
      renderer: {
        foreground: [240, 241, 242],
        background: [16, 17, 18],
        cursor: [171, 205, 239],
        cursorText: [1, 2, 3],
        selectionBackground: [32, 33, 34],
        selectionForeground: [224, 225, 226],
        palette: [{ index: 2, color: [4, 5, 6] }],
        backgroundOpacity: 0.73,
        backgroundOpacityCells: true,
        minimumContrast: 4.5,
        fontSize: 14,
        fontFamilies: ["JetBrains Mono"],
        paddingX: [3, 4],
        paddingY: [5, 5],
        postProcess: "none",
        shaderEffects: ["ghosttea:crt"],
        customShaderAnimation: true,
      },
      workspace: {
        clearKeybindings: true,
        keybindings: [{ trigger: "super+t", action: "new_tab" }],
      },
    } as ConfigSnapshot;

    const result = serializeSupportedGhosttyConfig(config);
    expect(result).toContain("foreground = #f0f1f2\n");
    expect(result).toContain("palette = 2=#040506\n");
    expect(result).toContain("minimum-contrast = 4.5\n");
    expect(result).toContain("window-padding-x = 3,4\nwindow-padding-y = 5\n");
    expect(result).toContain("custom-shader = ghosttea:crt\n");
    expect(result).toContain("keybind = clear\nkeybind = super+t=new_tab\n");
    expect(result).not.toContain("/Users/private");
  });

  it("accepts only the configured top-level renderer location", () => {
    const packaged = "/Applications/Ghosttea/resources/app/out/renderer/index.html";
    expect(trustedConfigEditorRendererUrl(pathToFileURL(packaged).href, undefined, packaged)).toBe(true);
    expect(
      trustedConfigEditorRendererUrl(
        pathToFileURL("/Applications/Ghosttea/resources/app/out/renderer/other.html").href,
        undefined,
        packaged,
      ),
    ).toBe(false);
    expect(trustedConfigEditorRendererUrl("http://localhost:5173/settings", "http://localhost:5173/", packaged)).toBe(
      true,
    );
    expect(trustedConfigEditorRendererUrl("https://example.com/", "http://localhost:5173/", packaged)).toBe(false);
    expect(trustedConfigEditorRendererUrl("not a url", undefined, packaged)).toBe(false);
  });

  it("allows existing include paths but refuses renderer-introduced file reads", () => {
    const current = [
      "config-file = /Users/private/dormant",
      "config-file =",
      'config-file = "themes/current"',
      "config-file = ?~/optional",
      "",
    ].join("\n");
    expect(configDocumentIncludes(current)).toEqual(new Set(["themes/current", "~/optional"]));
    expect(() =>
      assertConfigDocumentIncludesAuthorized(
        current,
        [
          "config-file = /Users/private/dormant",
          "config-file =",
          "config-file = themes/current",
          'config-file = ?"~/optional"',
          "",
        ].join("\n"),
      ),
    ).not.toThrow();
    expect(() => assertConfigDocumentIncludesAuthorized(current, "")).not.toThrow();
    expect(() => assertConfigDocumentIncludesAuthorized(current, "config-file = /Users/private/secrets\n")).toThrow(
      "cannot change active config-file directives",
    );
    expect(() => assertConfigDocumentIncludesAuthorized(current, "config-file = /Users/private/dormant\n")).toThrow(
      "cannot change active config-file directives",
    );
    expect(() =>
      assertConfigDocumentIncludesAuthorized(current, 'config-file = ?"~/optional"\nconfig-file = themes/current\n'),
    ).toThrow("cannot change active config-file directives");
  });

  it("blocks local and newly introduced errors but tolerates unchanged inherited errors", () => {
    const inherited = {
      severity: "error",
      code: "invalid-value",
      message: "inherited failure",
      source: "/Users/example/.config/ghostty/config",
      line: 4,
      key: "font-size",
    } as const;
    const local = { ...inherited, message: "local failure", source: "/profile/config.ghostty", line: 2 } as const;
    const introduced = { ...inherited, message: "new inherited failure", line: 7 } as const;
    const unattributed = {
      severity: "error",
      code: "invalid-value",
      message: "global failure",
      line: 4,
      key: "font-size",
    } as const;

    expect(blockingConfigDiagnostics([inherited], [inherited], "/profile/config.ghostty")).toEqual([]);
    expect(
      blockingConfigDiagnostics(
        [inherited, unattributed],
        [inherited, local, introduced, unattributed],
        "/profile/config.ghostty",
      ),
    ).toEqual([local, introduced, unattributed]);
  });
});
