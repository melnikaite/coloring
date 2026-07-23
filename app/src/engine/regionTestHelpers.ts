/**
 * Shared barrier-map builders for region-matching tests (`floodfill.test.ts`,
 * `ops.test.ts`). Not a `*.test.ts` file itself so vitest's `include` glob
 * never picks it up as its own test suite - it's plain test infrastructure,
 * imported by tests, not a test.
 */
import type { RegionInfo } from './floodfill';

/**
 * Builds a barrier map with a solid border (so the "wing" region stays
 * bounded) and a circular ring of barrier pixels around (cx, cy): the ring
 * splits the interior into two disjoint regions exactly like the real
 * `butterfly` catalog image's wing/spot pair - a small disc ("spot", inside
 * the ring) concentric with a much larger annulus ("wing", between the ring
 * and the border), both real flood-fill output, not hand-faked RegionInfo.
 */
export function buildNestedBarrier(width: number, height: number, cx: number, cy: number, innerRadius: number): Uint8Array {
  const barrier = new Uint8Array(width * height);
  const ringThickness = 2;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) {
        barrier[idx] = 1;
        continue;
      }
      const d = Math.hypot(x - cx, y - cy);
      if (d >= innerRadius && d < innerRadius + ringThickness) barrier[idx] = 1;
    }
  }
  return barrier;
}

/** Finds the bigger and smaller of exactly two regions by area, for readable assertions. */
export function byArea(regions: RegionInfo[]): { big: RegionInfo; small: RegionInfo } {
  if (regions.length !== 2) throw new Error(`byArea expects exactly 2 regions, got ${regions.length}`);
  const [a, b] = regions;
  return a.area >= b.area ? { big: a, small: b } : { big: b, small: a };
}
