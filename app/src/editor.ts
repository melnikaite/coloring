import { loadCatalog, imageUrl, imageFiles } from './catalog';
import { rasterizeSvg } from './engine/raster';
import { findNearestFree, RegionCache, Region } from './engine/floodfill';
import { StrokeDrawer, PALETTE, BRUSH_SIZES, MARKER_ALPHA, MASK_DILATE_RADIUS, ToolId, ModeId, SizeId, Point } from './engine/tools';
import { HistoryStack } from './engine/history';
import { getWork, saveWork, Work } from './store';
import { showCelebration } from './celebrate';
import { t, MessageKey } from './i18n';

const TOOL_ICONS: Record<ToolId, string> = { fill: '🪣', brush: '🖍️', marker: '🖊️', eraser: '🧽' };
const TOOL_TITLES: Record<ToolId, MessageKey> = {
  fill: 'toolFill',
  brush: 'toolBrush',
  marker: 'toolMarker',
  eraser: 'toolEraser',
};
const SIZE_DOT_PX: Record<SizeId, number> = { small: 10, medium: 18, large: 28 };
const SIZE_TITLES: Record<SizeId, MessageKey> = { small: 'sizeSmall', medium: 'sizeMedium', large: 'sizeLarge' };
const MIN_ZOOM = 1;
const MAX_ZOOM = 8;
const PAN_MARGIN = 60;

function clamp(v: number, min: number, max: number): number {
  return Math.min(Math.max(v, min), max);
}

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/**
 * Unique suffix for new work ids. crypto.randomUUID is secure-context-only,
 * so over plain http (e.g. LAN testing on a phone) fall back to
 * getRandomValues — opening a picture must never crash on it.
 */
function randomWorkSuffix(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c?.randomUUID) return c.randomUUID();
  const bytes = new Uint8Array(16);
  if (c?.getRandomValues) c.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/png');
  });
}

async function drawBlobToCanvas(blob: Blob, ctx: CanvasRenderingContext2D, w: number, h: number) {
  const bitmap = await createImageBitmap(blob);
  ctx.clearRect(0, 0, w, h);
  ctx.drawImage(bitmap, 0, 0, w, h);
}

/**
 * Mounts the paint editor screen. `requestedWorkId` selects which saved work
 * to resume; null starts a brand-new blank work. Returns a dispose function
 * the router must call before unmounting.
 */
