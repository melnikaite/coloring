/** IndexedDB persistence for saved colorings ("My works"). */

import type { PaintOp } from './engine/ops';

export interface Work {
  /**
   * Unique id of this coloring session. New works get `<imageId>-<random>`;
   * legacy records (one work per image) used workId === imageId and keep
   * working unchanged - they're just works like any other.
   */
  workId: string;
  imageId: string;
  updatedAt: number;
  /**
   * Frame 1's ordered paint operations - the source of truth for what's been
   * painted there. Frame 1's paint canvas is always derivable by replaying
   * these in order (see `engine/opRenderer.ts`); nothing else needs saving.
   */
  ops1: PaintOp[];
  /**
   * Frame 2's OWN ops (two-frame images only) - only ever populated for
   * regions the child has directly repainted there (see
   * `frame2OverriddenRegionIds`). Non-overridden regions mirror frame 1's ops
   * live at render/load time (via `matchFrameRegions` + `transformOp`), so
   * they're never duplicated into this list.
   */
  ops2?: PaintOp[];
  /**
   * Stable region ids (from `computeAllRegions`) on frame 2 that the child has
   * directly repainted there - those regions stop mirroring frame 1's ops.
   * Absent/old saves are treated as "nothing diverged yet, everything syncs".
   */
  frame2OverriddenRegionIds?: number[];
  thumbBlob: Blob; // 256px composite PNG for gallery thumbnails (frame 1), regenerated at save time
}

const DB_NAME = 'coloriki';
const DB_VERSION = 1;
const STORE = 'works';

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'workId' });
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      // If another tab/version ever needs to upgrade or delete the DB, close
      // our connection instead of deadlocking it (old tabs in the back/forward
      // cache would otherwise block the request forever).
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

export async function saveWork(work: Work): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(work);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getWork(workId: string): Promise<Work | undefined> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(workId);
    req.onsuccess = () => resolve(req.result as Work | undefined);
    req.onerror = () => reject(req.error);
  });
}

/** All works, most recently updated first. */
export async function getAllWorks(): Promise<Work[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => resolve((req.result as Work[]).sort((a, b) => b.updatedAt - a.updatedAt));
    req.onerror = () => reject(req.error);
  });
}

/** All works for one image, most recently updated first. Full-scan filter - fine at this scale. */
export async function getWorksForImage(imageId: string): Promise<Work[]> {
  return (await getAllWorks()).filter((w) => w.imageId === imageId);
}

export async function deleteWork(workId: string): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(workId);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
