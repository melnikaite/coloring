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

export interface RegionInfo {
  /** Stable: index in row-major scan order over the (static) barrier map. */
  id: number;
  /** Dilated the same way fills/strokes clip against, for consistent fill/matching geometry. */
  mask: Uint8Array;
  /** Pixel count (post-dilation) - used for match tie-breaking. */
  area: number;
  /** Mask centroid x. */
  cx: number;
  /** Mask centroid y. */
  cy: number;
  /** Inclusive bounding box of the mask (post-dilation) - lets fill/resync code scan/write
   * just this region's rectangle instead of the whole canvas. */
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  /** Lazily rasterized by MaskCanvasCache.get - only needed for destination-in stroke
   * clipping / cropped-content transfer, not every region needs one. */
  maskCanvas: HTMLCanvasElement | null;
}

/**
 * One-shot full labeling of every region in a static barrier map, with a
 * stable id (row-major scan order) per region. This is the ONLY place
 * flood-fill/dilation ever runs for a frame (after mount) - region lookup
 * everywhere else is a plain `regions[idMap[y*width+x]]` array index, and
 * `MaskCanvasCache` below only rasterizes masks this function already
 * computed, never re-floods them. Also used to persist "which region did the
 * child override" across reloads, and to match frame-1 regions to frame-2
 * regions by proximity/area.
 */
export function computeAllRegions(
  barrier: Uint8Array,
  width: number,
  height: number,
  dilateRadius: number
): { idMap: Int32Array; regions: RegionInfo[] } {
  const idMap = new Int32Array(width * height).fill(-1);
  const regions: RegionInfo[] = [];

  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const idx = row + x;
      if (barrier[idx] || idMap[idx] !== -1) continue;
      const mask = dilateMask(floodFillMask(barrier, width, height, x, y), width, height, dilateRadius);
      const id = regions.length;
      let area = 0;
      let sumX = 0;
      let sumY = 0;
      let minX = width;
      let minY = height;
      let maxX = -1;
      let maxY = -1;
      for (let p = 0; p < mask.length; p++) {
        if (!mask[p]) continue;
        idMap[p] = id;
        area++;
        const px = p % width;
        const py = (p / width) | 0;
        sumX += px;
        sumY += py;
        if (px < minX) minX = px;
        if (px > maxX) maxX = px;
        if (py < minY) minY = py;
        if (py > maxY) maxY = py;
      }
      regions.push({
        id,
        mask,
        area,
        cx: area ? sumX / area : x,
        cy: area ? sumY / area : y,
        minX: area ? minX : x,
        minY: area ? minY : y,
        maxX: area ? maxX : x,
        maxY: area ? maxY : y,
        maskCanvas: null,
      });
    }
  }

  return { idMap, regions };
}

// ---------------- Frame-1 <-> frame-2 region matching ----------------
// Two-frame images mirror frame 1's coloring onto frame 2 region-by-region
// (see `resyncFrame2`/`syncFrame2Stickers` in editor.ts). Matching a frame-2
// region to "the same" frame-1 region can't use raw pixel coordinates -
// frame 2's line art differs slightly (a limb/wing moved) - so it has to go
// by shape correspondence instead.
//
// A first pass by centroid distance (normalized by sqrt(area) so tiny and
// huge regions are held to proportionally different tolerances - see
// CANDIDATE_SCORE_THRESHOLD below) is cheap but shape-blind: it cannot tell
// "this small disc IS the big region's own concentric spot" apart from "this
// small disc-shaped region is actually the big region itself, just far away
// and coincidentally similar in normalized centroid distance." Concretely,
// on the `butterfly` catalog image, a wing region has a small circular
// "spot" cut out of it as its own disjoint region (flood fill makes the
// wing's own mask an annulus with a hole exactly where the spot sits). The
// spot's centroid sits almost exactly at the wing's own centroid too - by
// pure geometry, not correspondence - so centroid-distance scoring alone
// once matched a frame-2 spot to the frame-1 WING (or vice versa), causing a
// wing fill to bleed into its own untouched spot, and a sticker placed on
// one region to appear mirrored onto both on frame 2 (see reverseMatch).
//
// The fix: centroid distance only produces a cheap SHORTLIST of plausible
// candidates (this stays fast - real catalog images have only a handful to
// a few dozen regions per frame, so this first pass is O(regions1) per
// frame-2 region, touching only two numbers per candidate). The final pick
// is then confirmed by actual mask OVERLAP: candidate regions are mapped
// into each other's coordinate frame using the exact same centroid +
// sqrt(area) similarity transform `sampleStrokeContent`/`resolveStickerPos`
// already use elsewhere for adapting content between frames, and scored by
// how much of each region's own mask actually lands inside the other's mask
// (both directions - see `overlapScore`). A genuine match (wing<->wing,
// spot<->spot) overlaps almost fully in both directions; a spurious nested
// match (spot vs. the wing whose mask has a hole exactly there) overlaps
// almost nowhere, because the transformed pixels land in the hole, not the
// mask. This costs O(area(r1) + area(r2)) per confirmed candidate pair -
// bounded by the regions' own sizes, not the whole canvas - so it stays
// cheap even though it touches real mask arrays, not just two numbers.

