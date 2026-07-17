/**
 * Full-screen "celebrate the finished drawing" overlay, claymation-style:
 * the paint layer stays perfectly still while the line-art layer "boils"
 * between 3 gently-warped variants at 8fps (that hard-stepped wobble is the
 * claymation charm), with a confetti + twinkling-star burst on top and a
 * subtle whole-scene sway/pulse. Tap anywhere (outside the action buttons)
 * to dismiss. Self-contained, no external UI libraries (gifenc is used only
 * for byte-level GIF encoding).
 */
import { GIFEncoder, quantize, applyPalette } from 'gifenc';
import { t } from './i18n';

const CONFETTI_COLORS = [
  '#ff6b6b',
  '#ffd166',
  '#06d6a0',
  '#4ecdc4',
  '#118ab2',
  '#a06cd5',
  '#ff8fab',
  '#ffffff',
];

const BOIL_FRAME_COUNT = 3;
const BOIL_FRAME_MS = 125; // 8fps hard steps for the synthetic line boil
const REAL_FRAME_MS = 250; // ~4fps for real hand-made frames - actual movement reads better slower
const BOIL_MAX_AMPLITUDE_PX = 4;
const GIF_MAX_DIMENSION = 1024;

/** Frame delay for the on-screen animation AND the exported GIF. */
function frameDelayMs(source: CelebrateSource): number {
  return source.lineLayers.length > 1 ? REAL_FRAME_MS : BOIL_FRAME_MS;
}

export interface CelebrateSource {
  width: number;
  height: number;
  /**
   * The user's paint layer(s), parallel to `lineLayers`. With a single entry
   * that paint is used for every frame (classic shared coloring). When the
   * child painted frame 2 separately, pass both - frame i then renders
   * paintLayers[i] under lineLayers[i].
   */
  paintLayers: HTMLCanvasElement[];
  /**
   * The line-art layer(s). With a single canvas (`[lineCanvas]`) the boil
   * effect synthesizes 3 warped variants from it at 8fps. When the catalog
   * entry ships real hand-made frames (`frames` in catalog.json - e.g. a
   * blink or a shifted paw), all of them are passed here and cycled as-is
   * at ~4fps, skipping the synthetic warp.
   */
  lineLayers: HTMLCanvasElement[];
  /** Used for the exported file name. */
  imageId: string;
}

/**
 * The paint layer to composite under line frame `frameIndex`. Falls back to
 * the first (frame 1) paint when no dedicated layer exists - including for
 * synthetic boil frames, which all derive from line frame 0.
 */
function paintFor(source: CelebrateSource, frameIndex: number): HTMLCanvasElement {
  if (source.lineLayers.length <= 1) return source.paintLayers[0];
  return source.paintLayers[frameIndex] ?? source.paintLayers[0];
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  color: string;
  rotation: number;
  vr: number;
  shape: 'rect' | 'circle';
  life: number;
  decay: number;
}

interface Star {
  x: number;
  y: number;
  size: number;
  phase: number;
  speed: number;
}

// Warped line-boil variants are pure functions of the source line canvas, so
// they're computed lazily on first celebrate and cached for the rest of the
// session (line art is static per image, just like region masks).
const boilCache = new WeakMap<HTMLCanvasElement, HTMLCanvasElement[]>();

function randomWave(): { wavelength: number; phase: number } {
  return { wavelength: 200 + Math.random() * 150, phase: Math.random() * Math.PI * 2 };
}

/** Sum of two low-frequency sinusoids, clamped to +/-BOIL_MAX_AMPLITUDE_PX. */
function makeOffsetFn(): (coord: number) => number {
  const w1 = randomWave();
  const w2 = randomWave();
  const a1 = BOIL_MAX_AMPLITUDE_PX * 0.6;
  const a2 = BOIL_MAX_AMPLITUDE_PX * 0.4;
  return (coord: number) => {
    const v =
      a1 * Math.sin((coord / w1.wavelength) * Math.PI * 2 + w1.phase) +
      a2 * Math.sin((coord / w2.wavelength) * Math.PI * 2 + w2.phase);
    return Math.max(-BOIL_MAX_AMPLITUDE_PX, Math.min(BOIL_MAX_AMPLITUDE_PX, v));
  };
}

