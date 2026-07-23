import { loadCatalog, imageUrl, imageFiles } from './catalog';
import { rasterizeSvg } from './engine/raster';
import { findNearestFree, MaskCanvasCache, computeAllRegions, matchFrameRegions, RegionInfo } from './engine/floodfill';
import {
  StrokeDrawer,
  PALETTE,
  STICKER_EMOJIS,
  BRUSH_SIZES,
  MARKER_ALPHA,
  MASK_DILATE_RADIUS,
  ToolId,
  ModeId,
  SizeId,
  Point,
} from './engine/tools';
import {
  cloneOp,
  decimatePoints,
  FillOp,
  opHomeRegionId,
  PaintOp,
  resolveStickerPos,
  StickerOp,
  stickerOffsetFromPoint,
  StrokeOp,
  transformOp,
} from './engine/ops';
import { applyMaskToScratch, drawOp, replayOps } from './engine/opRenderer';
import { HistoryEntry, HistoryStack } from './engine/history';
import { getWork, saveWork, Work } from './store';
import { showCelebration } from './celebrate';
import { showReplay } from './replay';
import { t, MessageKey } from './i18n';

const TOOL_ICONS: Record<ToolId, string> = { fill: '🪣', brush: '🖍️', marker: '🖊️', eraser: '🧽', sticker: '🌟' };
const TOOL_TITLES: Record<ToolId, MessageKey> = {
  fill: 'toolFill',
  brush: 'toolBrush',
  marker: 'toolMarker',
  eraser: 'toolEraser',
  sticker: 'toolSticker',
};
/** Sticker emoji font size (internal-resolution px) at scale = 1. */
const BASE_STICKER_PX = 90;
const STICKER_MIN_SCALE = 0.4;
const STICKER_MAX_SCALE = 3;
/** Hit-test / draw radius (internal px) of the delete and scale handles shown on a selected sticker. */
const STICKER_HANDLE_R = 26;
const SIZE_DOT_PX: Record<SizeId, number> = { small: 10, medium: 18, large: 28 };
const SIZE_TITLES: Record<SizeId, MessageKey> = { small: 'sizeSmall', medium: 'sizeMedium', large: 'sizeLarge' };
const MIN_ZOOM = 1;
const MAX_ZOOM = 8;
const PAN_MARGIN = 60;

