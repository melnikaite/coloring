import { describe, expect, it } from 'vitest';
import { computeAllRegions, matchFrameRegions, RegionInfo } from './floodfill';
import { buildNestedBarrier, byArea } from './regionTestHelpers';
import {
  decimatePoints,
  FillOp,
  resolveStickerPos,
  StickerOp,
  stickerOffsetFromPoint,
  StrokeOp,
  transformOp,
} from './ops';

/** A minimal region for tests that don't need real flood-fill output - just centroid/area. */
function makeRegion(id: number, cx: number, cy: number, area: number): RegionInfo {
  return { id, mask: new Uint8Array(0), area, cx, cy, minX: 0, minY: 0, maxX: 0, maxY: 0, maskCanvas: null };
}

describe('transformOp: fill', () => {
  it('carries color/glitter unchanged, only moves regionId', () => {
    const r1 = makeRegion(3, 10, 10, 100);
    const r2 = makeRegion(7, 50, 60, 400);
    const op: FillOp = { kind: 'fill', id: 'f1', regionId: 3, color: '#ff0000', glitter: true };
    const out = transformOp(op, r1, r2);
    expect(out).toEqual({ kind: 'fill', id: 'f1', regionId: 7, color: '#ff0000', glitter: true });
  });
});

describe('transformOp: sticker', () => {
  it('carries offset/scale/emoji unchanged, only moves regionId', () => {
    const r1 = makeRegion(3, 10, 10, 100);
    const r2 = makeRegion(7, 50, 60, 400);
    const op: StickerOp = { kind: 'sticker', id: 's1', regionId: 3, emoji: '⭐', offsetX: 0.2, offsetY: -0.3, scale: 1.5 };
    const out = transformOp(op, r1, r2);
    expect(out).toEqual({ kind: 'sticker', id: 's1', regionId: 7, emoji: '⭐', offsetX: 0.2, offsetY: -0.3, scale: 1.5 });
  });
});

describe('transformOp: stroke', () => {
  it('remaps every point by the centroid + sqrt(area) similarity transform, and moves the anchor', () => {
    // r2 is r1 shifted by (40, 20) and scaled 2x in linear size (4x area).
    const r1 = makeRegion(3, 10, 10, 25); // sqrt(area) = 5
    const r2 = makeRegion(7, 50, 30, 100); // sqrt(area) = 10 -> scale factor 2
    const op: StrokeOp = {
      kind: 'stroke',
      id: 'st1',
      tool: 'brush',
      color: '#00ff00',
      size: 'medium',
      mode: 'inside',
      anchorRegionId: 3,
      points: [
        { x: 10, y: 10 }, // exactly the centroid -> maps exactly to r2's centroid
        { x: 15, y: 10 }, // 5px right of centroid -> 10px right of r2's centroid (2x scale)
        { x: 10, y: 5 }, // 5px above centroid -> 10px above r2's centroid
      ],
    };
    const out = transformOp(op, r1, r2) as StrokeOp;
    expect(out.anchorRegionId).toBe(7);
    expect(out.points).toEqual([
      { x: 50, y: 30 },
      { x: 60, y: 30 },
      { x: 50, y: 20 },
    ]);
    // Non-geometric fields untouched.
    expect(out.tool).toBe('brush');
    expect(out.color).toBe('#00ff00');
    expect(out.mode).toBe('inside');
  });

  it('combined with matchFrameRegions: a stroke anchored on the nested "spot" transfers onto the ' +
    'matched frame-2 spot, not the surrounding wing (the exact bug class this whole model exists to prevent)', () => {
    const W = 80;
    const H = 80;
    const barrier1 = buildNestedBarrier(W, H, 40, 40, 10);
    const barrier2 = buildNestedBarrier(W, H, 43, 38, 9);
    const { regions: regions1 } = computeAllRegions(barrier1, W, H, 0);
    const { regions: regions2 } = computeAllRegions(barrier2, W, H, 0);
    const f1 = byArea(regions1);
    const f2 = byArea(regions2);

    const { reverseMatch } = matchFrameRegions(regions1, regions2, W, H);

    // A stroke drawn across the small spot region on frame 1.
    const op: StrokeOp = {
      kind: 'stroke',
      id: 'spot-stroke',
      tool: 'brush',
      color: '#123456',
      size: 'small',
      mode: 'inside',
      anchorRegionId: f1.small.id,
      points: [
        { x: f1.small.cx - 1, y: f1.small.cy },
        { x: f1.small.cx + 1, y: f1.small.cy },
      ],
    };

    const targets = reverseMatch.get(f1.small.id)!;
    expect(targets.length).toBe(1);
    const r2 = regions2[targets[0]];
    expect(r2.id).toBe(f2.small.id); // matched the spot, not the wing

    const transformed = transformOp(op, f1.small, r2) as StrokeOp;
    expect(transformed.anchorRegionId).toBe(f2.small.id);
    // Transformed points should land near the frame-2 spot's own centroid, not the wing's.
    for (const p of transformed.points) {
      expect(Math.hypot(p.x - f2.small.cx, p.y - f2.small.cy)).toBeLessThan(f2.small.area ** 0.5);
    }
  });
});

describe('sticker position math', () => {
  it('resolveStickerPos and stickerOffsetFromPoint are inverses of each other', () => {
    const region = makeRegion(1, 100, 200, 64); // sqrt(area) = 8
    const p = { x: 130, y: 170 };
    const offset = stickerOffsetFromPoint(region, p);
    const back = resolveStickerPos(region, offset);
    expect(back.x).toBeCloseTo(p.x, 6);
    expect(back.y).toBeCloseTo(p.y, 6);
  });

  it('resolveStickerPos adapts automatically to a differently-sized matched region (no separate transform needed)', () => {
    const r1 = makeRegion(1, 0, 0, 25); // sqrt(area) = 5
    const r2 = makeRegion(2, 100, 100, 100); // sqrt(area) = 10, 2x linear scale
    const sticker = { offsetX: 1, offsetY: 0 }; // one region-radius to the right
    const pos1 = resolveStickerPos(r1, sticker);
    const pos2 = resolveStickerPos(r2, sticker);
    expect(pos1).toEqual({ x: 5, y: 0 });
    expect(pos2).toEqual({ x: 110, y: 100 });
  });
});

describe('decimatePoints', () => {
  it('keeps first and last points always, even for a dense path', () => {
    const points = Array.from({ length: 50 }, (_, i) => ({ x: i * 0.1, y: 0 })); // 0.1px apart
    const out = decimatePoints(points, 1.5);
    expect(out[0]).toEqual(points[0]);
    expect(out[out.length - 1]).toEqual(points[points.length - 1]);
    expect(out.length).toBeLessThan(points.length);
  });

  it('drops nothing when points are already sparser than minDist', () => {
    const points = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 20, y: 0 },
    ];
    expect(decimatePoints(points, 1.5)).toEqual(points);
  });

  it('leaves 0/1/2-point paths untouched', () => {
    expect(decimatePoints([])).toEqual([]);
    expect(decimatePoints([{ x: 1, y: 2 }])).toEqual([{ x: 1, y: 2 }]);
    const two = [{ x: 1, y: 2 }, { x: 3, y: 4 }];
    expect(decimatePoints(two)).toEqual(two);
  });
});
