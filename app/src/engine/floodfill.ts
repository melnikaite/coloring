/**
 * Scanline flood fill over the static line-art "barrier" map, plus mask
 * dilation and a per-region mask cache used by inside-lines painting mode.
 *
 * Iterative (no recursion) and typed-array based so a 1600x1600 fill stays
 * well under 100ms.
 */

/** Flood-fills the barrier map from (startX, startY) and returns a 0/1 region mask. */
export function floodFillMask(
  barrier: Uint8Array,
  width: number,
  height: number,
  startX: number,
  startY: number
): Uint8Array {
  const mask = new Uint8Array(width * height);
  if (startX < 0 || startY < 0 || startX >= width || startY >= height) return mask;
  if (barrier[startY * width + startX]) return mask;

  // Flat stack of encoded (x,y) pairs to avoid allocating tuples/objects.
  const stackX: number[] = [startX];
  const stackY: number[] = [startY];

  while (stackX.length) {
    const y = stackY.pop()!;
    let x = stackX.pop()!;
    const row = y * width;

    if (mask[row + x] || barrier[row + x]) continue;

    // Find left bound of the free span on this row.
    let xLeft = x;
    while (xLeft - 1 >= 0 && !barrier[row + xLeft - 1] && !mask[row + xLeft - 1]) xLeft--;
    let xRight = x;
    while (xRight + 1 < width && !barrier[row + xRight + 1] && !mask[row + xRight + 1]) xRight++;

    let spanAboveOpen = false;
    let spanBelowOpen = false;
    for (let xi = xLeft; xi <= xRight; xi++) {
      mask[row + xi] = 1;

      if (y > 0) {
        const aboveIdx = row - width + xi;
        const aboveFree = !barrier[aboveIdx] && !mask[aboveIdx];
        if (aboveFree && !spanAboveOpen) {
          stackX.push(xi);
          stackY.push(y - 1);
          spanAboveOpen = true;
        } else if (!aboveFree) {
          spanAboveOpen = false;
        }
      }
      if (y < height - 1) {
        const belowIdx = row + width + xi;
        const belowFree = !barrier[belowIdx] && !mask[belowIdx];
        if (belowFree && !spanBelowOpen) {
          stackX.push(xi);
          stackY.push(y + 1);
          spanBelowOpen = true;
        } else if (!belowFree) {
          spanBelowOpen = false;
        }
      }
    }
  }

  return mask;
}

/** Grows a 0/1 mask outward by `radius` pixels (4-neighbor dilation, `radius` passes). */
export function dilateMask(mask: Uint8Array, width: number, height: number, radius: number): Uint8Array {
  let current = mask;
  for (let pass = 0; pass < radius; pass++) {
    const next = new Uint8Array(current.length);
    for (let y = 0; y < height; y++) {
      const row = y * width;
      for (let x = 0; x < width; x++) {
        const idx = row + x;
        if (current[idx]) {
          next[idx] = 1;
          continue;
        }
        if (
          (x > 0 && current[idx - 1]) ||
          (x < width - 1 && current[idx + 1]) ||
          (y > 0 && current[idx - width]) ||
          (y < height - 1 && current[idx + width])
        ) {
          next[idx] = 1;
        }
      }
    }
    current = next;
  }
  return current;
}

/** Searches an expanding ring around (x, y) for the nearest non-barrier pixel. */
export function findNearestFree(
  barrier: Uint8Array,
  width: number,
  height: number,
  x: number,
  y: number,
  maxRadius = 6
): { x: number; y: number } | null {
  const xi = Math.round(x);
  const yi = Math.round(y);
  if (xi >= 0 && yi >= 0 && xi < width && yi < height && !barrier[yi * width + xi]) {
    return { x: xi, y: yi };
  }
  for (let r = 1; r <= maxRadius; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue; // ring only
        const nx = xi + dx;
        const ny = yi + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        if (!barrier[ny * width + nx]) return { x: nx, y: ny };
      }
    }
  }
  return null;
}

/** Renders a 0/1 mask into a canvas whose alpha channel encodes the mask (for destination-in clipping). */
export function maskToCanvas(mask: Uint8Array, width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  const imageData = ctx.createImageData(width, height);
  const d = imageData.data;
  for (let p = 0, i = 0; p < mask.length; p++, i += 4) {
    if (mask[p]) {
      d[i] = 0;
      d[i + 1] = 0;
      d[i + 2] = 0;
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(imageData, 0, 0);
  return canvas;
}

export interface Region {
  mask: Uint8Array;
  /** Lazily rendered by RegionCache.getMaskCanvas - only strokes need it. */
  maskCanvas: HTMLCanvasElement | null;
}

/**
 * LRU cache of flood-filled + dilated region masks. Line art is static, so
 * a cached region is always valid - the caps below are purely memory bounds
 * (a 1600x1600 mask array is ~2.5 MB and a maskCanvas ~10 MB; a busy picture
 * can have dozens of regions). Evicted regions simply recompute on next use
 * (flood fill is well under 100ms).
 *
 * The maskCanvas (needed only for destination-in stroke clipping, never for
 * bucket fill) is rendered lazily and capped separately and much tighter.
 */
export class RegionCache {
  private regions: Region[] = []; // LRU order: most recently used last

  constructor(
    private barrier: Uint8Array,
    private width: number,
    private height: number,
    private dilateRadius = 2,
    private maxRegions = 12,
    private maxMaskCanvases = 2
  ) {}

  clear() {
    this.regions = [];
  }

  private touch(region: Region) {
    const i = this.regions.indexOf(region);
    if (i >= 0 && i !== this.regions.length - 1) {
      this.regions.splice(i, 1);
      this.regions.push(region);
    }
  }

  /** Returns the region mask containing (x, y), computing and caching it if needed. */
  getRegionAt(x: number, y: number): Region | null {
    const idx = y * this.width + x;
    for (const region of this.regions) {
      if (region.mask[idx]) {
        this.touch(region);
        return region;
      }
    }
    const mask = dilateMask(
      floodFillMask(this.barrier, this.width, this.height, x, y),
      this.width,
      this.height,
      this.dilateRadius
    );
    // An empty mask (shouldn't normally happen since seed is pre-snapped off barriers)
    // is still cached to avoid repeated work on stray seeds.
    const region: Region = { mask, maskCanvas: null };
    this.regions.push(region);
    if (this.regions.length > this.maxRegions) this.regions.shift();
    return region;
  }

  /** Renders (or reuses) the region's mask canvas, evicting the least recently used ones over the cap. */
  getMaskCanvas(region: Region): HTMLCanvasElement {
    if (!region.maskCanvas) {
      region.maskCanvas = maskToCanvas(region.mask, this.width, this.height);
      let withCanvas = this.regions.filter((r) => r.maskCanvas);
      if (withCanvas.length > this.maxMaskCanvases) {
        // Drop canvases from the least recently used regions first.
        for (const r of this.regions) {
          if (r === region || !r.maskCanvas) continue;
          r.maskCanvas = null;
          withCanvas = this.regions.filter((c) => c.maskCanvas);
          if (withCanvas.length <= this.maxMaskCanvases) break;
        }
      }
    }
    return region.maskCanvas;
  }
}