/** Two-pass smooth warp: shift every row horizontally, then every column vertically. */
function warpLineCanvas(source: HTMLCanvasElement, width: number, height: number): HTMLCanvasElement {
  const rowOffset = makeOffsetFn();
  const colOffset = makeOffsetFn();

  const pass1 = document.createElement('canvas');
  pass1.width = width;
  pass1.height = height;
  const p1ctx = pass1.getContext('2d')!;
  for (let y = 0; y < height; y++) {
    p1ctx.drawImage(source, 0, y, width, 1, rowOffset(y), y, width, 1);
  }

  const pass2 = document.createElement('canvas');
  pass2.width = width;
  pass2.height = height;
  const p2ctx = pass2.getContext('2d')!;
  for (let x = 0; x < width; x++) {
    p2ctx.drawImage(pass1, x, 0, 1, height, x, colOffset(x), 1, height);
  }
  return pass2;
}

function getBoilFrames(source: CelebrateSource): HTMLCanvasElement[] {
  if (source.lineLayers.length > 1) {
    // Real multi-frame line art already provided by the catalog - use as-is.
    return source.lineLayers;
  }
  const base = source.lineLayers[0];
  const cached = boilCache.get(base);
  if (cached) return cached;
  const frames: HTMLCanvasElement[] = [];
  for (let i = 0; i < BOIL_FRAME_COUNT; i++) frames.push(warpLineCanvas(base, source.width, source.height));
  boilCache.set(base, frames);
  return frames;
}

function drawStaticPlusLine(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  paintCanvas: HTMLCanvasElement,
  lineFrame: HTMLCanvasElement
) {
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(paintCanvas, 0, 0);
  ctx.drawImage(lineFrame, 0, 0);
}

async function canvasToBlob(canvas: HTMLCanvasElement, type: string): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), type);
  });
}