export async function mountEditor(
  root: HTMLElement,
  imageId: string,
  requestedWorkId: string | null,
  goBack: () => void
): Promise<() => void> {
  root.innerHTML = '<div class="editor" style="display:flex;align-items:center;justify-content:center;font-size:56px;">⏳</div>';

  const catalog = await loadCatalog();
  const meta = catalog.images.find((i) => i.id === imageId);
  if (!meta) {
    goBack();
    return () => {};
  }

  const workId = requestedWorkId ?? `${imageId}-${randomWorkSuffix()}`;
  if (!requestedWorkId) {
    // Pin the new work's id into the URL (no hashchange fires for
    // replaceState) so a mid-painting reload resumes THIS work instead of
    // forking yet another blank one. Back/forward keep working normally.
    window.history.replaceState(null, '', `#/paint/${encodeURIComponent(imageId)}?w=${encodeURIComponent(workId)}`);
  }

  // Frame 0 (= meta.file) is the primary drawing. Two-frame images get a
  // second, independently paintable frame: its own paint canvas, history,
  // barrier map and region cache built from frame 2's line raster (regions
  // differ where the body part moved). Single-frame images are unchanged.
  const frameFiles = imageFiles(meta);
  const raster = await rasterizeSvg(imageUrl(frameFiles[0]));
  const { width: W, height: H } = raster;

  interface PaintFrame {
    lineCanvas: HTMLCanvasElement;
    barrier: Uint8Array;
    paintCanvas: HTMLCanvasElement;
    paintCtx: CanvasRenderingContext2D;
    history: HistoryStack;
    regionCache: RegionCache;
    /** True once the paint canvas has a meaningful state (restored or auto-copied) and history is seeded. */
    initialized: boolean;
  }

  function makePaintFrame(frameLineCanvas: HTMLCanvasElement, frameBarrier: Uint8Array): PaintFrame {
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    return {
      lineCanvas: frameLineCanvas,
      barrier: frameBarrier,
      paintCanvas: canvas,
      paintCtx: canvas.getContext('2d', { willReadFrequently: true })!,
      history: new HistoryStack(25),
      regionCache: new RegionCache(frameBarrier, W, H, MASK_DILATE_RADIUS),
      initialized: false,
    };
  }

  const paintFrames: PaintFrame[] = [makePaintFrame(raster.lineCanvas, raster.barrier)];
  const lineLayers: HTMLCanvasElement[] = [raster.lineCanvas];
  for (const frameFile of frameFiles.slice(1)) {
    try {
      const frameRaster = await rasterizeSvg(imageUrl(frameFile));
      if (frameRaster.width === W && frameRaster.height === H) {
        lineLayers.push(frameRaster.lineCanvas);
        // Per-frame painting supports exactly two frames; further frames
        // (none exist in the catalog today) stay celebrate-only.
        if (paintFrames.length < 2) {
          paintFrames.push(makePaintFrame(frameRaster.lineCanvas, frameRaster.barrier));
        }
      } else {
        // Mismatched viewBox - rescale for celebrate, but painting on this
        // frame is unsupported (its barrier map wouldn't align).
        const scaled = document.createElement('canvas');
        scaled.width = W;
        scaled.height = H;
        scaled.getContext('2d')!.drawImage(frameRaster.lineCanvas, 0, 0, W, H);
        lineLayers.push(scaled);
      }
    } catch {
      // A missing/broken extra frame must never block painting - skip it.
    }
  }
  const multiPaint = paintFrames.length > 1;

  const scratchCanvas = document.createElement('canvas');
  scratchCanvas.width = W;
  scratchCanvas.height = H;
  const scratchCtx = scratchCanvas.getContext('2d')!;

  const existing = requestedWorkId ? await getWork(requestedWorkId) : undefined;
  if (existing) {
    try {
      await drawBlobToCanvas(existing.paintBlob, paintFrames[0].paintCtx, W, H);
    } catch {
      // corrupt/old save - start blank
    }
  }
  paintFrames[0].history.init(await canvasToBlob(paintFrames[0].paintCanvas));
  paintFrames[0].initialized = true;
  if (multiPaint && existing?.paintBlob2) {
    try {
      await drawBlobToCanvas(existing.paintBlob2, paintFrames[1].paintCtx, W, H);
      paintFrames[1].history.init(await canvasToBlob(paintFrames[1].paintCanvas));
      paintFrames[1].initialized = true;
    } catch {
      // corrupt frame-2 save - it will be auto-copied from frame 1 on first switch
    }
  }

  // Mutable aliases for the ACTIVE frame - every stroke/fill/undo/render
  // path below reads these, so switching frames is a plain reassignment.
  let activeFrame: 0 | 1 = 0;
  let paintCanvas = paintFrames[0].paintCanvas;
  let paintCtx = paintFrames[0].paintCtx;
  let history = paintFrames[0].history;
  let regionCache = paintFrames[0].regionCache;
  let barrier = paintFrames[0].barrier;
  let activeLineCanvas = paintFrames[0].lineCanvas;

  root.innerHTML = `
    <div class="editor">
      <canvas class="display"></canvas>
      <div class="editor-top">
        <div class="group">
          <button class="btn round" data-action="home" title="${t('home')}">🏠</button>
          <button class="btn round" data-action="resetview" title="${t('resetView')}" hidden>⛶</button>
        </div>
        <div class="group">
          <button class="btn round" data-action="undo" title="${t('undo')}" disabled>🔙</button>
          <button class="btn round" data-action="redo" title="${t('redo')}" disabled>🔜</button>
          <button class="btn round" data-action="frame" hidden>2️⃣</button>
          <button class="btn round" data-action="copyframe" title="${t('copyColors')}" hidden>📋</button>
          <button class="btn round" data-action="celebrate" title="${t('celebrate')}">🎉</button>
          <button class="btn round" data-action="export" title="${t('shareImage')}">📤</button>
        </div>
      </div>
      <div class="editor-bottom">
        <div class="toolbar-row" data-role="tools"></div>
        <div class="toolbar-row" data-role="palette"></div>
      </div>
    </div>
  `;

  const el = root.querySelector('.editor') as HTMLElement;
  const displayCanvas = el.querySelector('canvas.display') as HTMLCanvasElement;
  const ctx = displayCanvas.getContext('2d')!;
  const homeBtn = el.querySelector('[data-action="home"]') as HTMLButtonElement;
  const resetViewBtn = el.querySelector('[data-action="resetview"]') as HTMLButtonElement;
  const undoBtn = el.querySelector('[data-action="undo"]') as HTMLButtonElement;
  const redoBtn = el.querySelector('[data-action="redo"]') as HTMLButtonElement;
  const exportBtn = el.querySelector('[data-action="export"]') as HTMLButtonElement;
  const celebrateBtn = el.querySelector('[data-action="celebrate"]') as HTMLButtonElement;
  const frameBtn = el.querySelector('[data-action="frame"]') as HTMLButtonElement;
  const copyFrameBtn = el.querySelector('[data-action="copyframe"]') as HTMLButtonElement;
  const toolsRow = el.querySelector('[data-role="tools"]') as HTMLElement;
  const paletteRow = el.querySelector('[data-role="palette"]') as HTMLElement;

  // ---------------- Tool state ----------------
  let tool: ToolId = 'brush';
  let mode: ModeId = 'inside';
  let size: SizeId = 'medium';
  let color = '#ff0000';

  const toolButtons = {} as Record<ToolId, HTMLButtonElement>;
  (['fill', 'brush', 'marker', 'eraser'] as ToolId[]).forEach((toolId) => {
    const b = document.createElement('button');
    b.className = 'btn';
    b.textContent = TOOL_ICONS[toolId];
    b.title = t(TOOL_TITLES[toolId]);
    b.addEventListener('click', () => setTool(toolId));
    toolsRow.appendChild(b);
    toolButtons[toolId] = b;
  });

  const sizeButtons = {} as Record<SizeId, HTMLButtonElement>;
  (['small', 'medium', 'large'] as SizeId[]).forEach((sizeId) => {
    const b = document.createElement('button');
    b.className = 'btn';
    const dot = document.createElement('span');
    dot.className = 'size-dot';
    const px = SIZE_DOT_PX[sizeId];
    dot.style.width = `${px}px`;
    dot.style.height = `${px}px`;
    b.appendChild(dot);
    b.title = t(SIZE_TITLES[sizeId]);
    b.addEventListener('click', () => setSize(sizeId));
    toolsRow.appendChild(b);
    sizeButtons[sizeId] = b;
  });

  const modeBtn = document.createElement('button');
  modeBtn.className = 'btn';
  modeBtn.title = t('modeToggle');
  modeBtn.addEventListener('click', () => setMode(mode === 'inside' ? 'free' : 'inside'));
  toolsRow.appendChild(modeBtn);

  const colorButtons: HTMLButtonElement[] = [];
  PALETTE.forEach((hex) => {
    const b = document.createElement('button');
    b.className = 'swatch';
    b.style.background = hex;
    b.title = hex;
    b.addEventListener('click', () => setColor(hex));
    paletteRow.appendChild(b);
    colorButtons.push(b);
  });

  function setTool(t: ToolId) {
    tool = t;
    (Object.keys(toolButtons) as ToolId[]).forEach((k) => toolButtons[k].classList.toggle('active', k === t));
  }
  function setSize(s: SizeId) {
    size = s;
    (Object.keys(sizeButtons) as SizeId[]).forEach((k) => sizeButtons[k].classList.toggle('active', k === s));
  }
  function setMode(m: ModeId) {
    mode = m;
    modeBtn.textContent = m === 'inside' ? '🧲' : '🖌️';
    // Highlight = inside-lines clipping is ON (the magnet is "engaged").
    modeBtn.classList.toggle('active', m === 'inside');
  }
  function setColor(hex: string) {
    color = hex;
    PALETTE.forEach((h, i) => colorButtons[i].classList.toggle('active', h === hex));
  }

  setTool('brush');
  setSize('medium');
  setMode('inside');
  setColor(color);

  // ---------------- Undo / redo / autosave ----------------
  // While an undo/redo blob is being decoded back onto paintCanvas, new
  // stroke/fill input is ignored (decode takes a few dozen ms at most).
  let restoreInFlight = false;

  function updateUndoRedoButtons() {
    undoBtn.disabled = restoreInFlight || !history.canUndo();
    redoBtn.disabled = restoreInFlight || !history.canRedo();
  }
  updateUndoRedoButtons();

  let autosaveTimer: number | undefined;
  function scheduleAutosave() {
    if (autosaveTimer) window.clearTimeout(autosaveTimer);
    autosaveTimer = window.setTimeout(() => {
      void doAutosave();
    }, 800);
  }
  async function compositeThumb(sizePx: number): Promise<Blob> {
    const c = document.createElement('canvas');
    c.width = sizePx;
    c.height = sizePx;
    const cctx = c.getContext('2d')!;
    cctx.fillStyle = '#fff';
    cctx.fillRect(0, 0, sizePx, sizePx);
    const s = Math.min(sizePx / W, sizePx / H);
    const dw = W * s;
    const dh = H * s;
    const dx = (sizePx - dw) / 2;
    const dy = (sizePx - dh) / 2;
    // Thumbnail is always frame-1-based, regardless of the active frame.
    cctx.drawImage(paintFrames[0].paintCanvas, 0, 0, W, H, dx, dy, dw, dh);
    cctx.drawImage(paintFrames[0].lineCanvas, 0, 0, W, H, dx, dy, dw, dh);
    return canvasToBlob(c);
  }
  function compositeFullCanvas(): HTMLCanvasElement {
    // Exports the ACTIVE frame (what the child currently sees).
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    const cctx = c.getContext('2d')!;
    cctx.fillStyle = '#fff';
    cctx.fillRect(0, 0, W, H);
    cctx.drawImage(paintCanvas, 0, 0);
    cctx.drawImage(activeLineCanvas, 0, 0);
    return c;
  }
  async function compositeFull(): Promise<Blob> {
    return canvasToBlob(compositeFullCanvas());
  }
  async function doAutosave() {
    const [paintBlob, thumbBlob] = await Promise.all([
      canvasToBlob(paintFrames[0].paintCanvas),
      compositeThumb(256),
    ]);
    const work: Work = { workId, imageId, updatedAt: Date.now(), paintBlob, thumbBlob };
    if (multiPaint && paintFrames[1].initialized) {
      work.paintBlob2 = await canvasToBlob(paintFrames[1].paintCanvas);
    }
    await saveWork(work);
  }
  async function flushAutosave() {
    if (autosaveTimer) {
      window.clearTimeout(autosaveTimer);
      autosaveTimer = undefined;
    }
    await doAutosave();
  }

  // ---------------- Zoom / pan ----------------
  let zoom = 1;
  let pan: Point = { x: 0, y: 0 };
  let fitScale = 1;

  function computeFitScale(rect: DOMRect) {
    fitScale = Math.min(rect.width / W, rect.height / H) * 0.92;
  }

  function computeOffset(totalScale: number, panV: Point, rect: DOMRect): Point {
    return {
      x: rect.width / 2 - (W * totalScale) / 2 + panV.x,
      y: rect.height / 2 - (H * totalScale) / 2 + panV.y,
    };
  }

  function pointToPage(clientX: number, clientY: number, totalScale: number, panV: Point, rect: DOMRect): Point {
    const off = computeOffset(totalScale, panV, rect);
    return {
      x: (clientX - rect.left - off.x) / totalScale,
      y: (clientY - rect.top - off.y) / totalScale,
    };
  }

  function panForAnchor(anchor: Point, screenX: number, screenY: number, totalScale: number, rect: DOMRect): Point {
    const offX = screenX - rect.left - anchor.x * totalScale;
    const offY = screenY - rect.top - anchor.y * totalScale;
    return {
      x: offX - (rect.width / 2 - (W * totalScale) / 2),
      y: offY - (rect.height / 2 - (H * totalScale) / 2),
    };
  }

  function clampPanValue(panV: Point, totalScale: number, rect: DOMRect): Point {
    const off = computeOffset(totalScale, panV, rect);
    const minOffX = PAN_MARGIN - W * totalScale;
    const maxOffX = rect.width - PAN_MARGIN;
    const minOffY = PAN_MARGIN - H * totalScale;
    const maxOffY = rect.height - PAN_MARGIN;
    const offX = clamp(off.x, Math.min(minOffX, maxOffX), Math.max(minOffX, maxOffX));
    const offY = clamp(off.y, Math.min(minOffY, maxOffY), Math.max(minOffY, maxOffY));
    return {
      x: offX - (rect.width / 2 - (W * totalScale) / 2),
      y: offY - (rect.height / 2 - (H * totalScale) / 2),
    };
  }

  function screenToInternal(clientX: number, clientY: number): Point {
    const rect = displayCanvas.getBoundingClientRect();
    return pointToPage(clientX, clientY, fitScale * zoom, pan, rect);
  }

  // ---------------- Render loop ----------------
  let dirty = true;
  let disposed = false;

  function render() {
    if (disposed) return;
    if (dirty) {
      const rect = displayCanvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const neededW = Math.max(1, Math.round(rect.width * dpr));
      const neededH = Math.max(1, Math.round(rect.height * dpr));
      if (displayCanvas.width !== neededW || displayCanvas.height !== neededH) {
        displayCanvas.width = neededW;
        displayCanvas.height = neededH;
      }
      computeFitScale(rect);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, displayCanvas.width, displayCanvas.height);
      const totalScale = fitScale * zoom;
      const off = computeOffset(totalScale, pan, rect);
      ctx.setTransform(dpr * totalScale, 0, 0, dpr * totalScale, dpr * off.x, dpr * off.y);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, W, H);
      ctx.drawImage(paintCanvas, 0, 0);
      if (activeStroke) {
        ctx.save();
        if (activeStroke.tool === 'eraser') {
          // destination-out also cuts through the white paper fill above -
          // restore the paper underneath so the live preview doesn't show
          // the page background through the "hole".
          ctx.globalCompositeOperation = 'destination-out';
          ctx.drawImage(scratchCanvas, 0, 0);
          ctx.globalCompositeOperation = 'destination-over';
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, W, H);
        } else if (activeStroke.tool === 'marker') {
          ctx.globalAlpha = MARKER_ALPHA;
          ctx.drawImage(scratchCanvas, 0, 0);
        } else {
          ctx.drawImage(scratchCanvas, 0, 0);
        }
        ctx.restore();
      }
      ctx.drawImage(activeLineCanvas, 0, 0);
      resetViewBtn.hidden = zoom === 1 && pan.x === 0 && pan.y === 0;
      dirty = false;
    }
    requestAnimationFrame(render);
  }
  requestAnimationFrame(render);

  const resizeObserver = new ResizeObserver(() => {
    dirty = true;
  });
  resizeObserver.observe(el);

  // ---------------- Stroke / gesture state ----------------
  interface ActiveStroke {
    tool: ToolId;
    drawer: StrokeDrawer;
    pointerId: number;
    region: Region | null;
  }
  let activeStroke: ActiveStroke | null = null;
  const activePointers = new Map<number, Point>();

  function applyMaskToScratch(region: Region) {
    scratchCtx.globalCompositeOperation = 'destination-in';
    scratchCtx.drawImage(regionCache.getMaskCanvas(region), 0, 0);
    scratchCtx.globalCompositeOperation = 'source-over';
  }

  function cancelActiveStroke() {
    if (activeStroke) {
      scratchCtx.clearRect(0, 0, W, H);
      activeStroke = null;
      dirty = true;
    }
  }

  // History snapshots are compressed PNG blobs (see HistoryStack). toBlob
  // captures the canvas state at call time, and the chain keeps pushes in
  // commit order even if encodes resolve at different speeds.
  let snapshotChain: Promise<void> = Promise.resolve();
  function snapshotToHistory() {
    // Capture the ACTIVE frame's history now - the user may switch frames
    // before the encode resolves, and the snapshot belongs to this frame.
    const targetHistory = history;
    const blobPromise = canvasToBlob(paintCanvas);
    snapshotChain = snapshotChain
      .then(async () => {
        targetHistory.push(await blobPromise);
        updateUndoRedoButtons();
      })
      .catch(() => {
        // encoding failed (out of memory?) - drop this snapshot, keep the app alive
      });
  }

  async function restoreFromHistory(direction: 'undo' | 'redo') {
    if (restoreInFlight) return;
    // Capture the active frame's history + context: frame switches are
    // blocked while restoreInFlight, but be defensive anyway.
    const targetHistory = history;
    const targetCtx = paintCtx;
    const blob = direction === 'undo' ? targetHistory.undo() : targetHistory.redo();
    if (!blob) return;
    restoreInFlight = true;
    updateUndoRedoButtons();
    try {
      const bitmap = await createImageBitmap(blob);
      targetCtx.clearRect(0, 0, W, H);
      targetCtx.drawImage(bitmap, 0, 0, W, H);
    } finally {
      restoreInFlight = false;
    }
    updateUndoRedoButtons();
    scheduleAutosave();
    dirty = true;
  }

  function commitStroke() {
    if (!activeStroke) return;
    paintCtx.save();
    if (activeStroke.tool === 'eraser') {
      paintCtx.globalCompositeOperation = 'destination-out';
      paintCtx.drawImage(scratchCanvas, 0, 0);
    } else if (activeStroke.tool === 'marker') {
      paintCtx.globalAlpha = MARKER_ALPHA;
      paintCtx.drawImage(scratchCanvas, 0, 0);
    } else {
      paintCtx.drawImage(scratchCanvas, 0, 0);
    }
    paintCtx.restore();
    scratchCtx.clearRect(0, 0, W, H);
    snapshotToHistory();
    scheduleAutosave();
    dirty = true;
  }

  function doFill(x: number, y: number) {
    if (barrier[y * W + x]) return;
    const region = regionCache.getRegionAt(x, y);
    if (!region) return;
    const imageData = paintCtx.getImageData(0, 0, W, H);
    const d = imageData.data;
    const [r, g, b] = hexToRgb(color);
    const mask = region.mask;
    for (let p = 0; p < mask.length; p++) {
      if (mask[p]) {
        const i = p * 4;
        d[i] = r;
        d[i + 1] = g;
        d[i + 2] = b;
        d[i + 3] = 255;
      }
    }
    paintCtx.putImageData(imageData, 0, 0);
    snapshotToHistory();
    scheduleAutosave();
    dirty = true;
  }

  // ---- Undo/redo/export/home wiring ----
  undoBtn.addEventListener('click', () => {
    void restoreFromHistory('undo');
  });
  redoBtn.addEventListener('click', () => {
    void restoreFromHistory('redo');
  });
  homeBtn.addEventListener('click', () => {
    void flushAutosave().finally(() => goBack());
  });
  resetViewBtn.addEventListener('click', () => {
    zoom = 1;
    pan = { x: 0, y: 0 };
    dirty = true;
  });
  exportBtn.addEventListener('click', () => {
    void (async () => {
      const blob = await compositeFull();
      const file = new File([blob], `${imageId}.png`, { type: 'image/png' });
      const nav = navigator as Navigator & { canShare?: (data?: ShareData) => boolean };
      if (nav.canShare && nav.canShare({ files: [file] }) && navigator.share) {
        try {
          await navigator.share({ files: [file] });
        } catch {
          // user cancelled share sheet - not an error
        }
      } else {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${imageId}.png`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
      }
      showExportFlash();
    })();
  });

  let dismissCelebration: (() => void) | null = null;
  celebrateBtn.addEventListener('click', () => {
    dismissCelebration?.();
    // Frame 2's own coloring is included only once it exists; otherwise all
    // frames share frame 1's paint (classic behavior).
    const paintLayers =
      multiPaint && paintFrames[1].initialized
        ? [paintFrames[0].paintCanvas, paintFrames[1].paintCanvas]
        : [paintFrames[0].paintCanvas];
    dismissCelebration = showCelebration(
      el,
      { width: W, height: H, paintLayers, lineLayers, imageId },
      () => {
        dismissCelebration = null;
      }
    );
  });

  // ---------------- Per-frame painting (two-frame images) ----------------
  function updateFrameButtons() {
    frameBtn.hidden = !multiPaint;
    copyFrameBtn.hidden = !multiPaint || activeFrame !== 1;
    if (!multiPaint) return;
    // The button shows the frame you'd switch TO.
    frameBtn.textContent = activeFrame === 0 ? '2️⃣' : '1️⃣';
    frameBtn.title = t(activeFrame === 0 ? 'frame2' : 'frame1');
  }

  async function setActiveFrame(index: 0 | 1) {
    if (!multiPaint || index === activeFrame || restoreInFlight) return;
    cancelActiveStroke();
    const frame = paintFrames[index];
    if (!frame.initialized) {
      // First visit to frame 2: start from a copy of frame 1's colors so the
      // child only has to fix the moved part, not recolor everything.
      frame.paintCtx.drawImage(paintFrames[0].paintCanvas, 0, 0);
      frame.history.init(await canvasToBlob(frame.paintCanvas));
      frame.initialized = true;
      scheduleAutosave();
    }
    activeFrame = index;
    paintCanvas = frame.paintCanvas;
    paintCtx = frame.paintCtx;
    history = frame.history;
    regionCache = frame.regionCache;
    barrier = frame.barrier;
    activeLineCanvas = frame.lineCanvas;
    updateFrameButtons();
    updateUndoRedoButtons();
    dirty = true; // zoom/pan intentionally preserved
  }

  frameBtn.addEventListener('click', () => {
    void setActiveFrame(activeFrame === 0 ? 1 : 0);
  });

  copyFrameBtn.addEventListener('click', () => {
    if (activeFrame !== 1) return;
    confirmAction('📋❓', () => {
      // Replace frame 2's paint with frame 1's current colors. Pushed to
      // history, so it's still undoable despite the confirm.
      paintCtx.clearRect(0, 0, W, H);
      paintCtx.drawImage(paintFrames[0].paintCanvas, 0, 0);
      snapshotToHistory();
      scheduleAutosave();
      dirty = true;
    });
  });

  function confirmAction(emoji: string, onYes: () => void) {
    const overlay = document.createElement('div');
    overlay.className = 'overlay';
    overlay.innerHTML = `
      <div class="dialog">
        <div class="dialog-emoji">${emoji}</div>
        <div class="dialog-actions">
          <button class="btn round" data-a="no" title="${t('confirmNo')}">❌</button>
          <button class="btn round" data-a="yes" title="${t('confirmYes')}">✅</button>
        </div>
      </div>
    `;
    (overlay.querySelector('[data-a="no"]') as HTMLButtonElement).addEventListener('click', () => overlay.remove());
    (overlay.querySelector('[data-a="yes"]') as HTMLButtonElement).addEventListener('click', () => {
      overlay.remove();
      onYes();
    });
    el.appendChild(overlay);
  }

  updateFrameButtons();

  function showExportFlash() {
    const span = document.createElement('div');
    span.className = 'export-flash';
    span.textContent = '✅';
    el.appendChild(span);
    setTimeout(() => span.remove(), 900);
  }

  // ---------------- Pointer / gesture handling ----------------
  let spacePressed = false;
  function onKeyDown(e: KeyboardEvent) {
    if (e.code === 'Space') spacePressed = true;
  }
  function onKeyUp(e: KeyboardEvent) {
    if (e.code === 'Space') spacePressed = false;
  }
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);

  let panDragging = false;
  let panPointerId: number | null = null;
  let panStart: Point = { x: 0, y: 0 };
  let panStartPan: Point = { x: 0, y: 0 };

  function beginPanDrag(e: PointerEvent) {
    panDragging = true;
    panPointerId = e.pointerId;
    panStart = { x: e.clientX, y: e.clientY };
    panStartPan = { ...pan };
  }
  function updatePanDrag(e: PointerEvent) {
    const rect = displayCanvas.getBoundingClientRect();
    const totalScale = fitScale * zoom;
    const dx = e.clientX - panStart.x;
    const dy = e.clientY - panStart.y;
    pan = clampPanValue({ x: panStartPan.x + dx, y: panStartPan.y + dy }, totalScale, rect);
    dirty = true;
  }

  interface PinchState {
    dist: number;
    center: Point;
    zoom: number;
    pan: Point;
  }
  let pinchStart: PinchState | null = null;

  function pinchPoints(): Point[] {
    return Array.from(activePointers.values());
  }

  function beginPinch() {
    const pts = pinchPoints();
    if (pts.length < 2) return;
    const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
    const center = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
    pinchStart = { dist, center, zoom, pan: { ...pan } };
  }

  function updatePinch() {
    if (!pinchStart) {
      beginPinch();
      return;
    }
    const pts = pinchPoints();
    if (pts.length < 2) return;
    const rect = displayCanvas.getBoundingClientRect();
    const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
    const center = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
    const scaleFactor = pinchStart.dist > 0 ? dist / pinchStart.dist : 1;
    const totalScaleOld = fitScale * pinchStart.zoom;
    const anchor = pointToPage(pinchStart.center.x, pinchStart.center.y, totalScaleOld, pinchStart.pan, rect);
    const newZoom = clamp(pinchStart.zoom * scaleFactor, MIN_ZOOM, MAX_ZOOM);
    const totalScaleNew = fitScale * newZoom;
    const newPan = panForAnchor(anchor, center.x, center.y, totalScaleNew, rect);
    zoom = newZoom;
    pan = clampPanValue(newPan, totalScaleNew, rect);
    dirty = true;
  }

  let lastTap = { time: 0, x: 0, y: 0 };
  function handleDoubleTap(e: PointerEvent): boolean {
    const now = performance.now();
    const dx = e.clientX - lastTap.x;
    const dy = e.clientY - lastTap.y;
    const isDouble = now - lastTap.time < 300 && Math.hypot(dx, dy) < 30;
    if (isDouble) {
      zoom = 1;
      pan = { x: 0, y: 0 };
      dirty = true;
      lastTap = { time: 0, x: 0, y: 0 };
      return true;
    }
    lastTap = { time: now, x: e.clientX, y: e.clientY };
    return false;
  }

  function onPointerDown(e: PointerEvent) {
    // Belt-and-suspenders alongside touch-action:none: never let a paint
    // gesture turn into a browser scroll/zoom/pull-to-refresh on mobile.
    e.preventDefault();
    displayCanvas.setPointerCapture(e.pointerId);
    activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (activePointers.size >= 2) {
      cancelActiveStroke();
      panDragging = false;
      beginPinch();
      return;
    }

    if (e.button === 1 || spacePressed) {
      beginPanDrag(e);
      return;
    }

    if (e.button !== 0) return;
    // Rapid tap-filling adjacent regions must not trigger the double-tap
    // zoom reset (there's an explicit reset-view button instead).
    if (tool !== 'fill' && handleDoubleTap(e)) return;
    if (restoreInFlight) return; // undo/redo decode in progress - ignore new paint input

    const p = screenToInternal(e.clientX, e.clientY);
    const ix = Math.round(p.x);
    const iy = Math.round(p.y);
    if (ix < 0 || iy < 0 || ix >= W || iy >= H) return;

    if (tool === 'fill') {
      doFill(ix, iy);
      return;
    }

    let startX = ix;
    let startY = iy;
    let region: Region | null = null;
    if (mode === 'inside') {
      if (barrier[iy * W + ix]) {
        const nearest = findNearestFree(barrier, W, H, ix, iy, 6);
        if (!nearest) return; // no free pixel nearby - ignore the stroke
        startX = nearest.x;
        startY = nearest.y;
      }
      region = regionCache.getRegionAt(startX, startY);
      if (!region) return;
    }

    scratchCtx.clearRect(0, 0, W, H);
    scratchCtx.globalCompositeOperation = 'source-over';
    scratchCtx.globalAlpha = 1;
    const lineWidth = BRUSH_SIZES[size];
    const drawColor = tool === 'eraser' ? '#000000' : color;
    const drawer = new StrokeDrawer(scratchCtx, lineWidth, drawColor);
    drawer.begin({ x: startX, y: startY });
    if (region) applyMaskToScratch(region);
    activeStroke = { tool, drawer, pointerId: e.pointerId, region };
    dirty = true;
  }

  function onPointerMove(e: PointerEvent) {
    if (activePointers.size > 0) e.preventDefault();
    if (activePointers.has(e.pointerId)) {
      activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    }
    if (activePointers.size >= 2) {
      updatePinch();
      return;
    }
    if (panDragging && e.pointerId === panPointerId) {
      updatePanDrag(e);
      return;
    }
    if (!activeStroke || activeStroke.pointerId !== e.pointerId) return;
    const p = screenToInternal(e.clientX, e.clientY);
    activeStroke.drawer.extend(p);
    if (activeStroke.region) applyMaskToScratch(activeStroke.region);
    dirty = true;
  }

  function endPointer(e: PointerEvent) {
    activePointers.delete(e.pointerId);
    if (activePointers.size < 2) pinchStart = null;
    if (panDragging && e.pointerId === panPointerId) {
      panDragging = false;
      panPointerId = null;
    }
    if (activeStroke && activeStroke.pointerId === e.pointerId) {
      commitStroke();
      activeStroke = null;
    }
  }

  displayCanvas.addEventListener('pointerdown', onPointerDown);
  displayCanvas.addEventListener('pointermove', onPointerMove);
  displayCanvas.addEventListener('pointerup', endPointer);
  displayCanvas.addEventListener('pointercancel', endPointer);
  displayCanvas.addEventListener('contextmenu', (e) => e.preventDefault());

  function onWheel(e: WheelEvent) {
    e.preventDefault();
    const rect = displayCanvas.getBoundingClientRect();
    const totalScaleOld = fitScale * zoom;
    const anchor = pointToPage(e.clientX, e.clientY, totalScaleOld, pan, rect);
    const factor = Math.exp(-e.deltaY * 0.0015);
    const newZoom = clamp(zoom * factor, MIN_ZOOM, MAX_ZOOM);
    const totalScaleNew = fitScale * newZoom;
    const newPan = panForAnchor(anchor, e.clientX, e.clientY, totalScaleNew, rect);
    zoom = newZoom;
    pan = clampPanValue(newPan, totalScaleNew, rect);
    dirty = true;
  }
  displayCanvas.addEventListener('wheel', onWheel, { passive: false });

  function dispose() {
    disposed = true;
    resizeObserver.disconnect();
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
    if (autosaveTimer) {
      // A save is pending (e.g. browser Back button fired hashchange) -
      // flush it now, fire-and-forget, so the last stroke isn't lost.
      window.clearTimeout(autosaveTimer);
      autosaveTimer = undefined;
      void doAutosave();
    }
    dismissCelebration?.();
    dismissCelebration = null;
  }

  return dispose;
}