/** First-pass shortlist cutoff: normalized centroid distance above this is never worth
 * confirming with a mask-overlap check (definitely unrelated regions). Deliberately looser
 * than the final decision (which is made by overlap, not this score) so a genuine match whose
 * centroid moved a little between frames (a limb shifted) is never pre-filtered out before
 * overlap gets a chance to confirm it. */
const CANDIDATE_SCORE_THRESHOLD = 4;
/** Final gate: minimum fraction of each region's own mask that must land inside the other's
 * mask (in both directions - see `overlapScore`) to accept the match. A true corresponding
 * pair overlaps almost completely; a spurious nested-region match overlaps almost nowhere. */
const MIN_OVERLAP_FRACTION = 0.4;

/**
 * Maps every one of `src`'s own masked pixels into `dst`'s coordinate frame via the centroid +
 * sqrt(area) similarity transform (same recipe as `sampleStrokeContent`'s `srcX`/`srcY` in
 * editor.ts, just named for the opposite direction here), and returns what fraction of them
 * land on a masked pixel of `dst`. Scoped to `src`'s own bounding box, so cost is O(src.area),
 * not O(width*height).
 */
function fractionInside(src: RegionInfo, dst: RegionInfo, width: number, height: number): number {
  if (src.area === 0) return 0;
  const s = Math.sqrt(Math.max(1, dst.area) / Math.max(1, src.area));
  let hit = 0;
  for (let y = src.minY; y <= src.maxY; y++) {
    const row = y * width;
    for (let x = src.minX; x <= src.maxX; x++) {
      if (!src.mask[row + x]) continue;
      const dx = Math.round(dst.cx + (x - src.cx) * s);
      const dy = Math.round(dst.cy + (y - src.cy) * s);
      if (dx < 0 || dy < 0 || dx >= width || dy >= height) continue;
      if (dst.mask[dy * width + dx]) hit++;
    }
  }
  return hit / src.area;
}

/**
 * Symmetric shape-overlap score for a candidate (r1, r2) match: the SMALLER of how much of r1
 * lands inside r2 and how much of r2 lands inside r1. Taking the min (rather than, say, the
 * average) means a nested false match - where mapping the small region into the big one lands
 * mostly outside its hole, OR mapping the big one into the small one obviously can't fit - is
 * caught by whichever direction exposes the mismatch, without the other direction's number
 * (which can look deceptively fine on its own) diluting it.
 *
 * Cost is O(area(r1) + area(r2)) in the worst case, but real catalog images have regions that
 * routinely span a large fraction of the whole (1024x1024) canvas - profiling this against real
 * catalog images (see the mount-time `console.debug` in editor.ts) showed the naive
 * "always compute both directions" version costing over a second for a single two-frame image's
 * worth of candidate pairs, almost all of it spent confirming candidates that were never going
 * to pass anyway. So the CHEAPER direction (scanning the smaller region's own - smaller - bbox)
 * is always computed first; if it already fails `MIN_OVERLAP_FRACTION`, the min can only get
 * smaller from the pricier direction, so that direction is skipped entirely. Only the (few)
 * candidates that survive the cheap check ever pay for the expensive one.
 */
