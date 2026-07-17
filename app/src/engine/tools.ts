/** Tool/mode/size vocabulary and the freehand stroke drawing helper. */

export type ToolId = 'fill' | 'brush' | 'marker' | 'eraser';
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

export interface Point {
  x: number;
  y: number;
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
