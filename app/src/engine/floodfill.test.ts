import { describe, it, expect } from 'vitest';
import { computeAllRegions, matchFrameRegions, RegionInfo } from './floodfill';
import { buildNestedBarrier, byArea } from './regionTestHelpers';

/**
 * Barrier that's solid (barrier=1) everywhere except two disjoint open
 * rectangles - a simple non-nested "big region + small region, side by
 * side" layout, in the spirit of the earlier "cat" head/mouth-detail
 * regression, to confirm ordinary matching still works alongside the new
 * overlap check (not just the nested case above).
 */
function buildSideBySideBarrier(
  width: number,
  height: number,
  big: { x0: number; x1: number; y0: number; y1: number },
  small: { x0: number; x1: number; y0: number; y1: number }
): Uint8Array {
  const barrier = new Uint8Array(width * height).fill(1);
  for (let y = big.y0; y <= big.y1; y++) {
    for (let x = big.x0; x <= big.x1; x++) barrier[y * width + x] = 0;
  }
  for (let y = small.y0; y <= small.y1; y++) {
    for (let x = small.x0; x <= small.x1; x++) barrier[y * width + x] = 0;
  }
  return barrier;
}

const W = 80;
const H = 80;

describe('matchFrameRegions', () => {
  it('matches a nested spot to its own nested spot, not the surrounding region (butterfly wing/spot case)', () => {
    // Frame 2 is "nearly identical" but not pixel-identical: center shifted a
    // little and radius changed a little, as a real slightly-different pose
    // would produce.
    const barrier1 = buildNestedBarrier(W, H, 40, 40, 10);
    const barrier2 = buildNestedBarrier(W, H, 43, 38, 9);

    const { regions: regions1 } = computeAllRegions(barrier1, W, H, 0);
    const { regions: regions2 } = computeAllRegions(barrier2, W, H, 0);
    const f1 = byArea(regions1);
    const f2 = byArea(regions2);

    const { regionMatch } = matchFrameRegions(regions1, regions2, W, H);

    expect(regionMatch.get(f2.big.id)).toBe(f1.big.id);
    expect(regionMatch.get(f2.small.id)).toBe(f1.small.id);
    // The failure mode this guards against: the small spot must NEVER match
    // the big wing (or vice versa), even though their centroids coincide.
    expect(regionMatch.get(f2.small.id)).not.toBe(f1.big.id);
    expect(regionMatch.get(f2.big.id)).not.toBe(f1.small.id);
  });

  it('every frame-1 region maps back to exactly one frame-2 region for the nested case (no sticker duplication)', () => {
    const barrier1 = buildNestedBarrier(W, H, 40, 40, 10);
    const barrier2 = buildNestedBarrier(W, H, 43, 38, 9);
    const { regions: regions1 } = computeAllRegions(barrier1, W, H, 0);
    const { regions: regions2 } = computeAllRegions(barrier2, W, H, 0);

    const { reverseMatch } = matchFrameRegions(regions1, regions2, W, H);

    for (const targets of reverseMatch.values()) {
      // A duplicated sticker bug looks exactly like this: two frame-2 region
      // ids both claiming the same frame-1 region as their best match.
      expect(targets.length).toBe(1);
    }
  });

  it('still matches simple side-by-side regions correctly (no nesting) - the earlier cat-style case', () => {
    const big1 = { x0: 5, x1: 40, y0: 5, y1: 74 };
    const small1 = { x0: 50, x1: 60, y0: 35, y1: 45 };
    const barrier1 = buildSideBySideBarrier(W, H, big1, small1);
    // Frame 2: both rectangles nudged a little, as a real slightly-different pose would produce.
    const big2 = { x0: 6, x1: 41, y0: 4, y1: 73 };
    const small2 = { x0: 52, x1: 62, y0: 32, y1: 42 };
    const barrier2 = buildSideBySideBarrier(W, H, big2, small2);

    const { regions: regions1 } = computeAllRegions(barrier1, W, H, 0);
    const { regions: regions2 } = computeAllRegions(barrier2, W, H, 0);
    const f1 = byArea(regions1);
    const f2 = byArea(regions2);

    const { regionMatch } = matchFrameRegions(regions1, regions2, W, H);

    expect(regionMatch.get(f2.big.id)).toBe(f1.big.id);
    expect(regionMatch.get(f2.small.id)).toBe(f1.small.id);
  });

  it('leaves a frame-2 region with no plausible frame-1 counterpart unmatched (null)', () => {
    const width = 160;
    const height = 160;
    // Frame 1: a single small blob near the top-left.
    const barrier1 = new Uint8Array(width * height).fill(1);
    for (let y = 5; y < 15; y++) {
      for (let x = 5; x < 15; x++) barrier1[y * width + x] = 0;
    }
    // Frame 2: the same blob, PLUS a same-shaped extra blob far away in the
    // opposite corner - representing a region newly exposed by the pose
    // change, with nothing plausible to match on frame 1 (too far away,
    // relative to its own size, to even make the candidate shortlist).
    const barrier2 = new Uint8Array(barrier1);
    for (let y = 145; y < 155; y++) {
      for (let x = 145; x < 155; x++) barrier2[y * width + x] = 0;
    }

    const { regions: regions1 } = computeAllRegions(barrier1, width, height, 0);
    const { regions: regions2 } = computeAllRegions(barrier2, width, height, 0);
    expect(regions1.length).toBe(1);
    expect(regions2.length).toBe(2);

    const { regionMatch } = matchFrameRegions(regions1, regions2, width, height);
    const nearMatch = regions2.find((r) => Math.abs(r.cx - regions1[0].cx) < 5 && Math.abs(r.cy - regions1[0].cy) < 5);
    const farRegion = regions2.find((r) => r.id !== nearMatch?.id)!;

    expect(regionMatch.get(nearMatch!.id)).toBe(regions1[0].id);
    expect(regionMatch.get(farRegion.id)).toBeNull();
  });
});
