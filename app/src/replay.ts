/**
 * Full-screen "watch how it was painted" overlay: replays a frame's own
 * `PaintOp[]` in commit order, each prefix rendered under the frame's static
 * line-art layer (same UNDER-the-lines layering `render()` uses for
 * paintCanvas). A different feature from celebrate.ts (which animates a
 * *finished* picture) - this shows the *progression* that built it up - but
 * it reuses the same overlay/stage visual language.
 *
 * Each step is "apply the next op" - literally `replayOps` (the same replay
 * function used for undo/redo and frame-2 mirror rebuilds) fed a growing
 * prefix of the op list, not a stored raster snapshot. Sticker ops are
 * skipped when building the step sequence (they never touch the paint
 * raster - a separate always-on-top layer, out of scope for replay, same as
 * before this file moved off raster-blob history).
 *
 * Playback is a simple autoplay loop (pace tuned for "watch it get colored
 * in", slower than celebrate's boil/blink cycling): step through every op
 * once, pause on the final (fully painted) frame, then restart. A play/pause
 * button, a restart button and a row of tappable step dots are provided for
 * whoever's actually driving (more likely a grown-up watching over a kid's
 * shoulder than the kid), on top of the minimum tap-to-dismiss.
 */

import type { PaintOp } from './engine/ops';
import { OpRenderTarget, replayOps } from './engine/opRenderer';

const STEP_MS = 450; // per-op advance while autoplaying - slower than celebrate's cycling, this is "watch paint happen"
const END_PAUSE_MS = 1400; // extra dwell on the final, fully-painted frame before looping

export interface ReplaySource {
  width: number;
  height: number;
  /** The frame's full op list, in commit order (see PaintFrame.ops in editor.ts). */
  ops: readonly PaintOp[];
  /** This frame's regions + mask-canvas cache, needed to replay fill/stroke ops. */
  target: OpRenderTarget;
  /** The frame's static line-art layer, drawn on top of every replayed step. */
  lineCanvas: HTMLCanvasElement;
}

/**
 * Shows the replay overlay inside `container`. Returns a dispose function;
 * also self-dismisses on background tap (calling `onDismiss`), matching
 * celebrate's contract.
 */
