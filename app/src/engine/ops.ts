/**
 * The paint-operation model: the source of truth for what's been painted on a
 * frame. A `PaintFrame`'s canvas (see editor.ts) is always a derived render
 * cache - it can be rebuilt at any time by replaying a frame's `PaintOp[]` in
 * order (see `engine/opRenderer.ts`) onto a blank canvas, and that replay is
 * always correct because the ops themselves - not sampled/reconstructed
 * pixels - are the record of what happened.
 *
 * This file stays pure (no DOM/canvas) so the op-transform logic - the part
 * that used to be the recurring source of bugs (dominant-color histograms,
 * painted-fraction thresholds, nearest-neighbor pixel sampling all trying to
 * *guess* intent from pixels) - is plain data-in/data-out and unit-testable
 * without a browser. See `ops.test.ts`.
 */
import type { RegionInfo } from './floodfill';
import type { ModeId, Point, SizeId } from './tools';

export interface FillOp {
  kind: 'fill';
  id: string;
  /** Stable region id (this frame's own `RegionInfo[]` indexing) the fill was applied to. */
  regionId: number;
  color: string;
  /** True = a glitter fill (see `paintGlitterMask`), false = a flat fill. Part of the op
   * itself now - no separate `glitterRegions` bookkeeping map needed alongside it. */
  glitter: boolean;
}

export interface StrokeOp {
  kind: 'stroke';
  id: string;
  tool: 'brush' | 'marker' | 'eraser';
  color: string;
  size: SizeId;
  /** The mode the stroke was drawn in - 'inside' strokes replay clipped to `anchorRegionId`'s
   * mask; 'free' strokes replay unclipped, regardless of whether an anchor region exists. */
  mode: ModeId;
  /** The stroke's actual path, in the frame's internal pixel space it was drawn in - replaying
   * means re-running the same `StrokeDrawer` used for live painting on these points, not
   * resampling pixels. Decimated (see `decimatePoints`) before storage to keep long strokes
   * from growing unbounded, since (unlike the old raster-blob history) every stroke's points
   * are kept forever for undo/redo and frame-2 mirroring. */
  points: Point[];
  /**
   * The region "home" this stroke is anchored to for frame-1<->frame-2 transform purposes -
   * the region under the stroke's start point (falling back to the nearest free pixel's region
   * if the start point itself landed on a barrier line, e.g. a free-mode stroke started on the
   * line art). Null only if no region could be found nearby - such a stroke is never mirrored to
   * the other frame, though it still renders fine on its own frame.
   */
  anchorRegionId: number | null;
}

export interface StickerOp {
  kind: 'sticker';
  id: string;
  /** Stable region id this sticker is positioned relative to (see `resolveStickerPos`). */
  regionId: number;
  emoji: string;
  /** Position offset from the region's centroid, normalized by sqrt(region.area) - see
   * `resolveStickerPos` - so a sticker mirrored onto a matched-but-differently-shaped region
   * still lands in the analogous spot with NO further transform needed (unlike StrokeOp's
   * points, a sticker's offset is already region-relative and scale-free). */
  offsetX: number;
  offsetY: number;
  scale: number;
}

export type PaintOp = FillOp | StrokeOp | StickerOp;

/**
 * Deep-enough clone of an op for safe history-snapshot storage: sticker ops
 * are mutated in place while dragging/scaling (same object identity kept
 * across the drag, see editor.ts), so a snapshot must copy at least one level
 * deep or a later drag would silently rewrite history already pushed. Fill
 * ops have no mutable fields; stroke ops' `points` array is never mutated
 * after the stroke commits, but is still copied here for defense in depth.
 */
export function cloneOp(op: PaintOp): PaintOp {
  if (op.kind === 'stroke') return { ...op, points: op.points.slice() };
  return { ...op };
}

