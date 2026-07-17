/** IndexedDB persistence for saved colorings ("My works"). */

export interface Work {
  /**
   * Unique id of this coloring session. New works get `<imageId>-<random>`;
   * legacy records (one work per image) used workId === imageId and keep
   * working unchanged - they're just works like any other.
   */
  workId: string;
  imageId: string;
  updatedAt: number;
  paintBlob: Blob; // full-resolution PNG of the (frame 1) paint layer
  /**
   * Frame 2's paint layer for two-frame images, present only once the child
   * has visited/painted frame 2. Optional and not part of any index, so old
   * records need no migration.
   */
  paintBlob2?: Blob;
  thumbBlob: Blob; // 256px composite PNG for gallery thumbnails (frame 1)
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
