/**
 * Undo/redo stack of paintCanvas snapshots, capped to avoid unbounded memory
 * growth. Snapshots are stored as PNG blobs, not raw ImageData: a raw
 * 1600x1600 RGBA frame is ~10 MB (25 of them would OOM mobile Safari), while
 * flat-color kid paintings compress to tens of KB. The cost is that restoring
 * a snapshot is async (blob decode) - the editor guards against a restore
 * racing new stroke input.
 */
export class HistoryStack {
  private stack: Blob[] = [];
  private redoStack: Blob[] = [];

  constructor(private cap = 25) {}

  /** Seeds the stack with the initial (usually blank) state. Clears redo. */
  init(snapshot: Blob) {
    this.stack = [snapshot];
    this.redoStack = [];
  }

  /** Records a new committed state. Call after each completed paint action. */
  push(snapshot: Blob) {
    this.stack.push(snapshot);
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
  undo(): Blob | null {
    if (!this.canUndo()) return null;
    const current = this.stack.pop()!;
    this.redoStack.push(current);
    return this.stack[this.stack.length - 1];
  }

  /** Returns the next state to restore, or null if there is nothing to redo. */
  redo(): Blob | null {
    if (!this.canRedo()) return null;
    const next = this.redoStack.pop()!;
    this.stack.push(next);
    if (this.stack.length > this.cap) this.stack.shift();
    return next;
  }
}
