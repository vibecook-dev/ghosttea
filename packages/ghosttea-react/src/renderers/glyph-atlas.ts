export class AtlasCapacityError extends Error {}

/** The current batch must submit before an atlas page can be recycled. */
export class AtlasBatchFullError extends Error {}

export interface AtlasGlyph<K> {
  key: K;
  width: number;
  height: number;
}

export interface GlyphLocation {
  u0: number;
  v0: number;
  u1: number;
  v1: number;
  cells: number;
}

interface Page<K> {
  texture: GPUTexture;
  bindGroup: GPUBindGroup;
  cache: Map<K, GlyphLocation>;
  generation: number;
  used: number;
  pinned: boolean;
  x: number;
  y: number;
  rowHeight: number;
}

/** Lazy, bounded atlas pages. A page used by an unsubmitted draw cannot be
 * recycled. Appending into its unused space is safe. Each pane uses one page
 * per glyph format, preserving instanced draws without per-glyph bind changes. */
export class GlyphAtlasPages<K> {
  readonly #pages: Page<K>[] = [];
  readonly #sampler: GPUSampler;
  #current: Page<K> | undefined;
  #generation = 0;
  #clock = 0;

  constructor(
    readonly device: GPUDevice,
    readonly layout: GPUBindGroupLayout,
    readonly label: string,
    readonly format: "r8unorm" | "rgba8unorm",
    readonly maxPages: number,
    readonly size = 2048,
  ) {
    this.#sampler = device.createSampler({ minFilter: "linear", magFilter: "linear" });
  }

  get generation(): number {
    return this.#current?.generation ?? 0;
  }

  get bindGroup(): GPUBindGroup {
    if (!this.#current) throw new Error(`${this.label} has not been prepared`);
    return this.#current.bindGroup;
  }

  prepare(input: Iterable<AtlasGlyph<K>>): void {
    const glyphs = new Map<K, AtlasGlyph<K>>();
    for (const glyph of input) glyphs.set(glyph.key, glyph);
    if (glyphs.size === 0) return;
    let selected: Page<K> | undefined;
    let bestHits = -1;
    for (const page of this.#pages) {
      if (!this.#fits(glyphs.values(), page)) continue;
      let hits = 0;
      for (const key of glyphs.keys()) if (page.cache.has(key)) hits += 1;
      if (hits > bestHits || (hits === bestHits && page.used > (selected?.used ?? -1))) {
        selected = page;
        bestHits = hits;
      }
    }
    if (!selected) {
      if (!this.#fits(glyphs.values())) {
        throw new AtlasCapacityError(`${this.label} cannot fit the glyphs visible in one frame`);
      }
      if (this.#pages.length === this.maxPages) {
        const recyclable = this.#pages.filter((page) => !page.pinned).sort((a, b) => a.used - b.used)[0];
        if (!recyclable) throw new AtlasBatchFullError(this.label);
        // A new texture also restores zero gutters; old texels must not bleed
        // around smaller replacement glyphs under linear filtering.
        recyclable.texture.destroy();
        this.#pages.splice(this.#pages.indexOf(recyclable), 1);
      }
      const texture = this.device.createTexture({
        label: this.label,
        size: [this.size, this.size],
        format: this.format,
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
      selected = {
        texture,
        bindGroup: this.device.createBindGroup({
          label: `${this.label} bindings`,
          layout: this.layout,
          entries: [
            { binding: 0, resource: texture.createView() },
            { binding: 1, resource: this.#sampler },
          ],
        }),
        cache: new Map(),
        generation: ++this.#generation,
        used: 0,
        pinned: false,
        x: 1,
        y: 1,
        rowHeight: 0,
      };
      this.#pages.push(selected);
    }
    selected.used = ++this.#clock;
    this.#current = selected;
  }

  pin(): void {
    if (this.#current) this.#current.pinned = true;
  }

  #fits(glyphs: Iterable<AtlasGlyph<K>>, page?: Page<K>): boolean {
    let x = page?.x ?? 1;
    let y = page?.y ?? 1;
    let rowHeight = page?.rowHeight ?? 0;
    for (const { key, width, height } of glyphs) {
      if (page?.cache.has(key)) continue;
      if (width + 2 > this.size || height + 2 > this.size) return false;
      if (x + width + 1 > this.size) {
        x = 1;
        y += rowHeight + 1;
        rowHeight = 0;
      }
      if (y + height + 1 > this.size) return false;
      x += width + 1;
      rowHeight = Math.max(rowHeight, height);
    }
    return true;
  }

  get(key: K): GlyphLocation | undefined {
    return this.#current?.cache.get(key);
  }

  insert(
    key: K,
    width: number,
    height: number,
    cells: number,
  ): {
    location: GlyphLocation;
    texture: GPUTexture;
    origin: [number, number];
  } {
    const page = this.#current;
    if (!page) throw new Error(`${this.label} has not been prepared`);
    if (page.x + width + 1 > this.size) {
      page.x = 1;
      page.y += page.rowHeight + 1;
      page.rowHeight = 0;
    }
    if (page.y + height + 1 > this.size) throw new AtlasCapacityError(`${this.label} exhausted`);
    const origin: [number, number] = [page.x, page.y];
    const location = {
      u0: page.x / this.size,
      v0: page.y / this.size,
      u1: (page.x + width) / this.size,
      v1: (page.y + height) / this.size,
      cells,
    };
    page.cache.set(key, location);
    page.x += width + 1;
    page.rowHeight = Math.max(page.rowHeight, height);
    return { location, texture: page.texture, origin };
  }

  releaseBatch(): void {
    for (const page of this.#pages) page.pinned = false;
  }

  destroy(): void {
    for (const page of this.#pages) page.texture.destroy();
    this.#pages.length = 0;
    this.#current = undefined;
  }
}
