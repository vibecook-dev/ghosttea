import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ConfigDiagnostic, ConfigSnapshot } from "@vibecook/ghosttea-protocol";

export const MAX_CONFIG_EDITOR_BYTES = 64 * 1024;

export interface ConfigSaveRequest {
  expectedRevision: string;
  contents: string;
}

type ConfigIncludeOperation = { kind: "include"; path: string; optional: boolean } | { kind: "reset" };

/**
 * Extract the include path values that Ghosttea's loader would enqueue from a
 * single overlay document. This intentionally mirrors the loader's small
 * `config-file` grammar rather than trying to parse the rest of Ghostty's
 * configuration language.
 */
export function configDocumentIncludes(contents: string): Set<string> {
  const includes = new Set<string>();
  for (const operation of configDocumentIncludeOperations(contents)) {
    if (operation.kind === "reset") includes.clear();
    else includes.add(operation.path);
  }
  return includes;
}

function configDocumentIncludeOperations(contents: string): ConfigIncludeOperation[] {
  const operations: ConfigIncludeOperation[] = [];
  for (const raw of contents.split(/\r?\n/u)) {
    const separator = raw.indexOf("=");
    if (separator < 0 || raw.slice(0, separator).trim() !== "config-file") continue;
    const rawValue = raw.slice(separator + 1).trim();
    const quoted = rawValue.length >= 2 && rawValue.startsWith('"') && rawValue.endsWith('"');
    let value = quoted ? rawValue.slice(1, -1) : rawValue;
    if (!quoted && value === "") {
      operations.push({ kind: "reset" });
      continue;
    }
    let optional = false;
    if (!quoted && value.startsWith("?")) {
      optional = true;
      value = value.slice(1);
      if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    }
    if (value) operations.push({ kind: "include", path: value, optional });
  }
  return operations;
}

/**
 * The renderer may retain the exact include queue or clear it completely, but
 * it cannot turn validation into an arbitrary file-read primitive by changing
 * queue structure. Merely allowlisting path strings is insufficient: an
 * included file can reset later queued entries, so reordering existing paths
 * could activate a source the baseline never read. Structural include edits
 * remain available through the externally opened profile file.
 */
export function assertConfigDocumentIncludesAuthorized(current: string, candidate: string): void {
  const baselineOperations = configDocumentIncludeOperations(current);
  const candidateOperations = configDocumentIncludeOperations(candidate);
  const unchanged =
    baselineOperations.length === candidateOperations.length &&
    baselineOperations.every((operation, index) => {
      const candidateOperation = candidateOperations[index];
      return (
        operation.kind === candidateOperation?.kind &&
        (operation.kind === "reset" ||
          (candidateOperation?.kind === "include" &&
            operation.path === candidateOperation.path &&
            operation.optional === candidateOperation.optional))
      );
    });
  if (!unchanged && configDocumentIncludes(candidate).size > 0) {
    throw new Error(
      "The in-app editor cannot change active config-file directives. Open the profile config externally to edit includes, then reload Settings.",
    );
  }
}

function diagnosticIdentity(diagnostic: ConfigDiagnostic): string {
  return JSON.stringify([
    diagnostic.severity,
    diagnostic.code,
    diagnostic.message,
    diagnostic.source ?? null,
    diagnostic.line ?? null,
    diagnostic.key ?? null,
  ]);
}

/**
 * Local overlay errors always block a write. Errors from inherited roots or
 * includes block only when the candidate introduces another occurrence; an
 * unrelated pre-existing Ghostty error must not make the owned overlay
 * permanently read-only.
 */
export function blockingConfigDiagnostics(
  baseline: readonly ConfigDiagnostic[],
  candidate: readonly ConfigDiagnostic[],
  documentPath: string,
): ConfigDiagnostic[] {
  const inherited = new Map<string, number>();
  for (const diagnostic of baseline) {
    if (diagnostic.severity !== "error" || !diagnostic.source || samePath(diagnostic.source, documentPath)) continue;
    const identity = diagnosticIdentity(diagnostic);
    inherited.set(identity, (inherited.get(identity) ?? 0) + 1);
  }

  const blocking: ConfigDiagnostic[] = [];
  for (const diagnostic of candidate) {
    if (diagnostic.severity !== "error") continue;
    if (!diagnostic.source || samePath(diagnostic.source, documentPath)) {
      blocking.push(diagnostic);
      continue;
    }
    const identity = diagnosticIdentity(diagnostic);
    const remaining = inherited.get(identity) ?? 0;
    if (remaining > 0) inherited.set(identity, remaining - 1);
    else blocking.push(diagnostic);
  }
  return blocking;
}

