/** IndexedDB persistence for saved colorings ("My works"). */

export interface Work {
  workId: string; // currently always === imageId (one work per image)
  imageId: string;
  updatedAt: number;
  paintBlob: Blob; // full-resolution PNG of the paint layer
  thumbBlob: Blob; // 256px composite PNG for gallery thumbnails
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
    req.onsuccess = () => resolve(req.result);
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

export async function getWork(imageId: string): Promise<Work | undefined> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(imageId);
    req.onsuccess = () => resolve(req.result as Work | undefined);
    req.onerror = () => reject(req.error);
  });
}

export async function getAllWorks(): Promise<Work[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => resolve((req.result as Work[]).sort((a, b) => b.updatedAt - a.updatedAt));
    req.onerror = () => reject(req.error);
  });
}

export async function deleteWork(imageId: string): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(imageId);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