function overlapScore(r1: RegionInfo, r2: RegionInfo, width: number, height: number): number {
  const [cheapSrc, cheapDst, pricierSrc, pricierDst] = r1.area <= r2.area ? [r1, r2, r2, r1] : [r2, r1, r1, r2];
  const cheapFraction = fractionInside(cheapSrc, cheapDst, width, height);
  if (cheapFraction < MIN_OVERLAP_FRACTION) return cheapFraction;
  const pricierFraction = fractionInside(pricierSrc, pricierDst, width, height);
  return Math.min(cheapFraction, pricierFraction);
}

export interface RegionMatchResult {
  /** frame-2 region id -> frame-1 region id, or null if no plausible match (leave unpainted). */
  regionMatch: Map<number, number | null>;
  /** Reverse of regionMatch: frame-1 region id -> every frame-2 region id that matched to it
   * (usually one, but nothing stops two frame-2 regions matching the same frame-1 region). */
  reverseMatch: Map<number, number[]>;
}

/**
 * Matches every frame-2 region to its best frame-1 counterpart (or null), by centroid-distance
 * shortlist + mask-overlap confirmation - see the block comment above. Pure function of the two
 * frames' already-computed `RegionInfo[]` (from `computeAllRegions`) - no DOM/canvas dependency,
 * so it's straightforwardly unit-testable.
 */
export function matchFrameRegions(
  regions1: RegionInfo[],
  regions2: RegionInfo[],
  width: number,
  height: number
): RegionMatchResult {
  const regionMatch = new Map<number, number | null>();
  const reverseMatch = new Map<number, number[]>();

  for (const r2 of regions2) {
    // Cheap first pass: shortlist frame-1 regions whose normalized centroid distance is at all
    // plausible. Ties/near-ties are common (e.g. two same-size regions equidistant), so this
    // keeps every candidate under the threshold, not just the single best-scoring one.
    let bestId: number | null = null;
    let bestOverlap = -1;
    let bestScore = Infinity;
    for (const r1 of regions1) {
      const dist = Math.hypot(r1.cx - r2.cx, r1.cy - r2.cy);
      const denom = Math.sqrt(Math.max(1, Math.min(r1.area, r2.area)));
      const score = dist / denom;
      if (score > CANDIDATE_SCORE_THRESHOLD) continue;
      const overlap = overlapScore(r1, r2, width, height);
      if (overlap > bestOverlap + 1e-9 || (Math.abs(overlap - bestOverlap) <= 1e-9 && score < bestScore)) {
        bestOverlap = overlap;
        bestScore = score;
        bestId = r1.id;
      }
    }
    const matched = bestId !== null && bestOverlap >= MIN_OVERLAP_FRACTION ? bestId : null;
    regionMatch.set(r2.id, matched);
    if (matched !== null) {
      const arr = reverseMatch.get(matched);
      if (arr) arr.push(r2.id);
      else reverseMatch.set(matched, [r2.id]);
    }
  }

  return { regionMatch, reverseMatch };
}

/**
 * LRU-capped lazy rasterizer for `RegionInfo.mask` -> `<canvas>` (needed only
 * for `destination-in` stroke clipping / cropped-content transfer - a
 * maskCanvas is ~10 MB, so most regions never get one materialized). Never
 * re-runs `floodFillMask`/`dilateMask` - masks are already computed once by
 * `computeAllRegions`; this only rasterizes them on demand and evicts the
 * least-recently-used canvas once the cap is exceeded.
 */
export class MaskCanvasCache {
  private used: RegionInfo[] = []; // MRU order: most recently used last

  constructor(
    private width: number,
    private height: number,
    private maxCanvases = 2
  ) {}

  /** Returns (rasterizing and caching if needed) the mask canvas for `region`. */
  get(region: RegionInfo): HTMLCanvasElement {
    if (!region.maskCanvas) {
      region.maskCanvas = maskToCanvas(region.mask, this.width, this.height);
    }
    const i = this.used.indexOf(region);
    if (i >= 0) this.used.splice(i, 1);
    this.used.push(region);
    while (this.used.length > this.maxCanvases) {
      const evicted = this.used.shift()!;
      if (evicted !== region) evicted.maskCanvas = null;
    }
    return region.maskCanvas;
  }
}