function samePath(source: string | undefined, expected: string): boolean {
  return source !== undefined && resolve(source) === resolve(expected);
}

export function validateConfigContents(payload: unknown): string {
  if (typeof payload !== "string") throw new Error("Configuration contents must be UTF-8 text");
  const bytes = Buffer.byteLength(payload, "utf8");
  if (bytes > MAX_CONFIG_EDITOR_BYTES) {
    throw new Error(`Configuration is ${bytes} bytes; maximum is ${MAX_CONFIG_EDITOR_BYTES} bytes`);
  }
  return payload;
}

export function validateConfigSaveRequest(payload: unknown): ConfigSaveRequest {
  if (!payload || typeof payload !== "object") throw new Error("Invalid configuration save request");
  const candidate = payload as Record<string, unknown>;
  if (
    typeof candidate.expectedRevision !== "string" ||
    candidate.expectedRevision.length < 1 ||
    candidate.expectedRevision.length > 256
  ) {
    throw new Error("Invalid configuration document revision");
  }
  return {
    expectedRevision: candidate.expectedRevision,
    contents: validateConfigContents(candidate.contents),
  };
}

export function trustedConfigEditorRendererUrl(
  value: string,
  developmentUrl: string | undefined,
  packagedFile: string,
): boolean {
  try {
    const actual = new URL(value);
    if (developmentUrl) return actual.origin === new URL(developmentUrl).origin;
    return actual.protocol === "file:" && resolve(fileURLToPath(actual)) === resolve(packagedFile);
  } catch {
    return false;
  }
}

function colorHex(color: readonly [number, number, number]): string {
  return `#${color.map((component) => component.toString(16).padStart(2, "0")).join("")}`;
}

function pair(values: readonly [number, number]): string {
  return values[0] === values[1] ? String(values[0]) : `${values[0]},${values[1]}`;
}

/**
 * Snapshot Ghosttea's supported projection of inherited Ghostty files.
 * Unsupported source text and relative includes are deliberately not copied.
 */
export function serializeSupportedGhosttyConfig(config: ConfigSnapshot): string {
  const renderer = config.renderer;
  const shaderEffects =
    renderer.shaderEffects && renderer.shaderEffects.length > 0
      ? renderer.shaderEffects
      : renderer.postProcess === "better-crt"
        ? ["ghosttea:better-crt"]
        : [];
  return [
    "# Supported settings imported from the detected Ghostty configuration.",
    "# Ghosttea generated this projection; source files and relative includes were not copied.",
    `foreground = ${colorHex(renderer.foreground)}`,
    `background = ${colorHex(renderer.background)}`,
    `cursor-color = ${colorHex(renderer.cursor)}`,
    `cursor-text = ${colorHex(renderer.cursorText ?? renderer.background)}`,
    `selection-background = ${colorHex(renderer.selectionBackground)}`,
    `selection-foreground = ${colorHex(renderer.selectionForeground)}`,
    "palette =",
    ...(renderer.palette ?? [])
      .slice()
      .sort((left, right) => left.index - right.index)
      .map(({ index, color }) => `palette = ${index}=${colorHex(color)}`),
    `background-opacity = ${(renderer.backgroundOpacity ?? 1).toFixed(2)}`,
    `background-opacity-cells = ${renderer.backgroundOpacityCells ?? false}`,
    `minimum-contrast = ${renderer.minimumContrast ?? 1}`,
    `scrollback-limit = ${config.terminal.scrollbackBytes}`,
    "font-family =",
    ...renderer.fontFamilies.map((family) => `font-family = ${family.replaceAll(/[\r\n]/gu, "")}`),
    `font-size = ${renderer.fontSize}`,
    `window-padding-x = ${pair(renderer.paddingX)}`,
    `window-padding-y = ${pair(renderer.paddingY)}`,
    "custom-shader =",
    ...shaderEffects.map((effect) => `custom-shader = ${effect}`),
    `custom-shader-animation = ${renderer.customShaderAnimation ?? false}`,
    config.workspace.clearKeybindings ? "keybind = clear" : "keybind =",
    ...config.workspace.keybindings.map(
      ({ trigger, action }) => `keybind = ${trigger.replaceAll(/[\r\n]/gu, "")}=${action.replaceAll(/[\r\n]/gu, "")}`,
    ),
    "",
  ].join("\n");
}
