/**
 * Renders `PaintOp`s (see `ops.ts`) onto a paint canvas - the ONE place that
 * turns an op back into pixels, shared by every consumer that needs to (live
 * incremental drawing in editor.ts, a full frame rebuild after undo/redo or a
 * frame-1<->frame-2 mirror change, and step-by-step playback in replay.ts).
 * Sticker ops are deliberately skipped here - they're never part of the paint
 * raster, always a separate always-on-top layer drawn straight from the op
 * list (see `drawStickersOnto` in editor.ts) - so replaying a frame's ops
 * onto its paint canvas only ever has to deal with fill/stroke pixels.
 */
import type { MaskCanvasCache, RegionInfo } from './floodfill';
import { BRUSH_SIZES, MARKER_ALPHA, hexToRgb, paintGlitterMask, StrokeDrawer } from './tools';
import type { FillOp, PaintOp, StrokeOp } from './ops';

/** Whatever a fill/stroke op needs to look itself up: this frame's regions (indexed by id)
 * plus its lazily-rasterized mask-canvas cache for stroke clipping. */
export interface OpRenderTarget {
  regions: RegionInfo[];
  maskCanvases: MaskCanvasCache;
}

/** Clips everything currently drawn on `scratchCtx` to `region`'s mask (destination-in) -
 * shared by both live stroke drawing and stroke-op replay so the two can never drift apart. */
export function applyMaskToScratch(
  scratchCtx: CanvasRenderingContext2D,
  maskCanvases: MaskCanvasCache,
  region: RegionInfo
): void {
  scratchCtx.globalCompositeOperation = 'destination-in';
  scratchCtx.drawImage(maskCanvases.get(region), 0, 0);
  scratchCtx.globalCompositeOperation = 'source-over';
}

function drawFillOp(ctx: CanvasRenderingContext2D, target: OpRenderTarget, width: number, op: FillOp): void {
  const region = target.regions[op.regionId];
  if (!region) return; // stale/foreign region id (e.g. an old save) - skip gracefully
  const { minX, minY, maxX, maxY, mask } = region;
  const bw = maxX - minX + 1;
  const bh = maxY - minY + 1;
  if (bw <= 0 || bh <= 0) return;
  const imageData = ctx.getImageData(minX, minY, bw, bh);
  const d = imageData.data;
  if (op.glitter) {
    paintGlitterMask(d, mask, width, op.color, { minX, minY, bw, bh });
  } else {
    const [r, g, b] = hexToRgb(op.color);
    for (let ry = 0; ry < bh; ry++) {
      const gy = minY + ry;
      const rowBase = gy * width;
      for (let rx = 0; rx < bw; rx++) {
        const p = rowBase + (minX + rx);
        if (!mask[p]) continue;
        const i = (ry * bw + rx) * 4;
        d[i] = r;
        d[i + 1] = g;
        d[i + 2] = b;
        d[i + 3] = 255;
      }
    }
  }
  ctx.putImageData(imageData, minX, minY);
}

function drawStrokeOp(
  ctx: CanvasRenderingContext2D,
  target: OpRenderTarget,
  scratchCanvas: HTMLCanvasElement,
  scratchCtx: CanvasRenderingContext2D,
  width: number,
  height: number,
  op: StrokeOp
): void {
  if (op.points.length === 0) return;
  scratchCtx.clearRect(0, 0, width, height);
  scratchCtx.globalCompositeOperation = 'source-over';
  scratchCtx.globalAlpha = 1;
  const lineWidth = BRUSH_SIZES[op.size];
  const drawColor = op.tool === 'eraser' ? '#000000' : op.color;
  const drawer = new StrokeDrawer(scratchCtx, lineWidth, drawColor);
  drawer.begin(op.points[0]);
  for (let i = 1; i < op.points.length; i++) drawer.extend(op.points[i]);
  if (op.mode === 'inside' && op.anchorRegionId != null) {
    const region = target.regions[op.anchorRegionId];
    if (region) applyMaskToScratch(scratchCtx, target.maskCanvases, region);
  }
  ctx.save();
  if (op.tool === 'eraser') {
    ctx.globalCompositeOperation = 'destination-out';
    ctx.drawImage(scratchCanvas, 0, 0);
  } else if (op.tool === 'marker') {
    ctx.globalAlpha = MARKER_ALPHA;
    ctx.drawImage(scratchCanvas, 0, 0);
  } else {
    ctx.drawImage(scratchCanvas, 0, 0);
  }
  ctx.restore();
}

/** Draws one op onto `ctx` (a fill or a stroke - sticker ops are a no-op here, see file doc). */
export function drawOp(
  ctx: CanvasRenderingContext2D,
  target: OpRenderTarget,
  scratchCanvas: HTMLCanvasElement,
  scratchCtx: CanvasRenderingContext2D,
  width: number,
  height: number,
  op: PaintOp
): void {
  if (op.kind === 'fill') drawFillOp(ctx, target, width, op);
  else if (op.kind === 'stroke') drawStrokeOp(ctx, target, scratchCanvas, scratchCtx, width, height, op);
}

/**
 * Rebuilds `ctx` from scratch by replaying `ops` in order - the "canvas is a
 * derived cache" half of the model: always correct, always redoable, given
 * only the op list. Used for mount-time seeding, undo/redo, and rebuilding
 * frame 2's mirrored canvas; NOT used for routine live painting, which
 * appends just the one new op directly for speed (see editor.ts).
 */
export function replayOps(
  ctx: CanvasRenderingContext2D,
  target: OpRenderTarget,
  scratchCanvas: HTMLCanvasElement,
  scratchCtx: CanvasRenderingContext2D,
  width: number,
  height: number,
  ops: readonly PaintOp[]
): void {
  ctx.clearRect(0, 0, width, height);
  for (const op of ops) drawOp(ctx, target, scratchCanvas, scratchCtx, width, height, op);
}
