import { afterEach, describe, expect, it, vi } from "vitest";
import { AtlasBatchFullError, AtlasCapacityError, GlyphAtlasPages } from "./glyph-atlas.js";

function fixture(maxPages = 2) {
  vi.stubGlobal("GPUTextureUsage", { TEXTURE_BINDING: 1, COPY_DST: 2 });
  const textures: Array<{ createView: () => object; destroy: ReturnType<typeof vi.fn> }> = [];
  const device = {
    createSampler: () => ({}),
    createBindGroup: (descriptor: object) => descriptor,
    createTexture: () => {
      const texture = { createView: () => ({ texture }), destroy: vi.fn() };
      textures.push(texture);
      return texture;
    },
  } as unknown as GPUDevice;
  return {
    atlas: new GlyphAtlasPages<string>(device, {} as GPUBindGroupLayout, "test", "r8unorm", maxPages, 8),
    textures,
  };
}

const glyph = (key: string, size = 2) => ({ key, width: size, height: size });
const fill = (atlas: GlyphAtlasPages<string>, keys: string[], size = 2) => {
  atlas.prepare(keys.map((key) => glyph(key, size)));
  for (const key of keys) if (!atlas.get(key)) atlas.insert(key, size, size, 1);
  atlas.pin();
  return atlas.generation;
};

afterEach(() => vi.unstubAllGlobals());

describe("bounded glyph atlas pages", () => {
  it("allocates nothing until a format has visible glyphs", () => {
    const { atlas, textures } = fixture();
    atlas.prepare([]);
    expect(textures).toHaveLength(0);
    expect(atlas.generation).toBe(0);
  });

  it("keeps disjoint pane working sets resident and returns to their stable locations", () => {
    const { atlas, textures } = fixture();
    const first = fill(atlas, ["a", "b", "c"]);
    const location = atlas.get("b");
    const second = fill(atlas, ["d", "e", "f"]);
    expect(second).not.toBe(first);
    atlas.releaseBatch();
    expect(fill(atlas, ["a", "b", "c"])).toBe(first);
    expect(atlas.get("b")).toBe(location);
    expect(fill(atlas, ["d", "e", "f"])).toBe(second);
    expect(textures).toHaveLength(2);
    expect(textures.every((texture) => texture.destroy.mock.calls.length === 0)).toBe(true);
  });

  it("requires a submission boundary before replacing a referenced page", () => {
    const { atlas, textures } = fixture(1);
    const first = fill(atlas, ["a"], 4);
    expect(() => atlas.prepare([glyph("b", 4)])).toThrow(AtlasBatchFullError);
    expect(textures[0]!.destroy).not.toHaveBeenCalled();
    expect(atlas.get("a")).toBeDefined();
    atlas.releaseBatch();
    const next = fill(atlas, ["b"], 4);
    expect(next).not.toBe(first);
    expect(textures[0]!.destroy).toHaveBeenCalledOnce();
    expect(textures).toHaveLength(2);
    expect(atlas.get("a")).toBeUndefined();
  });

  it("can append into unoccupied texels while a page is pinned", () => {
    const { atlas, textures } = fixture(1);
    const first = fill(atlas, ["a"]);
    const original = atlas.get("a");
    expect(fill(atlas, ["b"])).toBe(first);
    expect(atlas.get("a")).toBe(original);
    expect(atlas.get("b")).not.toEqual(original);
    expect(textures).toHaveLength(1);
  });

  it("rejects an oversized pane without allocating, evicting or pinning its page", () => {
    const { atlas, textures } = fixture(1);
    fill(atlas, ["a"], 4);
    atlas.releaseBatch();
    expect(() => atlas.prepare([glyph("b", 4), glyph("c", 4)])).toThrow(AtlasCapacityError);
    expect(textures).toHaveLength(1);
    expect(textures[0]!.destroy).not.toHaveBeenCalled();
    fill(atlas, ["d"], 4);
    expect(atlas.get("d")).toBeDefined();
  });

  it.each([
    ["b", "c", "d"],
    ["d", "c", "b"],
    ["c", "a", "d", "b"],
  ])("keeps prepared positions when glyphs are skipped or reordered: %s %s %s", (...order) => {
    const { atlas, textures } = fixture(1);
    const glyphs = [
      { key: "a", width: 1, height: 1 },
      { key: "b", width: 1, height: 1 },
      { key: "c", width: 4, height: 2 },
      { key: "d", width: 1, height: 4 },
    ];
    // Packing a,b,c,d fits. Repacking b,c,d after concealing a would overflow.
    atlas.prepare(glyphs);
    const generation = atlas.generation;
    const origins: Record<string, [number, number]> = { a: [1, 1], b: [3, 1], c: [1, 3], d: [6, 3] };
    const inserted = new Map<string, [number, number]>();
    for (const key of order) {
      const { width, height } = glyphs.find((glyph) => glyph.key === key)!;
      inserted.set(key, atlas.insert(key, width, height, 1).origin);
    }
    for (const key of order) expect(inserted.get(key)).toEqual(origins[key]);
    atlas.pin();
    atlas.releaseBatch();
    const oldB = atlas.get("b");
    // A reserved but unuploaded glyph can appear in a later frame, without
    // consuming another slot or moving any already uploaded glyph.
    atlas.prepare(glyphs);
    for (const { key, width, height } of glyphs) {
      if (!atlas.get(key)) expect(atlas.insert(key, width, height, 1).origin).toEqual(origins[key]);
    }
    expect(atlas.get("b")).toBe(oldB);
    expect(atlas.generation).toBe(generation);
    expect(textures).toHaveLength(1);
  });
});
