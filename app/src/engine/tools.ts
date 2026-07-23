/** Tool/mode/size vocabulary and the freehand stroke drawing helper. */

export type ToolId = 'fill' | 'brush' | 'marker' | 'eraser' | 'sticker';
export type ModeId = 'inside' | 'free';
export type SizeId = 'small' | 'medium' | 'large';

/** Stroke diameter in internal-resolution pixels. */
export const BRUSH_SIZES: Record<SizeId, number> = {
  small: 8,
  medium: 20,
  large: 44,
};

export const MARKER_ALPHA = 0.55;
export const MASK_DILATE_RADIUS = 2;

/** ~24 bright, kid-friendly colors: primaries, skin tones, browns, greys, pinks/purples. */
export const PALETTE: string[] = [
  '#000000', // black
  '#ffffff', // white
  '#7f7f7f', // grey
  '#c0c0c0', // light grey
  '#5c3a21', // dark brown
  '#8b5a2b', // brown
  '#f1c27d', // skin - light
  '#e0ac69', // skin - tan
  '#c68642', // skin - medium
  '#8d5524', // skin - dark
  '#ff0000', // red
  '#ff7f00', // orange
  '#ffd700', // gold
  '#ffff00', // yellow
  '#7cfc00', // lime
  '#008000', // green
  '#00ced1', // turquoise
  '#00bfff', // sky blue
  '#0000ff', // blue
  '#4b0082', // indigo
  '#8a2be2', // purple
  '#ff69b4', // pink
  '#ff1493', // deep pink
  '#a0522d', // sienna
];

/** Kid-friendly emoji options for the sticker tool - icon-only, no text. */
export const STICKER_EMOJIS: string[] = [
  '⭐', '🌟', '✨', '💖', '❤️', '🌈', '🎈', '🐱',
  '🐶', '🦄', '🌸', '🍀', '☀️', '🌙', '🔥', '🎵',
];

export interface Point {
  x: number;
  y: number;
}

export function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/**
 * Renders a "glitter" fill directly into an RGBA pixel buffer (as returned by
 * `getImageData`), clipped to `mask` - a sparkly alternative to a flat fill
 * that still lives as real pixels on the paint canvas (reuses all existing
 * compositing/undo/thumbnail code paths unchanged). Region content-kind
 * bookkeeping (glitter vs flat) is tracked separately by the caller since
 * this function only touches pixels, not metadata.
 *
 * The sparkle pattern is a deterministic hash of each pixel's coordinates
 * (not Math.random) purely so repeated calls for the same mask look stable;
 * it is NOT required to match between frame 1 and its mirrored frame-2
 * region - each frame renders its own sparkle over its own mask shape.
 *
 * `data`/`mask` are normally both full-canvas sized (`width` x full height),
 * indexed by the same pixel index `p`. Pass `bbox` when `data` is instead a
 * SMALLER buffer cropped via `getImageData(minX, minY, bw, bh)` (e.g. a
 * region's bounding box) - `mask` stays full-canvas sized either way, only
 * the write-target buffer is local to the crop.
 */
export function paintGlitterMask(
  data: Uint8ClampedArray,
  mask: Uint8Array,
  width: number,
  hex: string,
  bbox?: { minX: number; minY: number; bw: number; bh: number }
): void {
  const [r, g, b] = hexToRgb(hex);
  // Lightened base wash so sparkle dots read clearly against it.
  const baseR = Math.round(r + (255 - r) * 0.55);
  const baseG = Math.round(g + (255 - g) * 0.55);
  const baseB = Math.round(b + (255 - b) * 0.55);
  const paint = (li: number, x: number, y: number) => {
    const h = ((x * 374761393 + y * 668265263) ^ (x * 2246822519)) >>> 0;
    if (h % 1000 < 45) {
      // Sparkle dot: mostly a bright near-white highlight, sometimes full-saturation color.
      const bright = (h >>> 8) % 3 !== 0;
      data[li] = bright ? 255 : r;
      data[li + 1] = bright ? 255 : g;
      data[li + 2] = bright ? 255 : b;
      data[li + 3] = 255;
    } else {
      data[li] = baseR;
      data[li + 1] = baseG;
      data[li + 2] = baseB;
      data[li + 3] = 255;
    }
  };
  if (!bbox) {
    for (let p = 0; p < mask.length; p++) {
      if (!mask[p]) continue;
      paint(p * 4, p % width, (p / width) | 0);
    }
    return;
  }
  const { minX, minY, bw, bh } = bbox;
  for (let ry = 0; ry < bh; ry++) {
    const gy = minY + ry;
    const rowBase = gy * width;
    for (let rx = 0; rx < bw; rx++) {
      const gx = minX + rx;
      if (!mask[rowBase + gx]) continue;
      paint((ry * bw + rx) * 4, gx, gy);
    }
  }
}

/**
 * Draws a smoothed freehand stroke incrementally onto a 2D context: each
 * added point extends the path with a quadratic curve through the midpoints
 * of consecutive segments, avoiding a jagged polyline. Caller controls
 * `globalCompositeOperation`/`globalAlpha`/fillStyle context state before
 * starting a stroke (e.g. 'destination-out' for the eraser).
 */
export class StrokeDrawer {
  private pts: Point[] = [];

  constructor(
    private ctx: CanvasRenderingContext2D,
    private lineWidth: number,
    private color: string
  ) {}

  begin(p: Point) {
    this.pts = [p];
    this.dot(p);
  }

  extend(p: Point) {
    this.pts.push(p);
    this.drawLatestSegment();
  }

  private dot(p: Point) {
    this.ctx.fillStyle = this.color;
    this.ctx.beginPath();
    this.ctx.arc(p.x, p.y, this.lineWidth / 2, 0, Math.PI * 2);
    this.ctx.fill();
  }

  private drawLatestSegment() {
    const pts = this.pts;
    const n = pts.length;
    this.ctx.strokeStyle = this.color;
    this.ctx.lineWidth = this.lineWidth;
    this.ctx.lineCap = 'round';
    this.ctx.lineJoin = 'round';
    if (n === 2) {
      this.ctx.beginPath();
      this.ctx.moveTo(pts[0].x, pts[0].y);
      this.ctx.lineTo(pts[1].x, pts[1].y);
      this.ctx.stroke();
    } else {
      const p0 = pts[n - 3];
      const p1 = pts[n - 2];
      const p2 = pts[n - 1];
      const mid1 = { x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2 };
      const mid2 = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
      this.ctx.beginPath();
      this.ctx.moveTo(mid1.x, mid1.y);
      this.ctx.quadraticCurveTo(p1.x, p1.y, mid2.x, mid2.y);
      this.ctx.stroke();
    }
  }
}