export function showReplay(container: HTMLElement, source: ReplaySource, onDismiss: () => void): () => void {
  // Sticker ops never touch the paint raster (see engine/opRenderer.ts) - replay only steps
  // through the ops that actually change what's visible on the paint canvas.
  const paintOps = source.ops.filter((op) => op.kind !== 'sticker');

  const overlay = document.createElement('div');
  overlay.className = 'replay-overlay';

  const stage = document.createElement('div');
  stage.className = 'replay-stage';
  const artCanvas = document.createElement('canvas');
  artCanvas.className = 'replay-art';
  artCanvas.width = source.width;
  artCanvas.height = source.height;
  stage.appendChild(artCanvas);
  overlay.appendChild(stage);

  const dots = document.createElement('div');
  dots.className = 'replay-dots';
  const dotButtons: HTMLButtonElement[] = [];
  // A dot per step is only meaningful for a handful of steps; a freshly
  // opened, never-painted picture has exactly one step (the blank state) -
  // still renders fine as a single dot, no special-casing needed.
  for (let i = 0; i <= paintOps.length; i++) {
    const d = document.createElement('button');
    d.className = 'replay-dot';
    d.type = 'button';
    d.addEventListener('click', () => {
      playing = false;
      updatePlayButton();
      goTo(i);
    });
    dots.appendChild(d);
    dotButtons.push(d);
  }

  const actions = document.createElement('div');
  actions.className = 'replay-actions';
  const restartBtn = document.createElement('button');
  restartBtn.className = 'btn round';
  restartBtn.type = 'button';
  restartBtn.textContent = '⏮️';
  const playBtn = document.createElement('button');
  playBtn.className = 'btn round';
  playBtn.type = 'button';
  const closeBtn = document.createElement('button');
  closeBtn.className = 'btn round';
  closeBtn.type = 'button';
  closeBtn.textContent = '✖️';
  actions.appendChild(restartBtn);
  actions.appendChild(playBtn);
  actions.appendChild(closeBtn);
  overlay.appendChild(dots);
  overlay.appendChild(actions);
  // Dots/buttons live inside the tap-to-dismiss overlay - don't let taps on
  // them bubble to it (same pattern as celebrate's .celebrate-actions).
  dots.addEventListener('pointerdown', (e) => e.stopPropagation());
  dots.addEventListener('click', (e) => e.stopPropagation());
  actions.addEventListener('pointerdown', (e) => e.stopPropagation());
  actions.addEventListener('click', (e) => e.stopPropagation());

  container.appendChild(overlay);

  const artCtx = artCanvas.getContext('2d')!;
  // A dedicated paint-replay canvas, separate from artCanvas: replayOps clears+redraws it from
  // scratch each step, then this composites under the white page background and on top of the
  // line art onto artCanvas (mirrors the main editor's paintCanvas/displayCanvas split).
  const paintReplayCanvas = document.createElement('canvas');
  paintReplayCanvas.width = source.width;
  paintReplayCanvas.height = source.height;
  const paintReplayCtx = paintReplayCanvas.getContext('2d', { willReadFrequently: true })!;
  const scratchCanvas = document.createElement('canvas');
  scratchCanvas.width = source.width;
  scratchCanvas.height = source.height;
  const scratchCtx = scratchCanvas.getContext('2d')!;

  const lastIndex = paintOps.length;
  let index = 0;
  let playing = lastIndex > 0;
  let disposed = false;
  let rafId = 0;
  let lastStep = performance.now();

  function updatePlayButton() {
    playBtn.textContent = playing ? '⏸️' : '▶️';
  }
  updatePlayButton();

  function updateDots() {
    dotButtons.forEach((b, i) => b.classList.toggle('active', i === index));
  }

  function drawIndex(i: number) {
    index = i;
    replayOps(paintReplayCtx, source.target, scratchCanvas, scratchCtx, source.width, source.height, paintOps.slice(0, i));
    artCtx.clearRect(0, 0, source.width, source.height);
    artCtx.fillStyle = '#ffffff';
    artCtx.fillRect(0, 0, source.width, source.height);
    artCtx.drawImage(paintReplayCanvas, 0, 0);
    artCtx.drawImage(source.lineCanvas, 0, 0);
    updateDots();
  }

  function goTo(i: number) {
    lastStep = performance.now();
    drawIndex(clampIndex(i));
  }

  function clampIndex(i: number): number {
    return Math.min(lastIndex, Math.max(0, i));
  }

  goTo(0);

  restartBtn.addEventListener('click', () => {
    playing = lastIndex > 0;
    updatePlayButton();
    goTo(0);
  });
  playBtn.addEventListener('click', () => {
    playing = !playing;
    updatePlayButton();
    if (playing && index >= lastIndex) goTo(0); // resuming from the end restarts the loop
    else lastStep = performance.now();
  });

  function tick(now: number) {
    if (disposed) return;
    if (playing && lastIndex > 0) {
      const dwell = index >= lastIndex ? END_PAUSE_MS : STEP_MS;
      if (now - lastStep >= dwell) {
        lastStep = now;
        goTo(index >= lastIndex ? 0 : index + 1);
      }
    }
    rafId = requestAnimationFrame(tick);
  }
  rafId = requestAnimationFrame(tick);

  function dismiss() {
    if (disposed) return;
    disposed = true;
    cancelAnimationFrame(rafId);
    overlay.remove();
  }

  overlay.addEventListener('pointerdown', () => {
    dismiss();
    onDismiss();
  });
  closeBtn.addEventListener('click', () => {
    dismiss();
    onDismiss();
  });

  return dismiss;
}
