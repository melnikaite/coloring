import type { PaintOp } from './ops';

/**
 * One frame's full undo/redo-relevant state at a point in time: its own ops,
 * plus - for frame 2 only - which region ids were overridden then (see
 * `PaintFrame.overriddenRegionIds` in editor.ts). Frame 2's overridden-region
 * bookkeeping is mutated in lockstep with its ops (a fill/stroke/sticker op
 * landing on frame 2 both pushes the op AND may add to the set), so it must
 * be snapshotted and restored in lockstep too, or undo would roll back the op
 * list while leaving a now-stale region id in the set - permanently blocking
 * that region from ever mirroring frame 1 again. Frame 1 has no override
 * concept, so its entries always omit the field.
 */
export interface HistoryEntry {
  ops: PaintOp[];
  overriddenRegionIds?: number[];
}

/**
 * Undo/redo stack of a frame's state snapshots. Each entry's `ops` is a full
 * `PaintOp[]` snapshot (the caller clones it via `cloneOp` before pushing -
 * see editor.ts's `snapshotOps` - so a later live mutation, e.g. dragging a
 * sticker, can never leak into an entry already on the stack).
 *
 * This replaced an earlier raster-blob-based version (`HistoryEntry{blob,
 * stickers, glitterRegions, strokeRegions}`) that stored a full PNG-encoded
 * canvas per undo step, capped at 25 entries specifically to bound that
 * memory cost, and needed an async blob-decode to restore. Ops are tiny by
 * comparison (a fill is a few bytes, a stroke is a short point list, a
 * sticker is a few numbers) - restoring is now a synchronous array-copy plus
 * a canvas replay, so there's no decode race to guard against and undo/redo
 * itself is not async here. Still capped, just much higher: unlimited would
 * be fine for ordinary painting, but a pathological session (thousands of
 * tiny dabs) should not grow memory forever.
 */
export class HistoryStack {
  private stack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];

  constructor(private cap = 200) {}

  /** Seeds the stack with the initial (usually blank) state. Clears redo. */
  init(entry: HistoryEntry) {
    this.stack = [entry];
    this.redoStack = [];
  }

  /** Records a new committed state. Call after each completed paint/sticker action. */
  push(entry: HistoryEntry) {
    this.stack.push(entry);
    if (this.stack.length > this.cap) this.stack.shift();
    this.redoStack = [];
  }

  canUndo(): boolean {
    return this.stack.length > 1;
  }

  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /** Returns the previous state to restore, or null if there is nothing to undo. */
  undo(): HistoryEntry | null {
    if (!this.canUndo()) return null;
    const current = this.stack.pop()!;
    this.redoStack.push(current);
    return this.stack[this.stack.length - 1];
  }

  /** Returns the next state to restore, or null if there is nothing to redo. */
  redo(): HistoryEntry | null {
    if (!this.canRedo()) return null;
    const next = this.redoStack.pop()!;
    this.stack.push(next);
    if (this.stack.length > this.cap) this.stack.shift();
    return next;
  }
}