function clamp(v: number, min: number, max: number): number {
  return Math.min(Math.max(v, min), max);
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
    /** Always-derivable render cache: the result of replaying `ops` (plus, for frame 2, the
     * mirrored non-overridden slice of frame 1's ops - see `rebuildFrame2Canvas`) in order.
     * Never itself the source of truth - see the file-level doc comment on why. */
    paintCanvas: HTMLCanvasElement;
    paintCtx: CanvasRenderingContext2D;
    history: HistoryStack;
    /** One-shot full region labeling of this frame's (static) barrier map - stable ids, used for
     * frame1<->frame2 region matching and for "which region did the child override" bookkeeping.
     * Region lookup is a plain `regions[idMap[y*W+x]]` array index - flood-fill/dilation only
     * ever runs once, here, at mount (see `computeAllRegions`). */
    idMap: Int32Array;
    regions: RegionInfo[];
    /** Lazy LRU cache of rasterized region mask canvases (`destination-in` stroke clipping) -
     * never re-floods, only rasterizes masks already computed. */
    maskCanvases: MaskCanvasCache;
    /** Frame-2 only: stable region ids the child has directly repainted there - stop mirroring frame 1. */
    overriddenRegionIds: Set<number>;
    /**
     * This frame's own paint operations, in commit order - the SOURCE OF TRUTH for everything
     * painted here (fills, strokes, stickers, all interleaved in one chronological list, since
     * undo/redo doesn't care which tool made a change, just the order it happened in). Frame 2
     * only ever gets ops here for regions it directly diverged on (`overriddenRegionIds`) -
     * everything else is mirrored live from frame 1's `ops` at render time, never copied in.
     */
    ops: PaintOp[];
  }

  function makePaintFrame(frameLineCanvas: HTMLCanvasElement, frameBarrier: Uint8Array): PaintFrame {
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const { idMap, regions } = computeAllRegions(frameBarrier, W, H, MASK_DILATE_RADIUS);
    return {
      lineCanvas: frameLineCanvas,
      barrier: frameBarrier,
      paintCanvas: canvas,
      paintCtx: canvas.getContext('2d', { willReadFrequently: true })!,
      history: new HistoryStack(),
      idMap,
      regions,
      maskCanvases: new MaskCanvasCache(W, H, 2),
      overriddenRegionIds: new Set<number>(),
      ops: [],
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

  // ---------------- Frame-2 live sync (two-frame images) ----------------
  // Frame 2 is a set of regions that continuously mirror frame 1, except
  // regions the child has explicitly repainted on frame 2 (those diverge and
  // stop mirroring - see `overriddenRegionIds`). Matching a frame-2 region to
  // its frame-1 counterpart is NOT raw pixel coordinates, since frame 2's
  // line art is slightly different (a limb moved a little) - a pixel-for-
  // pixel copy would misalign by exactly that amount. The actual matching
  // algorithm (centroid-distance shortlist + mask-overlap confirmation, see
  // its own doc comment for why overlap - not just centroid distance - is
  // needed) lives in `matchFrameRegions` in engine/floodfill.ts, so it can be
  // unit-tested as a pure function of `RegionInfo[]`.
  const matchStart = performance.now();
  const { regionMatch, reverseMatch } = multiPaint
    ? matchFrameRegions(paintFrames[0].regions, paintFrames[1].regions, W, H)
    : { regionMatch: new Map<number, number | null>(), reverseMatch: new Map<number, number[]>() };
  if (multiPaint) {
    console.debug(
      `[editor] frame region matching: ${paintFrames[0].regions.length} x ${paintFrames[1].regions.length} regions in ${(performance.now() - matchStart).toFixed(1)}ms`
    );
  }

  const scratchCanvas = document.createElement('canvas');
  scratchCanvas.width = W;
  scratchCanvas.height = H;
  const scratchCtx = scratchCanvas.getContext('2d')!;
  // A second scratch canvas dedicated to op REPLAY (mount-time seeding, undo/redo, frame-2
  // mirror rebuilds) - kept separate from `scratchCanvas` above (which is reserved for the
  // live in-progress stroke preview `render()` reads every animation frame) purely so the two
  // concerns can never interleave/clobber each other, even though in practice replay always
  // runs to completion synchronously within one user-triggered call, never mid-gesture.
  const replayScratchCanvas = document.createElement('canvas');
  replayScratchCanvas.width = W;
  replayScratchCanvas.height = H;
  const replayScratchCtx = replayScratchCanvas.getContext('2d')!;

  // `buildFrame1MirrorOpsForFrame2` below is a pure function of two things:
  // `paintFrames[0].ops` and `paintFrames[1].overriddenRegionIds`. Naively
  // recomputing it on every call was fine at mount time, but it's also called
  // (via `effectiveStickerOps`) from `renderStickers()` inside `render()`'s
  // per-frame `dirty` path - so while frame 2 is being actively painted,
  // `dirty` goes true on every pointer-move sample during a stroke drag, and
  // this O(frame1.ops.length) recomputation was re-running dozens of times a
  // second for a drag that never touches frame 1 at all. These two version
  // counters are bumped ONLY where the two inputs above actually mutate
  // (never on every call), so the cache below is a hit on every render during
  // an unrelated frame-2 drag, and only a miss right after frame 1 itself
  // changes or a frame-2 region newly diverges.
  let frame1OpsVersion = 0;
  let frame2OverrideVersion = 0;
  let frame1MirrorCache: { opsVer: number; overrideVer: number; ops: PaintOp[] } | null = null;

  /**
   * Frame 1's own ops, transformed into frame 2's coordinate frame wherever a
   * match exists and the target region hasn't diverged - the live half of
   * "frame 2 mirrors frame 1, except where overridden." Pure derivation from
   * `paintFrames[0].ops` + `reverseMatch` (see `engine/floodfill.ts`) +
   * `transformOp` (see `engine/ops.ts`); never stored on the ops themselves,
   * but cached here (see `frame1OpsVersion`/`frame2OverrideVersion` above)
   * since it's recomputed far more often than its real inputs change.
   */
  function buildFrame1MirrorOpsForFrame2(): PaintOp[] {
    if (
      frame1MirrorCache &&
      frame1MirrorCache.opsVer === frame1OpsVersion &&
      frame1MirrorCache.overrideVer === frame2OverrideVersion
    ) {
      return frame1MirrorCache.ops;
    }
    const frame1 = paintFrames[0];
    const frame2 = paintFrames[1];
    const mirrored: PaintOp[] = [];
    for (const op of frame1.ops) {
      const homeRegionId = opHomeRegionId(op);
      if (homeRegionId == null) continue; // nothing to anchor a transform to - never mirrored
      const r1 = frame1.regions[homeRegionId];
      if (!r1) continue;
      const targets = reverseMatch.get(homeRegionId);
      if (!targets) continue;
      for (const r2id of targets) {
        if (frame2.overriddenRegionIds.has(r2id)) continue;
        const r2 = frame2.regions[r2id];
        if (!r2) continue;
        mirrored.push(transformOp(op, r1, r2));
      }
    }
    frame1MirrorCache = { opsVer: frame1OpsVersion, overrideVer: frame2OverrideVersion, ops: mirrored };
    return mirrored;
  }

  /** Every sticker op currently effective on `frameIndex` - own ops always, plus (frame 2 only)
   * whatever mirrors in from frame 1 for non-overridden regions. Stickers never touch the paint
   * raster (see engine/opRenderer.ts's doc comment) so this - not a canvas rebuild - is the only
   * thing that needs recomputing when frame 1's stickers change; render() picks it up next frame. */
  function effectiveStickerOps(frameIndex: 0 | 1): StickerOp[] {
    const own = stickerOps(paintFrames[frameIndex]);
    if (frameIndex === 0 || !multiPaint) return own;
    const mirrored = buildFrame1MirrorOpsForFrame2().filter((op): op is StickerOp => op.kind === 'sticker');
    return [...mirrored, ...own];
  }

  function stickerOps(frame: PaintFrame): StickerOp[] {
    return frame.ops.filter((op): op is StickerOp => op.kind === 'sticker');
  }

  /** Rebuilds frame 1's paint canvas from scratch by replaying its own ops - always correct,
   * used for mount-time seeding and undo/redo (never for routine live painting, which appends
   * just the new op directly onto the existing canvas for speed - see commitStroke/doFill). */
  function rebuildFrame1Canvas() {
    replayOps(paintFrames[0].paintCtx, paintFrames[0], replayScratchCanvas, replayScratchCtx, W, H, paintFrames[0].ops);
  }

  /** Rebuilds frame 2's paint canvas: mirrored (transformed, non-overridden) frame-1 ops first,
   * then frame 2's own ops on top - simplest correct ordering given the two are not really one
   * chronological timeline (mirrored content updates continuously as frame 1 changes; frame 2's
   * own edits are the child's deliberate, more recent overrides, so they always win visually). */
  function rebuildFrame2Canvas() {
    if (!multiPaint) return;
    const frame2 = paintFrames[1];
    const ops = [...buildFrame1MirrorOpsForFrame2(), ...frame2.ops];
    replayOps(frame2.paintCtx, frame2, replayScratchCanvas, replayScratchCtx, W, H, ops);
  }

  function rebuildFrameCanvas(index: 0 | 1) {
    if (index === 0) rebuildFrame1Canvas();
    else rebuildFrame2Canvas();
  }

  /**
   * Mirrors JUST ONE newly-committed frame-1 op onto frame 2's EXISTING paint
   * canvas - no clear, no replay of the rest of history - for the common case
   * of a single fill/stroke landing on frame 1 while viewing/painting frame 1
   * (see commitStroke/doFill). `rebuildFrame2Canvas` (full clear + replay)
   * stays reserved for the cases that genuinely need it: mount-time seeding,
   * undo/redo (an arbitrary jump in history, not one new op), and restoring a
   * saved `Work`.
   *
   * This is correct, not just faster, because:
   * - a fill op's mask coverage is total, so drawing a new fill mirror on top
   *   of whatever was there before (an older mirrored fill, or nothing)
   *   produces the same pixels a full replay would;
   * - a stroke op (including the eraser, via destination-out) composites onto
   *   whatever is already on the canvas, in commit order - since frame 2's
   *   canvas already correctly reflects every prior op (this function's own
   *   invariant, maintained incrementally call by call), drawing just the new
   *   one on top reproduces exactly what a full ordered replay would;
   * - `overriddenRegionIds` never changes as a *side effect* of a frame-1 op
   *   landing on frame 2 - it only changes via direct edits ON frame 2
   *   (commitStroke/doFill/handleStickerPointerDown/ensureOwnSticker, all
   *   guarded by `activeFrame === 1`/`frameIndex === 1`), so which regions are
   *   mirrored-vs-overridden can never shift out from under this function.
   */
  function mirrorNewFrame1OpToFrame2(op: PaintOp) {
    if (!multiPaint) return;
    const frame1 = paintFrames[0];
    const frame2 = paintFrames[1];
    const homeRegionId = opHomeRegionId(op);
    if (homeRegionId == null) return;
    const r1 = frame1.regions[homeRegionId];
    if (!r1) return;
    const targets = reverseMatch.get(homeRegionId);
    if (!targets) return;
    for (const r2id of targets) {
      if (frame2.overriddenRegionIds.has(r2id)) continue;
      const r2 = frame2.regions[r2id];
      if (!r2) continue;
      drawOp(frame2.paintCtx, frame2, replayScratchCanvas, replayScratchCtx, W, H, transformOp(op, r1, r2));
    }
  }

  /** A deep-enough-to-be-safe snapshot of a frame's current ops, for pushing onto its
   * `HistoryStack` - see `cloneOp`'s doc comment for why this can't just be the live array. */
  function snapshotOps(frame: PaintFrame): PaintOp[] {
    return frame.ops.map(cloneOp);
  }

  /** Full `HistoryEntry` snapshot for `frame` - `ops` always, plus (frame 2 only, index 1) its
   * current `overriddenRegionIds` so undo/redo can restore both in lockstep - see
   * `engine/history.ts`'s doc comment on why the two can never be snapshotted separately. */
  function snapshotHistoryEntry(frame: PaintFrame, frameIndex: 0 | 1): HistoryEntry {
    return {
      ops: snapshotOps(frame),
      overriddenRegionIds: frameIndex === 1 ? Array.from(frame.overriddenRegionIds) : undefined,
    };
  }

  const existing = requestedWorkId ? await getWork(requestedWorkId) : undefined;
  if (existing?.ops1) paintFrames[0].ops = existing.ops1.map(cloneOp);
  frame1OpsVersion++;
  rebuildFrame1Canvas();
  paintFrames[0].history.init(snapshotHistoryEntry(paintFrames[0], 0));
  if (multiPaint) {
    if (existing?.frame2OverriddenRegionIds) {
      paintFrames[1].overriddenRegionIds = new Set(existing.frame2OverriddenRegionIds);
      frame2OverrideVersion++;
    }
    if (existing?.ops2) paintFrames[1].ops = existing.ops2.map(cloneOp);
    // Seeds frame 2 the first time (no ops2 yet -> every matched region mirrors frame 1) and
    // also catches up any non-overridden regions if the saved ops2 predate later frame-1 edits
    // from a previous session. Diverged (overridden) regions keep their own restored ops.
    rebuildFrame2Canvas();
    paintFrames[1].history.init(snapshotHistoryEntry(paintFrames[1], 1));
  }

  // Mutable aliases for the ACTIVE frame - every stroke/fill/undo/render
  // path below reads these, so switching frames is a plain reassignment.
  let activeFrame: 0 | 1 = 0;
  let paintCanvas = paintFrames[0].paintCanvas;
  let paintCtx = paintFrames[0].paintCtx;
  let history = paintFrames[0].history;
  let maskCanvases = paintFrames[0].maskCanvases;
  let barrier = paintFrames[0].barrier;
  let idMap = paintFrames[0].idMap;
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
          <div class="group" data-role="frameToggle" hidden>
            <button class="btn round" data-frame="0" title="${t('frame1')}">1️⃣</button>
            <button class="btn round" data-frame="1" title="${t('frame2')}">2️⃣</button>
          </div>
          <button class="btn round" data-action="celebrate" title="${t('celebrate')}">🎉</button>
          <button class="btn round" data-action="replay" title="${t('replay')}">📼</button>
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
  const replayBtn = el.querySelector('[data-action="replay"]') as HTMLButtonElement;
  const frameToggleGroup = el.querySelector('[data-role="frameToggle"]') as HTMLElement;
  const frameButtons = {
    0: el.querySelector('[data-frame="0"]') as HTMLButtonElement,
    1: el.querySelector('[data-frame="1"]') as HTMLButtonElement,
  };
  const toolsRow = el.querySelector('[data-role="tools"]') as HTMLElement;
  const paletteRow = el.querySelector('[data-role="palette"]') as HTMLElement;

  // Declared ahead of the render loop below: `setTool` (called immediately
  // once tool state/buttons are wired up, below) already needs to mark a
  // frame dirty when leaving the sticker tool.
  let dirty = true;
  let disposed = false;

  // ---------------- Tool state ----------------
  let tool: ToolId = 'brush';
  let mode: ModeId = 'inside';
  let size: SizeId = 'medium';
  let color = '#ff0000';
  /** Fill tool only: when true, `doFill` paints a glitter fill (tinted `color`) instead of a flat one. */
  let glitterActive = false;
  /** Sticker tool: which emoji the next placed sticker uses. */
  let stickerEmoji = STICKER_EMOJIS[0];
  /** Sticker tool: id of the sticker currently showing its delete/scale handles, if any. */
  let selectedStickerId: string | null = null;
  /** Sticker tool: an in-progress move or scale drag on the selected sticker, if any. */
  let stickerDrag: { id: string; pointerId: number; mode: 'move' | 'scale' } | null = null;

  const toolButtons = {} as Record<ToolId, HTMLButtonElement>;
  (['fill', 'brush', 'marker', 'eraser', 'sticker'] as ToolId[]).forEach((toolId) => {
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

  // Palette row hosts two mutually-exclusive groups, toggled by setTool:
  // the color swatches (+ the glitter toggle) for paint tools, and the
  // sticker emoji picker for the sticker tool.
  const colorGroup = document.createElement('div');
  colorGroup.className = 'palette-group';
  paletteRow.appendChild(colorGroup);
  const stickerGroup = document.createElement('div');
  stickerGroup.className = 'palette-group';
  stickerGroup.hidden = true;
  paletteRow.appendChild(stickerGroup);

  const glitterBtn = document.createElement('button');
  glitterBtn.className = 'swatch glitter-swatch';
  glitterBtn.textContent = '✨';
  glitterBtn.title = t('fillGlitter');
  glitterBtn.addEventListener('click', () => (glitterActive ? setColor(color) : setGlitterActive()));
  colorGroup.appendChild(glitterBtn);

  const colorButtons: HTMLButtonElement[] = [];
  PALETTE.forEach((hex) => {
    const b = document.createElement('button');
    b.className = 'swatch';
    b.style.background = hex;
    b.title = hex;
    b.addEventListener('click', () => setColor(hex));
    colorGroup.appendChild(b);
    colorButtons.push(b);
  });

  const stickerButtons: HTMLButtonElement[] = [];
  STICKER_EMOJIS.forEach((emoji) => {
    const b = document.createElement('button');
    b.className = 'swatch emoji-swatch';
    b.textContent = emoji;
    b.title = emoji;
    b.addEventListener('click', () => setStickerEmoji(emoji));
    stickerGroup.appendChild(b);
    stickerButtons.push(b);
  });

  function setTool(t: ToolId) {
    tool = t;
    (Object.keys(toolButtons) as ToolId[]).forEach((k) => toolButtons[k].classList.toggle('active', k === t));
    colorGroup.hidden = t === 'sticker';
    stickerGroup.hidden = t !== 'sticker';
    if (t !== 'sticker') {
      selectedStickerId = null;
      stickerDrag = null;
      dirty = true;
    }
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
    glitterActive = false;
    glitterBtn.classList.remove('active');
    PALETTE.forEach((h, i) => colorButtons[i].classList.toggle('active', h === hex));
  }
  function setGlitterActive() {
    glitterActive = true;
    glitterBtn.classList.add('active');
    colorButtons.forEach((b) => b.classList.remove('active'));
  }
  function setStickerEmoji(emoji: string) {
    stickerEmoji = emoji;
    STICKER_EMOJIS.forEach((e, i) => stickerButtons[i].classList.toggle('active', e === emoji));
  }

  setTool('brush');
  setSize('medium');
  setMode('inside');
  setColor(color);
  setStickerEmoji(stickerEmoji);

  // ---------------- Undo / redo / autosave ----------------
  // Restoring a snapshot is now a synchronous ops-array copy + canvas replay
  // (no blob decode) - unlike the old raster-blob history, there's no async
  // gap for new input to race, so no restoreInFlight guard is needed here.
  function updateUndoRedoButtons() {
    undoBtn.disabled = !history.canUndo();
    redoBtn.disabled = !history.canRedo();
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
    cctx.save();
    cctx.translate(dx, dy);
    cctx.scale(s, s);
    drawStickersOnto(cctx, 0);
    cctx.restore();
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
    drawStickersOnto(cctx, activeFrame);
    return c;
  }
  async function compositeFull(): Promise<Blob> {
    return canvasToBlob(compositeFullCanvas());
  }
  async function doAutosave() {
    const thumbBlob = await compositeThumb(256);
    const work: Work = {
      workId,
      imageId,
      updatedAt: Date.now(),
      thumbBlob,
      ops1: paintFrames[0].ops.map(cloneOp),
    };
    if (multiPaint) {
      work.ops2 = paintFrames[1].ops.map(cloneOp);
      work.frame2OverriddenRegionIds = Array.from(paintFrames[1].overriddenRegionIds);
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
  // (`dirty`/`disposed` are declared earlier, alongside tool state - see above)

  /**
   * Draws every sticker effective on `frameIndex` (own ops, plus - for frame
   * 2 - whatever mirrors in from frame 1's non-overridden regions, see
   * `effectiveStickerOps`) onto `targetCtx`, in the frame's internal
   * (unscaled) pixel space - like a sticker stuck onto the page, no selection
   * UI. Reusable for any 2D context, not just the live display one: the
   * gallery thumbnail, the 📤 export/share PNG, and the 🎉 celebrate
   * animation/GIF all call this too, so stickers show up everywhere the
   * paint layer does, not just in the live editor.
   */
  function drawStickersOnto(targetCtx: CanvasRenderingContext2D, frameIndex: 0 | 1) {
    const regions = paintFrames[frameIndex].regions;
    for (const s of effectiveStickerOps(frameIndex)) {
      const region = regions[s.regionId];
      if (!region) continue;
      const pos = resolveStickerPos(region, s);
      const px = BASE_STICKER_PX * s.scale;
      targetCtx.save();
      targetCtx.font = `${px}px sans-serif`;
      targetCtx.textAlign = 'center';
      targetCtx.textBaseline = 'middle';
      targetCtx.fillText(s.emoji, pos.x, pos.y);
      targetCtx.restore();
    }
  }

  /**
   * Draws the active frame's stickers on top of the line art (via
   * `drawStickersOnto`), plus - only while the sticker tool is active - a
   * selection ring and delete/scale handles on the selected one. Runs in the
   * same already-transformed (internal-pixel) coordinate space as the rest
   * of render(), so stickers zoom/pan along with the artwork.
   */
  function renderStickers() {
    drawStickersOnto(ctx, activeFrame);
    if (tool !== 'sticker' || !selectedStickerId) return;
    const s = effectiveStickerOps(activeFrame).find((st) => st.id === selectedStickerId);
    if (!s) return;
    const region = paintFrames[activeFrame].regions[s.regionId];
    if (!region) return;
    const pos = resolveStickerPos(region, s);
    const r = stickerRadius(s);
    ctx.save();
    ctx.setLineDash([6, 6]);
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#2f6fed';
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, r + 8, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();

    const delPos = { x: pos.x + r * 0.75, y: pos.y - r * 0.75 };
    const scalePos = { x: pos.x + r * 0.75, y: pos.y + r * 0.75 };
    for (const [handlePos, glyph] of [
      [delPos, '✖️'],
      [scalePos, '↔️'],
    ] as const) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(handlePos.x, handlePos.y, STICKER_HANDLE_R, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#2f6fed';
      ctx.stroke();
      ctx.font = `${STICKER_HANDLE_R}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#000000';
      ctx.fillText(glyph, handlePos.x, handlePos.y);
      ctx.restore();
    }
  }

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
      renderStickers();
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
    /** Clip mask for 'inside' mode; null in 'free' mode (nothing clipped). */
    region: RegionInfo | null;
    /** Half-linewidth + margin used to inflate `bbox` around every point added to the stroke. */
    pad: number;
    /** Bounding box (canvas pixel space) of everything the stroke has drawn so far - see
     * commitStroke, which scans just this area to find every region the stroke touched. */
    bbox: { minX: number; minY: number; maxX: number; maxY: number };
    /** Every raw point the stroke has been extended with so far (undecimated, for a smooth live
     * preview) - stored (then decimated) into the committed StrokeOp, see commitStroke. */
    points: Point[];
    /** The region this stroke is anchored to for frame-1<->frame-2 mirroring, independent of
     * clip mode - see `StrokeOp.anchorRegionId`'s doc comment in engine/ops.ts. */
    anchorRegionId: number | null;
  }
  let activeStroke: ActiveStroke | null = null;
  const activePointers = new Map<number, Point>();

  function cancelActiveStroke() {
    if (activeStroke) {
      scratchCtx.clearRect(0, 0, W, H);
      activeStroke = null;
      dirty = true;
    }
  }

  /** A deep-enough clone of the active frame's state, pushed to its `HistoryStack` -
   * synchronous, since ops are plain data (no blob encode to await, unlike the old
   * raster-blob history). Includes `overriddenRegionIds` for frame 2 - see
   * `snapshotHistoryEntry`/`engine/history.ts` for why the two must move together. */
  function snapshotToHistory() {
    history.push(snapshotHistoryEntry(paintFrames[activeFrame], activeFrame));
    updateUndoRedoButtons();
  }

  /**
   * Undo/redo: pop/push the active frame's `HistoryStack` and rebuild that
   * frame's canvas by replaying the restored ops (see `rebuildFrameCanvas`) -
   * fully synchronous (no blob decode), unlike the old raster-blob history.
   * For frame 2, also rolls `overriddenRegionIds` back to its snapshotted
   * value in lockstep with `ops` (see `engine/history.ts`'s `HistoryEntry`
   * doc comment) - otherwise a region a stroke/fill/sticker just diverged
   * would stay stuck "overridden" (and therefore blank, since nothing mirrors
   * into it and its own op was just undone) even after the op that diverged
   * it is undone.
   */
  function restoreFromHistory(direction: 'undo' | 'redo') {
    const targetFrame = activeFrame;
    const frame = paintFrames[targetFrame];
    const snapshot = direction === 'undo' ? frame.history.undo() : frame.history.redo();
    if (!snapshot) return;
    frame.ops = snapshot.ops.map(cloneOp);
    if (targetFrame === 0) frame1OpsVersion++;
    if (targetFrame === 1) {
      frame.overriddenRegionIds = new Set(snapshot.overriddenRegionIds ?? []);
      frame2OverrideVersion++;
    }
    rebuildFrameCanvas(targetFrame);
    if (selectedStickerId && !frame.ops.some((op) => op.kind === 'sticker' && op.id === selectedStickerId)) {
      selectedStickerId = null;
    }
    if (multiPaint && targetFrame === 0) rebuildFrame2Canvas();
    updateUndoRedoButtons();
    scheduleAutosave();
    dirty = true;
  }

  function commitStroke() {
    if (!activeStroke) return;
    const frame = paintFrames[activeFrame];
    const { bbox } = activeStroke;
    const bx0 = Math.max(0, Math.floor(bbox.minX));
    const by0 = Math.max(0, Math.floor(bbox.minY));
    const bx1 = Math.min(W - 1, Math.ceil(bbox.maxX));
    const by1 = Math.min(H - 1, Math.ceil(bbox.maxY));
    // Scan just the stroke's own bounding box (not the whole canvas) over the
    // scratch layer - i.e. exactly the pixels this stroke drew, independent
    // of tool (an eraser's scratch alpha still marks its own path, even
    // though it composites via destination-out) - to collect EVERY region id
    // the stroke actually touched, not just the one under its start point.
    // Used only for frame-2 override bookkeeping below - the op's own single
    // `anchorRegionId` (computed at stroke start) is what frame-1 mirroring
    // transforms against.
    const touchedRegionIds = new Set<number>();
    if (bx1 >= bx0 && by1 >= by0) {
      const bw = bx1 - bx0 + 1;
      const bh = by1 - by0 + 1;
      const scratchData = scratchCtx.getImageData(bx0, by0, bw, bh).data;
      for (let ry = 0; ry < bh; ry++) {
        const gy = by0 + ry;
        const rowBase = gy * W;
        for (let rx = 0; rx < bw; rx++) {
          const li = (ry * bw + rx) * 4;
          if (scratchData[li + 3] === 0) continue;
          const regionId = idMap[rowBase + (bx0 + rx)];
          if (regionId >= 0) touchedRegionIds.add(regionId);
        }
      }
    }

    // Live-draw exactly like before: composite the scratch layer (already
    // holding this stroke's real, undecimated pixels) straight onto the
    // paint canvas. The committed op below stores decimated points for
    // replay/mirroring/undo purposes - it is NOT re-rendered here, so
    // decimation can never visibly change what the child just drew.
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

    const op: StrokeOp = {
      kind: 'stroke',
      id: randomWorkSuffix(),
      tool: activeStroke.tool as 'brush' | 'marker' | 'eraser',
      color,
      size,
      mode,
      points: decimatePoints(activeStroke.points),
      anchorRegionId: activeStroke.anchorRegionId,
    };
    frame.ops.push(op);
    if (activeFrame === 0) frame1OpsVersion++;

    if (activeFrame === 1) {
      if (touchedRegionIds.size > 0) frame2OverrideVersion++;
      for (const rid of touchedRegionIds) paintFrames[1].overriddenRegionIds.add(rid);
    }
    if (multiPaint && activeFrame === 0) mirrorNewFrame1OpToFrame2(op);
    snapshotToHistory();
    scheduleAutosave();
    dirty = true;
  }

  function doFill(x: number, y: number) {
    if (barrier[y * W + x]) return;
    const regionId = idMap[y * W + x];
    if (regionId < 0) return;
    const frame = paintFrames[activeFrame];
    const op: FillOp = { kind: 'fill', id: randomWorkSuffix(), regionId, color, glitter: glitterActive };
    frame.ops.push(op);
    if (activeFrame === 0) frame1OpsVersion++;
    drawOp(paintCtx, frame, scratchCanvas, scratchCtx, W, H, op);
    if (activeFrame === 1) {
      paintFrames[1].overriddenRegionIds.add(regionId);
      frame2OverrideVersion++;
    }
    if (multiPaint && activeFrame === 0) mirrorNewFrame1OpToFrame2(op);
    snapshotToHistory();
    scheduleAutosave();
    dirty = true;
  }

  // ---------------- Stickers ----------------
  // Stickers are just another op kind (StickerOp, see engine/ops.ts) - never
  // drawn onto the paint raster, always resolved live from the frame's op
  // list (own ops, plus - for frame 2 - whatever mirrors in from frame 1, see
  // `effectiveStickerOps`), so there is no separate "stickers array" to keep
  // in sync with anything.
  function stickerRadius(s: StickerOp): number {
    return (BASE_STICKER_PX * s.scale) / 2;
  }
  /** Hit-tests every sticker EFFECTIVE on `frameIndex` (own + mirrored), so the child can tap
   * any visible sticker regardless of whether it originated on this frame or frame 1. */
  function stickerAt(frameIndex: 0 | 1, px: number, py: number): StickerOp | null {
    const regions = paintFrames[frameIndex].regions;
    const list = effectiveStickerOps(frameIndex);
    for (let i = list.length - 1; i >= 0; i--) {
      const s = list[i];
      const region = regions[s.regionId];
      if (!region) continue;
      const pos = resolveStickerPos(region, s);
      if (Math.hypot(px - pos.x, py - pos.y) <= stickerRadius(s)) return s;
    }
    return null;
  }
  /**
   * Ensures `s` (found via `stickerAt`, so it may currently only exist as a
   * mirrored copy of a frame-1 sticker) has its own real `StickerOp` in
   * `frame.ops` before it's mutated/deleted directly - promoting a mirrored
   * sticker into a real, persisted, overridden one the first time the child
   * interacts with it on frame 2. A no-op when `s` is already a frame-1
   * sticker (frame index 0) or already frame 2's own (already in frame.ops).
   */
  function ensureOwnSticker(frameIndex: 0 | 1, s: StickerOp): StickerOp {
    const frame = paintFrames[frameIndex];
    const existing = frame.ops.find((op): op is StickerOp => op.kind === 'sticker' && op.id === s.id);
    if (existing) return existing;
    const own: StickerOp = { ...s };
    frame.ops.push(own);
    if (frameIndex === 0) frame1OpsVersion++;
    if (frameIndex === 1) {
      frame.overriddenRegionIds.add(own.regionId);
      frame2OverrideVersion++;
    }
    return own;
  }
  function deleteSticker(frameIndex: 0 | 1, s: StickerOp) {
    const owned = ensureOwnSticker(frameIndex, s);
    const frame = paintFrames[frameIndex];
    frame.ops = frame.ops.filter((op) => !(op.kind === 'sticker' && op.id === owned.id));
    if (frameIndex === 0) frame1OpsVersion++;
    if (selectedStickerId === owned.id) selectedStickerId = null;
    snapshotToHistory();
    scheduleAutosave();
    dirty = true;
  }

  /**
   * Sticker-tool tap handling: hit-tests the selected sticker's delete/scale
   * handles first, then any sticker (selecting + starting a move-drag), and
   * finally places a brand-new sticker if the tap landed inside a region.
   */
  function handleStickerPointerDown(ix: number, iy: number, pointerId: number, p: Point) {
    if (selectedStickerId) {
      const sel = effectiveStickerOps(activeFrame).find((s) => s.id === selectedStickerId);
      if (sel) {
        const region = paintFrames[activeFrame].regions[sel.regionId];
        if (region) {
          const pos = resolveStickerPos(region, sel);
          const r = stickerRadius(sel);
          const delPos = { x: pos.x + r * 0.75, y: pos.y - r * 0.75 };
          const scalePos = { x: pos.x + r * 0.75, y: pos.y + r * 0.75 };
          if (Math.hypot(p.x - delPos.x, p.y - delPos.y) <= STICKER_HANDLE_R) {
            deleteSticker(activeFrame, sel);
            return;
          }
          if (Math.hypot(p.x - scalePos.x, p.y - scalePos.y) <= STICKER_HANDLE_R) {
            const owned = ensureOwnSticker(activeFrame, sel);
            selectedStickerId = owned.id;
            stickerDrag = { id: owned.id, pointerId, mode: 'scale' };
            return;
          }
        }
      }
    }
    const hit = stickerAt(activeFrame, p.x, p.y);
    if (hit) {
      const owned = ensureOwnSticker(activeFrame, hit);
      selectedStickerId = owned.id;
      stickerDrag = { id: owned.id, pointerId, mode: 'move' };
      dirty = true;
      return;
    }
    const regionId = idMap[iy * W + ix];
    if (regionId < 0) {
      selectedStickerId = null;
      dirty = true;
      return;
    }
    const frame = paintFrames[activeFrame];
    const region = frame.regions[regionId];
    const s: StickerOp = {
      kind: 'sticker',
      id: randomWorkSuffix(),
      regionId,
      emoji: stickerEmoji,
      ...stickerOffsetFromPoint(region, p),
      scale: 1,
    };
    frame.ops.push(s);
    if (activeFrame === 0) frame1OpsVersion++;
    selectedStickerId = s.id;
    if (activeFrame === 1) {
      frame.overriddenRegionIds.add(regionId);
      frame2OverrideVersion++;
    }
    snapshotToHistory();
    scheduleAutosave();
    dirty = true;
  }

  // ---- Undo/redo/export/home wiring ----
  undoBtn.addEventListener('click', () => {
    restoreFromHistory('undo');
  });
  redoBtn.addEventListener('click', () => {
    restoreFromHistory('redo');
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
  let dismissReplay: (() => void) | null = null;
  celebrateBtn.addEventListener('click', () => {
    dismissCelebration?.();
    dismissReplay?.();
    // Frame 2's own coloring is included only for two-frame images; single-
    // frame images share frame 1's paint across all celebrate frames. Each
    // layer is a fresh composite of that frame's paint + its stickers drawn
    // on top - celebrate.ts itself stays unaware stickers exist, it just
    // gets plain canvases like before.
    const frameIndicesToCelebrate: (0 | 1)[] = multiPaint ? [0, 1] : [0];
    const paintLayers = frameIndicesToCelebrate.map((index) => {
      const c = document.createElement('canvas');
      c.width = W;
      c.height = H;
      const cctx = c.getContext('2d')!;
      cctx.drawImage(paintFrames[index].paintCanvas, 0, 0);
      drawStickersOnto(cctx, index);
      return c;
    });
    dismissCelebration = showCelebration(
      el,
      { width: W, height: H, paintLayers, lineLayers, imageId },
      () => {
        dismissCelebration = null;
      }
    );
  });

  // Replays the ACTIVE frame's own history sequence (consistent with how the
  // frame toggle scopes undo/redo to one frame at a time) - not a merged
  // replay across both frames of a two-frame image.
  replayBtn.addEventListener('click', () => {
    dismissCelebration?.();
    dismissReplay?.();
    const frame = paintFrames[activeFrame];
    dismissReplay = showReplay(
      el,
      { width: W, height: H, ops: frame.ops, target: frame, lineCanvas: frame.lineCanvas },
      () => {
        dismissReplay = null;
      }
    );
  });

  // ---------------- Per-frame painting (two-frame images) ----------------
  function updateFrameButtons() {
    frameToggleGroup.hidden = !multiPaint;
    if (!multiPaint) return;
    (frameButtons[0]).classList.toggle('active', activeFrame === 0);
    (frameButtons[1]).classList.toggle('active', activeFrame === 1);
    frameButtons[0].disabled = activeFrame === 0;
    frameButtons[1].disabled = activeFrame === 1;
  }

  function setActiveFrame(index: 0 | 1) {
    if (!multiPaint || index === activeFrame) return;
    cancelActiveStroke();
    selectedStickerId = null;
    stickerDrag = null;
    const frame = paintFrames[index];
    activeFrame = index;
    paintCanvas = frame.paintCanvas;
    paintCtx = frame.paintCtx;
    history = frame.history;
    maskCanvases = frame.maskCanvases;
    barrier = frame.barrier;
    idMap = frame.idMap;
    activeLineCanvas = frame.lineCanvas;
    updateFrameButtons();
    updateUndoRedoButtons();
    dirty = true; // zoom/pan intentionally preserved
  }

  frameButtons[0].addEventListener('click', () => setActiveFrame(0));
  frameButtons[1].addEventListener('click', () => setActiveFrame(1));

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
      stickerDrag = null;
      panDragging = false;
      beginPinch();
      return;
    }

    if (e.button === 1 || spacePressed) {
      beginPanDrag(e);
      return;
    }

    if (e.button !== 0) return;
    // Rapid tap-filling adjacent regions, or rapid tapping to select/place
    // stickers, must not trigger the double-tap zoom reset (there's an
    // explicit reset-view button instead).
    if (tool !== 'fill' && tool !== 'sticker' && handleDoubleTap(e)) return;

    const p = screenToInternal(e.clientX, e.clientY);
    const ix = Math.round(p.x);
    const iy = Math.round(p.y);
    if (ix < 0 || iy < 0 || ix >= W || iy >= H) return;

    if (tool === 'sticker') {
      handleStickerPointerDown(ix, iy, e.pointerId, p);
      return;
    }

    if (tool === 'fill') {
      doFill(ix, iy);
      return;
    }

    let startX = ix;
    let startY = iy;
    let region: RegionInfo | null = null;
    if (mode === 'inside') {
      if (barrier[iy * W + ix]) {
        const nearest = findNearestFree(barrier, W, H, ix, iy, 6);
        if (!nearest) return; // no free pixel nearby - ignore the stroke
        startX = nearest.x;
        startY = nearest.y;
      }
      const startRegionId = idMap[startY * W + startX];
      region = startRegionId >= 0 ? paintFrames[activeFrame].regions[startRegionId] : null;
      if (!region) return;
    }
    // The stroke's "home" region for frame-1<->frame-2 mirroring purposes, independent of clip
    // mode: 'inside' mode already resolved `region` above; 'free' mode leaves it null (nothing
    // clips), but the stroke can still be anchored to whatever region is at/near its start point
    // (falling back to the nearest free pixel's region if the start landed right on a line).
    let anchorRegionId: number | null = region ? region.id : null;
    if (anchorRegionId == null) {
      const idAtStart = idMap[startY * W + startX];
      if (idAtStart >= 0) {
        anchorRegionId = idAtStart;
      } else {
        const nearest = findNearestFree(barrier, W, H, startX, startY, 6);
        if (nearest) {
          const nearestId = idMap[nearest.y * W + nearest.x];
          anchorRegionId = nearestId >= 0 ? nearestId : null;
        }
      }
    }

    scratchCtx.clearRect(0, 0, W, H);
    scratchCtx.globalCompositeOperation = 'source-over';
    scratchCtx.globalAlpha = 1;
    const lineWidth = BRUSH_SIZES[size];
    const drawColor = tool === 'eraser' ? '#000000' : color;
    const drawer = new StrokeDrawer(scratchCtx, lineWidth, drawColor);
    const startPoint = { x: startX, y: startY };
    drawer.begin(startPoint);
    if (region) applyMaskToScratch(scratchCtx, maskCanvases, region);
    // bbox tracks (inflated by half the stroke's line width + a small margin)
    // everything the stroke has drawn so far - commitStroke scans just this
    // rectangle, not the whole canvas, to find which regions the stroke
    // actually touched (Phase 2: every region a stroke crosses, not just the
    // one under its start point).
    const pad = lineWidth / 2 + 4;
    activeStroke = {
      tool,
      drawer,
      pointerId: e.pointerId,
      region,
      pad,
      bbox: { minX: startX - pad, minY: startY - pad, maxX: startX + pad, maxY: startY + pad },
      points: [startPoint],
      anchorRegionId,
    };
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
    if (stickerDrag && stickerDrag.pointerId === e.pointerId) {
      const frame = paintFrames[activeFrame];
      const s = frame.ops.find((op): op is StickerOp => op.kind === 'sticker' && op.id === stickerDrag!.id);
      const region = s ? frame.regions[s.regionId] : null;
      if (s && region) {
        const p = screenToInternal(e.clientX, e.clientY);
        if (stickerDrag.mode === 'move') {
          Object.assign(s, stickerOffsetFromPoint(region, p));
        } else {
          const pos = resolveStickerPos(region, s);
          const dist = Math.hypot(p.x - pos.x, p.y - pos.y);
          s.scale = clamp(dist / (BASE_STICKER_PX * 0.5), STICKER_MIN_SCALE, STICKER_MAX_SCALE);
        }
      }
      dirty = true;
      return;
    }
    if (!activeStroke || activeStroke.pointerId !== e.pointerId) return;
    const p = screenToInternal(e.clientX, e.clientY);
    activeStroke.drawer.extend(p);
    activeStroke.points.push(p);
    if (activeStroke.region) applyMaskToScratch(scratchCtx, maskCanvases, activeStroke.region);
    const { bbox, pad } = activeStroke;
    bbox.minX = Math.min(bbox.minX, p.x - pad);
    bbox.minY = Math.min(bbox.minY, p.y - pad);
    bbox.maxX = Math.max(bbox.maxX, p.x + pad);
    bbox.maxY = Math.max(bbox.maxY, p.y + pad);
    dirty = true;
  }

  function endPointer(e: PointerEvent) {
    activePointers.delete(e.pointerId);
    if (activePointers.size < 2) pinchStart = null;
    if (panDragging && e.pointerId === panPointerId) {
      panDragging = false;
      panPointerId = null;
    }
    if (stickerDrag && stickerDrag.pointerId === e.pointerId) {
      const frame = paintFrames[activeFrame];
      const s = frame.ops.find((op): op is StickerOp => op.kind === 'sticker' && op.id === stickerDrag!.id);
      if (s) {
        // Already promoted to an own, overridden op at drag-start (see ensureOwnSticker) -
        // just commit the drag's final position/scale to history. The sticker itself was
        // mutated in place during the drag (onPointerMove, above) rather than re-pushed, so
        // this is the one point that must bump frame1OpsVersion for a frame-1 sticker drag -
        // otherwise `buildFrame1MirrorOpsForFrame2`'s cache would keep serving the position the
        // sticker had before this drag once frame 2 is next viewed.
        if (activeFrame === 0) frame1OpsVersion++;
        snapshotToHistory();
      }
      stickerDrag = null;
      scheduleAutosave();
      dirty = true;
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
    dismissReplay?.();
    dismissReplay = null;
  }

  return dispose;
}
