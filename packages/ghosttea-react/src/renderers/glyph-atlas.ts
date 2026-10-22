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

interface GlyphSlot {
  origin: [number, number];
  width: number;
  height: number;
}

interface PackingPlan<K> {
  slots: Map<K, GlyphSlot>;
  x: number;
  y: number;
  rowHeight: number;
}

interface Page<K> extends PackingPlan<K> {
  texture: GPUTexture;
  bindGroup: GPUBindGroup;
  cache: Map<K, GlyphLocation>;
  generation: number;
  used: number;
  pinned: boolean;
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
    let selectedPlan: PackingPlan<K> | undefined;
    let bestHits = -1;
    for (const page of this.#pages) {
      const plan = this.#plan(glyphs.values(), page);
      if (!plan) continue;
      let hits = 0;
      for (const key of glyphs.keys()) if (page.cache.has(key)) hits += 1;
      if (hits > bestHits || (hits === bestHits && page.used > (selected?.used ?? -1))) {
        selected = page;
        selectedPlan = plan;
        bestHits = hits;
      }
    }
    if (!selected) {
      selectedPlan = this.#plan(glyphs.values());
      if (!selectedPlan) {
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
        slots: new Map(),
        generation: ++this.#generation,
        used: 0,
        pinned: false,
        x: 1,
        y: 1,
        rowHeight: 0,
      };
      this.#pages.push(selected);
    }
    // Commit preflight's exact positions, including glyphs geometry may skip.
    // Removing/reordering shelf-packed rectangles can change row breaks and
    // overflow even when the original sequence fit. Upload remains lazy.
    const plan = selectedPlan!;
    for (const [key, slot] of plan.slots) selected.slots.set(key, slot);
    selected.x = plan.x;
    selected.y = plan.y;
    selected.rowHeight = plan.rowHeight;
    selected.used = ++this.#clock;
    this.#current = selected;
  }

  pin(): void {
    if (this.#current) this.#current.pinned = true;
  }

  #plan(glyphs: Iterable<AtlasGlyph<K>>, page?: Page<K>): PackingPlan<K> | undefined {
    const slots = new Map<K, GlyphSlot>();
    let x = page?.x ?? 1;
    let y = page?.y ?? 1;
    let rowHeight = page?.rowHeight ?? 0;
    for (const { key, width, height } of glyphs) {
      if (page?.slots.has(key)) continue;
      if (width + 2 > this.size || height + 2 > this.size) return undefined;
      if (x + width + 1 > this.size) {
        x = 1;
        y += rowHeight + 1;
        rowHeight = 0;
      }
      if (y + height + 1 > this.size) return undefined;
      slots.set(key, { origin: [x, y], width, height });
      x += width + 1;
      rowHeight = Math.max(rowHeight, height);
    }
    return { slots, x, y, rowHeight };
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
    const slot = page.slots.get(key);
    if (!slot || slot.width !== width || slot.height !== height) {
      throw new Error(`${this.label} glyph does not match its prepared reservation`);
    }
    const origin = slot.origin;
    const [x, y] = origin;
    const location = {
      u0: x / this.size,
      v0: y / this.size,
      u1: (x + width) / this.size,
      v1: (y + height) / this.size,
      cells,
    };
    page.cache.set(key, location);
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
