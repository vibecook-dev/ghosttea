export interface GlyphCatalogBudget {
  maxDefinitions: number;
  maxSharedDefinitions: number;
  maxSessionPixelBytes: number;
  maxSharedPixelBytes: number;
}

export type CatalogAdmission = "install" | "request-full" | "text-fallback";

export function catalogAdmission(
  resetsCatalog: boolean,
  alreadyUsingFallback: boolean,
  fits: boolean,
): CatalogAdmission {
  if (alreadyUsingFallback && !resetsCatalog) return "text-fallback";
  if (fits) return "install";
  return resetsCatalog ? "text-fallback" : "request-full";
}

interface GlyphLike {
  id: number;
  pixels: { byteLength: number };
}

export function glyphCatalogFits<T extends GlyphLike, K = number>(
  sessionDefinitions: ReadonlyMap<number, T>,
  sessionPixelBytes: number,
  sharedDefinitions: ReadonlyMap<K, { definition: T }>,
  sharedPixelBytes: number,
  definitions: readonly T[],
  budget: GlyphCatalogBudget,
  sharedKey: (id: number) => K = (id: number) => id as K,
): boolean {
  if (definitions.length === 0) return true;
  let nextDefinitionCount = sessionDefinitions.size;
  let nextSharedDefinitionCount = sharedDefinitions.size;
  let nextSessionPixelBytes = sessionPixelBytes;
  let nextSharedPixelBytes = sharedPixelBytes;
  const pending = new Set<number>();
  for (const definition of definitions) {
    if (sessionDefinitions.has(definition.id) || pending.has(definition.id)) continue;
    pending.add(definition.id);
    const shared = sharedDefinitions.get(sharedKey(definition.id));
    const pixelBytes = shared?.definition.pixels.byteLength ?? definition.pixels.byteLength;
    nextDefinitionCount += 1;
    nextSessionPixelBytes += pixelBytes;
    if (!shared) {
      nextSharedDefinitionCount += 1;
      nextSharedPixelBytes += pixelBytes;
    }
    if (
      nextDefinitionCount > budget.maxDefinitions ||
      nextSharedDefinitionCount > budget.maxSharedDefinitions ||
      nextSessionPixelBytes > budget.maxSessionPixelBytes ||
      nextSharedPixelBytes > budget.maxSharedPixelBytes
    )
      return false;
  }
  return true;
}

export function definitionCatalogFits<T extends { id: number }>(
  installed: ReadonlyMap<number, T>,
  definitions: readonly T[],
  maxDefinitions: number,
  retainedDefinitions = installed.size,
  maxRetainedDefinitions = Number.MAX_SAFE_INTEGER,
): boolean {
  if (definitions.length === 0) return true;
  let nextDefinitionCount = installed.size;
  let nextRetainedDefinitions = retainedDefinitions;
  const pending = new Set<number>();
  for (const definition of definitions) {
    if (installed.has(definition.id) || pending.has(definition.id)) continue;
    pending.add(definition.id);
    nextDefinitionCount += 1;
    nextRetainedDefinitions += 1;
    if (nextDefinitionCount > maxDefinitions || nextRetainedDefinitions > maxRetainedDefinitions) return false;
  }
  return true;
}