/**
 * Collapses consecutive points closer than `minDist` together, keeping the
 * first and last point always. Called once at stroke-commit time (not during
 * live drawing, which still gets every raw pointer sample for a smooth
 * preview) - a long, wobbly stroke can otherwise accumulate hundreds of
 * points, and every stored stroke now lives forever in the op list (no 25-
 * entry raster cap bounding it away anymore), so this keeps storage/replay
 * cost bounded without visibly changing the stroke's shape (the quadratic
 * through-midpoints smoothing in `StrokeDrawer` already fairs out small gaps).
 */
export function decimatePoints(points: Point[], minDist = 1.5): Point[] {
  if (points.length <= 2) return points.slice();
  const out: Point[] = [points[0]];
  for (let i = 1; i < points.length - 1; i++) {
    const last = out[out.length - 1];
    if (Math.hypot(points[i].x - last.x, points[i].y - last.y) >= minDist) out.push(points[i]);
  }
  out.push(points[points.length - 1]);
  return out;
}

/**
 * A sticker's screen position, resolved from its region-relative offset -
 * the inverse of `stickerOffsetFromPoint`. Pure function of `RegionInfo`
 * (no DOM), reused for placing, hit-testing, dragging AND mirroring a
 * sticker onto a matched frame-2 region (which naturally has a different
 * `region.cx/cy/area` - the same formula "just works" for both cases, no
 * separate transform needed for stickers the way strokes need one).
 */
export function resolveStickerPos(region: RegionInfo, s: { offsetX: number; offsetY: number }): Point {
  const r = Math.sqrt(Math.max(1, region.area));
  return { x: region.cx + s.offsetX * r, y: region.cy + s.offsetY * r };
}

/** The inverse of `resolveStickerPos`: the region-relative offset for a screen point `p`. */
export function stickerOffsetFromPoint(region: RegionInfo, p: Point): { offsetX: number; offsetY: number } {
  const r = Math.sqrt(Math.max(1, region.area));
  return { offsetX: (p.x - region.cx) / r, offsetY: (p.y - region.cy) / r };
}

/**
 * Transforms `op` (anchored on frame-1 region `r1`) into frame-2 region
 * `r2`'s coordinate frame, via `matchFrameRegions`'s output - the caller
 * already knows r1/r2 correspond (see `matchFrameRegions` in floodfill.ts).
 *
 * - `fill`: color/glitter carry over unchanged; only `regionId` moves to r2.
 * - `sticker`: offset/scale are already region-relative (see `resolveStickerPos`), so they
 *   carry over unchanged too; only `regionId` moves to r2.
 * - `stroke`: the actual path points, so they need a real geometric transform - the same
 *   centroid + sqrt(area) similarity ratio used throughout this codebase for adapting content
 *   between two differently-shaped-but-corresponding regions (see `matchFrameRegions`'s own
 *   `fractionInside`, and `resolveStickerPos` above). Mapping a point `p` from r1-space to
 *   r2-space: `r2.cx + (p.x - r1.cx) * sqrt(r2.area / r1.area)` (and the same for y).
 */
export function transformOp(op: PaintOp, r1: RegionInfo, r2: RegionInfo): PaintOp {
  switch (op.kind) {
    case 'fill':
      return { ...op, regionId: r2.id };
    case 'sticker':
      return { ...op, regionId: r2.id };
    case 'stroke': {
      const s = Math.sqrt(Math.max(1, r2.area) / Math.max(1, r1.area));
      const points = op.points.map((p) => ({
        x: r2.cx + (p.x - r1.cx) * s,
        y: r2.cy + (p.y - r1.cy) * s,
      }));
      return { ...op, points, anchorRegionId: r2.id };
    }
  }
}

/** The region id an op is anchored to for matching/transform purposes, or null if it has none
 * (a stroke that couldn't find any nearby region at draw time - never mirrored). */
export function opHomeRegionId(op: PaintOp): number | null {
  return op.kind === 'stroke' ? op.anchorRegionId : op.regionId;
}
