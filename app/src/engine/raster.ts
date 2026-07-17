/**
 * Rasterizes a coloring-page SVG into the engine's internal working resolution
 * and extracts a "barrier map" (dark line-art pixels) used by flood fill and
 * inside-lines masking.
 */

export const INTERNAL_MAX = 1600;
/** Luminance below this is considered part of the line art (a barrier). */
export const LINE_LUMINANCE_THRESHOLD = 140;

export interface RasterResult {
  width: number;
  height: number;
  /** Offscreen canvas containing only the black line art on a transparent background. */
  lineCanvas: HTMLCanvasElement;
  /** 1 = barrier (dark line pixel), 0 = paintable. Row-major, length = width*height. */
  barrier: Uint8Array;
}

function parseViewBox(svgText: string): [number, number, number, number] {
  const match = svgText.match(/viewBox\s*=\s*"([^"]+)"/i);
  if (!match) return [0, 0, 1024, 1024];
  const parts = match[1].trim().split(/[\s,]+/).map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return [0, 0, 1024, 1024];
  return parts as [number, number, number, number];
}

function makeCanvas(width: number, height: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  return c;
}

/** Load an SVG from a URL and rasterize it at internal working resolution. */
export async function rasterizeSvg(url: string): Promise<RasterResult> {
  const res = await fetch(url);
  const svgText = await res.text();
  const [, , vbWidth, vbHeight] = parseViewBox(svgText);

  const longSide = Math.max(vbWidth, vbHeight) || 1024;
  const scale = INTERNAL_MAX / longSide;
  const width = Math.max(1, Math.round(vbWidth * scale));
  const height = Math.max(1, Math.round(vbHeight * scale));

  const img = new Image();
  const blob = new Blob([svgText], { type: 'image/svg+xml' });
  const blobUrl = URL.createObjectURL(blob);
  try {
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error(`Failed to decode SVG: ${url}`));
      img.src = blobUrl;
    });
  } finally {
    // Keep the URL alive until after drawImage below (revoked in finally after draw).
  }

  const raster = makeCanvas(width, height);
  const rctx = raster.getContext('2d', { willReadFrequently: true })!;
  rctx.fillStyle = '#fff';
  rctx.fillRect(0, 0, width, height);
  rctx.drawImage(img, 0, 0, width, height);
  URL.revokeObjectURL(blobUrl);

  const imageData = rctx.getImageData(0, 0, width, height);
  const { data } = imageData;
  const barrier = new Uint8Array(width * height);

  const lineCanvas = makeCanvas(width, height);
  const lctx = lineCanvas.getContext('2d')!;
  const lineData = lctx.createImageData(width, height);
  const ld = lineData.data;

  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const luminance = 0.299 * r + 0.587 * g + 0.114 * b;
    if (luminance < LINE_LUMINANCE_THRESHOLD) {
      barrier[p] = 1;
      ld[i] = 0;
      ld[i + 1] = 0;
      ld[i + 2] = 0;
      ld[i + 3] = 255;
    } else {
      ld[i + 3] = 0;
    }
  }
  lctx.putImageData(lineData, 0, 0);

  return { width, height, lineCanvas, barrier };
}