async function shareOrDownload(blob: Blob, filename: string, mimeType: string): Promise<void> {
  const file = new File([blob], filename, { type: mimeType });
  const nav = navigator as Navigator & { canShare?: (data?: ShareData) => boolean };
  if (nav.canShare && nav.canShare({ files: [file] }) && navigator.share) {
    try {
      await navigator.share({ files: [file] });
      return;
    } catch {
      // user cancelled the share sheet - fall through to download as a backup
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

async function exportPng(source: CelebrateSource, boilFrames: HTMLCanvasElement[]): Promise<void> {
  const c = document.createElement('canvas');
  c.width = source.width;
  c.height = source.height;
  const ctx = c.getContext('2d')!;
  drawStaticPlusLine(ctx, source.width, source.height, paintFor(source, 0), boilFrames[0]);
  const blob = await canvasToBlob(c, 'image/png');
  await shareOrDownload(blob, `${source.imageId}.png`, 'image/png');
}

async function exportGif(source: CelebrateSource, boilFrames: HTMLCanvasElement[]): Promise<void> {
  const scale = Math.min(1, GIF_MAX_DIMENSION / Math.max(source.width, source.height));
  const outW = Math.max(1, Math.round(source.width * scale));
  const outH = Math.max(1, Math.round(source.height * scale));

  const frameCanvas = document.createElement('canvas');
  frameCanvas.width = outW;
  frameCanvas.height = outH;
  const frameCtx = frameCanvas.getContext('2d', { willReadFrequently: true })!;

  const gif = GIFEncoder();
  for (let i = 0; i < boilFrames.length; i++) {
    const lineFrame = boilFrames[i];
    frameCtx.clearRect(0, 0, outW, outH);
    frameCtx.fillStyle = '#ffffff';
    frameCtx.fillRect(0, 0, outW, outH);
    frameCtx.drawImage(paintFor(source, i), 0, 0, source.width, source.height, 0, 0, outW, outH);
    frameCtx.drawImage(lineFrame, 0, 0, source.width, source.height, 0, 0, outW, outH);
    const { data } = frameCtx.getImageData(0, 0, outW, outH);
    const palette = quantize(data, 256);
    const index = applyPalette(data, palette);
    gif.writeFrame(index, outW, outH, { palette, delay: frameDelayMs(source), repeat: 0 });
  }
  gif.finish();
  // `.buffer` sidesteps a TS lib mismatch between gifenc's Uint8Array return
  // type and BlobPart's ArrayBufferView<ArrayBuffer> constraint.
  const blob = new Blob([gif.bytes().buffer as ArrayBuffer], { type: 'image/gif' });
  await shareOrDownload(blob, `${source.imageId}.gif`, 'image/gif');
}

/**
 * Shows the celebration overlay inside `container`. Returns a dispose
 * function; also self-dismisses on background tap (calling `onDismiss`).
 */
export function showCelebration(container: HTMLElement, source: CelebrateSource, onDismiss: () => void): () => void {
  const overlay = document.createElement('div');
  overlay.className = 'celebrate-overlay';

  const confettiCanvas = document.createElement('canvas');
  confettiCanvas.className = 'celebrate-confetti';
  overlay.appendChild(confettiCanvas);

  const stage = document.createElement('div');
  stage.className = 'celebrate-stage';
  const artCanvas = document.createElement('canvas');
  artCanvas.className = 'celebrate-art';
  artCanvas.width = source.width;
  artCanvas.height = source.height;
  stage.appendChild(artCanvas);
  overlay.appendChild(stage);

  const actions = document.createElement('div');
  actions.className = 'celebrate-actions';
  const pngBtn = document.createElement('button');
  pngBtn.className = 'btn round';
  pngBtn.textContent = '📤';
  pngBtn.title = t('sharePicture');
  const gifBtn = document.createElement('button');
  gifBtn.className = 'btn round';
  gifBtn.textContent = '🎬';
  gifBtn.title = t('shareAnimation');
  actions.appendChild(pngBtn);
  actions.appendChild(gifBtn);
  overlay.appendChild(actions);
  // Buttons live inside the tap-to-dismiss overlay - don't let taps on them bubble to it.
  actions.addEventListener('pointerdown', (e) => e.stopPropagation());
  actions.addEventListener('click', (e) => e.stopPropagation());

  container.appendChild(overlay);

  const artCtx = artCanvas.getContext('2d')!;
  const confettiCtx = confettiCanvas.getContext('2d')!;
  const boilFrames = getBoilFrames(source);
  let boilIndex = 0;
  let lastBoilSwitch = performance.now();

  function drawArt() {
    drawStaticPlusLine(artCtx, source.width, source.height, paintFor(source, boilIndex), boilFrames[boilIndex]);
  }
  drawArt();

  pngBtn.addEventListener('click', () => {
    void exportPng(source, boilFrames);
  });
  gifBtn.addEventListener('click', () => {
    void exportGif(source, boilFrames);
  });

  let particles: Particle[] = [];
  const stars: Star[] = [];
  let disposed = false;
  let rafId = 0;
  let lastTime = performance.now();

  function resizeConfetti() {
    const rect = overlay.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    confettiCanvas.width = Math.max(1, Math.round(rect.width * dpr));
    confettiCanvas.height = Math.max(1, Math.round(rect.height * dpr));
    confettiCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  resizeConfetti();
  const resizeObserver = new ResizeObserver(resizeConfetti);
  resizeObserver.observe(overlay);

  function viewSize() {
    const rect = overlay.getBoundingClientRect();
    return { w: rect.width, h: rect.height };
  }

  function seedStars() {
    const { w, h } = viewSize();
    stars.length = 0;
    for (let i = 0; i < 24; i++) {
      stars.push({
        x: Math.random() * w,
        y: Math.random() * h * 0.6,
        size: 2 + Math.random() * 3,
        phase: Math.random() * Math.PI * 2,
        speed: 1 + Math.random() * 2,
      });
    }
  }
  seedStars();

  function spawnBurst(cx: number, cy: number, count: number) {
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 2.5 + Math.random() * 7;
      particles.push({
        x: cx,
        y: cy,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 3,
        size: 4 + Math.random() * 7,
        color: CONFETTI_COLORS[Math.floor(Math.random() * CONFETTI_COLORS.length)],
        rotation: Math.random() * Math.PI * 2,
        vr: (Math.random() - 0.5) * 0.3,
        shape: Math.random() < 0.5 ? 'rect' : 'circle',
        life: 1,
        decay: 0.004 + Math.random() * 0.004,
      });
    }
  }

  function burstAt(fracX: number, fracY: number, count: number) {
    const { w, h } = viewSize();
    spawnBurst(w * fracX, h * fracY, count);
  }

  burstAt(0.5, 0.35, 60);
  const t1 = window.setTimeout(() => burstAt(0.25, 0.3, 40), 350);
  const t2 = window.setTimeout(() => burstAt(0.75, 0.3, 40), 700);

  function tick(now: number) {
    if (disposed) return;
    const dt = Math.min(32, now - lastTime);
    lastTime = now;

    if (now - lastBoilSwitch >= frameDelayMs(source)) {
      boilIndex = (boilIndex + 1) % boilFrames.length;
      lastBoilSwitch = now;
      drawArt();
    }

    const { w, h } = viewSize();
    confettiCtx.clearRect(0, 0, w, h);

    for (const star of stars) {
      star.phase += (star.speed * dt) / 1000;
      const twinkle = 0.35 + 0.65 * Math.abs(Math.sin(star.phase));
      confettiCtx.save();
      confettiCtx.globalAlpha = twinkle;
      confettiCtx.fillStyle = '#ffffff';
      drawStar(confettiCtx, star.x, star.y, star.size);
      confettiCtx.restore();
    }

    const gravity = 0.22;
    particles = particles.filter((p) => p.life > 0 && p.y < h + 40);
    for (const p of particles) {
      p.vy += gravity * (dt / 16.7);
      p.x += p.vx * (dt / 16.7);
      p.y += p.vy * (dt / 16.7);
      p.rotation += p.vr * (dt / 16.7);
      p.life -= p.decay * (dt / 16.7);
      confettiCtx.save();
      confettiCtx.globalAlpha = Math.max(0, p.life);
      confettiCtx.translate(p.x, p.y);
      confettiCtx.rotate(p.rotation);
      confettiCtx.fillStyle = p.color;
      if (p.shape === 'rect') {
        confettiCtx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
      } else {
        confettiCtx.beginPath();
        confettiCtx.arc(0, 0, p.size / 2, 0, Math.PI * 2);
        confettiCtx.fill();
      }
      confettiCtx.restore();
    }

    rafId = requestAnimationFrame(tick);
  }
  rafId = requestAnimationFrame(tick);

  function dismiss() {
    if (disposed) return;
    disposed = true;
    window.clearTimeout(t1);
    window.clearTimeout(t2);
    cancelAnimationFrame(rafId);
    resizeObserver.disconnect();
    overlay.remove();
  }

  overlay.addEventListener('pointerdown', () => {
    dismiss();
    onDismiss();
  });

  return dismiss;
}

function drawStar(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number) {
  ctx.beginPath();
  for (let i = 0; i < 4; i++) {
    const angle = (Math.PI / 2) * i;
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(angle) * r * 2, cy + Math.sin(angle) * r * 2);
  }
  ctx.lineWidth = Math.max(1, r * 0.4);
  ctx.strokeStyle = ctx.fillStyle as string;
  ctx.stroke();
}
